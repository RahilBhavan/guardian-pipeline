/** Scrollable feed of the most recent invariant violations. */
import type { AlertRow } from '../types';

interface Props {
  alerts: AlertRow[];
}

/** Render an ISO timestamp as a compact "Xs/m/h ago" string. */
function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(diffMs / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function AlertFeed({ alerts }: Props) {
  if (alerts.length === 0) {
    return <div className="empty">No violations detected — all invariants healthy.</div>;
  }

  return (
    <div className="alert-list scrollbar">
      {alerts.map((a) => (
        <div className="alert-row" key={a.id}>
          <span className="pill">{a.invariant_id}</span>
          <div className="body">
            <div className="name">{a.invariant_name}</div>
            <div className="meta">
              <span>
                <a
                  href={`https://sepolia.basescan.org/block/${a.block_number}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  block #{a.block_number}
                </a>
              </span>
              <span>{timeAgo(a.created_at)}</span>
              {a.detection_latency_ms != null && <span>{a.detection_latency_ms}ms latency</span>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
