/**
 * Server-side fuzzy matcher for the natural-language agent API.
 *
 * A tiny driving LLM (e.g. Qwen 2.5 1.5B) can't reliably match "shoping list" to a
 * "Shopping List" project or "coles" to a "Shopping:Coles" tag. So the model passes
 * names verbatim and the server resolves them here: deterministic, dependency-free,
 * and tuned so typos/word-order/abbreviations still resolve, while genuine non-matches
 * stay unmatched (the LLM is told to ask rather than guess).
 *
 * Scoring is banded so a stronger structural match always outranks a weaker one:
 *   exact 1.0  >  prefix 0.8–0.9  >  substring 0.6–0.78  >  token-overlap 0.45–0.65
 *   with a Levenshtein "fuzzy" band (0.3–0.75) layered in for typos. The final score is
 *   the max across bands; the reported `reason` is the band that produced it.
 */

export type MatchReason = 'exact' | 'prefix' | 'substring' | 'token-overlap' | 'fuzzy';

export interface Scored<T> {
  item: T;
  score: number;
  reason: MatchReason;
  /** The candidate key that scored highest (the one that matched). */
  key: string;
}

/** Below this, a candidate is not returned at all. */
export const MIN_SCORE = 0.2;
/** A single best match is only "confident" at or above this score… */
export const ACCEPT = 0.55;
/** …and only if it beats the runner-up by at least this margin (else it's ambiguous). */
export const AMBIGUITY_GAP = 0.15;

/** Lowercase, drop apostrophes/punctuation (keep ':' so tag paths survive), collapse
 *  whitespace, strip a leading "the ". */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9:\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the\s+/, '');
}

/** Normalized word tokens (split on whitespace and ':'). */
export function tokens(s: string): string[] {
  return normalize(s)
    .split(/[\s:]+/)
    .filter(Boolean);
}

function levenshtein(a: string, a2: string): number {
  if (a === a2) return 0;
  if (!a.length) return a2.length;
  if (!a2.length) return a.length;
  let prev = Array.from({ length: a2.length + 1 }, (_, i) => i);
  let cur = new Array<number>(a2.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= a2.length; j++) {
      const cost = a[i - 1] === a2[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[a2.length];
}

/** 0..1 similarity from edit distance. */
function levRatio(a: string, b: string): number {
  const m = Math.max(a.length, b.length);
  return m === 0 ? 0 : 1 - levenshtein(a, b) / m;
}

/** Two tokens match if identical, or (for non-trivial words) close under edit distance —
 *  so "shoping" matches the "shopping" token of a multi-word name. */
function tokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.max(a.length, b.length) < 4) return false;
  return levRatio(a, b) >= 0.8;
}

/**
 * Score one query against one candidate string. Returns null when nothing matches
 * above MIN_SCORE.
 */
export function scoreText(
  query: string,
  candidate: string,
): { score: number; reason: MatchReason } | null {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return null;

  const bands: Array<{ score: number; reason: MatchReason }> = [];

  if (q === c) bands.push({ score: 1, reason: 'exact' });

  const lenRatio = Math.min(q.length, c.length) / Math.max(q.length, c.length);
  if (c.startsWith(q) || q.startsWith(c)) {
    bands.push({ score: 0.8 + 0.1 * lenRatio, reason: 'prefix' });
  } else if (c.includes(q) || q.includes(c)) {
    bands.push({ score: 0.6 + 0.18 * lenRatio, reason: 'substring' });
  }

  // Token overlap (Dice coefficient) — order-independent, typo-tolerant multi-word
  // matching, so a single keyword like "shoping" resolves "Shopping List".
  const qt = [...new Set(tokens(query))];
  const ct = [...new Set(tokens(candidate))];
  if (qt.length && ct.length) {
    const qMatched = qt.filter((a) => ct.some((b) => tokenMatch(a, b))).length;
    const cMatched = ct.filter((b) => qt.some((a) => tokenMatch(a, b))).length;
    if (qMatched > 0) {
      const dice = (qMatched + cMatched) / (qt.length + ct.length);
      bands.push({ score: 0.45 + 0.2 * dice, reason: 'token-overlap' });
    }
  }

  // Levenshtein "fuzzy" band — typo/abbreviation tolerance over the spaceless strings.
  const lr = levRatio(q.replace(/\s+/g, ''), c.replace(/\s+/g, ''));
  if (lr >= 0.6) {
    bands.push({ score: 0.3 + ((lr - 0.6) / 0.4) * 0.45, reason: 'fuzzy' });
  }

  if (!bands.length) return null;
  const best = bands.reduce((a, b) => (b.score > a.score ? b : a));
  return best.score >= MIN_SCORE ? best : null;
}

export interface RankOpts {
  limit?: number;
  minScore?: number;
}

/**
 * Rank `items` against `query` using one or more key extractors (e.g. a tag's full
 * path and its leaf). Each item is scored by its best-matching key. Sorted by score
 * desc, tiebroken by shorter key (more specific).
 */
export function rankBy<T>(
  query: string,
  items: T[],
  keyFns: Array<(t: T) => string>,
  opts: RankOpts = {},
): Scored<T>[] {
  const limit = opts.limit ?? 8;
  const min = opts.minScore ?? MIN_SCORE;
  const scored: Scored<T>[] = [];
  for (const item of items) {
    let best: { score: number; reason: MatchReason; key: string } | null = null;
    for (const kf of keyFns) {
      const key = kf(item);
      const s = scoreText(query, key);
      if (s && (!best || s.score > best.score)) best = { ...s, key };
    }
    if (best && best.score >= min) {
      scored.push({ item, score: best.score, reason: best.reason, key: best.key });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.key.length - b.key.length);
  return scored.slice(0, limit);
}

export interface BestMatch<T> {
  /** The confident single match, or null if none clears ACCEPT + the ambiguity gap. */
  matched: Scored<T> | null;
  /** All candidates above the score floor, best first. */
  ranked: Scored<T>[];
  /** Why there's no confident match (when `matched` is null and `ranked` is non-empty). */
  reason: 'no_match' | 'ambiguous' | null;
}

/** Pick the single best match if it's both strong enough and clearly ahead of the rest. */
export function bestMatch<T>(
  query: string,
  items: T[],
  keyFns: Array<(t: T) => string>,
  opts: RankOpts = {},
): BestMatch<T> {
  const ranked = rankBy(query, items, keyFns, opts);
  const top = ranked[0];
  const second = ranked[1];
  if (!top || top.score < ACCEPT) {
    return { matched: null, ranked, reason: 'no_match' };
  }
  if (second && top.score - second.score < AMBIGUITY_GAP) {
    return { matched: null, ranked, reason: 'ambiguous' };
  }
  return { matched: top, ranked, reason: null };
}
