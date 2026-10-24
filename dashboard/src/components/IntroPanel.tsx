/**
 * IntroPanel — the dismissible "How to read this" strip under the top bar.
 *
 * This is the plain-language on-ramp for a first-time visitor: what the board
 * is, and how to skim it. Dismissal is owned by App (persisted to localStorage),
 * so a returning viewer isn't nagged; a "What is this?" button brings it back.
 */
import { Tip } from './InfoTip';
import { copy, type CopyKey } from '../content';

/** Glossary terms surfaced as hover chips in the intro (inline-tooltip layer). */
const GLOSSARY: CopyKey[] = [
  'gl:invariant',
  'gl:fuzz-campaign',
  'gl:mirror-evaluator',
  'gl:exploit-class',
  'gl:vault',
  'gl:base-sepolia',
  'gl:detection-latency',
  'gl:ci-gate',
];

const RECORDED_INTRO =
  'This page normally shows a monitor re-checking a demo lending vault\'s 12 math-based safety rules ("invariants") on Base Sepolia, a free test network. That live monitor is offline, so what you see is a recorded run: the same monitor code replayed over a scripted scenario on a local test chain. The run ends with a deliberate breach so you can see what a detected violation looks like. The assurance panels (score, traceability, exploit replays) are build-time reports from CI.';

export function IntroPanel({ onDismiss, recorded = false }: { onDismiss: () => void; recorded?: boolean }) {
  const c = copy('intro');
  return (
    <section className="intro" role="note" aria-label="How to read this dashboard">
      <span className="intro-icon" aria-hidden>
        ◈
      </span>
      <div className="intro-body">
        <div className="intro-title">{c.label ?? 'How to read this'}</div>
        <div className="intro-text">{recorded ? RECORDED_INTRO : c.plain}</div>
        {c.technical && <div className="intro-tech">{c.technical}</div>}
        <div className="intro-glossary">
          <span className="intro-glossary-label">Jargon</span>
          {GLOSSARY.map((k) => {
            const g = copy(k);
            return (
              <Tip key={k} plain={g.plain} technical={g.technical}>
                <span className="gl-chip">{g.label}</span>
              </Tip>
            );
          })}
        </div>
      </div>
      <button
        type="button"
        className="intro-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss the introduction"
      >
        ×
      </button>
    </section>
  );
}
