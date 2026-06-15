# Public demo addresses

Canonical on-chain addresses for trying Guardian Pipeline **without deploying your own contracts**.

## One command

```bash
node scripts/lookup-demo-addresses.mjs --verify
```

`--verify` checks the vault still has bytecode on Base Sepolia and fills in `collateralAsset` / `oracle` from the chain when missing from the registry.

## Registry

Machine-readable source of truth: [`addresses.json`](./addresses.json).

| Field | Value |
|-------|-------|
| Network | Base Sepolia (84532) |
| Vault (`AttackableVault`) | `0xfF9D77D1EC64C212D0552aEf587fa12125f803AF` |
| Debt asset (`MockERC20`) | `0x5E4FFa88822890f52002195D6DD45205B29D20Eb` |
| Deploy block | `42751398` |
| Demo attacker | `0x2497c84b19676b71a1A730A06c4dFac728094D16` |
| Live dashboard | https://guardian.rahilbhavan.com |
| Supabase (read) | https://klbqkgyyqkmqoebxbawy.supabase.co |

Explorer: [vault on BaseScan](https://sepolia.basescan.org/address/0xfF9D77D1EC64C212D0552aEf587fa12125f803AF).

## What you can do with these

1. **Browse the hosted dashboard** — shows invariant health and alerts when the Guardian bot is running against this vault.
2. **Inspect contracts on BaseScan** — read state, events, and transactions.
3. **Point your own dashboard clone** — set `VITE_VAULT_ADDRESS` and Supabase vars per [`dashboard/.env.example`](../dashboard/.env.example).
4. **Run the Guardian bot locally** — set `VAULT_ADDRESS`, `DEBT_ASSET`, and `VAULT_DEPLOY_BLOCK` in `guardian/.env` (see [`docs/setup.md`](../docs/setup.md)).

Calling `attack()` (STAGED-01 detection demo) on the demo vault is **one-way** — it permanently violates INV-01. Only the demo attacker wallet can call it; redeploy for a fresh vault.

## Cursor subagent

A project subagent knows this registry and how to use it:

```
Use the guardian-demo subagent to show me the public demo addresses
```

Definition: [`.cursor/agents/guardian-demo.md`](../.cursor/agents/guardian-demo.md).

## Updating after redeploy

1. Deploy with `script/DeployVault.s.sol` (see `docs/setup.md` §4).
2. Update `demo/addresses.json` (`vault`, `deployBlock`, and any reused token addresses).
3. Run `node scripts/lookup-demo-addresses.mjs --verify` to confirm.
4. Update Vercel / `guardian/.env` / `dashboard/.env` with the new vault address.
