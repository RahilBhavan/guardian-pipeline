/**
 * App.tsx — the Guardian monitoring dashboard.
 *
 * Reads the `alerts` and `blocks_checked` tables on mount, then keeps both live
 * via Supabase Postgres real-time subscriptions. No polling, no page refresh.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, VAULT_ADDRESS } from './supabase';
import { INVARIANTS } from './types';
import type { AlertRow, BlockCheckedRow, LatencyPoint } from './types';
import { InvariantHealth } from './components/InvariantHealth';
import { AlertFeed } from './components/AlertFeed';
import { LatencyBadge } from './components/LatencyBadge';
import { AssuranceScore } from './components/AssuranceScore';
import { TraceabilityMatrix } from './components/TraceabilityMatrix';
import { ExploitReplay } from './components/ExploitReplay';
import { ErrorBoundary } from './components/ErrorBoundary';
import { assuranceReport } from './assurance';

/** Page size for the alert feed — also the chunk size for "load older". */
const ALERT_PAGE_SIZE = 50;
/** Fixed-size moving window for the latency sparkline. */
const LATENCY_HISTORY_SIZE = 100;
/** Cap on initial-load retries before we ask the user to refresh. */
const MAX_INITIAL_LOAD_ATTEMPTS = 10;
/** Backoff schedule (ms) for failed initial loads — capped at 30s. */
const INITIAL_LOAD_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

function backoffMsFor(attempt: number): number {
  const idx = Math.min(attempt - 1, INITIAL_LOAD_BACKOFF_MS.length - 1);
  return INITIAL_LOAD_BACKOFF_MS[Math.max(0, idx)] ?? 30000;
}

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

/**
 * Realtime subscription states. `CONNECTING` is the local pre-callback state;
 * the rest mirror Supabase's REALTIME_SUBSCRIBE_STATES enum verbatim.
 */
type RealtimeStatus = 'CONNECTING' | 'SUBSCRIBED' | 'CLOSED' | 'CHANNEL_ERROR' | 'TIMED_OUT';

/** Human-readable banner copy per failure mode. */
const REALTIME_BANNER_COPY: Record<Exclude<RealtimeStatus, 'CONNECTING' | 'SUBSCRIBED'>, string> = {
  CLOSED: 'Realtime channel closed — attempting to reconnect.',
  CHANNEL_ERROR: 'Realtime channel error — reconnecting. Data shown may be stale.',
  TIMED_OUT: 'Realtime channel timed out — reconnecting. Data shown may be stale.',
};

export function App() {
  const [latestBlock, setLatestBlock] = useState<number | null>(null);
  const [invariantStatus, setInvariantStatus] = useState<Record<string, boolean | null>>(
    allInvariants(null),
  );
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [latencyHistory, setLatencyHistory] = useState<LatencyPoint[]>([]);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>('CONNECTING');
  const [initialLoadError, setInitialLoadError] = useState<string | null>(null);
  const [initialLoadAttempts, setInitialLoadAttempts] = useState<number>(0);
  const [nextRetryMs, setNextRetryMs] = useState<number | null>(null);
  /** Pages of alerts beyond the first that have been fetched via "Load older". */
  const [extraAlertPagesLoaded, setExtraAlertPagesLoaded] = useState<number>(0);
  const [canLoadOlder, setCanLoadOlder] = useState<boolean>(true);
  const [loadingOlder, setLoadingOlder] = useState<boolean>(false);

  /**
   * The mount effect owns lifecycle flags — components below trigger reloads
   * via the manual-retry callback, but the cancelled/timeout refs let us abort
   * cleanly on unmount and prevent the retry from racing a manual refresh.
   */
  const cancelledRef = useRef<boolean>(false);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef<number>(0);

  /**
   * Initial-history load. Returns true on success so the retry loop can stop
   * scheduling. Sets `initialLoadError` on failure so the banner renders.
   */
  const load = useCallback(async (): Promise<boolean> => {
    const { data: recentAlerts, error: alertsError } = await supabase
      .from('alerts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(ALERT_PAGE_SIZE);

    const { data: recentBlocks, error: blocksError } = await supabase
      .from('blocks_checked')
      .select('*')
      .order('checked_at', { ascending: false })
      .limit(LATENCY_HISTORY_SIZE);

    if (cancelledRef.current) return false;

    if (alertsError || blocksError) {
      setInitialLoadError((alertsError ?? blocksError)?.message ?? 'unknown error');
      return false;
    }
    setInitialLoadError(null);
    setNextRetryMs(null);

    const alertRows = (recentAlerts ?? []) as AlertRow[];
    setAlerts(alertRows);
    setExtraAlertPagesLoaded(0);
    setCanLoadOlder(alertRows.length >= ALERT_PAGE_SIZE);

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

    return true;
  }, []);

  /**
   * Schedule the next retry with capped exponential backoff. Tracks the
   * attempt counter via a ref so the scheduled callback always reads the
   * latest count, even if React batches the state update.
   */
  const scheduleRetry = useCallback((): void => {
    if (cancelledRef.current) return;
    const attempt = attemptRef.current;
    if (attempt >= MAX_INITIAL_LOAD_ATTEMPTS) {
      setNextRetryMs(null);
      return;
    }
    const wait = backoffMsFor(attempt);
    setNextRetryMs(wait);
    retryTimeoutRef.current = setTimeout(() => {
      if (cancelledRef.current) return;
      attemptRef.current += 1;
      setInitialLoadAttempts(attemptRef.current);
      void load().then((ok) => {
        if (cancelledRef.current) return;
        if (!ok) scheduleRetry();
        else {
          attemptRef.current = 0;
          setInitialLoadAttempts(0);
        }
      });
    }, wait);
  }, [load]);

  /**
   * Banner "Retry now" handler — clears any queued backoff retry, resets the
   * counter, and fires `load()` immediately.
   */
  const retryNow = useCallback((): void => {
    if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    retryTimeoutRef.current = null;
    attemptRef.current = 1;
    setInitialLoadAttempts(1);
    setNextRetryMs(null);
    void load().then((ok) => {
      if (cancelledRef.current) return;
      if (!ok) scheduleRetry();
      else {
        attemptRef.current = 0;
        setInitialLoadAttempts(0);
      }
    });
  }, [load, scheduleRetry]);

  useEffect(() => {
    cancelledRef.current = false;
    attemptRef.current = 1;
    setInitialLoadAttempts(1);

    void load().then((ok) => {
      if (cancelledRef.current) return;
      if (!ok) scheduleRetry();
      else {
        attemptRef.current = 0;
        setInitialLoadAttempts(0);
      }
    });

    const channel = supabase
      .channel('guardian-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'alerts' },
        (payload) => {
          const row = payload.new as AlertRow;
          // Trim only if we're holding more than the user has explicitly
          // requested — "Load older" extends the buffer; new arrivals
          // shouldn't immediately undo that work.
          setAlerts((prev) => {
            const next = [row, ...prev];
            const cap = ALERT_PAGE_SIZE * (extraAlertPagesLoadedRef.current + 1);
            return next.length > cap ? next.slice(0, cap) : next;
          });
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
            ].slice(-LATENCY_HISTORY_SIZE),
          );
          if (row.all_passed) setInvariantStatus(allInvariants(true));
        },
      )
      .subscribe((status) => {
        // Supabase's underlying socket auto-reconnects, so transitioning
        // CLOSED → SUBSCRIBED happens without manual re-subscribe. Surfacing
        // the state to the user is the missing piece; the banner below
        // renders when status is anything other than SUBSCRIBED so a real
        // outage is honest about itself instead of showing as silence.
        setRealtimeStatus(status as RealtimeStatus);
      });

    return () => {
      cancelledRef.current = true;
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
      void supabase.removeChannel(channel);
    };
    // load/scheduleRetry are stable (useCallback with no state deps), so this
    // effect runs once on mount and tears down on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Mirror `extraAlertPagesLoaded` into a ref so the realtime callback above
   * — which closes over mount-time values — always reads the current page
   * count when computing the buffer cap.
   */
  const extraAlertPagesLoadedRef = useRef<number>(0);
  useEffect(() => {
    extraAlertPagesLoadedRef.current = extraAlertPagesLoaded;
  }, [extraAlertPagesLoaded]);

  /**
   * Fetch the next page of older alerts and append. Supabase's `.range()` is
   * inclusive at both ends, hence the `- 1`. A short page means we've hit the
   * tail; no more pages exist.
   */
  const loadOlderAlerts = useCallback(async (): Promise<void> => {
    if (loadingOlder || !canLoadOlder) return;
    setLoadingOlder(true);
    const from = alerts.length;
    const to = from + ALERT_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('alerts')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, to);
    if (cancelledRef.current) return;
    setLoadingOlder(false);
    if (error) {
      // Non-fatal — leave canLoadOlder true so the user can retry. We don't
      // raise the banner because partial-history pagination is a "nice to
      // have" relative to the live feed, which still works.
      console.error('[App] load older alerts failed:', error);
      return;
    }
    const rows = (data ?? []) as AlertRow[];
    setAlerts((prev) => [...prev, ...rows]);
    setExtraAlertPagesLoaded((n) => n + 1);
    setCanLoadOlder(rows.length >= ALERT_PAGE_SIZE);
  }, [alerts.length, canLoadOlder, loadingOlder]);

  const avgLatency = useMemo<number | null>(() => {
    const last = latencyHistory.slice(-10);
    if (last.length === 0) return null;
    return last.reduce((sum, p) => sum + p.latencyMs, 0) / last.length;
  }, [latencyHistory]);

  const bannerCopy =
    realtimeStatus === 'CLOSED' || realtimeStatus === 'CHANNEL_ERROR' || realtimeStatus === 'TIMED_OUT'
      ? REALTIME_BANNER_COPY[realtimeStatus]
      : null;

  const exhausted = initialLoadAttempts >= MAX_INITIAL_LOAD_ATTEMPTS && initialLoadError !== null;
  const initialBanner = (() => {
    if (!initialLoadError) return null;
    if (exhausted) {
      return `Could not load history after ${MAX_INITIAL_LOAD_ATTEMPTS} attempts (${initialLoadError}). Refresh to retry.`;
    }
    if (nextRetryMs !== null) {
      const secs = Math.ceil(nextRetryMs / 1000);
      return `Could not load history (attempt ${initialLoadAttempts}: ${initialLoadError}). Retrying in ${secs}s…`;
    }
    return `Could not load history (attempt ${initialLoadAttempts}: ${initialLoadError}). Live updates may still arrive.`;
  })();

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="shield">◈</span>Guardian Pipeline
        </div>
        <LatencyBadge latencyMs={avgLatency} blockNumber={latestBlock} lastChecked={lastChecked} />
        <span className="vault">{VAULT_ADDRESS}</span>
      </header>

      {initialBanner && (
        <div className="realtime-banner" role="alert">
          <span className="dot" aria-hidden />
          <span style={{ flex: 1 }}>{initialBanner}</span>
          <button type="button" onClick={retryNow}>
            Retry now
          </button>
        </div>
      )}
      {!initialLoadError && bannerCopy && (
        <div className="realtime-banner" role="status">
          <span className="dot" aria-hidden />
          {bannerCopy}
        </div>
      )}

      <main className="board">
        {/* Column 1 — assurance score (fixed) over invariant health (fills). */}
        <div className="col">
          <ErrorBoundary name="Assurance Score">
            <AssuranceScore report={assuranceReport} />
          </ErrorBoundary>
          <ErrorBoundary name="Invariant Health">
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
          </ErrorBoundary>
        </div>

        {/* Column 2 — finding traceability over exploit replay, split evenly. */}
        <div className="col">
          <ErrorBoundary name="Finding Traceability">
            <TraceabilityMatrix traceability={assuranceReport.traceability} />
          </ErrorBoundary>
          <ErrorBoundary name="Exploit Replay">
            <ExploitReplay exploits={assuranceReport.exploits} />
          </ErrorBoundary>
        </div>

        {/* Column 3 — alert feed (fills) over the latency chart (fixed). */}
        <div className="col">
          <ErrorBoundary name="Alert Feed">
            <section className="panel">
              <div className="panel-title">Alert Feed · latest {alerts.length}</div>
              <AlertFeed
                alerts={alerts}
                canLoadOlder={canLoadOlder}
                loadingOlder={loadingOlder}
                onLoadOlder={loadOlderAlerts}
              />
            </section>
          </ErrorBoundary>
          <ErrorBoundary name="Detection Latency">
            <section className="panel chart-wrap">
              <div className="panel-title">
                Detection Latency · last {latencyHistory.length} blocks
              </div>
              <LatencyChart points={latencyHistory} />
            </section>
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
