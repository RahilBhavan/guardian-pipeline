import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAbi } from 'viem';
import { evaluateMorpho, morphoDebtUp, fetchMorphoSnapshot, type MorphoSnapshot } from '../src/morpho.js';
const account = '0x0000000000000000000000000000000000000001';
function state(): MorphoSnapshot {
  return { blockNumber: 1n, blockHash: '0x01', timestamp: 1000n, lastUpdate: 1000n,
    totalSupplyAssets: 100n, totalSupplyShares: 100_000_000n,
    totalBorrowAssets: 50n, totalBorrowShares: 50_000_000n,
    lltv: 800_000_000_000_000_000n, price: 10n ** 36n, fee: 0n,
    positions: [{ address: account, supplyShares: 100_000_000n, borrowShares: 50_000_000n, collateral: 100n }] };
}
test('Morpho debt rounds up at a single-unit boundary and ignores empty shares', () => {
  assert.equal(morphoDebtUp(1n, 1n, 1n), 1n);
  assert.equal(morphoDebtUp(0n, 1n, 1n), 0n);
  assert.equal(morphoDebtUp(50_000_000n, 50n, 50_000_000n), 50n);
});
test('Morpho health uses two floors, reports risk separately, and never claims complete coverage', () => {
  const s = state();
  const p = s.positions[0];
  assert.ok(p);
  s.positions = [{ ...p, borrowShares: 1n, collateral: 1n }];
  // collateral value floor(1 * 1.9)=1, LLTV floor(1*.8)=0; debt rounds up to 1.
  s.price = 19n * 10n ** 35n;
  const result = evaluateMorpho(s);
  assert.equal(result.liquidatable.length, 1);
  assert.equal(result.liquidatable[0]?.maxDebt, 0n);
  assert.equal(result.violations.length, 0);
  assert.equal(result.coverage, 'sample');
  assert.ok(result.unavailable.includes('complete-holder conservation'));
});
test('corrupted market accounting and position sums trip the detector', () => {
  const s = state();
  assert.deepEqual(evaluateMorpho(s).violations, []);
  s.totalSupplyAssets = 49n;
  s.totalSupplyShares = 1n;
  s.totalBorrowShares = 1n;
  s.lastUpdate = 999n;
  s.fee = 250_000_000_000_000_001n;
  assert.deepEqual(evaluateMorpho(s).violations.map((v) => v.id), [
    'MORPHO-LIQUIDITY', 'MORPHO-SUPPLY-SUBSET', 'MORPHO-BORROW-SUBSET', 'MORPHO-ACCRUAL', 'MORPHO-FEE',
  ]);
});
test('mainnet batches simulate accrual without changing stored state', { skip: !process.env.BASE_MAINNET_RPC, timeout: 120_000 }, async () => {
  const { morphoInputs } = await import('../scripts/morpho-config.js');
  const { params } = await morphoInputs();
  const stored = () => params.client.readContract({ address: params.morpho,
    abi: parseAbi(['function market(bytes32 id) view returns (uint128,uint128,uint128,uint128,uint128,uint128)']),
    functionName: 'market', args: [params.market], blockNumber: params.block });
  const before = await stored();
  const snapshot = await fetchMorphoSnapshot({ ...params, actors: params.actors.slice(0, 101) });
  assert.equal(snapshot.positions.length, 101);
  assert.equal(snapshot.lastUpdate, snapshot.timestamp);
  assert.deepEqual(evaluateMorpho(snapshot).violations, []);
  const again = await fetchMorphoSnapshot({ ...params, actors: params.actors.slice(0, 1) });
  assert.equal(again.totalBorrowAssets, snapshot.totalBorrowAssets);
  assert.deepEqual(again.positions[0], snapshot.positions[0]);
  assert.deepEqual(await stored(), before);
});
