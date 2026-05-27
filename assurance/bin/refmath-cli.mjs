#!/usr/bin/env node
/**
 * refmath-cli — zero-dependency Node executable that mirrors
 * assurance/src/refmath.ts in plain JavaScript so Foundry's vm.ffi can
 * shell out to it without an npm install.
 *
 * Usage:
 *   node assurance/bin/refmath-cli.mjs <op> <arg1> <arg2> ...
 *
 * Output: a single line, hex-encoded 32-byte uint256 prefixed with `0x`.
 *   Foundry decodes the `0x` prefix natively, so the test can do:
 *     uint256 result = abi.decode(vm.ffi(cmd), (uint256));
 *
 * Keep this file in lockstep with assurance/src/refmath.ts. The
 * assurance/test/refmath.test.ts unit test catches drift between the
 * TS module and its consumers; the Foundry differential test catches
 * drift between this JS reference and src/Vault.sol.
 */

const WAD = 1_000_000_000_000_000_000n;
const MAX_UINT256 = (1n << 256n) - 1n;

function depositShares(amount, totalSupplyAssets, totalSupplyShares) {
  if (totalSupplyShares === 0n) return amount;
  return (amount * totalSupplyShares) / totalSupplyAssets;
}

function withdrawAmount(shares, totalSupplyAssets, totalSupplyShares) {
  return (shares * totalSupplyAssets) / totalSupplyShares;
}

function borrowShares(amount, borrowIndex) {
  return (amount * WAD + borrowIndex - 1n) / borrowIndex;
}

function userDebt(borrowSharesAmount, borrowIndex) {
  return (borrowSharesAmount * borrowIndex) / WAD;
}

function applyAccrual(borrowIndex, ratePerSecond, dt) {
  return borrowIndex + (borrowIndex * ratePerSecond * dt) / WAD;
}

function toUint256Hex(n) {
  if (n < 0n || n > MAX_UINT256) {
    throw new Error(`result ${n} out of uint256 range`);
  }
  return '0x' + n.toString(16).padStart(64, '0');
}

function parseBig(s) {
  if (typeof s !== 'string') throw new Error('arg missing');
  if (s.startsWith('0x') || s.startsWith('0X')) return BigInt(s);
  return BigInt(s);
}

const [, , op, ...rawArgs] = process.argv;
const args = rawArgs.map(parseBig);

let result;
switch (op) {
  case 'deposit-shares':
    result = depositShares(args[0], args[1], args[2]);
    break;
  case 'withdraw-amount':
    result = withdrawAmount(args[0], args[1], args[2]);
    break;
  case 'borrow-shares':
    result = borrowShares(args[0], args[1]);
    break;
  case 'user-debt':
    result = userDebt(args[0], args[1]);
    break;
  case 'accrue':
    result = applyAccrual(args[0], args[1], args[2]);
    break;
  default:
    process.stderr.write(`unknown op: ${op}\n`);
    process.exit(2);
}

process.stdout.write(toUint256Hex(result));
