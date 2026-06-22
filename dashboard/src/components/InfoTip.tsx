/**
 * Tip — the dashboard's "explain what this is" layer.
 *
 * Every panel shows plain language by default; this popover is the on-demand
 * second layer (plain restatement + precise technical detail). The board's
 * panels and lists use `overflow: hidden` / `overflow-y: auto`, which would
 * clip an absolutely-positioned tooltip, so the popover renders into a portal
 * at <body> with fixed positioning computed from the trigger's bounding box and
 * repositions on scroll/resize.
 *
 * Two trigger modes:
 *   <Tip plain="…" technical="…" />            → renders a small circled-i glyph
 *   <Tip plain="…"><span className="sev-tag">…</span></Tip>
 *                                              → wraps an existing tag, no glyph
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

interface TipProps {
  /** Plain-language explanation — shown first, jargon-free. */
  plain: string;
  /** Optional precise/technical detail — shown under a hairline divider. */
  technical?: string;
  /** Optional bold heading for the popover. */
  title?: string;
  /**
   * Custom trigger. Omitted → a circled-i glyph is rendered. Provided (e.g. an
   * existing tag) → the children become the hover/focus target with no glyph.
   */
  children?: ReactNode;
  /** Accessible name for the default (i) trigger. */
  label?: string;
}

interface Pos {
  top: number;
  left: number;
  placement: 'top' | 'bottom';
}

/** Popover max width; clamped to the viewport on small screens. */
const MAX_W = 300;
/** Minimum margin kept between the popover and the viewport edge. */
const GAP = 8;
/** Below this much space under the trigger we flip the popover above it. */
const FLIP_THRESHOLD = 170;

export function Tip({ plain, technical, title, children, label }: TipProps) {
  const [open, setOpen] = useState(false);
  /** Click pins the popover open so it survives mouse-leave (touch + read). */
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popId = useId();

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(MAX_W, vw - GAP * 2);
    let left = r.left + r.width / 2 - width / 2;
    left = Math.max(GAP, Math.min(left, vw - width - GAP));
    const spaceBelow = vh - r.bottom;
    const placement: 'top' | 'bottom' =
      spaceBelow < FLIP_THRESHOLD && r.top > spaceBelow ? 'top' : 'bottom';
    const top = placement === 'bottom' ? r.bottom + 6 : r.top - 6;
    setPos({ top, left, placement });
  }, []);

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      setPinned(false);
    };
    const onScroll = () => reposition();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popRef.current?.contains(t)) return;
      close();
    };
    // Capture phase catches scrolls inside nested overflow containers too.
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, [open, reposition]);

  const show = () => setOpen(true);
  const hide = () => {
    if (!pinned) setOpen(false);
  };
  const toggle = () => {
    const next = !pinned;
    setPinned(next);
    setOpen(next);
  };

  const width =
    pos && typeof window !== 'undefined' ? Math.min(MAX_W, window.innerWidth - GAP * 2) : MAX_W;

  const popover =
    open && pos
      ? createPortal(
          <div
            ref={popRef}
            id={popId}
            role="tooltip"
            className="tip-pop"
            style={{
              top: pos.top,
              left: pos.left,
              width,
              transform: pos.placement === 'top' ? 'translateY(-100%)' : undefined,
            }}
          >
            {title && <div className="tip-title">{title}</div>}
            <div className="tip-plain">{plain}</div>
            {technical && (
              <>
                <div className="tip-divider" />
                <div className="tip-tech-label">Technical</div>
                <div className="tip-tech">{technical}</div>
              </>
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={children ? 'tip-as-child' : 'tip-trigger'}
        aria-label={label ?? (title ? `About ${title}` : 'More information')}
        aria-expanded={open}
        aria-describedby={open ? popId : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={toggle}
      >
        {children ?? (
          <span aria-hidden className="tip-i">
            i
          </span>
        )}
      </button>
      {popover}
    </>
  );
}
