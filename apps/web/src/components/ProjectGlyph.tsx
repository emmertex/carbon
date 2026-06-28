import type { OrderMode } from '@carbon/core';

/**
 * Sidebar glyph reflecting a project's order_mode (the colour is tinted by the
 * project's colour, exactly like the old Folder icon was):
 *  - parallel   — two rows, each: filled circle left → line → empty circle right
 *  - sequential — one row: filled, filled, empty, joined by a line
 *  - single     — same three dots as sequential, but no connecting line
 */
export function ProjectGlyph({
  mode = 'parallel',
  size = 17,
  color,
}: {
  mode?: OrderMode;
  size?: number;
  color?: string | null;
}) {
  const stroke = color ?? 'currentColor';
  const sw = 1.6;
  const r = 2.6;

  // Filled dot = done/started; empty dot = remaining. Empty dots use the surface
  // colour for their fill so the line doesn't show through.
  const dot = (cx: number, cy: number, filled: boolean) => (
    <circle
      cx={cx}
      cy={cy}
      r={r}
      strokeWidth={sw}
      stroke={stroke}
      fill={filled ? stroke : 'var(--surface, #fff)'}
    />
  );
  const line = (x1: number, y1: number, x2: number, y2: number) => (
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
  );

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className="block"
      aria-hidden
      style={color ? { color } : undefined}
    >
      {mode === 'parallel' && (
        <>
          {line(5, 8, 19, 8)}
          {line(5, 16, 19, 16)}
          {dot(5, 8, true)}
          {dot(19, 8, false)}
          {dot(5, 16, true)}
          {dot(19, 16, false)}
        </>
      )}
      {mode === 'sequential' && (
        <>
          {line(5, 12, 19, 12)}
          {dot(5, 12, true)}
          {dot(12, 12, true)}
          {dot(19, 12, false)}
        </>
      )}
      {mode === 'single' && (
        <>
          {dot(5, 12, true)}
          {dot(12, 12, true)}
          {dot(19, 12, false)}
        </>
      )}
    </svg>
  );
}
