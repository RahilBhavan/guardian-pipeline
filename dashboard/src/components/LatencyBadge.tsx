/** Top-bar status: latest block, last-checked time, average latency, liveness dot. */
import { useEffect, useState } from 'react';

interface Props {
  /** Average detection latency over the last N readings, in ms. */
  latencyMs: number | null;
  blockNumber: number | null;
  lastChecked: Date | null;
}

/** Liveness threshold — hosted demo uses ~5 min GHA cron; 7 min window avoids false DOWN. */
const LIVE_WINDOW_MS = 420_000;

export function LatencyBadge({ latencyMs, blockNumber, lastChecked }: Props) {
  // Re-render once a second so "last checked" and the liveness dot stay current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const ageMs = lastChecked ? Date.now() - lastChecked.getTime() : Infinity;
  const isLive = ageMs < LIVE_WINDOW_MS;
  const agoText = !lastChecked
    ? '—'
    : ageMs < 1000
      ? 'just now'
      : `${Math.floor(ageMs / 1000)}s ago`;

  return (
    <div className="topbar-status">
      <div className="item">
        <span className="label">Latest block</span>
        <span className="value">
          {blockNumber != null ? (
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
        <span className="label">Last checked</span>
        <span className="value">{agoText}</span>
      </div>
      <div className="item">
        <span className="label">Avg latency</span>
        <span className="value">{latencyMs != null ? `${latencyMs.toFixed(1)}ms` : '—'}</span>
      </div>
      <div className="live-pill">
        <span className={`dot ${isLive ? 'live' : 'down'}`} />
        <span style={{ color: isLive ? 'var(--green)' : 'var(--red)' }}>
          {isLive ? 'GUARDIAN LIVE' : 'GUARDIAN DOWN'}
        </span>
      </div>
    </div>
  );
}
