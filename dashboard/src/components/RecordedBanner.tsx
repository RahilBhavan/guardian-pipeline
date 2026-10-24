/** Banner shown whenever the dashboard renders the recorded run instead of live data. */
import { recordedDate, recordedRun } from '../recorded';

export function RecordedBanner() {
  const blocks = recordedRun.blocks.length;
  return (
    <div className="recorded-banner" role="status">
      <strong>Recorded run, {recordedDate} — live monitor offline.</strong>{' '}
      Nothing on this page is being checked right now. The {blocks} blocks below were recorded by
      replaying the repo&apos;s own monitor code over a scripted scenario on a local test chain (not Base
      Sepolia), ending in a deliberate staged breach of INV-01. Source: commit{' '}
      <code>{recordedRun.sourceCommit ?? 'unknown'}</code>,{' '}
      <a
        href="https://github.com/RahilBhavan/guardian-pipeline/blob/main/scripts/record-demo-run.sh"
        target="_blank"
        rel="noreferrer"
      >
        scripts/record-demo-run.sh
      </a>
      . The assurance panels (score, traceability, exploit replays) are build-time reports from CI.
    </div>
  );
}
