# Spec 05 — Monitoring Dashboard + Supabase

**Paste this into Claude and say:** "Build the React dashboard in `dashboard/src/` exactly as specified, plus the Supabase SQL schema. Use Vite + React + TypeScript. No component libraries — plain CSS with CSS variables."

---

## Context

The Guardian bot (Spec 04) already writes to Supabase. This spec adds:
- Supabase schema (SQL migration).
- React + Vite dashboard that reads from Supabase in real time.
- Live invariant health indicators (green/red per invariant).
- Alert history feed.
- Detection latency readout.

The dashboard is deployed to Vercel. The URL goes in the README.

---

## File 1: Supabase SQL migration

Run this in the Supabase SQL editor (or add to `supabase/migrations/`):

```sql
-- Table: alerts
-- One row per invariant violation event
create table public.alerts (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  vault        text not null,
  block_number bigint not null,
  block_ts     timestamptz,
  invariant_id text not null,          -- e.g. 'INV-01'
  invariant_name text not null,
  passed       boolean not null default false,
  actual_value text,                   -- store as text (bigint too large for Postgres bigint)
  bound_value  text,
  description  text,
  detection_latency_ms integer
);

-- Table: blocks_checked
-- One row per block the Guardian checked (for latency monitoring)
create table public.blocks_checked (
  id              uuid primary key default gen_random_uuid(),
  checked_at      timestamptz not null default now(),
  block_number    bigint not null,
  vault           text not null,
  all_passed      boolean not null,
  latency_ms      integer,
  violations_count integer not null default 0
);

-- Enable RLS (row-level security) — read-only for anon
alter table public.alerts enable row level security;
alter table public.blocks_checked enable row level security;

create policy "Public read alerts"
  on public.alerts for select using (true);

create policy "Public read blocks"
  on public.blocks_checked for select using (true);

-- Allow the bot (service role key) to insert — handled automatically
-- No additional policy needed for service role
```

Also update the Guardian bot's `router.ts` to insert into `blocks_checked` on every block (not just violations), so the dashboard can show latency history.

---

## File 2: `dashboard/package.json`

```json
{
  "name": "guardian-dashboard",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "@supabase/supabase-js": "^2.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.0.0",
    "typescript": "^5.4.0",
    "vite": "^5.0.0"
  }
}
```

---

## File 3: `dashboard/vite.config.ts`

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
```

---

## File 4: `dashboard/index.html`

Standard Vite HTML shell. Title: `Guardian Pipeline`. No external fonts — use system font stack.

---

## File 5: `dashboard/src/main.tsx`

Standard React 18 `createRoot` mounting `<App />` into `#root`.

---

## File 6: `dashboard/src/App.tsx`

### Layout

```
┌────────────────────────────────────────────────┐
│  Header: "Guardian Pipeline" + vault address   │
├──────────────┬─────────────────────────────────┤
│  Invariant   │  Alert feed                     │
│  Health      │  (latest 50 violations)         │
│  (8 cards)   │                                 │
├──────────────┴─────────────────────────────────┤
│  Latency chart (last 100 blocks)               │
└────────────────────────────────────────────────┘
```

### State

```typescript
const [latestBlock, setLatestBlock] = useState<number | null>(null);
const [invariantStatus, setInvariantStatus] = useState<Record<string, boolean>>({});
const [alerts, setAlerts] = useState<AlertRow[]>([]);
const [latencyHistory, setLatencyHistory] = useState<LatencyPoint[]>([]);
const [lastChecked, setLastChecked] = useState<Date | null>(null);
```

### Data fetching

Use `@supabase/supabase-js` with real-time subscriptions:

```typescript
// Initial load
const { data: recentAlerts } = await supabase
  .from('alerts')
  .select('*')
  .order('created_at', { ascending: false })
  .limit(50);

// Real-time subscription — updates the feed live
const subscription = supabase
  .channel('alerts-channel')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alerts' },
    (payload) => setAlerts(prev => [payload.new as AlertRow, ...prev.slice(0, 49)])
  )
  .subscribe();
```

Also subscribe to `blocks_checked` inserts to update `latestBlock`, `lastChecked`, and `latencyHistory`.

---

## File 7: `dashboard/src/components/InvariantHealth.tsx`

### Props

```typescript
interface Props {
  invariantId: string;     // 'INV-01'
  name: string;            // 'Solvency'
  description: string;
  passed: boolean | null;  // null = not yet evaluated
}
```

### Render

A card: `passed=true` → green left border + "Healthy" badge. `passed=false` → red left border + "VIOLATED" badge (bold). `passed=null` → gray border + "Checking…" badge.

### Styles (CSS-in-JS object or inline — no external library)

```typescript
const borderColor = passed === true ? '#22c55e'
                  : passed === false ? '#ef4444'
                  : '#6b7280';
```

Use system fonts: `font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`.

Show all 8 invariants in a 2×4 grid (2 columns, 4 rows on desktop; 1 column on mobile via CSS).

---

## File 8: `dashboard/src/components/AlertFeed.tsx`

### Props

```typescript
interface Props {
  alerts: AlertRow[];
}

interface AlertRow {
  id: string;
  created_at: string;
  vault: string;
  block_number: number;
  invariant_id: string;
  invariant_name: string;
  actual_value: string;
  bound_value: string;
  description: string;
  detection_latency_ms: number | null;
}
```

### Render

A scrollable list (max height 400px, `overflow-y: auto`). Each row shows:
- Invariant ID badge (e.g. `INV-01` in red pill).
- Invariant name.
- Block number with Basescan link: `https://sepolia.basescan.org/block/{block_number}`.
- Time ago (e.g. "2m ago") — compute from `created_at`.
- Detection latency in ms.

If `alerts.length === 0`, show: "No violations detected — all invariants healthy."

---

## File 9: `dashboard/src/components/LatencyBadge.tsx`

### Props

```typescript
interface Props {
  latencyMs: number | null;
  blockNumber: number | null;
  lastChecked: Date | null;
}
```

### Render

A header-style strip showing:
- "Block #12345678" (link to Basescan).
- "Last checked: 2s ago".
- "Avg latency: 1.4ms" (computed from last 10 readings).
- A pulsing green dot when the bot is live (last check < 10s ago), red dot otherwise.

---

## Deployment: `vercel.json`

```json
{
  "buildCommand": "cd dashboard && npm install && npm run build",
  "outputDirectory": "dashboard/dist",
  "framework": "vite"
}
```

Add to root of the repo. Vercel will detect this automatically on connect.

### Vercel environment variables to set

In Vercel dashboard → Project → Settings → Environment Variables:

| Key | Value |
|---|---|
| `VITE_SUPABASE_URL` | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Your Supabase anon key |
| `VITE_VAULT_ADDRESS` | Deployed vault address |

Note: Vite exposes only vars prefixed with `VITE_` to the browser bundle. The anon key is intentionally public (row-level security handles access control).

---

## Acceptance criteria

- `npm run build` in `dashboard/` exits 0.
- Dashboard loads with 8 invariant health cards, all showing "Checking…" until first data arrives.
- When an alert row is inserted into Supabase, the feed updates in real time without a page refresh.
- Basescan links open correctly on Base Sepolia.
- The pulsing dot turns red if the bot hasn't checked a block in the last 10 seconds (bot is down).
- Mobile-responsive: 1 column on screens < 768px.
- No `any` types. No `console.log` in production paths.
