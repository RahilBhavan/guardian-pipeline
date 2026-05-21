# Spec 04 — Guardian Bot (TypeScript)

**Paste this into Claude and say:** "Build all files in `guardian/src/` exactly as specified. Include `package.json`, `tsconfig.json`, and `.env.example`. Use viem, not ethers.js."

---

## Context

The vault is deployed on Base Sepolia. This bot connects via Alchemy WebSocket, subscribes to new blocks, fetches vault state on each block, evaluates all 8 invariants from Spec 01, and persists any violation to Supabase. It must mirror the Solidity invariant logic exactly — the same check that passes in Foundry must be the check the bot runs live.

---

## File 1: `guardian/package.json`

```json
{
  "name": "guardian-bot",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/bot.ts",
    "start": "node dist/bot.js",
    "build": "tsup src/bot.ts --format esm --dts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "viem": "^2.0.0",
    "pino": "^9.0.0",
    "pino-pretty": "^11.0.0",
    "@supabase/supabase-js": "^2.0.0",
    "dotenv": "^16.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "tsx": "^4.0.0",
    "tsup": "^8.0.0",
    "@types/node": "^20.0.0"
  }
}
```

---

## File 2: `guardian/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

---

## File 3: `guardian/src/types.ts`

Define all types used across the bot. No logic here — types only.

```typescript
export type InvariantId =
  | 'INV-01' | 'INV-02' | 'INV-03' | 'INV-04'
  | 'INV-05' | 'INV-06' | 'INV-07' | 'INV-08';

export interface VaultState {
  totalDeposited: bigint;
  totalBorrowed: bigint;
  totalShares: bigint;
  sharePrice: bigint;
  collateralRatio: bigint;
  tokenBalance: bigint;         // vault's ERC-20 balance
  blockNumber: bigint;
  timestamp: number;
}

export interface InvariantResult {
  id: InvariantId;
  name: string;
  passed: boolean;
  actualValue: bigint;
  boundValue: bigint;
  description: string;
}

export interface AlertPayload {
  vaultAddress: string;
  blockNumber: bigint;
  timestamp: number;
  violations: InvariantResult[];
  detectedAt: number;           // Date.now() in ms
}

export interface BotConfig {
  rpcUrl: string;
  vaultAddress: `0x${string}`;
  tokenAddress: `0x${string}`;
  supabaseUrl: string;
  supabaseKey: string;
  blockPollIntervalMs: number;
}
```

---

## File 4: `guardian/src/fetcher.ts`

Reads vault state from the chain. Uses `multicall` to batch all reads into a single RPC call per block.

### Vault ABI (minimal — only the state variables the bot reads)

```typescript
export const VAULT_ABI = [
  { name: 'totalDeposited', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalBorrowed', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalShares', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'sharePrice', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'collateralRatio', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

export const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }] },
] as const;
```

### `fetchVaultState` function

```typescript
export async function fetchVaultState(
  client: PublicClient,
  vaultAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  blockNumber: bigint
): Promise<VaultState>
```

Use `client.multicall` with `allowFailure: false`. Batch all 5 vault reads + 1 `balanceOf` call. Map results to `VaultState`. Include `blockNumber` and `timestamp: Date.now() / 1000`.

---

## File 5: `guardian/src/evaluator.ts`

Evaluates all 8 invariants against a `VaultState`. Returns an array of `InvariantResult`. This is the mirror of the Solidity `invariant_*` functions.

### Structure

```typescript
export function evaluateInvariants(state: VaultState): InvariantResult[]
```

Internally calls one private function per invariant. Each returns `InvariantResult`. Collect all 8, return the array.

### Invariant implementations

Implement each one. Examples:

**INV-01: Solvency**
```typescript
function inv01(state: VaultState): InvariantResult {
  return {
    id: 'INV-01',
    name: 'Solvency',
    passed: state.totalBorrowed <= state.totalDeposited,
    actualValue: state.totalBorrowed,
    boundValue: state.totalDeposited,
    description: 'totalBorrowed must not exceed totalDeposited',
  };
}
```

**INV-02: Liquidity buffer**
```typescript
function inv02(state: VaultState): InvariantResult {
  const expectedLiquidity = state.totalDeposited - state.totalBorrowed;
  return {
    id: 'INV-02',
    name: 'Liquidity buffer',
    passed: state.tokenBalance >= expectedLiquidity,
    actualValue: state.tokenBalance,
    boundValue: expectedLiquidity,
    description: 'vault token balance must cover free liquidity',
  };
}
```

**INV-03: Share price floor**
```typescript
function inv03(state: VaultState): InvariantResult {
  const ONE_E18 = 1_000_000_000_000_000_000n;
  return {
    id: 'INV-03',
    name: 'Share price floor',
    passed: state.sharePrice >= ONE_E18,
    actualValue: state.sharePrice,
    boundValue: ONE_E18,
    description: 'sharePrice must be >= 1e18 (no share devaluation)',
  };
}
```

**INV-04 through INV-08:** Implement similarly, mirroring the Solidity logic exactly. For INV-04 (share accounting) and INV-05 (per-user collateral cap), note that the bot cannot iterate all users from on-chain without an event log. For the MVP:
- INV-04: Compare `totalShares` against `totalDeposited / sharePrice` as a proxy.
- INV-05: Skip per-user check in MVP; log a TODO comment.

---

## File 6: `guardian/src/router.ts`

Persists alert payloads to Supabase. Only called when `violations.length > 0`.

### Supabase function

```typescript
export async function logAlertToSupabase(
  supabase: SupabaseClient,
  payload: AlertPayload,
  logger: Logger
): Promise<void>
```

Insert one row per violation into the `alerts` table (schema in Spec 05). Again, wrap in try/catch — Supabase failure must not crash the bot.

---

## File 7: `guardian/src/bot.ts`

The entry point. Initialises all clients, starts the block subscription loop.

### Structure

```typescript
import 'dotenv/config';
import { createPublicClient, webSocket } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import pino from 'pino';
import { createClient } from '@supabase/supabase-js';
import { fetchVaultState } from './fetcher.js';
import { evaluateInvariants } from './evaluator.js';
import { logAlertToSupabase } from './router.js';
import type { BotConfig } from './types.js';
```

### Config validation

Read all env vars at startup. If any required var is missing, throw immediately with a clear message — do not start the bot in a broken state.

```typescript
function loadConfig(): BotConfig {
  const required = [
    'ALCHEMY_KEY', 'VAULT_ADDRESS', 'TOKEN_ADDRESS',
    'SUPABASE_URL', 'SUPABASE_ANON_KEY'
  ];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  }
  // ... build and return BotConfig
}
```

### Main loop

Use `client.watchBlockNumber` (viem's block subscription) rather than polling. On each new block:

1. Call `fetchVaultState(client, vaultAddress, tokenAddress, blockNumber)`.
2. Call `evaluateInvariants(state)`.
3. Filter to violations: `results.filter(r => !r.passed)`.
4. If `violations.length > 0`:
   - Log at `logger.error` level with structured fields.
   - Build `AlertPayload`.
   - Call `logAlertToSupabase` to persist one row per violation.
5. If no violations: log at `logger.debug` level with block number and latency.

### Latency tracking

Capture `Date.now()` before `fetchVaultState` and after the invariant check. Log `detectionLatencyMs` on every block and persist it with each alert row.

### Graceful shutdown

Listen for `SIGINT` and `SIGTERM`. On signal: log "Guardian shutting down", unwatch blocks, exit 0.

---

## File 8: `guardian/.env.example`

```env
ALCHEMY_KEY=your_alchemy_api_key_here
VAULT_ADDRESS=0x0000000000000000000000000000000000000000
TOKEN_ADDRESS=0x0000000000000000000000000000000000000000
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key
BLOCK_POLL_INTERVAL_MS=2000
CHAIN=base-sepolia
```

---

## Acceptance criteria

- `npm run typecheck` exits 0 with no errors in strict mode.
- `npm run dev` starts without crashing when `.env` is populated.
- On a clean Base Sepolia connection, the bot logs a structured line per block.
- When the `attack()` function is called on the vault, the next block's check writes alert rows to Supabase.
- Bot does NOT crash if Supabase is unreachable — it logs the error and continues.
- No `any` types anywhere. No `// @ts-ignore`.
