# How to record the staged detection demo

A 60–90 second screen recording shows the full pipeline: on-chain state change →
Guardian bot → Supabase → dashboard.

## Prerequisites

1. Fresh `AttackableVault` on Base Sepolia ([setup.md](setup.md) §4).
2. Guardian bot running (`cd guardian && npm start`).
3. Dashboard running locally or on the [live deployment](https://guardian.rahilbhavan.com).

## Recording steps

1. Open the dashboard — confirm all 12 invariant cards are green.
2. In a second terminal, run:

   ```bash
   ./scripts/staged-detection-demo.sh
   ```

3. Within one block (~2 s), the dashboard should show red cards (at minimum
   INV-01) and new rows in the alert feed.
4. Optional: show Supabase `alerts` table or guardian logs for latency numbers.

## What to say (optional voiceover)

- `attack()` is a **planted demo flag** on `AttackableVault`, not a real exploit.
- The bot evaluates the **same 12 properties** the Foundry harness proves in CI.
- This demonstrates **plumbing** (fetch → evaluate → persist), not novel exploit detection.

## After filming

Redeploy the vault before the next demo — `attack()` permanently violates INV-01.
