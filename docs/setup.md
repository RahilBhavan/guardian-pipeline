# Setup & deployment

End-to-end instructions to run every layer of Guardian Pipeline locally and on
Base Sepolia. Budget ~15 minutes.

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| [Foundry](https://getfoundry.sh/) | latest stable | `forge`, `cast`, `anvil` |
| Node.js | ≥ 20 | for the bot and dashboard |
| Alchemy API key | — | free tier; Base Sepolia RPC |
| Supabase project | — | free tier; Postgres + real-time |
| Base Sepolia ETH | ~0.01 | from a [Base Sepolia faucet](https://www.alchemy.com/faucets/base-sepolia) |

---

## 1. Clone and install

```bash
git clone https://github.com/rahilbhavan/guardian-pipeline
cd guardian-pipeline
forge install                        # forge-std + openzeppelin-contracts
cd guardian && npm install && cd ..
cd dashboard && npm install && cd ..
```

## 2. Run the invariant suite

```bash
# Fast — default profile, 500 runs
forge test --match-contract InvariantVault -vvv

# CI profile — 2,000 runs
FOUNDRY_PROFILE=ci forge test --match-contract InvariantVault -vvv

# Deep — 10,000 runs, run before any release
FOUNDRY_PROFILE=deep forge test --match-contract InvariantVault -vvv

# Unit suite + coverage
forge test --match-contract VaultUnit -vvv
forge coverage --report summary
```

## 3. Create a deploy keystore

The deployer key lives in a Foundry **encrypted keystore** — no raw private key
on disk or in `.env`.

```bash
# Generate a fresh testnet wallet (prints an address + private key)
cast wallet new

# Import that private key into an encrypted keystore named "guardian-demo"
cast wallet import guardian-demo --interactive
```

Fund the wallet's address with ~0.01 Base Sepolia ETH from a faucet, then
confirm:

```bash
cast wallet list   # should list "guardian-demo"
cast balance <ADDRESS> --rpc-url https://base-sepolia.g.alchemy.com/v2/$ALCHEMY_KEY
```

> Use a **testnet-only** key. Never import a mainnet key into a demo keystore.

## 4. Deploy to Base Sepolia

`DeployVault.s.sol` reads `ATTACKER_ADDRESS` from the environment and deploys a
`MockERC20` plus an `AttackableVault` — the demo-only `Vault` subclass that
adds the `attack()` backdoor used in step 8. `src/Vault.sol` itself carries no
backdoor; `AttackableVault.attack()` reverts on Base mainnet, so it is safe to
deploy only on the testnet. Broadcast with the keystore account:

```bash
ATTACKER_ADDRESS=<your-attacker-address> \
forge script script/DeployVault.s.sol \
  --rpc-url https://base-sepolia.g.alchemy.com/v2/$ALCHEMY_KEY \
  --account guardian-demo \
  --broadcast --verify
```

Copy the printed vault and token addresses — and note the **deployment block
number** from the broadcast output — you need all three next.

## 5. Provision Supabase

Run the files in `supabase/migrations/` **in order** in the Supabase SQL editor
(or apply them with the Supabase CLI):

- `0001_init.sql` — creates `alerts` and `blocks_checked`, enables row-level
  security with **public read**, and adds both tables to the real-time
  publication.
- `0002_lockdown_insert_rls.sql` — removes any public insert policy, so writes
  require the service-role key.

RLS is **public read, no public write**: the dashboard reads with the anon key,
but inserts are denied to it. The Guardian bot must run with the service-role
key (`SUPABASE_SERVICE_KEY`), which bypasses RLS — this stops anyone holding the
public anon key from forging alerts.

## 6. Configure and start the Guardian bot

```bash
cp guardian/.env.example guardian/.env
```

Fill in `guardian/.env`:

| Variable | Value |
|----------|-------|
| `ALCHEMY_KEY` | your Alchemy API key |
| `VAULT_ADDRESS` | the vault address from step 4 |
| `TOKEN_ADDRESS` | the token address from step 4 |
| `SUPABASE_URL` | your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | the **service-role** key (Settings → API) |
| `VAULT_DEPLOY_BLOCK` | the deployment block from step 4 — the start of the event scan that seeds the user set (defaults to `0`) |
| `BLOCK_POLL_INTERVAL_MS` | `2000` (default) |
| `CHAIN` | `base-sepolia` |

```bash
cd guardian
npm run dev      # tsx — runs src/ directly, no build step
# or: npm run build && npm start   # compiled dist/
```

A healthy start logs `RPC connection OK`, `Vault contract verified on-chain`,
`Supabase connection OK`, and `Guardian live — watching Base blocks`.

> If `npm start` fails with a stale-config error, `dist/` is out of date — run
> `npm run build` first, or use `npm run dev`.

## 7. Run the dashboard

```bash
cd dashboard
cp .env.example .env     # fill in VITE_SUPABASE_* + VITE_VAULT_ADDRESS
npm run dev
```

The dashboard reads Supabase with the **anon** key and subscribes to real-time
inserts — it never writes.

---

## 8. Trigger the demo violation

With the bot running and the dashboard open, in a separate terminal:

```bash
cast send $VAULT_ADDRESS "attack()" \
  --account guardian-demo \
  --rpc-url https://base-sepolia.g.alchemy.com/v2/$ALCHEMY_KEY
```

`attack()` inflates `totalSupplyAssets` so lender claims exceed the assets
backing them — a direct INV-01 (Protocol solvency) violation. On the next block
(~2 s) the Guardian logs `INVARIANT VIOLATION DETECTED`, writes `alerts` rows
to Supabase, and the dashboard cards turn red.

> `attack()` lives only on `AttackableVault` and permanently violates the
> vault. Redeploy (step 4) for a fresh, healthy vault before another demo run.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Missing required env var` | `.env` incomplete | Fill every variable in step 6 |
| `cast` → `invalid string length` | Pasted an address, not a private key | A private key is `0x` + 64 hex chars |
| `cast balance` returns `0` | ETH on the wrong chain | Use a **Base Sepolia** faucet (chain 84532), not Ethereum Sepolia |
| Bot starts but never logs blocks | Wrong RPC or vault address | Check `ALCHEMY_KEY` and `VAULT_ADDRESS` |
| Supabase writes rejected | Using the anon key | The bot needs `SUPABASE_SERVICE_KEY` |
| `npm start` uses old behaviour | Stale `dist/` | `npm run build`, or use `npm run dev` |

---

## Related documents

- [architecture.md](architecture.md) — what each layer you just started does.
- [guardian-bot.md](guardian-bot.md) — the bot's configuration and lifecycle.
- [database.md](database.md) — the Supabase schema and RLS model.
- [contracts.md](contracts.md) — the deployed contract's API.
- [assurance.md](assurance.md) — running the Assurance Score locally.
