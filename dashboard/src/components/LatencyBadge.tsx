/** Top-bar status: latest block, last-checked time, average latency, liveness dot. */
import { useEffect, useState } from 'react';
import { Tip } from './InfoTip';
import { copy } from '../content';

interface Props {
  /** Average detection latency over the last N readings, in ms. */
  latencyMs: number | null;
  blockNumber: number | null;
  lastChecked: Date | null;
  /** True when showing a recorded run: no ticking clock, no live pill, no explorer links. */
  recorded?: boolean;
}

/** Liveness threshold — hosted demo uses ~5 min GHA cron; 7 min window avoids false DOWN. */
const LIVE_WINDOW_MS = 420_000;

export function LatencyBadge({ latencyMs, blockNumber, lastChecked, recorded = false }: Props) {
  // Re-render once a second so "last checked" and the liveness dot stay current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const ageMs = lastChecked ? Date.now() - lastChecked.getTime() : Infinity;
  const isLive = !recorded && ageMs < LIVE_WINDOW_MS;
  const agoText = !lastChecked
    ? '—'
    : recorded
      ? lastChecked.toISOString().slice(0, 10)
      : ageMs < 1000
      ? 'just now'
      : `${Math.floor(ageMs / 1000)}s ago`;

  return (
    <div className="topbar-status">
      <div className="item">
        <Tip
          plain={copy('topbar:latest-block').plain}
          technical={copy('topbar:latest-block').technical}
        >
          <span className="label">Latest block</span>
        </Tip>
        <span className="value">
          {blockNumber != null && recorded ? (
            <>#{blockNumber} (local chain)</>
          ) : blockNumber != null ? (
            <a
              href={`https://sepolia.basescan.org/block/${blockNumber}`}
              target="_blank"
              rel="noreferrer"
            >
              #{blockNumber}
            </a>
          ) : (
            '—'
          )}
        </span>
      </div>
      <div className="item">
        <Tip
          plain={copy('topbar:last-checked').plain}
          technical={copy('topbar:last-checked').technical}
        >
          <span className="label">{recorded ? 'Recorded on' : 'Last checked'}</span>
        </Tip>
        <span className="value">{agoText}</span>
      </div>
      <div className="item">
        <Tip
          plain={copy('topbar:avg-latency').plain}
          technical={copy('topbar:avg-latency').technical}
        >
          <span className="label">Avg latency</span>
        </Tip>
        <span className="value">{latencyMs != null ? `${latencyMs.toFixed(1)}ms` : '—'}</span>
      </div>
      <div className="live-pill">
        <span className={`dot ${recorded ? 'recorded' : isLive ? 'live' : 'down'}`} />
        <Tip
          plain={
            recorded
              ? 'The live monitor is offline. This page shows a recorded run, not a current check.'
              : copy('topbar:guardian-live').plain
          }
          technical={
            recorded
              ? 'No live backend is configured (VITE_GUARDIAN_LIVE is unset), so the page renders dashboard/src/data/recorded-run.json.'
              : copy('topbar:guardian-live').technical
          }
        >
          <span style={{ color: recorded ? 'var(--text-dim)' : isLive ? 'var(--green)' : 'var(--red)' }}>
            {recorded ? 'RECORDED RUN · MONITOR OFFLINE' : isLive ? 'GUARDIAN LIVE' : 'GUARDIAN DOWN'}
          </span>
        </Tip>
      </div>
    </div>
  );
}
