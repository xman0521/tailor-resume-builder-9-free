import type { JobAnalysis } from '../../types/template';

/**
 * Every term a job description named, in one place.
 *
 * WHY THIS EXISTS. The prompt hands the model several lists, each assembled by
 * its own function reading its own subset of the analysis. That worked until a
 * field was left out of one of them: `skills.required` and `skills.preferred`
 * reached the Technical Skills selection but no prose checklist, so a preferred
 * technology the library had never heard of - ArgoCD, in the case that found
 * this - was extracted from the posting, carried all the way through the
 * analysis, and then written nowhere at all. Nothing noticed, because nothing
 * ever compared what came out of the posting against what went into the prompt.
 *
 * So this is the denominator. It reads the analysis field by field, and the
 * coverage check downstream subtracts from it. A field added to `JobAnalysis`
 * and forgotten here is the one hole this cannot see - which is why the type is
 * spelled out rather than walked generically: adding a field to the interface
 * and not to this list is a compile-time omission somebody has to look at,
 * instead of a silent one.
 */
export function collectJobKeywords(jobAnalysis?: JobAnalysis): string[] {
  if (!jobAnalysis) return [];

  const skills = jobAnalysis.skills ?? ({} as JobAnalysis['skills']);
  const keywords = jobAnalysis.keywords ?? ({} as JobAnalysis['keywords']);

  const everything: Array<string | undefined> = [
    ...(skills.technical ?? []),
    ...(skills.required ?? []),
    ...(skills.preferred ?? []),
    ...(skills.tools ?? []),
    ...(skills.soft ?? []),
    ...(skills.technologies ?? []),
    ...(jobAnalysis.technologies ?? []),
    ...(jobAnalysis.protocols ?? []),
    ...(jobAnalysis.methodologies ?? []),
    ...(jobAnalysis.architecturePatterns ?? []),
    ...(jobAnalysis.responsibilities ?? []),
    ...(jobAnalysis.domainKnowledge ?? []),
    ...(jobAnalysis.softSkills ?? []),
    ...(keywords.actionVerbs ?? []),
    ...(keywords.buzzwords ?? []),
    ...(keywords.mustInclude ?? []),
    jobAnalysis.jobMeta?.industry,
    jobAnalysis.jobMeta?.department,
  ];

  const seen = new Set<string>();
  const collected: string[] = [];
  for (const raw of everything) {
    const term = typeof raw === 'string' ? raw.trim() : '';
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    collected.push(term);
  }
  return collected;
}

/**
 * The terms a set of prompt lists does not carry.
 *
 * Compared case-insensitively and on the whole term, which is the same test a
 * keyword scanner applies. A term that appears only as part of a longer phrase
 * is NOT counted as covered: "Kubernetes" inside "Kubernetes operators" is a
 * different string to match on, and treating it as present is how a coverage
 * number flatters itself.
 */
export function findUncoveredKeywords(
  jobKeywords: string[],
  promptLists: string[][]
): string[] {
  const covered = new Set(
    promptLists.flat().map((term) => String(term ?? '').trim().toLowerCase()).filter(Boolean)
  );
  return jobKeywords.filter((term) => !covered.has(term.trim().toLowerCase()));
}
