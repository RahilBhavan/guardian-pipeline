/**
 * App.tsx — the Guardian monitoring dashboard.
 *
 * Reads the `alerts` and `blocks_checked` tables on mount, then keeps both live
 * via Supabase Postgres real-time subscriptions. No polling, no page refresh.
 */
import { useEffect, useMemo, useState } from 'react';
import { supabase, VAULT_ADDRESS } from './supabase';
import { INVARIANTS } from './types';
import type { AlertRow, BlockCheckedRow, LatencyPoint } from './types';
import { InvariantHealth } from './components/InvariantHealth';
import { AlertFeed } from './components/AlertFeed';
import { LatencyBadge } from './components/LatencyBadge';
import { AssuranceScore } from './components/AssuranceScore';
import { TraceabilityMatrix } from './components/TraceabilityMatrix';
import { ExploitReplay } from './components/ExploitReplay';
import { assuranceReport } from './assurance';

/** All six invariants set to a single status value. */
function allInvariants(value: boolean | null): Record<string, boolean | null> {
  return Object.fromEntries(INVARIANTS.map((i) => [i.id, value]));
}

/** Minimal SVG sparkline of recent detection latency. */
function LatencyChart({ points }: { points: LatencyPoint[] }) {
  if (points.length < 2) {
    return <div className="empty">Awaiting latency data…</div>;
  }

  const W = 1000;
  const H = 120;
  const PAD = 8;
  const max = Math.max(...points.map((p) => p.latencyMs), 1);
  const stepX = (W - PAD * 2) / (points.length - 1);

  const coords = points.map((p, i) => {
    const x = PAD + i * stepX;
    const y = H - PAD - (p.latencyMs / max) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const line = coords.join(' ');
  const area = `${PAD},${H - PAD} ${line} ${PAD + (points.length - 1) * stepX},${H - PAD}`;

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <polygon points={area} fill="rgba(94,106,210,0.16)" />
      <polyline points={line} fill="none" stroke="#5e6ad2" strokeWidth="2" />
    </svg>
  );
}

export function App() {
  const [latestBlock, setLatestBlock] = useState<number | null>(null);
  const [invariantStatus, setInvariantStatus] = useState<Record<string, boolean | null>>(
    allInvariants(null),
  );
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [latencyHistory, setLatencyHistory] = useState<LatencyPoint[]>([]);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      const { data: recentAlerts } = await supabase
        .from('alerts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      const { data: recentBlocks } = await supabase
        .from('blocks_checked')
        .select('*')
        .order('checked_at', { ascending: false })
        .limit(100);

      if (cancelled) return;

      const alertRows = (recentAlerts ?? []) as AlertRow[];
      setAlerts(alertRows);

      const blockRows = (recentBlocks ?? []) as BlockCheckedRow[];
      const newest = blockRows[0];
      if (newest) {
        setLatestBlock(newest.block_number);
        setLastChecked(new Date(newest.checked_at));

        // Derive current invariant health from the most recent checked block.
        if (newest.all_passed) {
          setInvariantStatus(allInvariants(true));
        } else {
          const status = allInvariants(true);
          for (const a of alertRows) {
            if (a.block_number === newest.block_number) status[a.invariant_id] = false;
          }
          setInvariantStatus(status);
        }
      }

      // Oldest-first for the left-to-right sparkline.
      setLatencyHistory(
        [...blockRows].reverse().map((b) => ({
          blockNumber: b.block_number,
          latencyMs: b.latency_ms ?? 0,
          checkedAt: new Date(b.checked_at),
        })),
      );
    }

    void load();

    const channel = supabase
      .channel('guardian-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'alerts' },
        (payload) => {
          const row = payload.new as AlertRow;
          setAlerts((prev) => [row, ...prev.slice(0, 49)]);
          setInvariantStatus((prev) => ({ ...prev, [row.invariant_id]: false }));
        },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'blocks_checked' },
        (payload) => {
          const row = payload.new as BlockCheckedRow;
          setLatestBlock(row.block_number);
          setLastChecked(new Date(row.checked_at));
          setLatencyHistory((prev) =>
            [
              ...prev,
              {
                blockNumber: row.block_number,
                latencyMs: row.latency_ms ?? 0,
                checkedAt: new Date(row.checked_at),
              },
            ].slice(-100),
          );
          if (row.all_passed) setInvariantStatus(allInvariants(true));
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, []);

  const avgLatency = useMemo<number | null>(() => {
    const last = latencyHistory.slice(-10);
    if (last.length === 0) return null;
    return last.reduce((sum, p) => sum + p.latencyMs, 0) / last.length;
  }, [latencyHistory]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="shield">◈</span>Guardian Pipeline
        </div>
        <LatencyBadge latencyMs={avgLatency} blockNumber={latestBlock} lastChecked={lastChecked} />
        <span className="vault">{VAULT_ADDRESS}</span>
      </header>

      <main className="board">
        {/* Column 1 — assurance score (fixed) over invariant health (fills). */}
        <div className="col">
          <AssuranceScore report={assuranceReport} />
          <section className="panel">
            <div className="panel-title">Invariant Health</div>
            <div className="invariant-grid scrollbar">
              {INVARIANTS.map((inv) => (
                <InvariantHealth
                  key={inv.id}
                  invariantId={inv.id}
                  name={inv.name}
                  description={inv.description}
                  passed={invariantStatus[inv.id] ?? null}
                />
              ))}
            </div>
          </section>
        </div>

        {/* Column 2 — finding traceability over exploit replay, split evenly. */}
        <div className="col">
          <TraceabilityMatrix traceability={assuranceReport.traceability} />
          <ExploitReplay exploits={assuranceReport.exploits} />
        </div>

        {/* Column 3 — alert feed (fills) over the latency chart (fixed). */}
        <div className="col">
          <section className="panel">
            <div className="panel-title">Alert Feed · latest {alerts.length}</div>
            <AlertFeed alerts={alerts} />
          </section>
          <section className="panel chart-wrap">
            <div className="panel-title">
              Detection Latency · last {latencyHistory.length} blocks
            </div>
            <LatencyChart points={latencyHistory} />
          </section>
        </div>
      </main>
    </div>
  );
}
