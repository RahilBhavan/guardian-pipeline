#!/usr/bin/env node
/**
 * Print (and optionally verify) public Guardian Pipeline demo addresses.
 *
 * Usage:
 *   node scripts/lookup-demo-addresses.mjs
 *   node scripts/lookup-demo-addresses.mjs --verify
 *   node scripts/lookup-demo-addresses.mjs --json
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const REGISTRY_PATH = join(ROOT, 'demo', 'addresses.json');

const SELECTORS = {
  debtAsset: '0xa919802d',
  collateralAsset: '0xaabaecd6',
  oracle: '0x7dc0d1d0',
  attacker: '0x48eb76ee',
};

/** @param {string} rpc @param {string} to @param {string} data */
async function ethCall(rpc, to, data) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
  return json.result;
}

/** @param {string} hex */
function decodeAddress(hex) {
  if (!hex || hex === '0x') return null;
  return `0x${hex.slice(-40)}`.toLowerCase().replace(/^0x0x/, '0x');
}

/** @param {string} rpc @param {string} address */
async function hasBytecode(rpc, address) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getCode',
      params: [address, 'latest'],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
  return json.result && json.result !== '0x';
}

/** @param {string} base @param {string} address */
function explorerUrl(base, address) {
  return `${base}/address/${address}`;
}

/** @param {Record<string, string | null>} contracts @param {string} rpc */
async function enrichFromChain(contracts, rpc) {
  const vault = contracts.vault;
  if (!vault) return contracts;

  const out = { ...contracts };
  for (const [key, selector] of Object.entries(SELECTORS)) {
    if (out[key]) continue;
    try {
      const result = await ethCall(rpc, vault, selector);
      out[key] = decodeAddress(result);
    } catch {
      // leave null — RPC may be unavailable offline
    }
  }
  return out;
}

function loadRegistry() {
  return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
}

function printHuman(registry, contracts) {
  const { network, deployment, services } = registry;
  const explorer = network.explorer;

  console.log('Guardian Pipeline — public demo addresses');
  console.log('=========================================');
  console.log(`Network:     ${network.name} (chain ${network.chainId})`);
  console.log(`Label:       ${deployment.label}`);
  console.log(`Deploy blk:  ${deployment.deployBlock}`);
  console.log();
  console.log('Contracts');
  console.log('---------');
  for (const [name, addr] of Object.entries(contracts)) {
    if (!addr) {
      console.log(`  ${name.padEnd(18)} (run with --verify to fetch from chain)`);
      continue;
    }
    console.log(`  ${name.padEnd(18)} ${addr}`);
    console.log(`  ${''.padEnd(18)} ${explorerUrl(explorer, addr)}`);
  }
  console.log();
  console.log('Services');
  console.log('--------');
  console.log(`  dashboard          ${services.dashboard}`);
  console.log(`  supabase           ${services.supabase.url}`);
  console.log(`  note               ${services.supabase.note}`);
  console.log();
  console.log('Quick start');
  console.log('-----------');
  console.log('  1. Open the dashboard URL — live data when the Guardian bot is running.');
  console.log('  2. Inspect the vault on BaseScan (links above).');
  console.log('  3. Full local setup: docs/setup.md');
  console.log('  4. Cursor subagent:  @guardian-demo  or  Use the guardian-demo subagent');
}

async function main() {
  const verify = process.argv.includes('--verify');
  const jsonOut = process.argv.includes('--json');
  const registry = loadRegistry();
  const rpc = registry.network.rpcPublic;
  let contracts = { ...registry.deployment.contracts };

  if (verify) {
    const vault = contracts.vault;
    if (vault) {
      const live = await hasBytecode(rpc, vault);
      if (!live) {
        console.error(`Vault ${vault} has no bytecode on ${registry.network.name}. Redeploy and update demo/addresses.json.`);
        process.exit(1);
      }
      contracts = await enrichFromChain(contracts, rpc);
    }
  }

  const payload = {
    ...registry,
    deployment: { ...registry.deployment, contracts },
  };

  if (jsonOut) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printHuman(registry, contracts);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
