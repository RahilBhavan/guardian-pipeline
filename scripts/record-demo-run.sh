#!/usr/bin/env bash
# Regenerate dashboard/src/data/recorded-run.json.
#
# Starts a throwaway local anvil chain, deploys the demo contracts (debt asset,
# collateral asset, MockOracle, AttackableVault), plays a fixed scenario, then
# replays the Guardian monitor's own fetcher + evaluator over every block and
# writes the results. Nothing here touches Base Sepolia or a database.
#
# Needs network access to a Base Sepolia RPC (one eth_getCode call) and: foundry (anvil, forge, cast), node >= 22, `npm ci` in guardian/.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${ANVIL_PORT:-8599}"
RPC="http://127.0.0.1:$PORT"
OUT="${OUT_FILE:-$ROOT/dashboard/src/data/recorded-run.json}"
# anvil's well-known dev accounts (public test keys, valueless).
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; A0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
K1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d; A1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
K2=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a; A2=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
K3=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6; A3=0x90F79bf6EB2c4f870365E785982E1f101E93b906

anvil --port "$PORT" --silent >/dev/null 2>&1 & ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for _ in $(seq 50); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done

# viem's multicall needs Multicall3 at its canonical address, which a fresh anvil
# lacks. Copy its runtime code from Base Sepolia (read-only) before the first block.
MC3=0xcA11bde05977b3631167028862bE2a173976CA11
cast rpc --rpc-url "$RPC" anvil_setCode "$MC3" \
  "$(cast code "$MC3" --rpc-url "${CODE_SOURCE_RPC:-https://sepolia.base.org}")" >/dev/null

send() { local key=$1; shift; cast send --rpc-url "$RPC" --private-key "$key" "$@" >/dev/null; }
create() { forge create --rpc-url "$RPC" --private-key "$K0" --broadcast "$@" 2>&1 | awk '/Deployed to:/ {print $3}'; }
# skip_time moves the clock without mining, so the next transaction lands a day later.
skip_time() { cast rpc --rpc-url "$RPC" evm_increaseTime "$1" >/dev/null; }
mine() { cast rpc --rpc-url "$RPC" evm_mine >/dev/null; }

DEBT=$(create src/MockERC20.sol:MockERC20)
COLL=$(create src/MockERC20.sol:MockERC20)
ORACLE=$(create src/MockOracle.sol:MockOracle --constructor-args 2000000000000000000000)
FROM_BLOCK=$(cast block-number --rpc-url "$RPC")
VAULT=$(create src/AttackableVault.sol:AttackableVault \
  --constructor-args "$DEBT" "$COLL" "$ORACLE" 1000 500 "$A3")
FROM_BLOCK=$((FROM_BLOCK + 1))   # the vault's deployment block

E18=000000000000000000
# 1. lender supplies 10,000 debt tokens
send "$K0" "$DEBT" "mint(address,uint256)" "$A1" "10000$E18"
send "$K1" "$DEBT" "approve(address,uint256)" "$VAULT" "10000$E18"
send "$K1" "$VAULT" "deposit(uint256)" "10000$E18"
# 2. borrower posts 10 collateral (priced 2,000) and borrows 12,000 of 16,000 allowed
send "$K0" "$COLL" "mint(address,uint256)" "$A2" "10$E18"
send "$K2" "$COLL" "approve(address,uint256)" "$VAULT" "10$E18"
send "$K2" "$VAULT" "depositCollateral(uint256)" "10$E18"
send "$K2" "$VAULT" "borrow(uint256)" "8000$E18"
# 3. a day passes, the oracle is refreshed, interest accrues
skip_time 86400
send "$K0" "$ORACLE" "setPrice(uint256)" "2000$E18"
send "$K0" "$VAULT" "accrue()"
# 4. collateral price falls to 900, the position is under water, a liquidator closes part of it
send "$K0" "$ORACLE" "setPrice(uint256)" "900$E18"
send "$K0" "$DEBT" "mint(address,uint256)" "$A0" "3000$E18"
send "$K0" "$DEBT" "approve(address,uint256)" "$VAULT" "3000$E18"
send "$K0" "$VAULT" "liquidate(address,uint256)" "$A2" "3000$E18"
# 5. the demo breach: attack() inflates the lender-side claim, breaking INV-01
send "$K3" "$VAULT" "attack()"
# 6. one more block after the breach
skip_time 1; mine

NODE_NO_WARNINGS=1 \
RPC_URL="$RPC" VAULT_ADDRESS="$VAULT" DEBT_ASSET="$DEBT" FROM_BLOCK="$FROM_BLOCK" OUT_FILE="$OUT" \
SOURCE_COMMIT="$(git rev-parse --short HEAD)" \
SCENARIO="Lender deposits 10,000 debt tokens|Borrower posts 10 collateral (priced 2,000) and borrows 8,000|One day passes and interest accrues|Collateral price falls to 900 and a liquidator repays 3,000 of the debt|AttackableVault.attack() inflates lender claims, breaking INV-01" \
  npx --prefix guardian tsx guardian/src/record.ts
