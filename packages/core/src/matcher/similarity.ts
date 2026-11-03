/** Exact-stage normalization: uppercase, strip spaces and hyphens. */
export function normalizeUtrText(text: string): string {
  return text.toUpperCase().replace(/[\s-]+/g, "");
}

/** Uppercase and drop every non-alphanumeric character (used for ledger reference ↔ narration). */
export function alnumOnly(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

/**
 * UTR-like tokens from a narration: each alphanumeric token, plus joins of 2–3 adjacent tokens
 * (recovers UTRs split by spaces, hyphens, dots or slashes).
 */
export function utrCandidateTokens(narration: string, minLength: number, maxLength: number): string[] {
  const parts = narration.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < parts.length; i++) {
    let joined = "";
    for (let j = i; j < Math.min(parts.length, i + 3); j++) {
      joined += parts[j];
      if (joined.length > maxLength) break;
      if (joined.length >= minLength && /\d/.test(joined)) out.add(joined);
    }
  }
  return [...out];
}

/**
 * Extra candidate tokens (e.g. parsed by the AI layer) are accepted only if they are grounded: their
 * characters appear contiguously in the narration once both are reduced to uppercase alphanumerics.
 * A hint can therefore surface a UTR that is genuinely in the text, never introduce one.
 */
export function groundedTokens(narration: string, hints: readonly string[], minLength: number, maxLength: number): string[] {
  const text = alnumOnly(narration);
  return hints.map(alnumOnly).filter((t) => t.length >= minLength && t.length <= maxLength && /\d/.test(t) && text.includes(t));
}

/** Levenshtein distance, giving up early: returns `max + 1` as soon as the distance must exceed `max`. */
export function boundedLevenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  const d = prev[b.length] as number;
  return d > max ? max + 1 : d;
}
