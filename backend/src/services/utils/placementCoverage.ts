/**
 * How much of the keyword checklist the finished resume actually carries.
 *
 * WHY THIS EXISTS. The tailoring prompt asks for at least 90% of the checklist
 * to appear in the summary, the role descriptions and the bullets. Nothing ever
 * checked. A resume that placed 60% and one that placed 95% came back looking
 * identical to this app, and the prompt's own rule 3 tells the model to drop a
 * term "when in doubt" - so the number was not only unmeasured, it was being
 * actively pushed down by an instruction nobody could see the cost of.
 *
 * This measures it. What the caller does about a low number is the caller's
 * business; the point is that the number exists.
 */

export type PlacementReport = {
  /** Terms asked for. */
  total: number;
  /** Terms found in the rendered prose. */
  placed: number;
  /** 0-1. Zero terms asked for counts as fully covered: nothing was missed. */
  ratio: number;
  missing: string[];
};

/**
 * The text a scanner actually reads.
 *
 * The summary, the role descriptions and the achievement bullets, and nothing
 * else. Deliberately NOT the cover letter - it is a separate document that is
 * not scanned with the resume - and deliberately not the skills block either,
 * because the checklist terms are prose targets and a term parked in the skills
 * list has not been written into the resume in the sense the prompt means.
 */
export function renderedProse(content: {
  summary?: string;
  experience?: Array<{ description?: string; achievements?: string[] }>;
}): string {
  return [
    content.summary ?? '',
    ...(content.experience ?? []).flatMap((role) => [
      role.description ?? '',
      ...(role.achievements ?? []),
    ]),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Whether a term is present as a term, rather than as a coincidence.
 *
 * Bounded on both sides so "Go" does not match "Google" and "AI" does not match
 * "detail". Whitespace inside a term is matched loosely, because a model that
 * writes "full stack engineering" for "full-stack engineering" has placed the
 * keyword as far as any scanner is concerned.
 */
export function containsTerm(haystack: string, term: string): boolean {
  const cleaned = term.trim();
  if (!cleaned) return false;

  const pattern = cleaned
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/(\\\s|\s|-)+/g, '[\\s-]+');

  return new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, 'i').test(haystack);
}

export function measurePlacement(prose: string, checklist: string[]): PlacementReport {
  const wanted = [...new Set(checklist.map((term) => term.trim()).filter(Boolean))];
  if (wanted.length === 0) {
    return { total: 0, placed: 0, ratio: 1, missing: [] };
  }

  const missing = wanted.filter((term) => !containsTerm(prose, term));
  const placed = wanted.length - missing.length;
  return { total: wanted.length, placed, ratio: placed / wanted.length, missing };
}

/**
 * The floor the prompt states, so the two cannot drift apart.
 *
 * Read from the environment for the same reason every other threshold here is:
 * an operator who wants to see how close a run really gets can lower it without
 * editing the source, and one who wants a stricter bar can raise it.
 */
export function placementFloor(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseFloat(env.RESUME_KEYWORD_FLOOR || '');
  if (!Number.isFinite(raw) || raw <= 0 || raw > 1) return 0.9;
  return raw;
}
