/**
 * Detect whether an Add-box entry should be routed to the LLM command endpoint instead of
 * creating a plain task. True when the text *starts with* one of the configured keywords
 * (case-insensitive). Supports multi-word keywords like "check off" — the keyword must be
 * followed by a space (or be the whole entry), so "add" matches "add milk" but not "added".
 */
export function firstWordIsCommand(text: string, keywords: string[]): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  return keywords.some((k) => {
    const kw = k.trim().toLowerCase();
    return !!kw && (t === kw || t.startsWith(kw + ' '));
  });
}
