/** A single invariant health card — one of the eight in the 2×4 grid. */

interface Props {
  invariantId: string;
  name: string;
  description: string;
  /** true = healthy, false = violated, null = not yet evaluated. */
  passed: boolean | null;
}

export function InvariantHealth({ invariantId, name, description, passed }: Props) {
  const borderColor =
    passed === true
      ? 'var(--green)'
      : passed === false
        ? 'var(--red)'
        : 'var(--text-faint)';

  const badge =
    passed === true
      ? { className: 'badge healthy', label: 'HEALTHY' }
      : passed === false
        ? { className: 'badge violated', label: 'VIOLATED' }
        : { className: 'badge checking', label: 'CHECKING…' };

  return (
    <div className="inv-card" style={{ borderLeftColor: borderColor }}>
      <div className="top">
        <span className="id">{invariantId}</span>
        <span className={badge.className}>{badge.label}</span>
      </div>
      <div className="name">{name}</div>
      <div className="desc">{description}</div>
    </div>
  );
}
