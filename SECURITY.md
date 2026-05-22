# Security

Guardian Pipeline is a security research and demonstration project: an
automated DeFi assurance pipeline. This document is its **threat model** — the
trust boundaries, the deliberate demo-only weaknesses, and how to report a
genuine issue.

> **Status.** The `Vault` contract is a deliberately minimal teaching example.
> It is **not audited for production** and must not custody real value. The
> security value of this repository is the *pipeline* — the invariant harness,
> the runtime Guardian, and the Assurance Score — not the vault itself.

---

## Trust boundaries

The system has four components and three trust boundaries.

```
   CI / Foundry            Vault (Base L2)            Guardian bot            Dashboard
   ─────────────           ───────────────            ────────────            ─────────
   trusted: repo      │    untrusted: anyone     │    trusted: operator   │   untrusted:
   maintainers        │    can call public fns   │    runs it, holds the  │   public; anon
   pin the campaign   │                          │    service-role key    │   key, read-only
                      ▲                          ▲                        ▲
              boundary 1: on-chain        boundary 2: RPC          boundary 3: Supabase RLS
              (public functions)          (read-only)              (write = service-role only)
```

### Boundary 1 — the vault's public surface

Every state-changing path (`deposit`, `withdraw`, `borrow`, `repay`,
`liquidate`, `accrue`) is callable by anyone. Their safety rests entirely on the
in-function guards documented in [docs/contracts.md](docs/contracts.md) and on
the six [invariants](docs/invariants.md). The fuzz harness exists precisely to
attack this boundary with 300,000+ randomised calls per CI run.

### Boundary 2 — the Guardian's RPC link

The bot only ever **reads** chain state (`multicall` over `view` functions).
It holds no signing key and can never move funds. A malicious or faulty RPC
endpoint could feed it wrong state — at worst causing a false alert or a missed
one — but cannot cause on-chain harm.

### Boundary 3 — the Supabase database

This is the project's most important off-chain boundary, enforced by
row-level security:

- **Reads are public.** The dashboard uses the **anon** key, which ships in the
  browser bundle. It is read-only by design.
- **Writes require the service-role key.** RLS grants `insert` to no role; the
  bot's service-role key bypasses RLS. The anon key therefore **cannot forge
  alerts or fake block-checks.** See [docs/database.md](docs/database.md#row-level-security).

The single most damaging mistake an operator could make is leaking the
**service-role key** — it grants full write access to the monitoring record.
Keep it in server-side environment variables only; never commit it, never ship
it to the browser.

---

## The `attack()` backdoor — isolated to a separate contract

The audited contract, `src/Vault.sol`, contains **no backdoor of any kind**.
The demo breach lives only in `src/AttackableVault.sol` — a demo-only subclass
that inflates `totalSupplyAssets` past the assets backing it, forcing an INV-01
(solvency) violation so the Loom demo can show the Guardian bot detecting it
live. `AttackableVault` is **never deployed to production**; the testnet demo
deploys it deliberately. It is contained by two independent guards:

1. **Access control** — `attack()` reverts with `NotAttacker` unless called by
   the `attacker` address fixed at construction. In the Foundry harness that
   address is a dedicated actor the fuzzer never controls.
2. **Chain gate** — `attack()` reverts with `MainnetDisabled` whenever
   `block.chainid == 8453` (Base mainnet). Even if this exact bytecode were
   deployed to production, the backdoor cannot fire.

Both guards are exercised by the unit suite and replayed as exploit scenario
**EXP-01**, where the expected outcome is **DETECTED** — the reference example
of a runtime breach a static audit cannot prevent but the live layer catches.

---

## Secrets and key handling

| Secret | Where it lives | Exposure rule |
|--------|----------------|---------------|
| `ALCHEMY_KEY` | `guardian/.env` | Read-only RPC access. Server-side only. |
| `SUPABASE_SERVICE_KEY` | `guardian/.env` | **Most sensitive.** Bypasses RLS. Server-side only — never in the browser, never committed. |
| `VITE_SUPABASE_ANON_KEY` | `dashboard/.env` | Public by design — ships in the browser bundle. Read-only via RLS. |
| Deployer key | Foundry encrypted keystore (`cast wallet import`) | Never in `.env`, never in plaintext on disk. Use a **testnet-only** key. |

Enforcement in the repo:

- `.gitignore` excludes `.env`, `.env.local`, `guardian/.env`, `dashboard/.env`.
- Only `.env.example` files — with placeholder values — are committed.
- The bot reads every secret from `process.env`; nothing is hardcoded. A
  missing required variable throws at startup.
- The CI pipeline holds **no deployment keys** — it never broadcasts a
  transaction.

If you ever commit a real key: rotate it immediately (a `git` history rewrite
alone is not enough — assume it is compromised the moment it is pushed).

---

## Known limitations

These are documented design boundaries, not undisclosed bugs:

- **The vault is a teaching example.** Single asset, a fixed-rate interest
  model, no price oracle, and no bad-debt reserve (audit finding GUA-08). Do not
  custody real value.
- **`MockERC20` has unrestricted `mint` and no transfer hooks** — test-only.
  Never deploy it to a real network.
- **The bot monitors only blocks seen while running** — no historical backfill
  of alerts, though the user set is seeded from the full event history at
  startup so the per-user invariants are exact from the first checked block.

---

## Reporting a vulnerability

If you find a security issue in the **pipeline tooling** — the invariant
harness, the Guardian bot, the assurance engine, the RLS model, or the CI
configuration — please report it responsibly:

1. **Do not** open a public issue for anything exploitable.
2. Email the maintainer, or use **GitHub's private vulnerability reporting**
   ("Report a vulnerability" under the repository's *Security* tab).
3. Include: the affected component, the impact, and the minimal steps to
   reproduce.

Issues in the demo `Vault` contract that are already listed under
[Known limitations](#known-limitations) or in
[docs/assurance.md](docs/assurance.md#audit-traceability) do not need a private
report — they are documented by design.

You can expect an acknowledgement within a few days. As a non-commercial
research project there is no bug bounty, but genuine reports will be credited.

---

## Related documents

- [docs/contracts.md](docs/contracts.md) — the contract's guards and errors.
- [docs/database.md](docs/database.md) — the RLS model in full.
- [docs/assurance.md](docs/assurance.md) — audit findings and exploit replays.
- [docs/guardian-bot.md](docs/guardian-bot.md) — the bot's trust assumptions.
</content>
