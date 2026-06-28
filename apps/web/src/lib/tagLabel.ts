import { tagSegments } from '@carbon/core';

/**
 * Compact a tag path for on-task previews: abbreviate every ancestor segment to
 * its first letter, keep the leaf in full. "Shopping:Coles:FreshGoods" → "S:C:FreshGoods".
 * Top-level tags are returned unchanged. (The leading # is drawn separately by TagMark.)
 */
export function abbreviateTagPath(name: string): string {
  const segs = tagSegments(name);
  if (segs.length <= 1) return name;
  const leaf = segs[segs.length - 1]!;
  const initials = segs.slice(0, -1).map((s) => s[0]!);
  return [...initials, leaf].join(':');
}
