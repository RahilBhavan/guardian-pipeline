/**
 * PanelHeader — a panel's title row: heading + an (i) tooltip + a plain subtitle.
 *
 * The subtitle is the always-visible plain-language layer; the (i) opens the
 * on-demand plain + technical popover. Copy is looked up from content.ts by key.
 */
import type { ReactNode } from 'react';
import { Tip } from './InfoTip';
import { copy, type CopyKey } from '../content';

interface Props {
  /** The panel heading (also used as the tooltip popover title). */
  title: string;
  /** content.ts key for this panel's plain/technical/subtitle copy. */
  copyKey: CopyKey;
  /** Optional dim trailing text, e.g. a live count — kept outside the tooltip. */
  suffix?: ReactNode;
}

export function PanelHeader({ title, copyKey, suffix }: Props) {
  const c = copy(copyKey);
  return (
    <div className="panel-head">
      <div className="panel-title">
        <span>
          {title}
          {suffix != null && <> {suffix}</>}
        </span>
        <Tip title={title} plain={c.plain} technical={c.technical} />
      </div>
      {c.subtitle && <div className="panel-sub">{c.subtitle}</div>}
    </div>
  );
}
