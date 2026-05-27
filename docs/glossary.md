# Glossary

Terms used across Guardian Pipeline's code and documentation. Project-specific
identifiers (`INV-…`, `EXP-…`, `GUA-…`) are listed first; general DeFi and
tooling terms follow.

---

## Project identifiers

| Term | Meaning |
|------|---------|
| **`INV-01` … `INV-06`** | The six **invariants** — mathematical properties the vault must hold in every reachable state. Defined identically in the Foundry harness, the Guardian evaluator, and the exploit replays. Full reference: [invariants.md](invariants.md). |
| **`EXP-01` … `EXP-07`** | The seven **exploit-replay scenarios** — classes of real-world DeFi attack replayed against the vault. Each is classified PREVENTED / DETECTED / MISSED. Catalogue: [assurance.md](assurance.md#exploit-replays). |
| **`GUA-01` … `GUA-08`** | The eight findings in the self-conducted security review (`security-review/`), each traced to the layers that cover it. See [assurance.md](assurance.md#finding-traceability). |
| **Assurance Methodology Coverage (AMC)** | A composite 0–100 metric, recomputed every commit, weighting three pre-deployment components (static verification 45%, exploit resistance 35%, finding traceability 20%). Measures methodology rigor — *not* code security. CI gates at ≥ 80. Earlier revisions called this the "Assurance Score"; the JSON and CLI field names still read `score`. |
| **Guardian bot** | The off-chain TypeScript daemon (`guardian/`) — a runnable reference runtime monitor that, when run against a deployed vault, checks the invariants block by block. |
| **The four layers** | Pre-deployment CI, the smart contract, the runtime Guardian, and the assurance layer. See [architecture.md](architecture.md). |

---

## Invariant outcomes

| Term | Meaning |
|------|---------|
| **PREVENTED** | An exploit replay where the contract's own code blocked the attack — no state corruption. |
| **DETECTED** | An exploit replay where state *was* corrupted, but an invariant caught it the same block. The runtime layer's reason to exist. |
| **MISSED** | An exploit replay where value was extracted and no invariant noticed — a genuine coverage gap. Fails the CI build. |
| **Detection latency** | Wall-clock milliseconds from fetching vault state to finishing the six-invariant evaluation. Logged per block, charted on the dashboard. |

---

## Smart-contract terms

| Term | Meaning |
|------|---------|
| **Invariant** | A property that must hold in *every* reachable state, as opposed to a single-input unit assertion. |
| **Invariant fuzzing** | A testing technique (here, Foundry's) that drives a contract through random call sequences and asserts the invariants after every call. |
| **Handler** | A wrapper contract that exposes a *bounded* action space to the fuzzer, so it explores meaningful states. Guardian uses `DepositHandler`, `BorrowHandler`, `WarpHandler`, `LiquidateHandler`. |
| **Counterexample** | The minimal failing call sequence Forge prints (after *shrinking*) when an invariant breaks. |
| **Shrinking** | Forge's reduction of a failing fuzz sequence to the smallest sequence that still reproduces the failure. |
| **Over-collateralised** | A loan backed by collateral worth more than the debt. Guardian's vault caps borrowing at 80% of collateral value. |
| **Supply share / `userSupplyShares`** | A lender's claim on the vault's assets. Shares are minted on `deposit` against the stored `totalSupplyAssets`; their asset value *rises* as borrowers pay interest — it is not fixed 1:1. |
| **`sharePrice`** | The WAD-scaled asset-per-share rate, `totalSupplyAssets * 1e18 / totalSupplyShares`. Starts at `1e18` and only rises (INV-04). |
| **Borrow share / `userBorrowShares` / `borrowIndex`** | A borrower's debt is held as borrow shares; the asset value of one share is `borrowIndex`-scaled. `borrowIndex` starts at `1e18` and rises monotonically as `accrue` charges interest, so `userDebt = userBorrowShares * borrowIndex / 1e18`. |
| **`accrue`** | Charges borrower interest since the last call by raising `borrowIndex`, then credits the same realised amount to `totalSupplyAssets`. Called at the start of every state-mutating function; idempotent within a block. |
| **`liquidate`** | Clears an under-water borrower's position: repays part or all of their debt and seizes their collateral plus a 5% liquidation bonus. |
| **WAD** | A fixed-point unit of `1e18`. All share and index maths is WAD-scaled. |
| **BPS** | Basis points; `100_00` bps = 100%. The collateral ratio is `80_00` bps, the liquidation bonus `5_00` bps. |
| **`nonReentrant`** | An OpenZeppelin modifier that blocks a function from being re-entered mid-execution. |
| **Custom error** | A named, parameterised Solidity revert (e.g. `CollateralCapExceeded`) — cheaper than a `require` string and gives tests a precise selector. |
| **NatSpec** | Solidity's documentation-comment standard (`@notice`, `@dev`, `@param`). |

---

## Tooling and infrastructure

| Term | Meaning |
|------|---------|
| **Foundry** | The Solidity toolchain used here — `forge` (build/test), `cast` (CLI calls), `anvil` (local node). |
| **Fuzz profile** | A named set of fuzz parameters in `foundry.toml` (`default`, `ci`, `deep`), selected with `FOUNDRY_PROFILE`. |
| **`viem`** | The TypeScript Ethereum library the Guardian bot uses. The project standard — `ethers.js` is not used. |
| **`multicall`** | A single RPC call that batches several contract reads. The bot fetches a whole vault snapshot in one `multicall`. |
| **Base / Base L2 / Base Sepolia** | Base is Coinbase's Ethereum L2 (mainnet chain id `8453`); Base Sepolia is its testnet (chain id `84532`), the project's deploy target. |
| **Alchemy** | The RPC provider. The bot connects over an Alchemy WebSocket endpoint. |
| **Supabase** | The hosted Postgres + real-time service that is the bot↔dashboard boundary. |
| **RLS (row-level security)** | Postgres access control evaluated per row. Guardian's RLS allows public reads and denies all writes except the service-role key's. |
| **Anon key / service-role key** | Supabase API keys. The **anon** key is public and read-only (used by the dashboard); the **service-role** key bypasses RLS and is write-capable (used by the bot — keep it secret). |
| **`pino`** | The structured JSON logger the bot uses. `console.log` is banned in bot paths. |
| **Vite** | The dashboard's build tool. `create-react-app` is not used. |
| **Slither / Aderyn** | Solidity static analysers run by the `static-analysis` CI job. |
| **`forge snapshot`** | Records gas usage per test into `.gas-snapshot`; CI checks the diff against that baseline. |
| **LCOV** | The coverage report format `forge coverage` emits; the `coverage` job gates `Vault.sol` on its line percentage. |

---

## Research references

| Term | Meaning |
|------|---------|
| **Bourveau, Brendel & Schoenfeld (2024)** | *Decentralized Finance (DeFi) assurance: early evidence* (Review of Accounting Studies 29(3)). Hand-codes ~8,500 audit reports; documents the DeFi audit market as pervasive, value-relevant, and substantively different from conventional financial audits. |
| **Landsman, Lyandres, Maydew, Rabetti & Zhang (2025)** | *Auditing Smart Contracts* (SSRN). Across ~8,195 reports and 1,575 protocols, finds post-deployment outcomes depend on auditor characteristics — market share, launch rate, hack rate — rather than on the mere presence of an audit. |

These papers establish that the DeFi audit market is real and that audit
*effectiveness* is an open empirical question. The continuous, multi-layered
framing is this project's interpretation — not a claim of either paper. See
the [References section of the root README](../README.md#references).
</content>
