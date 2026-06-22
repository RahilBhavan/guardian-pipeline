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

export function IntroPanel({ onDismiss }: { onDismiss: () => void }) {
  const c = copy('intro');
  return (
    <section className="intro" role="note" aria-label="How to read this dashboard">
      <span className="intro-icon" aria-hidden>
        ◈
      </span>
      <div className="intro-body">
        <div className="intro-title">{c.label ?? 'How to read this'}</div>
        <div className="intro-text">{c.plain}</div>
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
