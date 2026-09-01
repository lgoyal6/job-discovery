// Resolving a posting's company name onto a USCIS legal entity.
//
// The two sides name the same company differently. A posting says "AMD",
// "Stripe", "Booz Allen"; the USCIS export says "advanced micro devices",
// "stripe", "booz allen hamilton". Matching them raw resolves 24% of our
// employers, and the misses are not companies that fail to sponsor, they are
// companies we failed to look up. That distinction is the whole point: this
// table exists so that absence can mean something.
//
// Deterministic on purpose. Fuzzy substring matching is what turns "imc" into
// "pimco" and "ramp" into "liveramp", so every pass here either matches on a
// whole token sequence or does not match at all.

// Words a legal entity carries and a posting does not. Stripped from both sides
// before comparison, never from the middle of a name.
const LEGAL_SUFFIXES = new Set([
  'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'company', 'co', 'plc', 'lp', 'llp',
  'holdings', 'holding', 'group', 'technologies', 'technology', 'tech', 'systems', 'solutions',
  'services', 'labs', 'laboratories', 'usa', 'us', 'america', 'americas', 'international',
  'global', 'worldwide', 'na', 'north'
]);

const tokens = (name: string): string[] => name.split(/\s+/).filter(Boolean);

// "The Walt Disney Company" and "The Hartford" are how a posting writes what
// USCIS files as "walt disney" and "hartford". A leading article carries no
// identity, so it comes off both sides before anything is compared.
const dropArticle = (name: string): string => name.replace(/^the\s+/, '');

/** Drop trailing legal words, keeping at least the first token. */
export function stripLegal(name: string): string {
  const parts = tokens(dropArticle(name));
  while (parts.length > 1 && LEGAL_SUFFIXES.has(parts[parts.length - 1]!)) parts.pop();
  return parts.join(' ');
}

export interface ResolutionResult {
  matched: Map<string, string>;
  /** Employers no pass could resolve. Absence stays meaningless for these. */
  unresolved: string[];
  /** Employers where more than one entity was an equally good match. */
  ambiguous: Map<string, string[]>;
}

/**
 * Resolve each posting-side employer onto a USCIS entity name.
 *
 * Three passes, each stricter than a substring test:
 *   1. exact
 *   2. exact after stripping legal suffixes from both sides
 *   3. the employer's tokens are a leading run of the entity's tokens, so
 *      "booz allen" reaches "booz allen hamilton" but "allen" does not.
 * Pass 3 keeps a match only when exactly one entity qualifies; several means
 * ambiguous, which is reported rather than guessed.
 */
export function resolveEmployers(employers: string[], entities: Iterable<string>, aliases: Record<string, string | null> = {}): ResolutionResult {
  const entityList = [...entities];
  const exact = new Set(entityList);
  const byStripped = new Map<string, string[]>();
  const byFirstToken = new Map<string, string[]>();
  for (const entity of entityList) {
    const stripped = stripLegal(entity);
    (byStripped.get(stripped) ?? byStripped.set(stripped, []).get(stripped)!).push(entity);
    const first = tokens(entity)[0];
    if (first) (byFirstToken.get(first) ?? byFirstToken.set(first, []).get(first)!).push(entity);
  }

  const matched = new Map<string, string>();
  const ambiguous = new Map<string, string[]>();
  const unresolved: string[] = [];

  for (const employer of employers) {
    // A hand-checked alias outranks every pass. Its value is either the USCIS
    // entity this employer files as, or null meaning "looked it up, genuinely
    // not in the export" - which is the answer for defense and space employers
    // that hire citizens, and for anything renamed after the data was cut.
    if (Object.prototype.hasOwnProperty.call(aliases, employer)) {
      const target = aliases[employer];
      if (target) matched.set(employer, target); else unresolved.push(employer);
      continue;
    }
    if (exact.has(employer)) { matched.set(employer, employer); continue; }

    const stripped = stripLegal(employer);
    const strippedHits = byStripped.get(stripped);
    if (strippedHits?.length === 1) { matched.set(employer, strippedHits[0]!); continue; }
    if (strippedHits && strippedHits.length > 1) { ambiguous.set(employer, strippedHits); continue; }

    const employerTokens = tokens(stripped);
    const first = employerTokens[0];
    const prefixHits = first
      ? (byFirstToken.get(first) ?? []).filter(entity => {
          const entityTokens = tokens(entity);
          return entityTokens.length >= employerTokens.length
            && employerTokens.every((token, i) => entityTokens[i] === token);
        })
      : [];
    if (prefixHits.length === 1) { matched.set(employer, prefixHits[0]!); continue; }
    if (prefixHits.length > 1) { ambiguous.set(employer, prefixHits); continue; }

    unresolved.push(employer);
  }

  return { matched, unresolved, ambiguous };
}
