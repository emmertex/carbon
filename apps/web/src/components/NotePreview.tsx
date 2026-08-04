import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { parseThumb, type Item } from '@carbon/core';
import { getBlobObjectUrl } from '@/lib/blobs';
import { cn } from '@/lib/cn';

// The two bits of "a note row is not a task row": the leading image (its
// thumbnail, never the original) and the two-line body excerpt under the title.

/** Strip the Markdown a body carries so a row excerpt reads as plain prose rather
 *  than syntax. Deliberately shallow — this is a preview, not a renderer: fenced
 *  code, images and link URLs are dropped, inline emphasis/heading/list/quote
 *  markers are peeled off, and everything else is left alone. */
export function noteExcerpt(body: string | null | undefined, maxChars = 240): string {
  if (!body) return '';
  const text = body
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/^---\n[\s\S]*?\n---\n/, '') // YAML frontmatter (imported notes)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images — shown as the thumbnail instead
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → their text
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '') // headings
        .replace(/^\s{0,3}>\s?/, '') // block quotes
        .replace(/^\s*([-*+]|\d+\.)\s+/, '') // list bullets
        .replace(/^\s*[-*_]{3,}\s*$/, '') // horizontal rules
        .replace(/[*_~`]/g, '') // inline emphasis / code ticks
        .trim(),
    )
    .filter(Boolean)
    .join(' · ')
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * A note's leading visual: its thumbnail when it has one, else the note glyph.
 *
 * Only ever resolves `thumb.hash` — the small, always-synced rendition. It never
 * touches the full-size original, so a list of photo notes costs kilobytes.
 */
export function NoteThumbnail({
  item,
  size,
  className,
}: {
  item: Item;
  /** Square edge length in px. */
  size: number;
  className?: string;
}) {
  const thumb = parseThumb(item);
  const hash = thumb?.hash ?? null;
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!hash) {
      setSrc(null);
      return;
    }
    let live = true;
    void getBlobObjectUrl(hash).then((url) => {
      if (live) setSrc(url);
    });
    return () => {
      live = false;
    };
  }, [hash]);

  const box = cn(
    'shrink-0 overflow-hidden rounded-md border border-border bg-surface-2',
    className,
  );

  if (hash && src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className={cn(box, 'object-cover')}
      />
    );
  }

  // No image in the note (or its thumbnail hasn't arrived yet) — the glyph, sized
  // to the same box so rows never reflow when a thumbnail resolves.
  return (
    <span
      style={{ width: size, height: size }}
      className={cn(box, 'flex items-center justify-center text-text-faint')}
      aria-label="Note"
      title="Note"
    >
      <FileText size={Math.round(size * 0.42)} />
    </span>
  );
}
