#!/usr/bin/env bash
# Staged detection demo — triggers AttackableVault.attack() on Base Sepolia.
# Prerequisites: guardian bot running, dashboard open, guardian-demo keystore funded.
# See docs/setup.md §8 and docs/demo-recording.md for filming notes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f guardian/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source guardian/.env
  set +a
fi

: "${VAULT_ADDRESS:?Set VAULT_ADDRESS in guardian/.env}"
: "${ALCHEMY_KEY:?Set ALCHEMY_KEY in guardian/.env}"

RPC_URL="${BASE_SEPOLIA_RPC:-https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}}"

echo "==> Vault: $VAULT_ADDRESS"
echo "==> RPC:   ${RPC_URL%%/v2/*}/v2/***"
echo "==> Sending attack() — expect INV-01 violation on next block"
echo

cast send "$VAULT_ADDRESS" "attack()" \
  --account guardian-demo \
  --rpc-url "$RPC_URL"

echo
echo "Done. Check guardian logs and the dashboard alert feed within ~2s."
echo "Redeploy AttackableVault before another demo (attack() is one-way)."
