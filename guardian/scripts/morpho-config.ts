/** Validated inputs shared by the pinned Morpho CLI and benchmark. */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createPublicClient, http, isAddress, isHex } from 'viem';
import { base } from 'viem/chains';

export async function morphoInputs() {
  const file = new URL('../../demo/morpho-benchmark-actors.json', import.meta.url);
  const bytes = await readFile(file, 'utf8');
  const fixture: unknown = JSON.parse(bytes);
  if (typeof fixture !== 'object' || fixture === null || !('actors' in fixture) || !Array.isArray(fixture.actors) ||
      !('market' in fixture) || typeof fixture.market !== 'string' || !isHex(fixture.market) || fixture.market.length !== 66) throw new Error('Invalid actor fixture');
  const actors = fixture.actors.map((value: unknown) => {
    if (typeof value !== 'string' || !isAddress(value)) throw new Error('Invalid actor');
    return value;
  });
  const rpc = new URL(process.env.BASE_MAINNET_RPC ?? 'https://mainnet.base.org');
  if (!['http:', 'https:'].includes(rpc.protocol)) throw new Error('RPC must use HTTP(S)');
  const client = createPublicClient({ chain: base, transport: http(rpc.href, { timeout: 30_000 }) });
  if (await client.getChainId() !== base.id) throw new Error('Expected Base mainnet');
  return { bytes, rpcHost: rpc.hostname, params: { client, actors, market: fixture.market,
    morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as const, block: 53_120_000n } };
}
