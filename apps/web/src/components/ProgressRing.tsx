/** A pie/ring progress indicator for a parent task: a track plus an arc that
 *  fills as sub-tasks complete. Empty centre — completing the task stays a
 *  deliberate tap on the ring. When full (done===total) the ring reads as a
 *  solid accent circle, inviting completion. Pure SVG; the caller owns the
 *  surrounding button (tap target / aria). */
export function ProgressRing({
  done,
  total,
  size = 18,
  /** Track colour (CSS colour/var). Defaults to the neutral border. */
  ringColor = 'var(--border-strong)',
  /** Completion-arc colour (CSS colour/var). Defaults to the accent. */
  fillColor = 'var(--accent)',
  /** Glyph outline. 'square' is reserved for a future priority-shape encoding
   *  (e.g. own-priority tasks rendered square) — currently unused. */
  shape = 'circle',
}: {
  done: number;
  total: number;
  size?: number;
  ringColor?: string;
  fillColor?: string;
  shape?: 'circle' | 'square';
}) {
  const sw = 2.5;
  const c = size / 2;
  const frac = total > 0 ? Math.min(1, done / total) : 0;

  if (shape === 'square') {
    // Rounded-square variant. `pathLength={100}` normalises the perimeter so the
    // progress dash maths is identical to the circle regardless of actual length.
    const inset = sw / 2;
    const dim = size - sw;
    const rx = 4;
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block" aria-hidden>
        <rect x={inset} y={inset} width={dim} height={dim} rx={rx} fill="none" strokeWidth={sw} stroke={ringColor} />
        {frac > 0 && (
          <rect
            x={inset}
            y={inset}
            width={dim}
            height={dim}
            rx={rx}
            fill="none"
            strokeWidth={sw}
            stroke={fillColor}
            pathLength={100}
            strokeDasharray={100}
            strokeDashoffset={100 * (1 - frac)}
            strokeLinecap="round"
            transform={`rotate(-90 ${c} ${c})`}
          />
        )}
      </svg>
    );
  }

  const r = (size - sw) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block" aria-hidden>
      <circle cx={c} cy={c} r={r} fill="none" strokeWidth={sw} stroke={ringColor} />
      {frac > 0 && (
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          strokeWidth={sw}
          stroke={fillColor}
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - frac)}
          strokeLinecap="round"
          transform={`rotate(-90 ${c} ${c})`}
        />
      )}
    </svg>
  );
}
