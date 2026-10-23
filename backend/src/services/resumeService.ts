import type { AiChoice } from '../config/aiPreferences';
import { describeAiChoice } from '../config/aiPreferences';
import { Profile } from '../types/profile';
import type { AIProvider, JobAnalysis, RawNestedJobAnalysis, TailoredContent } from '../types/template';
import { createPromptCompletion, DEFAULT_PROVIDER } from './ai';
import { AIProviderError, isAIProviderError } from './ai/errors';
import {
  analysisCacheKey,
  readAnalysisCache,
  writeAnalysisCache,
} from './ai/analysisCache';
import { resolvePromptByExactId } from './promptService';
import { uniqueCaseInsensitive } from '../utils/array';
import { extractJSON } from '../utils/json';
import { collectJobKeywords, findUncoveredKeywords } from './utils/keywordCoverage';
import { normalizeDashes } from './utils/dashes';
import { headlineWithTargetRole, shortRoleTitle } from './utils/roleTitle';
import {
  containsTerm,
  measurePlacement,
  placementFloor,
  renderedProse,
  renderedSkillBlock,
  type PlacementReport,
} from './utils/placementCoverage';
import {
  MAX_SKILL_BLOCK_SIZE,
  MAX_SKILL_GROUPS,
  bulletsNamingATool,
  findBrokenBullets,
  findGarbledMetrics,
  tidySkillGroups,
  repeatedPhrases,
  isSoftSkillsGroup,
  namesWithInnerCapitals,
  parseSkillEntry,
  belongsInBlock,
  SOFT_SKILLS_GROUP,
} from './utils/resumeQuality';
import {
  DEFAULT_ANALYZE_JOB_PROMPT_ID,
  DEFAULT_COVER_LETTER_PROMPT_ID,
  DEFAULT_RESUME_PROMPT_ID,
} from './profileService';

/**
 * Resume and cover-letter domain logic.
 *
 * Everything about HOW a model is reached now lives in `services/ai`; this
 * module only decides what to ask, and how to read the answer. The `.env` load
 * that used to sit here (with `override: true`, quietly beating the process
 * environment for every importer) belongs to the entry point and lives in
 * index.ts.
 */

const resumeBuildTiming = new WeakMap<JobAnalysis, { firstCallEndedAt: bigint }>();

function formatDuration(start: bigint, end: bigint): string {
  return `${(Number(end - start) / 1_000_000_000).toFixed(2)}s`;
}

function getTailoringSourceText(jobAnalysis?: JobAnalysis): string {
  const directSource = jobAnalysis?.sourceJobDescription?.trim();
  if (directSource) {
    return directSource;
  }

  return [
    getJobAnalysisTitle(jobAnalysis),
    ...getTechnicalSkills(jobAnalysis),
    ...getRequiredSkills(jobAnalysis),
    ...getPreferredSkills(jobAnalysis),
    ...getSkillTools(jobAnalysis),
    ...getTechnologies(jobAnalysis),
    ...getProtocols(jobAnalysis),
    ...getMethodologies(jobAnalysis),
    ...getArchitecturePatterns(jobAnalysis),
    ...getKeywordChecklist(jobAnalysis),
    ...getResponsibilities(jobAnalysis),
    ...getDomainKnowledge(jobAnalysis),
    ...getSoftSkills(jobAnalysis),
  ]
    .filter((value) => value.trim().length > 0)
    .join('\n');
}

function capitalizeFirstCharacter(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

const MAX_ROLE_BRIEF_LENGTH = 900;
/**
 * Appended to the tailor-resume turn.
 *
 * It used to say the opposite: "do not decide, generate, or return skills",
 * because code decided every list from the skill library and overwrote
 * whatever came back. The library is no longer consulted for what a resume
 * prints, so the same slot now carries the instruction the pipeline actually
 * depends on - return the block, grouped - and says plainly that it is printed
 * unchanged. It lives here rather than in the stored prompt so an admin
 * editing the prompt cannot drop the field the renderer reads.
 */
/*
 * THE SOFT-SKILL GROUP HEADING USED TO BE DRAWN HERE, from a list of eight, so
 * that a batch of resumes did not all end their skills block with the words
 * "Professional Skills". The group it headed is gone: the operator asked for no
 * soft skills in the skills block at all - they are unprovable adjectives in a
 * list - so they are shown through the bullets instead, where SOFT SKILLS ARE
 * PROSE already required them. The heading, the draw, the `SOFT_SKILL_HEADING`
 * pin and the `[[softSkillGroupHeading]]` prompt value went with it.
 */

/**
 * What the draft is short of, and the revision that asks for it.
 *
 * WHY IT IS NOT JUST FIGURES ANY MORE. The second call was built for the
 * five-figure floor. A scan of a finished resume then came back at 69% with
 * twenty-two hard skills missing, and they were all the same KIND of term:
 * "Artificial intelligence", "Full-stack development", "Web applications",
 * "Mobile application development", "Personalized learning" - capabilities
 * rather than products. Traced through the pipeline, every one of them reached
 * the prompt, on the concept checklist or the keyword one. Nothing was missing
 * upstream; the model simply did not write them, and only the figure count was
 * enforced, so nothing asked twice.
 *
 * A term the scanner counts and the page does not carry is the cheapest point
 * lost in this whole pipeline: the words cost nothing and there is room.
 *
 * WHAT THE REVISION MAY NOT DO. Invent a domain. A term naming an industry the
 * candidate has not worked in - "clinical documentation" on a banking engineer -
 * stays missing, and the instruction says so, because rule 3 is the one part of
 * this that protects the person whose name is on the page.
 */
type CoverageGap = {
  missingTerms: string[];
  /** The missing terms that are worth a second model call on their own. */
  missingImportant: string[];
  /** Of those, the soft skills, which now have nowhere else to appear. */
  missingSoft: string[];
  /**
   * On the page, in the skills block, and in no sentence.
   *
   * Not missing - that is the point of counting them apart - but worth a line
   * in the log, because the size of this list is the size of the mistake the
   * prose-only measurement used to make.
   */
  inBlockOnly: string[];
  figures: number;
  /** Sentences in the summary as it will print. */
  summarySentences: number;
  short: boolean;
  reason: string;
};

/**
 * How many ordinary terms have to be missing before the call is worth making.
 *
 * MEASURED, not guessed. The first version revised whenever ANYTHING was
 * missing, and with the keyword floor at 100% of a 25-45 term checklist that is
 * nearly every resume: a batch of 500 went from 0.84 hours of working time to
 * 2.21. One stray term is worth a fraction of a point and cost a whole call.
 */
const REVISION_MISSING_FLOOR = 3;

/**
 * And how many missing SOFT skills are worth it, which is fewer.
 *
 * WHY THEY GET THEIR OWN FLOOR. They used to be pooled with everything else, so
 * a resume missing four soft skills and nothing else never bought the call -
 * and since the skills block stopped carrying a group of them, a soft skill
 * that is not in a bullet is not on the resume at all. Measured over the batch
 * that prompted this: soft-skill presence fell from 8.8 terms per resume to
 * 6.8 when the group went, and the bullets picked up less than a third of what
 * the block had been carrying.
 *
 * TWO, NOT ONE, because the call costs money and time - a batch of 500 went
 * from 0.84 hours to 2.21 when an earlier version revised on any single
 * missing term. Most of the resumes this now catches were already being
 * revised for something else, so it is one call either way; what changes is
 * that the call is TOLD about the soft skills.
 */
const SOFT_SKILL_MISSING_FLOOR = 2;

function measureCoverageGap(
  content: TailoredContent,
  jobAnalysis?: JobAnalysis,
  movedConcepts: string[] = []
): CoverageGap {
  const prose = renderedProse(content);
  const wanted = normalizeSkillsList([
    ...getProseChecklist(jobAnalysis),
    ...getSoftSkills(jobAnalysis),
    ...movedConcepts,
  ]);

  /*
   * MISSING MEANS MISSING FROM THE PAGE, not missing from the sentences.
   *
   * This used to ask `renderedProse` alone, and the checklist it asks is not a
   * prose checklist: `getKeywordChecklist` reads the posting's tools,
   * technologies and protocols along with its ideas, so most of what is on it
   * belongs in the skills block and is PUT there, correctly, by the model.
   *
   * MEASURED on a posting naming Azure, GCP, Bash, LLMs and MCP: a draft that
   * had done everything right - every technology in the block, bullets about
   * work - was scored as missing 30 of 30 terms, SIXTEEN of them sitting in its
   * own skills block. That list is what the revision call receives. It is told
   * a bullet may carry two or three of these and that a role may not exceed
   * eight bullets, so the terms genuinely absent - "artificial intelligence",
   * the soft skills, the concepts that have nowhere else to go - were
   * competing for bullet space against sixteen that were already printed.
   *
   * The prose-only number is still measured and still reported, by
   * `reportPlacement`, which answers the different question the prompt's own
   * 90% rule asks: how much of this was written into a sentence.
   */
  const block = renderedSkillBlock(content);
  const missingTerms = wanted.filter(
    (term) => !containsTerm(prose, term) && !containsTerm(block, term)
  );
  const inBlockOnly = wanted.filter(
    (term) => !containsTerm(prose, term) && containsTerm(block, term)
  );
  // Bullets only, matching the floor's own wording: "five measurable results in
  // bullet points". The summary contributes at most one.
  const figures = countFigures({ experience: content.experience });

  /*
   * The terms a missing one of which is worth the call by itself: the five this
   * posting leans on, and the concepts - which is the class a scan reported
   * twenty-two of missing at once. Everything else has to reach a count.
   */
  const important = new Set(
    normalizeSkillsList([...focusSkills(jobAnalysis), ...getConceptKeywords(jobAnalysis)])
      .map((term) => term.toLowerCase())
  );
  const missingImportant = missingTerms.filter((term) => important.has(term.toLowerCase()));

  // The soft skills among them, counted apart: with no group in the skills
  // block, a bullet is the only place they can appear.
  const softWanted = new Set(getSoftSkills(jobAnalysis).map((term) => term.toLowerCase()));
  const missingSoft = missingTerms.filter((term) => softWanted.has(term.toLowerCase()));
  const moved = new Set(movedConcepts.map((term) => term.toLowerCase()));
  const missingMoved = missingTerms.filter((term) => moved.has(term.toLowerCase()));

  const reasons: string[] = [];
  if (missingImportant.length > 0) {
    reasons.push(`${missingImportant.length} of the posting's leading terms missing`);
  }
  if (missingMoved.length > 0) {
    reasons.push(`${missingMoved.length} concept(s) taken out of the skills block and on no line of the page`);
  }
  if (missingSoft.length >= SOFT_SKILL_MISSING_FLOOR) {
    reasons.push(`${missingSoft.length} soft skill(s) missing, which now appear nowhere else`);
  }
  if (missingTerms.length >= REVISION_MISSING_FLOOR) {
    reasons.push(`${missingTerms.length} checklist terms missing`);
  }
  if (figures < FIGURE_FLOOR) {
    reasons.push(`${figures} figure(s) against a floor of ${FIGURE_FLOOR}`);
  }
  // Counted, not a reason for a call by itself: a revision made for another
  // reason is told to fix a one-sentence summary while it is there.
  const summaryCount = summarySentences(content.summary ?? '').length;

  return {
    missingTerms,
    missingImportant,
    missingSoft,
    inBlockOnly,
    figures,
    summarySentences: summaryCount,
    short: reasons.length > 0,
    reason: reasons.join(', '),
  };
}

/** The prompt the revision call uses: its own, short one. */
const RESUME_REVISION_PROMPT_ID = 'revise-resume-coverage';

/**
 * What the revision is sent: the draft's own sentences, and nothing else.
 *
 * Every call here opens a FRESH conversation, so a follow-up has to carry its
 * own context - which is why the first version re-sent the whole tailoring
 * prompt, all 36,853 characters of rules, and asked for the whole resume back.
 * It does not need the rules. It needs the sentences it is rewriting.
 */
/**
 * The revision call's values, exported for the test that renders the prompt.
 *
 * A variable added to the prompt and not to this function fails the whole
 * revision at runtime with "missing runtime values", which is a thing to find
 * in a test rather than in the middle of a batch.
 */
export function buildRevisionPromptValuesForTests(
  content: TailoredContent,
  gap: CoverageGap
): Record<string, string> {
  return revisionPromptValues(content, gap);
}

function revisionPromptValues(content: TailoredContent, gap: CoverageGap): Record<string, string> {
  const draft = {
    summary: content.summary ?? '',
    experience: (content.experience ?? []).map((role) => ({
      company: role.company ?? '',
      title: role.title ?? '',
      achievements: role.achievements ?? [],
    })),
  };

  const figuresNote = gap.figures < FIGURE_FLOOR
    ? `THE DRAFT ALSO NEEDS MORE MEASURABLE RESULTS. Its bullets carry ${gap.figures} and this `
      + `resume needs at least ${FIGURE_FLOOR}: a page under that reads as a list of duties and `
      + `fails a scanner's measurable-results check. Add figures to enough bullets to reach `
      + `${FIGURE_FLOOR}, spread across roles, at most one per bullet. Use the number the work `
      + `itself implies - how many services a change covered, how many engineers a review `
      + `involved, how often a release went out, how long a job took before and after - small, `
      + `ordinary and defensible. Prefer a before-and-after to a lone percentage, and write the `
      + `unit on BOTH ends of one: "from 40 minutes to 6 minutes", never "by 40 minutes to 6". `
      + `The figures in this instruction are examples; every number you write comes from the work `
      + `in the bullet.`
    : 'The draft carries enough measurable results. Do not add more.';

  /*
   * Soft skills, named separately and told where to go.
   *
   * They are in `missingTermsJson` as well, pooled with everything else, and
   * that was not enough: the skills block no longer carries a group of them, so
   * a soft skill that is not in a bullet is not on the resume - and the one
   * instruction most likely to be obeyed is the one that says which words and
   * which sentences.
   */
  const softSkillsNote = gap.missingSoft.length > 0
    ? `SOFT SKILLS STILL MISSING: ${gap.missingSoft.join(', ')}. `
      + `Write each one INSIDE a sentence about work the draft already describes, so the skill is `
      + `visible in the action rather than named after it. NEVER append one after a clause that has `
      + `already finished - no ", applying X", no ", demonstrating X", no ", with attention to detail". `
      + `If a term has nothing in this draft to attach to naturally, leave it out rather than bolting `
      + `it on - a sentence whose last words are a keyword tells a reader exactly how the page was made.`
    : 'The draft carries the soft skills this posting asked for. Do not add more.';

  const summaryNote = gap.summarySentences > 0 && gap.summarySentences < MIN_SUMMARY_SENTENCES
    ? `THE SUMMARY IS ONE SENTENCE, and it must be two or three. Return "summary" rewritten as `
      + `two or three short, plain sentences: split it where it changes subject, keep the candidate's `
      + `years and every term it already carries, and add no new claim.`
    : `The summary is two or three sentences. If you rewrite it, it stays two or three - never one.`;

  return {
    draftJson: promptJson(draft),
    missingTermsJson: promptJson(gap.missingTerms),
    figuresNote,
    softSkillsNote,
    summaryNote,
  };
}

/**
 * The draft with the revision's sentences in it, and nothing else touched.
 *
 * The revision returns only what it changed - the summary, and the roles whose
 * bullets it rewrote - and everything else is taken from the draft this
 * application already holds. That is what keeps the employers, dates, skills
 * block and cover letter safe by construction rather than by instruction: the
 * old shape asked for the whole object back and a model told "do not touch the
 * cover letter" would sometimes return it without one, which sent the route off
 * to write a new letter with a THIRD model call.
 */
function mergeRevision(draft: TailoredContent, patch: unknown): TailoredContent | null {
  if (!patch || typeof patch !== 'object') return null;
  const revision = patch as {
    summary?: unknown;
    experience?: Array<{ company?: unknown; title?: unknown; achievements?: unknown }>;
  };

  const rewritten = Array.isArray(revision.experience) ? revision.experience : [];
  const key = (company: unknown, title: unknown) =>
    `${String(company ?? '').trim().toLowerCase()}|${String(title ?? '').trim().toLowerCase()}`;
  const byRole = new Map<string, string[]>();
  for (const role of rewritten) {
    const bullets = Array.isArray(role.achievements)
      ? role.achievements.filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
      : [];
    if (bullets.length > 0) byRole.set(key(role.company, role.title), bullets);
  }

  const summary = typeof revision.summary === 'string' && revision.summary.trim()
    ? revision.summary.trim()
    : draft.summary;
  if (summary === draft.summary && byRole.size === 0) return null;

  return {
    ...draft,
    summary,
    experience: (draft.experience ?? []).map((role) => {
      const bullets = byRole.get(key(role.company, role.title));
      return bullets ? { ...role, achievements: bullets } : role;
    }),
  };
}

/** Off switch for the revision call, for an operator watching the bill. */
function coverageRevisionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // The old name still works: it was the figures-only switch before this was
  // generalised, and an operator may have it set.
  return !env.RESUME_REVISION_OFF && !env.RESUME_METRIC_RETRY_OFF;
}

/**
 * Does a revision call that FAILED take the build down with it?
 *
 * YES, AND THE REPORT THAT CHANGED IT: "even when the account browsers didn't
 * respond after receiving prompt, our program finished generating resumes
 * saying 5 out of 5 generated successfully." They had. The draft was complete,
 * a PDF was written, and the only trace of a browser that took the prompt and
 * never answered was a console warning nobody was reading.
 *
 * A failed call is now a failed build, which puts it through `withUnitRetry`
 * like any other transient browser fault - a retry re-enters the tab pool and
 * takes whichever browser is free, which is the whole reason a retry has a
 * chance of going differently. A revision correctly REJECTED for being no
 * better is untouched by this: the model answered, the answer was judged, and
 * the draft standing is the right outcome rather than a failure.
 *
 * THE WAY BACK, because this can turn a batch that was shipping into a batch
 * that fails: set RESUME_REVISION_SOFT_FAIL to keep the old behaviour, or
 * RESUME_REVISION_OFF to stop making the call at all.
 */
function coverageRevisionFailureIsFatal(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.RESUME_REVISION_SOFT_FAIL;
}

/**
 * The same failure, said in a way that names the stage it happened at.
 *
 * REBUILT RATHER THAN WRAPPED IN A PLAIN ERROR, because `isRetryableFailure`
 * reads `retryable` off an AIProviderError and that flag is derived from the
 * KIND. Carrying the kind across carries the decision: `auth`, `disabled`,
 * `locked` and `binaryMissing` still say "do not try again", and a timeout
 * still says "do".
 */
function asRevisionFailure(error: unknown, stage = 'coverage revision'): unknown {
  if (!isAIProviderError(error)) return error;
  return new AIProviderError({
    provider: error.provider,
    kind: error.kind,
    detail: `${stage}: ${error.detail ?? error.message}`,
    adminAction: error.adminAction,
    retryAfterSeconds: error.retryAfterSeconds,
    cause: error,
  });
}

/** The skills check: turns concepts in the block into tools, before the coverage check. */
const SKILL_CHECK_PROMPT_ID = 'check-skills';
/** An answer with fewer tools than this is treated as broken, and the draft's block stands. */
const MIN_CHECKED_SKILLS = 10;

function skillCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.RESUME_SKILL_CHECK_OFF;
}

type SkillGroupNames = Array<{ category: string; skills: string[] }>;

function skillCheckPromptValues(
  technical: SkillGroupNames,
  draft: Record<string, unknown>,
  jobAnalysis: JobAnalysis
): Record<string, string> {
  const roles = (Array.isArray(draft.experience) ? draft.experience : []).map((role) => {
    const r = (role ?? {}) as Record<string, unknown>;
    return {
      title: r.title ?? '',
      company: r.company ?? '',
      startDate: r.startDate ?? '',
      endDate: r.endDate ?? '',
      achievements: Array.isArray(r.achievements) ? r.achievements : [],
    };
  });
  return {
    skillGroupsJson: promptJson(technical),
    rolesJson: promptJson(roles),
    postingToolsJson: promptJson(getJobNamedHardSkills(jobAnalysis)),
  };
}

/** Exported for the test that checks how an answer is applied to the block. */
export function applySkillCheckForTests(
  technical: SkillGroupNames,
  answer: unknown,
  postingTools: string[]
): { groups: SkillGroupNames; concepts: string[]; keepCase: string[] } | null {
  return applySkillCheck(technical, answer, postingTools);
}

/** Exported for the test that renders the prompt with the values the run uses. */
export function buildSkillCheckPromptValuesForTests(
  technical: SkillGroupNames,
  draft: Record<string, unknown>,
  jobAnalysis: JobAnalysis
): Record<string, string> {
  return skillCheckPromptValues(technical, draft, jobAnalysis);
}

/**
 * Applies the check's answer to the block: each concept is replaced in place by
 * its tools, tools are renamed or removed as asked, and additions join the
 * heading they name. A name the posting gives is never removed, renamed to
 * another name, or treated as a concept.
 * Returns null when the answer is unusable, so the draft's block stands.
 */
function applySkillCheck(
  technical: SkillGroupNames,
  answer: unknown,
  postingTools: string[]
): { groups: SkillGroupNames; concepts: string[]; keepCase: string[] } | null {
  if (!answer || typeof answer !== 'object') return null;
  const record = answer as { concepts?: unknown; rename?: unknown; remove?: unknown; additions?: unknown };
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const key = (value: string) => value.trim().toLowerCase();

  const posting = new Set(postingTools.map(key));
  const conceptRows = new Map<string, { tools: string[]; bullet: boolean }>();
  for (const row of list(record.concepts)) {
    const r = (row ?? {}) as { entry?: unknown; tools?: unknown; bullet?: unknown };
    const entry = text(r.entry);
    if (!entry || posting.has(key(entry))) continue;
    conceptRows.set(key(entry), { tools: list(r.tools).map(text).filter(Boolean), bullet: r.bullet !== false });
  }
  // The posting's own names are never removed, and renamed only to fix their
  // capitals: the posting's spelling is the one a scanner looks for.
  const renames = new Map<string, string>();
  for (const row of list(record.rename)) {
    const r = (row ?? {}) as { entry?: unknown; name?: unknown };
    const entry = text(r.entry);
    const name = text(r.name);
    if (!entry || !name) continue;
    if (posting.has(key(entry)) && key(name) !== key(entry)) continue;
    renames.set(key(entry), name);
  }
  const removals = new Set(
    list(record.remove).map(text).filter(Boolean).map(key).filter((entry) => !posting.has(entry))
  );
  // Names whose official form starts in lower case, in the model's spelling.
  const lowercase = new Map(
    list((record as { lowercase?: unknown }).lowercase).map(text).filter(Boolean).map((name) => [key(name), name] as const)
  );

  const concepts: string[] = [];
  const groups = technical.map((group) => {
    const skills: string[] = [];
    for (const entry of group.skills) {
      const concept = conceptRows.get(key(entry));
      if (concept) {
        skills.push(...concept.tools);
        if (concept.bullet) concepts.push(entry);
      } else if (!removals.has(key(entry))) {
        skills.push(renames.get(key(entry)) ?? entry);
      }
    }
    return { category: group.category, skills };
  });

  for (const row of list(record.additions)) {
    const r = (row ?? {}) as { name?: unknown; group?: unknown };
    const name = text(r.name);
    const category = text(r.group);
    if (!name || !category || isSoftSkillsGroup(category)) continue;
    const target = groups.find((group) => key(group.category) === key(category));
    if (target) target.skills.push(name);
    else groups.push({ category, skills: [name] });
  }

  const kept = groups
    .map((group) => ({
      category: group.category,
      skills: normalizeSkillsList(group.skills.map((name) => lowercase.get(key(name)) ?? name)),
    }))
    .filter((group) => group.skills.length > 0);
  const total = kept.reduce((n, group) => n + group.skills.length, 0);
  if (total < MIN_CHECKED_SKILLS) return null;
  const keepCase = kept.flatMap((group) => group.skills).filter((name) => lowercase.has(key(name)));
  return { groups: kept, concepts, keepCase };
}

/**
 * Has the model check the draft's technical skills block: every entry that is
 * not a real tool is replaced by the tools that work is done with, and handed
 * back as a concept for the bullets. The Soft Skills group is not sent and is
 * kept as written. Returns the draft text with the checked block in it.
 */
async function checkSkillBlock(
  draftText: string,
  profile: Profile,
  jobAnalysis: JobAnalysis,
  choice: AiChoice,
  signal?: AbortSignal
): Promise<{ text: string; concepts: string[] }> {
  const unchanged = { text: draftText, concepts: [] as string[] };
  if (!skillCheckEnabled()) return unchanged;

  let draft: Record<string, unknown>;
  try {
    draft = JSON.parse(extractJSON(draftText));
  } catch {
    return unchanged;
  }

  /*
   * THE WRITING CALL'S LABELS SURVIVE THE CHECK. An entry it labelled practice,
   * concept, domain or category is held back and put back afterwards, so the
   * tidy-up still takes it out of the block by that label - the check used to
   * be sent everything and hand every survivor back as a "tool", which is how
   * "General Ledger" and "Month-End Close" reached a printed block. An entry the
   * check keeps keeps the kind it arrived with.
   */
  const soft: unknown[] = [];
  const technical: SkillGroupNames = [];
  const heldBack: Array<{ category: string; skills: unknown[] }> = [];
  const kindOf = new Map<string, string>();
  for (const group of Array.isArray(draft.skillGroups) ? draft.skillGroups : []) {
    const g = (group ?? {}) as { category?: unknown; skills?: unknown };
    const category = String(g.category ?? '').trim();
    const entries = Array.isArray(g.skills) ? g.skills : [];
    if (isSoftSkillsGroup(category)) {
      soft.push(...entries);
      continue;
    }
    const names: string[] = [];
    const held: unknown[] = [];
    for (const raw of entries) {
      const entry = parseSkillEntry(raw);
      if (!entry) continue;
      if (entry.kind === 'soft') soft.push(raw);
      else if (!belongsInBlock(entry)) held.push(raw);
      else {
        names.push(entry.name);
        kindOf.set(entry.name.toLowerCase(), entry.kind);
      }
    }
    if (category && names.length > 0) technical.push({ category, skills: names });
    if (category && held.length > 0) heldBack.push({ category, skills: held });
  }
  if (technical.length === 0) return unchanged;

  const startedAt = process.hrtime.bigint();
  const postingTools = getJobNamedHardSkills(jobAnalysis);
  try {
    const answer = await createPromptCompletion({
      promptId: SKILL_CHECK_PROMPT_ID,
      callSite: SKILL_CHECK_PROMPT_ID,
      promptValues: skillCheckPromptValues(technical, draft, jobAnalysis),
      fallbackProvider: choice.provider,
      fallbackModelName: choice.modelName,
      effort: choice.effort,
      thinking: choice.thinking,
      route: choice.route,
      maxTokens: 2500,
      temperature: 0.2,
      responseFormat: 'json',
      useExactPromptId: true,
      signal,
    });
    const checked = applySkillCheck(technical, JSON.parse(extractJSON(answer)), postingTools);
    if (!checked) {
      console.warn(`[Resume skills check] ${profile.name}: the answer held too few tools to use. Keeping the draft's block.`);
      return unchanged;
    }

    const before = technical.reduce((n, group) => n + group.skills.length, 0);
    const after = checked.groups.reduce((n, group) => n + group.skills.length, 0);
    console.log(
      `[Resume skills check] ${profile.name}: ${before} entries checked in `
        + `${formatDuration(startedAt, process.hrtime.bigint())}, ${after} tools kept or added; `
        + `${checked.concepts.length} concept(s) moved to the prose`
        + `${checked.concepts.length > 0 ? ` - ${checked.concepts.slice(0, 6).join(', ')}${checked.concepts.length > 6 ? ', ...' : ''}` : ''}.`
    );

    const technicalGroups: Array<{ category: string; skills: unknown[] }> = checked.groups.map((group) => ({
      category: group.category,
      skills: group.skills.map((name) => ({
        name,
        kind: kindOf.get(name.toLowerCase()) ?? 'tool',
        ...(checked.keepCase.includes(name) ? { keepCase: true } : {}),
      })),
    }));
    for (const held of heldBack) {
      const home = technicalGroups.find((group) => group.category.toLowerCase() === held.category.toLowerCase());
      if (home) home.skills.push(...held.skills);
      else technicalGroups.push(held);
    }
    const skillGroups = [
      ...technicalGroups,
      ...(soft.length > 0 ? [{ category: SOFT_SKILLS_GROUP, skills: soft }] : []),
    ];
    return { text: JSON.stringify({ ...draft, skillGroups }), concepts: checked.concepts };
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    if (coverageRevisionFailureIsFatal()) {
      console.warn(
        `[Resume skills check] ${profile.name}: the call failed (${said}). Failing the build so it is retried. `
          + `Set RESUME_REVISION_SOFT_FAIL to keep the draft's block instead.`
      );
      throw asRevisionFailure(error, 'skills check');
    }
    console.warn(`[Resume skills check] ${profile.name}: the call failed (${said}). Keeping the draft's block.`);
    return unchanged;
  }
}

/**
 * The skills-block instruction an admin cannot edit away.
 *
 * Appended to the user body on every call, which makes it the LAST thing the
 * model reads and the most salient - so it has to agree with the prompt word
 * for word. It did not: while the prompt was being changed to ban soft skills
 * from the block, this still said "the last group headed X and holding this
 * posting's own soft-skill words spelled as it spells them", and being last it
 * would have won. A rule in two places is a rule that disagrees with itself
 * sooner or later; both are changed together or neither is.
 *
 * It no longer takes a heading, because there is no soft-skill group to head.
 */
const finalSkillOverride = () => `FINAL SKILL OVERRIDE:
Return "skillGroups": an array of { "category": string, "skills": [{ "name": string, "kind": string }] }, 5-7 groups, 5-9 skills each and never fewer than five in a group, ordered as you want them read, and then ONE MORE GROUP, last, headed exactly "Soft Skills". EVERY ENTRY CARRIES ITS KIND: language, framework, library, tool, platform, database, protocol, methodology or technology belong in the technical groups; practice, concept, domain and category are taken out of the block before printing, whoever wrote them, so write those into a bullet first and label them honestly rather than mislabelling them to keep them; soft goes in the Soft Skills group. An entry whose kind you cannot name is not a thing and does not go in. The FIRST group is "Languages & Frameworks" and it is required on every resume - the languages this candidate writes and the frameworks they build with - because it is the first thing a technical reader looks for. REAL TOOLS ONLY in the technical groups: concrete tools, languages, frameworks, platforms and named technologies. NO soft skills in the technical groups - not "Ownership", "Communication", "Collaboration", "Mentoring", nor any other; they go in the Soft Skills group - and no category words such as "Cloud", "Infrastructure", "Platforms", "Systems", "Data", "Tools" or "Technologies": a category word leaves the block when you label it honestly, kind category, and is PRINTED when you label it a tool, because the label is the only thing read. No entry of three or more words unless it is a proper name with its capitals, and no entry joining two things with "and". NO CONCEPTS OR PRACTICES - write the TOOL the work was done with instead: the monitoring tool the candidate used, not "Observability". An entry goes if its last word names an activity (engineering, optimization, automation, orchestration, monitoring, planning, tracking, modeling, validation, testing, design, deployment, integration, implementation, operations) or if it is two or more words with no capital letter in it, WHOEVER WROTE IT: a phrase the posting wrote goes in an experience bullet, spelled as the posting spells it - it is moved, not dropped, and the application checks that it arrived. A named technology stays when it is labelled technology, in ONE form: "CI/CD", "APIs", "REST", "LLMs", "RAG". No past-tense verb as a skill. One entry per real thing: where one entry's words are all inside another's, write the shorter, and never stack near-synonyms - "Snowflake", "Snowflake Cortex" and "Snowflake Cortex AI" is one family written three ways, so keep one, or two where they are genuinely distinct tools. An abbreviation and its expansion are one thing, never two entries: "RAG" or "Retrieval-Augmented Generation", "LLMs" or "Large Language Models" - keep the form the posting leads with and write the other in a bullet; the application deletes the second one it finds. Count the skills before returning: AT LEAST 35 in total - thirty-five is a floor, and five groups need seven entries each, six need six, seven need five - never more than 45, and anything past 45 is deleted from the end of the longest group. The Soft Skills group is not counted in any of that. Reach thirty-five with real tools only, by naming the stack one layer at a time - never by writing one thing several ways, adding a phrase, or copying a tool from an example in the prompt: name the cloud PLATFORM this posting names and then the services the candidate's work used, because the platform's own name is what a scanner searches for and a block listing only services matches none of them. Never create a group the candidate's real tools cannot fill, and never fill a group with entries that belong under another heading. Infer what the described work could not have been done without, never a tool from an industry they have not worked in; a competitor beside the tool they used is allowed WHEN THIS POSTING NAMES IT, and left out when the posting is silent. If thirty-five would need a line nobody could be asked about, return what is true and stop short - fill up from the technologies this posting names and the ones the candidate's own roles imply, so the block answers the posting without reading as a copy of it. A tool is not gated by the profile; a DOMAIN is - nothing from an industry this candidate has not worked in. Beyond those removals it is printed as returned - nothing reorders it, renames a group or tops it up, and the only merge is that the two smallest headings are joined, both names kept, when you send more than seven groups - so no duplicates of one product, no concepts, no invented versions. Never invent an employer, a title or a date. THE SOFT SKILLS GROUP holds 5-8 soft skills THIS posting asks for that the candidate's work shows, each labelled kind soft and written as a plain skill name in title case ("Stakeholder Management", "Mentoring") - chosen for this posting, never a slogan or culture phrase, never a technology. Do NOT return "softSkills" as a separate field. Never bolt a soft skill onto the end of a finished sentence - no ", applying X", no ", demonstrating X", no ", with attention to detail". Category labels must be plain and conventional - "Languages & Frameworks", "Cloud & Infrastructure", "Data & Storage", "CI/CD & Automation", "Testing", "Monitoring", "Databases", "ML & AI" - never marketing copy like "Research to Production", "Delivery Quality", "State, Behavior & Reliability", "Intelligence Layer". Every entry must belong under its heading: "RAG", "Vector Search" and "Semantic Search" under "Testing" is a failed check - move each entry to the group it belongs in, or rename the heading to describe what is honestly inside it. CAPITALISE every word of every skill entry - "Vector Databases", "Spring Boot" - and keep the maker's casing inside a word: PyTorch, not "Pytorch". The one exception is a name its makers write in lower case - "dbt", "pytest", "iOS", "eBPF" - which is written exactly that way. Judge by the product's name, not the package you import: numpy, scipy, networkx and openapi are import names, and the products are NumPy, SciPy, NetworkX and OpenAPI. A bullet naming the same tool writes it the same way. If a keyword is not a named tool or technology, do NOT force it into the skills block - place it in an experience bullet instead: "pull-request review automation", "staged rollout management", "drift monitoring", "evaluation methods", "audit evidence", "human review" are process descriptions, not skills. Do not restate the group heading as an entry: "CI/CD" in the "CI/CD & Automation" group is the heading repeated; write the TOOLS instead. Omit "skills" and "hardSkills": those flat lists are derived from skillGroups.`;

function normalizeSkillsList(skills: string[] | undefined): string[] {
  if (!Array.isArray(skills)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const raw of skills) {
    if (typeof raw !== 'string') continue;
    const skill = raw.trim();
    if (!skill) continue;
    const key = skill.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(skill);
  }

  return normalized;
}

const JOB_POSTING_PERSPECTIVE_PATTERN =
  /\b(?:we|our|ours|ourselves|you|your|yours|yourself|yourselves)\b/i;
const JOB_POSTING_RECRUITING_PATTERN =
  /\b(?:join us|help us|you will|you'll|you are|you would|the ideal candidate|successful candidate|next generation|break ground|ground-breaking)\b/i;
const RESUME_META_TAILORING_PATTERN =
  /\b(?:this background maps to|background maps to|maps to|mapped to|aligns with|aligned with|target role|target job|job description|job posting|ats|keyword coverage|required skills|key responsibilities|for this specific role|for this role)\b/i;
const IMPERATIVE_RESPONSIBILITY_VERBS = new Set([
  'build',
  'create',
  'develop',
  'design',
  'implement',
  'lead',
  'own',
  'manage',
  'drive',
  'deliver',
  'enable',
  'collaborate',
  'partner',
  'support',
  'improve',
  'optimize',
  'architect',
]);

function normalizeJobAnalysisPhrase(value: string): string {
  return value
    .replace(/^[\s\-*]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[;:,\s]+$/, '')
    .trim();
}

function isUnsafeJobPostingPhrase(value: string): boolean {
  const normalized = normalizeJobAnalysisPhrase(value);
  if (!normalized) return true;
  return (
    JOB_POSTING_PERSPECTIVE_PATTERN.test(normalized) ||
    JOB_POSTING_RECRUITING_PATTERN.test(normalized) ||
    RESUME_META_TAILORING_PATTERN.test(normalized)
  );
}

function neutralizeResponsibilityPhrase(value: string): string {
  const normalized = normalizeJobAnalysisPhrase(value).replace(/\.$/, '');
  if (!normalized || isUnsafeJobPostingPhrase(normalized)) return '';

  const words = normalized.split(/\s+/);
  const first = words[0]?.toLowerCase();
  if (first && IMPERATIVE_RESPONSIBILITY_VERBS.has(first) && words.length > 1) {
    return `${words.slice(1).join(' ')} delivery`;
  }

  return normalized;
}

function normalizeSafeKeywordList(values: string[]): string[] {
  return normalizeSkillsList(values)
    .map(normalizeJobAnalysisPhrase)
    .filter((item) => item && !isUnsafeJobPostingPhrase(item));
}

function normalizeSafeResponsibilityList(values: string[]): string[] {
  return normalizeSkillsList(values)
    .map(neutralizeResponsibilityPhrase)
    .filter(Boolean);
}


function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function normalizeJobAnalysisResponse(
  parsed: RawNestedJobAnalysis,
  jobDescription: string
): JobAnalysis {
  // const inferredSoft = inferAtsSoftSkillsFromText(jobDescription);
  // const inferredHard = inferHardSkillsFromText(jobDescription);

  const technical = normalizeSafeKeywordList([
    ...toStringList(parsed.skills?.technical),
    ...toStringList(parsed.skills?.required),
  ]);
  const required = normalizeSkillsList([
    ...technical,
    // ...inferredHard,
  ]);
  const preferred = normalizeSkillsList([
    ...toStringList(parsed.skills?.preferred),
  ]);
  const tools = normalizeSkillsList(toStringList(parsed.skills?.tools));
  const soft = normalizeSkillsList([
    ...toStringList(parsed.skills?.soft),
    ...toStringList(parsed.softSkills),
  ]);
  const technologies = normalizeSafeKeywordList([
    ...toStringList(parsed.technologies),
    ...toStringList(parsed.skills?.technologies),
  ]);
  const protocols = normalizeSafeKeywordList(toStringList(parsed.protocols));
  const methodologies = normalizeSafeKeywordList(toStringList(parsed.methodologies));
  const architecturePatterns = normalizeSafeKeywordList(toStringList(parsed.architecturePatterns));
  const responsibilities = normalizeSafeResponsibilityList([
    ...toStringList(parsed.responsibilities),
  ]);
  const domainKnowledge = normalizeSafeKeywordList([
    ...toStringList(parsed.domainKnowledge),
  ]);
  const keywordGroups = parsed.keywords && typeof parsed.keywords === 'object' && !Array.isArray(parsed.keywords)
    ? parsed.keywords as Record<string, unknown>
    : {};

  return {
    jobMeta: {
      title: asString(parsed.jobMeta?.title) || asString(parsed.jobMeta?.title),
      seniority: asString(parsed.jobMeta?.seniority),
      industry: asString(parsed.jobMeta?.industry),
      department: asString(parsed.jobMeta?.department),
    },
    skills: {
      technical,
      required,
      preferred,
      tools,
      soft,
      technologies,
    },
    technologies,
    protocols,
    methodologies,
    architecturePatterns,
    responsibilities,
    domainKnowledge,
    softSkills: soft,
    keywords: {
      actionVerbs: normalizeSafeKeywordList(toStringList(keywordGroups.actionVerbs)),
      buzzwords: normalizeSafeKeywordList(toStringList(keywordGroups.buzzwords)),
      mustInclude: normalizeSafeKeywordList([
        ...toStringList(keywordGroups.mustInclude),
      ]),
    },
    sourceJobDescription: jobDescription.trim(),
  };
}

function getJobAnalysisTitle(jobAnalysis?: JobAnalysis): string {
  return jobAnalysis?.jobMeta?.title?.trim() ?? '';
}

function getTechnicalSkills(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.skills?.technical);
}

function getRequiredSkills(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    ...(jobAnalysis?.skills?.required ?? []),
    ...getTechnicalSkills(jobAnalysis),
  ]);
}

function getPreferredSkills(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.skills?.preferred);
}

function getSkillTools(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.skills?.tools);
}

function getTechnologies(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    ...(jobAnalysis?.technologies ?? []),
    ...(jobAnalysis?.skills?.technologies ?? []),
  ]);
}

function getProtocols(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.protocols);
}

function getMethodologies(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.methodologies);
}

function getArchitecturePatterns(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.architecturePatterns);
}

function getResponsibilities(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.responsibilities);
}

function getDomainKnowledge(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.domainKnowledge);
}

function getSoftSkills(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    ...(jobAnalysis?.softSkills ?? []),
    ...(jobAnalysis?.skills?.soft ?? []),
  ]);
}

function getIndustryTerms(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    jobAnalysis?.jobMeta?.industry ?? '',
    jobAnalysis?.jobMeta?.department ?? '',
    ...getDomainKnowledge(jobAnalysis),
  ]);
}

/**
 * Every term the job named that the resume is scored on.
 *
 * `skills.technical` belongs here and was the one field missing from it. The
 * analyser is asked for 15-25 entries there - it is the LARGEST field it
 * produces - and they are the abilities a scanner looks for by name:
 * "Full-stack engineering", "Network operations", "Web development",
 * "Data processing systems". Every other field reached this list in full;
 * technical reached it not at all, so those terms were invisible to the 80%
 * coverage floor and simply never written.
 *
 * This is a PROSE checklist. Nothing here is a candidate for the Technical
 * Skills block - that list is built separately, from the library and from the
 * analyser's named-tool fields - and an ability is not a skill you can list.
 */
function getKeywordChecklist(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    ...(jobAnalysis?.keywords?.actionVerbs ?? []),
    ...(jobAnalysis?.keywords?.buzzwords ?? []),
    ...(jobAnalysis?.keywords?.mustInclude ?? []),
    ...getTechnicalSkills(jobAnalysis),
    // Required and preferred were the two fields missing from this list, and
    // the omission was invisible: both reach the Technical Skills SELECTION, so
    // anything the library carries came out fine, and only a term the library
    // had never heard of - a preferred technology like ArgoCD - was extracted
    // from the posting and then written nowhere at all.
    ...getRequiredSkills(jobAnalysis),
    ...getPreferredSkills(jobAnalysis),
    ...getSoftSkills(jobAnalysis),
    ...getSkillTools(jobAnalysis),
    ...getTechnologies(jobAnalysis),
    ...getProtocols(jobAnalysis),
    ...getMethodologies(jobAnalysis),
    ...getArchitecturePatterns(jobAnalysis),
    ...getDomainKnowledge(jobAnalysis),
  ]);
}

/**
 * The five skills this posting is actually about.
 *
 * WHY FIVE, AND WHY THESE. A posting names thirty things and means five of
 * them: the ones in the requirements, named first, repeated in the
 * responsibilities. A scanner weights those highest and a reader looks for
 * nothing else, so the prompt is told which five to build the bullets around
 * rather than being left to spread its attention evenly over a list of thirty.
 *
 * Required before preferred before merely mentioned, in the posting's own
 * order, because that order is the employer's own ranking. Anything that is not
 * a technology - an ability, a practice, a soft skill - is left out: those have
 * their own checklists, and a bullet cannot be built around "collaboration" the
 * way it can be built around Kubernetes.
 */
export function focusSkills(jobAnalysis?: JobAnalysis, limit = 5): string[] {
  const named = new Set(getJobNamedHardSkills(jobAnalysis).map((skill) => skill.toLowerCase()));
  const ordered = normalizeSkillsList([
    ...(jobAnalysis?.skills?.required ?? []),
    ...getJobNamedHardSkills(jobAnalysis),
    ...(jobAnalysis?.skills?.preferred ?? []),
  ]);

  const chosen: string[] = [];
  for (const skill of ordered) {
    // A technology, not an ability: the named list is the technologies this
    // posting spelled out, and a required entry counts when it is one of them.
    if (!named.has(skill.toLowerCase())) continue;
    chosen.push(skill);
    if (chosen.length === limit) break;
  }
  return chosen;
}

/**
 * The technologies the JOB ITSELF named: the analyser's tools, technologies,
 * protocols and methodologies, the four fields its prompt defines as named
 * things ("MLOps", "Scrum" and "CI/CD" are methodologies there, and a practice
 * with no name goes in skills.technical). Nothing is matched against a list
 * here - deciding which words in a posting are names is the analyser's job.
 */
function getJobNamedHardSkills(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    ...getSkillTools(jobAnalysis),
    ...getTechnologies(jobAnalysis),
    ...getProtocols(jobAnalysis),
    ...getMethodologies(jobAnalysis),
  ]);
}

/**
 * The job's concept terms: the analysis fields that hold ideas by definition.
 *
 * `skills.technical` is "technical abilities NOT tied to a specific named
 * tool" and `architecturePatterns` is "high-level structural and system design
 * patterns" - both are ideas, so both are prose targets, never block entries.
 * Anything the posting also named as a tool is left out, so a term is asked for
 * once. Decided by the analyser's own fields, not by a list of words in code.
 */
function getConceptKeywords(jobAnalysis?: JobAnalysis): string[] {
  const named = new Set(getJobNamedHardSkills(jobAnalysis).map((term) => term.toLowerCase()));
  return normalizeSkillsList([
    ...getTechnicalSkills(jobAnalysis),
    ...getArchitecturePatterns(jobAnalysis),
  ]).filter((term) => !named.has(term.toLowerCase()));
}

/**
 * The prose targets, as the prompt received them.
 *
 * Built from the same two functions that fill `keywordsJson` and
 * `conceptKeywordsJson`, so the thing being measured is the thing that was
 * asked for. Anything else would produce a number that looks like coverage and
 * answers a different question.
 */
/** At most this many bullets under one role, whatever the model returns. */
/**
 * ASKED FOR: "2-3 sentences in the summary section, at least 2", and no word
 * limit. The 50-word cap is gone: it was what cut two-sentence summaries down
 * to one, by dropping whole sentences from the end to get under it.
 */
export const MIN_SUMMARY_SENTENCES = 2;
export const MAX_SUMMARY_SENTENCES = 3;

/**
 * The summary's sentences, with their punctuation.
 *
 * A boundary is a stop, then a space, then a capital or a digit, so "Node.js",
 * "9.5 years" and "ASP.NET" are not sentence ends. The old splitter treated a
 * stop inside a word as a failed match and silently skipped the text before it.
 */
export function summarySentences(summary: string): string[] {
  const trimmed = String(summary ?? '').trim();
  if (!trimmed) return [];
  return trimmed
    .split(/(?<=[.!?])\s+(?=["'(\u201c]?[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * Holds a summary to three sentences by dropping whole sentences after the third.
 *
 * Never mid-sentence: a paragraph cut mid-clause is the first thing anybody
 * sees on the page. A one-sentence summary is left as it is and reported -
 * making two sentences of one is the prompt's job, not this file's.
 */
export function capSummarySentences(summary: string): { summary: string; dropped: number; sentences: number } {
  const trimmed = String(summary ?? '').trim();
  const sentences = summarySentences(trimmed);
  if (sentences.length <= MAX_SUMMARY_SENTENCES) {
    return { summary: trimmed, dropped: 0, sentences: sentences.length };
  }
  const kept = sentences.slice(0, MAX_SUMMARY_SENTENCES);
  return { summary: kept.join(' '), dropped: sentences.length - kept.length, sentences: kept.length };
}

const MAX_BULLETS_PER_ROLE = 8;

/**
 * The cap, which an operator can move without editing the source.
 */
function bulletCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.RESUME_MAX_BULLETS || '', 10);
  if (!Number.isFinite(raw) || raw < 1) return MAX_BULLETS_PER_ROLE;
  return raw;
}

/**
 * Which bullets survive the cap.
 *
 * WHY NOT THE FIRST EIGHT. A role came back with twenty-two bullets - the
 * prompt has said "maximum 8" throughout, and the model wrote twenty-two - and
 * the fourteen that had to go were carrying keywords: taking the first eight
 * would have dropped whichever terms the model happened to put late, including
 * the ones that appear nowhere else on the page. The resume is a keyword
 * document and this is a keyword decision.
 *
 * So the eight are chosen for COVERAGE. Repeatedly take the bullet that adds
 * the most checklist terms nothing kept so far has; break ties towards a bullet
 * carrying a figure, because the page needs five of those, and then towards the
 * order the model wrote them in. When the terms run out, the earliest bullets
 * left fill the remaining slots, and the survivors are printed in the model's
 * own order rather than in the order they were picked.
 *
 * Nothing is rewritten: a kept bullet is the model's sentence, untouched.
 */
function chooseBullets(bullets: string[], cap: number, jobAnalysis?: JobAnalysis): string[] {
  if (bullets.length <= cap) return bullets;

  const terms = normalizeSkillsList([
    ...focusSkills(jobAnalysis, 8),
    ...getProseChecklist(jobAnalysis),
  ]);
  const covered = new Set<string>();
  const kept = new Set<number>();

  const termsIn = (bullet: string) => terms.filter((term) => containsTerm(bullet, term));
  const hasFigure = (bullet: string) => countFigures({ experience: [{ achievements: [bullet] }] }) > 0;

  while (kept.size < cap) {
    let best = -1;
    let bestScore = -1;
    for (let index = 0; index < bullets.length; index += 1) {
      if (kept.has(index)) continue;
      const adds = termsIn(bullets[index]).filter((term) => !covered.has(term.toLowerCase())).length;
      // A figure is worth less than a keyword and more than a tie.
      const score = adds * 2 + (hasFigure(bullets[index]) ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    }
    if (best === -1) break;
    kept.add(best);
    for (const term of termsIn(bullets[best])) covered.add(term.toLowerCase());
  }

  return bullets.filter((_bullet, index) => kept.has(index));
}

function getProseChecklist(jobAnalysis?: JobAnalysis): string[] {
  if (!jobAnalysis) return [];
  return normalizeSkillsList([...getKeywordChecklist(jobAnalysis), ...getConceptKeywords(jobAnalysis)]);
}

/**
 * Says how much of the checklist the finished resume carries.
 *
 * Logged rather than enforced. The model has already answered by the time this
 * runs, and throwing away a resume that placed 84% of the terms in exchange for
 * nothing is worse than shipping it with the number written down - the operator
 * can see the figure, and a run whose average sits below the floor is a prompt
 * problem rather than a per-resume one.
 */
/**
 * Bullets whose verb says the same word as their noun.
 *
 * "Automated model training workflow automation", "Evaluated ML model
 * evaluation results", "Experimented with ML technology experimentation",
 * "Optimized AI agent optimization experiments" - four bullets from one
 * delivered resume. It is the model wedging a checklist phrase into a sentence
 * whose verb already says it, and on the page it is the clearest possible tell
 * that nobody wrote this.
 *
 * The prompt now bans it and offers rewrites. This counts it, because a writing
 * rule nobody counts is a writing rule that quietly stops holding.
 *
 * The test is crude on purpose: take the opening verb, cut the inflection off
 * it, and see whether the same stem turns up again later in the same sentence.
 * Five letters of stem, so "built"/"build" and "ran"/"run" cannot collide with
 * anything by accident.
 */
export function echoingBullets(bullets: readonly string[]): string[] {
  const echoes: string[] = [];

  for (const bullet of bullets) {
    const opening = /^[\s\-•]*([A-Za-z]+)/.exec(bullet);
    if (!opening) continue;
    const stem = opening[1].toLowerCase().replace(/(?:ed|ing|s)$/, '');
    if (stem.length < 5) continue;
    const rest = bullet.slice(opening[0].length);
    if (new RegExp(`\\b${stem}`, 'i').test(rest)) echoes.push(bullet);
  }

  return echoes;
}

/** Roles where two bullets open with the same verb. */
function repeatedOpeners(bullets: readonly string[]): string[] {
  const seen = new Map<string, number>();
  for (const bullet of bullets) {
    const opening = /^[\s\-•]*([A-Za-z]+)/.exec(bullet);
    if (!opening) continue;
    const verb = opening[1].toLowerCase();
    seen.set(verb, (seen.get(verb) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([verb]) => verb);
}

/** Says whether the bullets read like sentences or like slots. */
function reportBulletVoice(
  profileName: string,
  content: { experience?: Array<{ company?: string; achievements?: string[] }> }
): void {
  const roles = content.experience ?? [];
  const echoes = roles.flatMap((role) => echoingBullets(role.achievements ?? []));
  const repeated = roles
    .map((role) => ({ role: role.company ?? 'a role', verbs: repeatedOpeners(role.achievements ?? []) }))
    .filter((entry) => entry.verbs.length > 0);

  if (echoes.length === 0 && repeated.length === 0) return;

  const parts: string[] = [];
  if (echoes.length > 0) {
    parts.push(`${echoes.length} bullet(s) whose verb repeats its own noun: ${JSON.stringify(echoes[0].slice(0, 70))}`);
  }
  if (repeated.length > 0) {
    parts.push(`${repeated.length} role(s) opening two bullets with the same verb (${repeated[0].verbs.join(', ')})`);
  }
  console.warn(`[Resume voice] ${profileName}: ${parts.join('; ')}.`);
}

/**
 * Figures whose two ends do not describe one measurement.
 *
 * REPORTED BY THE OPERATOR as garbled metrics: "reduced deploy time by about 40
 * minutes to 6". This prompt taught it - its own before-and-after example was
 * written "40 minutes to 6", with the unit on one end - so the example and the
 * rule were both fixed, and this counts what still arrives.
 */
function reportGarbledMetrics(
  profileName: string,
  content: { experience?: Array<{ achievements?: string[] }> }
): void {
  const found = findGarbledMetrics(content.experience ?? []);
  if (found.length === 0) return;

  console.warn(
    `[Resume metrics] ${profileName}: ${found.length} figure(s) a reader cannot parse - `
      + found
        .slice(0, 3)
        .map((hit) => `${hit.shape}: ${JSON.stringify(hit.bullet.slice(0, 90))}`)
        .join('; ')
      + `${found.length > 3 ? ', ...' : ''}.`
  );
}

/** The prompt's own floor: two of every three bullets name a technology. */
const TOOL_SHARE_FLOOR = 2 / 3;

/**
 * The bullets the prompt asks for, and the reason the floor is counted.
 *
 * MEASURED on a five-role profile after the per-role guidance was cut to 5-7
 * and 2-3: twelve bullets, below the prompt's own stated minimum of fourteen.
 * A short page is why the soft skills, the checklist terms and the five
 * measurable results all ran out of room at once - each needs a sentence to
 * live in. The page has no length limit, so there is nothing a short resume
 * buys.
 */
const BULLET_FLOOR = 14;

/**
 * Faults on the operator's list, counted rather than repaired.
 *
 * Too few bullets, broken or leftover text, and bullets naming none of the
 * tools this resume claims. Each one needs the sentence rewritten, so each is a
 * rule in the prompt - and a writing rule
 * nobody counts is a writing rule that quietly stops holding, which is why
 * `echoingBullets` is counted beside its own ban.
 *
 * ONE LINE PER RESUME, and only when there is something to say: an operator
 * reads a batch of sixty of these.
 */
function reportBulletShape(
  profileName: string,
  roles: ReadonlyArray<{ company?: string; achievements?: string[] }>,
  vocabulary: readonly string[]
): void {
  const parts: string[] = [];

  const written = roles.reduce((count, role) => count + (role.achievements ?? []).length, 0);
  if (written > 0 && written < BULLET_FLOOR) {
    parts.push(
      `${written} bullets across ${roles.length} role(s), under the floor of ${BULLET_FLOOR} `
        + `- everything else on this page needs a sentence to live in`
    );
  }

  const broken = findBrokenBullets(roles, vocabulary);
  if (broken.length > 0) {
    parts.push(
      `${broken.length} bullet(s) that are not one finished sentence (`
        + `${broken.slice(0, 2).map((hit) => `${hit.shape}: ${JSON.stringify(hit.bullet.slice(0, 70))}`).join('; ')})`
    );
  }

  const tools = bulletsNamingATool(roles, vocabulary);
  if (tools.bullets > 0 && tools.share < TOOL_SHARE_FLOOR) {
    parts.push(
      `only ${tools.named}/${tools.bullets} bullets name a technology this resume claims `
        + `(${Math.round(tools.share * 100)}%, floor ${Math.round(TOOL_SHARE_FLOOR * 100)}%)`
    );
  }

  if (parts.length === 0) return;
  console.warn(`[Resume bullets] ${profileName}: ${parts.join('; ')}.`);
}

/** How many times a term appears in the achievement bullets. */
function timesInBullets(
  content: { experience?: Array<{ achievements?: string[] }> },
  term: string
): number {
  const bullets = (content.experience ?? []).flatMap((role) => role.achievements ?? []);
  return bullets.filter((bullet) => containsTerm(bullet, term)).length;
}

/**
 * The figures a scanner counts as measurable results.
 *
 * Dates, years and the numbers inside product names are not results, which is
 * why they are taken out before counting: "OAuth 2.0", "S3" and "01/2019" are
 * not achievements, and a resume that scored them as such would pass the floor
 * while saying nothing.
 */
export function countFigures(
  content: { summary?: string; experience?: Array<{ achievements?: string[] }> }
): number {
  const text = [
    content.summary ?? '',
    ...(content.experience ?? []).flatMap((role) => role.achievements ?? []),
  ].join(' ');

  const stripped = text
    .replace(/\b(?:0[1-9]|1[0-2])\/(?:19|20)\d{2}\b/g, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    // A number welded to a name is part of the name: S3, Log4j, p99, H2, ES2015.
    .replace(/\b[A-Za-z]+\d+(?:\.\d+)?[A-Za-z]*\b/g, ' ')
    // And the products that write their version apart from their name, however
    // they separate the two: "OAuth 2.0", "HTTP/2", "Python 3".
    .replace(/\b(?:OAuth|OIDC|HTTP|HTTPS|TLS|SSL|IPv|Python|Java|Node|PHP|Angular|Vue|React|Spring|Kafka|Postgres|PostgreSQL|MySQL|Redis|Kubernetes|Windows|Android|iOS)[\s/.-]?\d+(?:\.\d+)?\b/gi, ' ');

  return (stripped.match(/\d+(?:[.,]\d+)?/g) ?? []).length;
}

/** Each of the posting's five leading skills, this often in the bullets. */
const FOCUS_SKILL_FLOOR = 2;

/** Figures on the page, which is what a measurable-results check counts. */
const FIGURE_FLOOR = 5;

/** Bullets that may carry a number or a before-and-after; the prompt rations them. */
const FIGURE_BULLET_CEILING = 7;

/**
 * The two floors the operator set by number, counted where they are read.
 *
 * Reported, never repaired: the model writes the resume and nothing here edits
 * it. But a floor nobody counts is a floor nobody keeps, and both of these were
 * asked for as numbers - each of the five focus skills in the bullets two or
 * three times, and at least five figures on the page.
 */
function reportFocusAndFigures(
  profileName: string,
  content: { summary?: string; experience?: Array<{ achievements?: string[] }> },
  jobAnalysis?: JobAnalysis
): void {
  const five = focusSkills(jobAnalysis);
  if (five.length > 0) {
    const counted = five.map((skill) => ({ skill, times: timesInBullets(content, skill) }));
    const short = counted.filter((entry) => entry.times < FOCUS_SKILL_FLOOR);
    const line = counted.map((entry) => `${entry.skill} x${entry.times}`).join(', ');
    if (short.length === 0) {
      console.log(`[Resume focus] ${profileName}: ${line}.`);
    } else {
      console.warn(
        `[Resume focus] ${profileName}: ${line} - ${short.length} of the posting's top `
          + `${five.length} below ${FOCUS_SKILL_FLOOR} mentions in the bullets.`
      );
    }
  }

  /*
   * COUNTED IN THE BULLETS ONLY, on the operator's instruction: "at least 5
   * measurable results in bullet points". It used to count the summary too,
   * which inflated the number by one on most resumes and by more on the long
   * summaries - and the summary has room for a single figure at most,
   * so a floor that counted it would be a floor of four.
   */
  const figures = countFigures({ experience: content.experience });
  const withFigures = (content.experience ?? [])
    .flatMap((role) => role.achievements ?? [])
    .filter((bullet) => countFigures({ experience: [{ achievements: [bullet] }] }) > 0).length;
  if (withFigures > FIGURE_BULLET_CEILING) {
    console.warn(
      `[Resume metrics] ${profileName}: ${withFigures} bullets carry a number, over the ceiling of `
        + `${FIGURE_BULLET_CEILING}.`
    );
  } else if (figures >= FIGURE_FLOOR) {
    console.log(`[Resume metrics] ${profileName}: ${figures} measurable result(s) in ${withFigures} bullet(s).`);
  } else {
    console.warn(
      `[Resume metrics] ${profileName}: only ${figures} measurable result(s) in the bullets, `
        + `floor ${FIGURE_FLOOR}.`
    );
  }
}

function reportPlacement(
  profileName: string,
  content: {
    summary?: string;
    // `company` and `endDate` are here for the two date-aware checks below: a
    // claim is only too new for the years of the role it sits in.
    experience?: Array<{
      company?: string;
      endDate?: string;
      description?: string;
      achievements?: string[];
    }>;
  },
  jobAnalysis?: JobAnalysis
): PlacementReport | null {
  reportFocusAndFigures(profileName, content, jobAnalysis);
  reportBulletVoice(profileName, content);
  reportGarbledMetrics(profileName, content);
  const checklist = getProseChecklist(jobAnalysis);
  if (checklist.length === 0) return null;

  const report = measurePlacement(renderedProse(content), checklist);
  const floor = placementFloor();
  const percent = (report.ratio * 100).toFixed(0);

  /*
   * Soft skills counted on their own, as well as inside the total.
   *
   * They used to have a section of their own, which satisfied a scanner
   * whatever the prose did. The section is gone - it printed the skill
   * library's idea of a soft skill, "Innovation" and "Proactiveness" - so a
   * scanner now finds them only if the sentences carry them. Buried in a
   * 34-term total, a run that drops every one of them still reads as 88%
   * placed, and the thing that changed is invisible.
   */
  /*
   * The posting's concepts, counted where a scanner reads them.
   *
   * The skills block prints the TOOL a concept is built with - PagerDuty for
   * "incident response" - which answers the block and not the scanner: it
   * scores "Incident response" as a hard skill and reported it missing from a
   * resume whose block said PagerDuty. The prompt now requires the phrase
   * itself in the summary or a bullet; this says whether it arrived.
   */
  const conceptsWanted = getConceptKeywords(jobAnalysis);
  if (conceptsWanted.length > 0) {
    const conceptProse = renderedProse(content);
    const placed = conceptsWanted.filter((term) => containsTerm(conceptProse, term));
    const missingConcepts = conceptsWanted.filter((term) => !containsTerm(conceptProse, term));
    const conceptLine =
      `[Resume concepts] ${profileName}: ${placed.length}/${conceptsWanted.length} written into the prose` +
      `${missingConcepts.length > 0 ? `. Missing: ${missingConcepts.slice(0, 8).join(', ')}` : '.'}`;
    // A warning now, for the same reason the soft skills became one: the block
    // used to carry these as entries whatever the sentences did, and it no
    // longer does. A concept missing from the prose is missing from the resume.
    if (missingConcepts.length > 0) console.warn(`${conceptLine} - the bullets are the only place they count now.`);
    else console.log(conceptLine);
  }

  const softWanted = getSoftSkills(jobAnalysis);
  if (softWanted.length > 0) {
    const prose = renderedProse(content);
    const softPlaced = softWanted.filter((term) => containsTerm(prose, term));
    const missing = softWanted.filter((term) => !containsTerm(prose, term));
    /*
     * A WARNING when any are missing, which it was not while the skills block
     * ended with a group of them: a scanner found them there whatever the
     * sentences did, so a shortfall here cost nothing. That group is gone, so
     * a soft skill that is not in a bullet is not on the resume, and the score
     * falls by exactly the number missing.
     */
    const line =
      `[Resume soft skills] ${profileName}: ${softPlaced.length}/${softWanted.length} placed in the prose` +
      `${missing.length > 0 ? `. Missing: ${missing.slice(0, 8).join(', ')}` : '.'}`;
    if (missing.length > 0) console.warn(`${line} - the bullets are the only place they count now.`);
    else console.log(line);
  }

  if (report.ratio >= floor) {
    console.log(
      `[Resume keywords] ${profileName}: ${report.placed}/${report.total} checklist terms placed (${percent}%).`
    );
    return report;
  }

  console.warn(
    `[Resume keywords] ${profileName}: only ${report.placed}/${report.total} checklist terms placed ` +
      `(${percent}%, floor ${(floor * 100).toFixed(0)}%). Missing: ` +
      `${report.missing.slice(0, 12).join(', ')}${report.missing.length > 12 ? `, +${report.missing.length - 12} more` : ''}`
  );
  return report;
}

function buildFallbackExperienceDescription(title: string, jobAnalysis?: JobAnalysis): string {
  const role = title.trim() || 'Engineer';
  const text = `${role} focused on reliable product delivery, maintainable systems, and practical engineering outcomes.`;
  return text.slice(0, MAX_ROLE_BRIEF_LENGTH).trim();
}

function buildFallbackAchievements(jobAnalysis?: JobAnalysis): string[] {
  const base = normalizeSafeResponsibilityList(getResponsibilities(jobAnalysis))
    .slice(0, 3);

  if (base.length > 0) {
    return base.map((item) => `Improved ${item.replace(/\.$/, '').trim()} through practical engineering execution.`);
  }

  return [
    'Improved delivery consistency across critical projects.',
    'Enhanced service reliability and operational efficiency.',
  ];
}

/**
 * A summary for a profile whose model output came back empty.
 *
 * This is the last resort and nothing else, which is a deliberate narrowing of
 * what it used to be. It previously ran on EVERY summary: it discarded whatever
 * opening sentence the model had written and substituted
 * "{Title} with about {N} years of experience in {a}, {b}, {c}." - so every
 * resume this app has ever produced opened on the same sentence with different
 * nouns dropped into it. That single line, not the model, is why the summaries
 * read as interchangeable.
 *
 * The years requirement did not go away, it moved: the tailor-resume prompt now
 * asks for the candidate's experience length in the model's own words and in
 * whatever position suits the sentence, which is what makes one summary differ
 * from the next.
 */
function buildFallbackSummary(profile: Profile): string {
  const years = profile.totalYearsExperience;
  const role = profile.title?.trim() || 'Professional';
  const topSkills = (profile.skills ?? []).slice(0, 3);
  const skillsText = topSkills.length > 0 ? ` in ${topSkills.join(', ')}` : '';

  if (typeof years !== 'number' || !Number.isFinite(years) || years < 0) {
    return `${role}${skillsText}.`;
  }

  const yearsText = Number.isInteger(years) ? String(years) : years.toFixed(1);
  return `${role} with about ${yearsText} years of experience${skillsText}.`;
}

const SPELLED_OUT_NUMBERS = new Map<string, string>([
  ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'],
  ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'], ['ten', '10'],
  ['eleven', '11'], ['twelve', '12'], ['thirteen', '13'], ['fourteen', '14'],
  ['fifteen', '15'], ['sixteen', '16'], ['seventeen', '17'], ['eighteen', '18'],
  ['nineteen', '19'], ['twenty', '20'], ['twenty-five', '25'], ['thirty', '30'],
]);

/**
 * Writes a span of experience as a numeral.
 *
 * "Seven years of engineering work" reads well in prose and scans badly on a
 * resume: a recruiter skimming for a number does not find one, and a filter
 * looking for "7+ years" does not match a word. Only quantities of TIME are
 * converted - a sentence about "three greenfield systems" keeps its word, which
 * is how it would be written anywhere else.
 *
 * Applied to the model's own wording, so a summary that already says "7 years"
 * is left exactly as it is.
 */
function useNumeralsForExperienceYears(summary: string): string {
  const words = [...SPELLED_OUT_NUMBERS.keys()].sort((a, b) => b.length - a.length).join('|');
  const pattern = new RegExp(`\\b(${words})(\\s+|-)(years?|yrs?)\\b`, 'gi');

  return summary.replace(pattern, (match, word: string, gap: string, unit: string) => {
    const digits = SPELLED_OUT_NUMBERS.get(word.toLowerCase());
    return digits ? `${digits}${gap}${unit}` : match;
  });
}

/**
 * Takes the candidate's employers out of the summary.
 *
 * A summary is the one section that is not about a particular job, and naming
 * an employer in it dates the paragraph to whichever company happens to be
 * current - the reader meets the company before they meet the candidate, and
 * the same sentence has to be rewritten the moment they move. The companies are
 * already stated, with dates, ten lines further down.
 *
 * The prepositional form is removed rather than the sentence, because the
 * sentence is usually the good one: "Seven years of engineering work at Capital
 * One shaped a practice built around distributed systems" loses two words and
 * keeps everything that was worth saying.
 *
 * A bare mention is only removed for a multi-word employer. A one-word name is
 * too often an ordinary noun as well - a candidate from Block or Stripe would
 * otherwise have sentences about block storage and stripe charts quietly
 * mangled - so those are left to the prompt, which is told not to write them.
 */
function removeCompanyMentionsFromSummary(summary: string, profile?: Profile): string {
  const companies = uniqueCaseInsensitive(
    (profile?.experience ?? [])
      .map((role) => role.company?.trim() ?? '')
      .filter((company) => company.length >= 3)
  );
  if (companies.length === 0) return summary;

  let output = summary;
  for (const company of companies) {
    const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // A short aside that exists only to name the employer goes whole:
    // "..., most recently for Capital One, across payments" would otherwise
    // leave a dangling "most recently,". Length-capped so this can never take
    // out a clause that was carrying the sentence.
    output = output.replace(
      new RegExp(`,\\s*[^,.]{0,40}\\b${escaped}(?:'s|’s)?\\b[^,.]{0,20},`, 'gi'),
      ','
    );

    // "... work at Capital One shaped ..." -> "... work shaped ..."
    output = output.replace(
      new RegExp(`\\s+(?:at|with|for|within|across|of|from)\\s+${escaped}(?:'s|’s)?\\b`, 'gi'),
      ''
    );

    if (company.trim().includes(' ')) {
      output = output.replace(new RegExp(`\\b${escaped}(?:'s|’s)?\\b`, 'gi'), '');
    }
  }

  return recapitalizeSentences(
    output
      .replace(/\s{2,}/g, ' ')
      .replace(/\s([.,;:!?])/g, '$1')
      .replace(/([.,;:])\s*\1+/g, '$1')
      .replace(/\s*,\s*\./g, '.')
      .trim()
  );
}

/**
 * Restores the capital letter a removal took with it.
 *
 * Dropping a company that opened a sentence - "Capital One systems handled
 * heavy load" - leaves the next word carrying a lower-case letter where the
 * sentence now starts.
 */
function recapitalizeSentences(text: string): string {
  return text.replace(/(^|[.!?]\s+)([a-z])/g, (_match, lead: string, letter: string) =>
    `${lead}${letter.toUpperCase()}`
  );
}

/**
 * The summary's "at most one figure" rule now lives in the prompt.
 *
 * It used to be enforced here by deleting every number after the first, which
 * deletes the number and keeps the sentence around it: "cut latency by 30%"
 * became "cut latency by." That was survivable while the summary's first number
 * was whatever the model happened to write, and became routine once spans of
 * experience were converted to numerals, because "7 years" then claimed the one
 * allowed slot and every real metric after it was stripped.
 *
 * A rule about how many numbers a paragraph should carry is a writing rule, and
 * the model can hold it while still writing a sentence that parses. Deleting
 * tokens afterwards cannot.
 */

/**
 * The headline the resume is printed under: the candidate's own title.
 *
 * WHAT THIS LINE HAS BEEN, in order, because the history is the argument. It was
 * rebuilt into a fixed `Senior <domain> Engineer` shape from whichever title
 * could be found, which renamed the candidate. Then the profile's own title with
 * the posting's discipline in parentheses - "Software Engineer (Integration)".
 * Then the profile's title alone. Then the POSTING's title, to win the job-title
 * match a scanner scores: measured over 495 delivered resumes, the posting's
 * title appeared verbatim in 2% of them and in 68% not even its first two words
 * appeared anywhere.
 *
 * It is the candidate's own title again, on the operator's instruction, and the
 * match it gave up is bought back somewhere the claim is smaller: the summary
 * names the KIND of role in the model's own words - "AI data engineering" for a
 * posting called "Data & AI Engineer - AWS, Java & Python" - which is a sentence
 * about what this person does rather than a title they have not held. See
 * `targetRoleTitle` in the prompt values, and the SUMMARY rule that uses it.
 *
 * The fallbacks are for a profile with no headline at all, and go to the
 * candidate's own most recent role before anything else.
 *
 * A PROFILE MAY SAY ITS OWN. `profileSettings.headerTitle` comes first when it
 * is set, and `appendTargetRole: false` prints it alone. Both exist because the
 * Title field is doing four jobs at once - it is printed, sent to the model as
 * who this person is, scanned for the skills they already claim, and used in
 * the fallback summary - so editing it to fix the printed line moved the other
 * three as well. These move only the printed line.
 */
function buildResumeHeadline(
  contentTitle: string | undefined,
  jobAnalysis: JobAnalysis | undefined,
  profile?: Profile
): string {
  const settings = profile?.profileSettings;
  const candidates = [
    settings?.headerTitle,
    profile?.title,
    contentTitle,
    profile?.experience?.[0]?.title,
  ];

  for (const candidate of candidates) {
    const trimmed = (candidate ?? '').trim().replace(/\s+/g, ' ');
    if (!trimmed) continue;
    // Off is a deliberate choice and is obeyed whatever the headline came from:
    // a profile whose own wording already names the discipline reads as a
    // stutter with the posting's kind of role after it.
    if (settings?.appendTargetRole === false) return trimmed;
    // The candidate's own line, and after it the kind of role this application
    // is for - in one of six shapes, drawn per resume. See
    // `headlineWithTargetRole`: the separator is the one part of the line that
    // can vary without changing what it says, and a batch where every headline
    // takes the same shape is a pattern anyone holding two of them can see.
    return headlineWithTargetRole(trimmed, getJobAnalysisTitle(jobAnalysis));
  }
  return 'Professional';
}

function isCompanyDescriptionLike(value: string, company?: string): boolean {
  const normalized = value.trim().replace(/\s+/g, ' ');
  const companyName = company?.trim();
  if (!normalized || !companyName) return false;

  const escapedCompany = companyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const companyLeadPattern = new RegExp(
    `^(?:category:\\s*)?${escapedCompany}\\b\\s+(?:is|are|was|were|builds|provides|offers|serves|uses|aims|helps|connects|creates|develops|delivers)\\b`,
    'i'
  );
  const marketingContextPattern = new RegExp(
    `\\b${escapedCompany}\\b.{0,80}\\b(?:founded|headquartered|acquired|serves|customers|platform|company|nonprofit|non-profit)\\b`,
    'i'
  );

  return companyLeadPattern.test(normalized) || marketingContextPattern.test(normalized);
}

function stripUnsafeResumeSentences(value: string, company?: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return '';

  const sentences = normalized.split(/(?<=[.!?])\s+/);
  const safeSentences = sentences
    .map((sentence) => sentence.trim())
    .filter((sentence) =>
      sentence &&
      !isUnsafeJobPostingPhrase(sentence) &&
      !isCompanyDescriptionLike(sentence, company)
    );

  return safeSentences.join(' ').trim();
}

/**
 * The profile as the MODEL needs to see it.
 *
 * Built by naming what goes in rather than by spreading the record and deleting
 * from it, so a field added to `Profile` later is not sent to a chat window by
 * default and noticed by nobody.
 *
 * Three groups are left out, and each for its own reason:
 *
 * - `id`, `createdAt`, `updatedAt` are this database's bookkeeping. They mean
 *   nothing to a model rewriting a summary.
 * - `profileSettings` is the operator's own configuration: which prompt
 *   records to use, their output file-name templates, and which AI model they
 *   pay for. Sending it typed the operator's tooling choices into somebody
 *   else's chat history for no purpose whatever.
 * - `contact` is a phone number, an email address and social links. This call
 *   rewrites the summary, the experience and the skills; it is never asked for
 *   contact details and the rendered resume takes them straight from the
 *   profile. No prompt in this app so much as mentions them.
 *
 * Measured on a five-role profile, together with dropping the pretty-printing:
 * the profile went from 7,428 characters to 5,363 and the whole tailoring
 * payload from 9,365 to 6,942 - 26% less, with nothing the model reads removed.
 * On a free chat provider that is also 26% less to type into the composer,
 * which is the slowest step of the turn by a wide margin.
 */
function buildPromptProfile(profile: Profile): Record<string, unknown> {
  return {
    name: profile.name,
    title: profile.title,
    totalYearsExperience: profile.totalYearsExperience,
    summary: profile.summary,
    experience: profile.experience.map((experience) => ({
      title: experience.title,
      company: experience.company,
      startDate: experience.startDate,
      endDate: experience.endDate,
      location: experience.location,
      // The raw description is replaced, not passed alongside: it is the field
      // most likely to carry a sentence about the COMPANY rather than the
      // person, and `stripUnsafeResumeSentences` is what takes those out.
      companyContext: stripUnsafeResumeSentences(experience.description ?? '', experience.company),
      achievements: experience.achievements,
      skills: experience.skills,
    })),
    strengths: profile.strengths,
    skills: profile.skills,
    // Sent when the profile has one: the model is asked to select skills, and
    // the author's own grouping is a fact about them it should not contradict.
    ...(profile.skillCategories?.length ? { skillCategories: profile.skillCategories } : {}),
    education: profile.education,
    certifications: profile.certifications,
  };
}

/**
 * JSON for a prompt: compact, not pretty.
 *
 * Two-space indentation is for a person reading a file. Nothing reads these but
 * a model, which parses both identically, and the indentation is 15-20% of the
 * payload on a nested record like a profile - paid on every call, for
 * whitespace.
 */
function promptJson(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Says what the model returned for the skills block. Changes nothing.
 *
 * Two things an operator would want to know and cannot see from the page:
 * whether the block came in thin - the prompt asks for about 18 skills and
 * tops up from the candidate's own stack to get there - and how much of it is
 * simply the posting's own list. A block that is entirely the posting's terms
 * is the shape a reader recognises as written for them this morning, which is
 * the thing the prompt is trying to avoid.
 *
 * Reported rather than corrected, because correcting it would mean editing an
 * answer this app asked the model to own.
 */
function reportSkillBlock(
  profileName: string,
  groups: Array<{ category: string; skills: string[] }>,
  skills: string[],
  jobAnalysis?: JobAnalysis
): void {
  if (groups.length === 0) return;

  const posting = new Set(
    [...getJobNamedHardSkills(jobAnalysis), ...getTechnicalSkills(jobAnalysis)]
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean)
  );
  const fromPosting = skills.filter((skill) => posting.has(skill.trim().toLowerCase())).length;
  const share = skills.length > 0 ? Math.round((100 * fromPosting) / skills.length) : 0;

  /*
   * The share of the block the posting did NOT name, said out loud.
   *
   * At a floor of 35 entries, most of the block is read off the candidate's
   * work rather than copied from the job description - no posting names
   * thirty-five tools, and these profiles carry no skill list of their own. The
   * prompt licenses that inference and bounds it: the ordinary companions of a
   * tool somebody plainly used, never a competitor beside it and never an
   * industry they have not worked in. An interviewer can still ask about any
   * line, so the number is worth seeing rather than burying.
   */
  const inferred = 100 - share;
  const thin = skills.length < MIN_SKILL_BLOCK_SIZE
    ? ` - UNDER the floor of ${MIN_SKILL_BLOCK_SIZE}`
    : '';
  const line =
    `[Resume skills] ${profileName}: ${skills.length} skill(s) in ${groups.length} group(s)${thin}. `
    + `${share}% are terms this posting named, ${inferred}% read off the candidate's work.`;
  if (thin) console.warn(line);
  else console.log(line);

  /*
   * Groups too small to stand, reported and not touched.
   *
   * Code did fold them for one batch, into whichever heading shared the most
   * words - and a resume came back with "LLM, APIs, Webhooks, OpenAPI,
   * PostgreSQL, RAG, ETL Pipelines" under CLOUD & INFRASTRUCTURE. The target
   * was a guess every time, and a wrong heading reads worse than a short
   * group, so the merging went back to the prompt where the model knows what
   * the entries are. This counts them.
   */
  const small = groups.filter((group) => group.skills.length < MIN_SKILLS_PER_GROUP);
  if (small.length > 0) {
    console.warn(
      `[Resume skills] ${profileName}: ${small.length} group(s) under ${MIN_SKILLS_PER_GROUP} entries - `
        + `${small.map((group) => `${group.category} (${group.skills.length})`).join(', ')}. `
        + `A thin group is how a block of 35 becomes a block of 16.`
    );
  }

  /*
   * The one fault left that nothing removes.
   *
   * The prompt bans ordinary words as skill names - "Logs", "Reflection",
   * "Less", "Echo", "Behave" - because each is also a real product, so a reader
   * cannot tell whether the resume means the tool or the word. "Logs" was
   * printed in a delivered block beside "prediction logs". It is NOT deleted
   * here: each one genuinely is a product somebody might have used, and a
   * removal that cannot tell which would be guessing. Said out loud instead.
   */
  /*
   * The group the operator calls essential.
   *
   * "Languages & Framework category in the skill section is essential and
   * required." It is the first thing a technical reader looks for and the
   * first thing a scanner matches on, and a block that opens with "Cloud &
   * Infrastructure" has buried it. Reported rather than invented: the entries
   * would have to come from somewhere, and a group of languages this candidate
   * does not write is worse than a block without the heading.
   */
  const hasLanguages = groups.some((group) => /\blanguage/i.test(group.category));
  if (!hasLanguages) {
    console.warn(
      `[Resume skills] ${profileName}: no Languages group in the block - `
        + `${groups.map((group) => group.category).join(', ')}.`
    );
  }
  /*
   * The floor only. The ceiling is enforced before this runs - `capSkillGroups`
   * joins headings until the block is within it - so a warning about too many
   * groups here could only ever fire on a block this code had already fixed,
   * and the merge says so in its own line.
   */
  if (groups.length < MIN_SKILL_GROUPS) {
    console.warn(
      `[Resume skills] ${profileName}: ${groups.length} group(s), under the `
        + `${MIN_SKILL_GROUPS} the prompt asks for.`
    );
  }
}

/**
 * The floor the prompt states, and the operator asked for by number.
 *
 * MEASURED before it moved: "about 30, at most 40" delivered 25 entries on
 * average across a batch, 17 on one resume. A ceiling stated hard and a floor
 * stated soft is obeyed on one side only - the same shape as the 65-word
 * summary floor that produced 52 words - so this is now a floor in both the
 * prompt and the log.
 */
const MIN_SKILL_BLOCK_SIZE = 35;

/*
 * And the shape it asks for: see TECHNICAL SKILLS in the prompt.
 *
 * The maximum is imported rather than written again here, because it is now
 * ENFORCED - `capSkillGroups` joins headings until the block is within it - and
 * a second copy of an enforced number is a copy that drifts. The floor stays
 * local and stays a warning: reaching five groups from three would mean
 * splitting or inventing a category, which is the judgement this code does not
 * make.
 */
const MIN_SKILL_GROUPS = 5;

/**
 * Five to a group, because the arithmetic of the floor depends on it.
 *
 * Five groups of seven, six of six or seven of five all reach 35; a group
 * holding one tool - "Security & Performance: Redis", from a delivered resume -
 * is how a block of 35 turns into a block of 17.
 */
const MIN_SKILLS_PER_GROUP = 5;

function normalizeTailoredContent(
  content: TailoredContent,
  jobAnalysis?: JobAnalysis,
  profile?: Profile,
  options: { alreadyRouted?: boolean } = {}
): TailoredContent {
  /*
   * The skills block, as the model returned it, printed unchanged.
   *
   * WHAT THIS REPLACED. The block used to be chosen by code: library matching,
   * concept mapping, vendor-prefix collapsing, priority ordering, padding each
   * heading to a minimum and truncating it to a maximum. The library is a
   * curated list of 1,492 rows, and what it curated reached every resume -
   * "Echo", "Logs", "Reflection", "Behave", "Amazon Kinesis" printed beside
   * "Kinesis", "REST" beside "REST API". Rules were added for each of those in
   * turn and the next row found the next gap.
   *
   * So the operator took the decision away from the library. The tailor call
   * already has the profile and the posting in front of it, and it now returns
   * the finished block, grouped under its own headings. Nothing here reorders
   * it, filters it or tops it up: a rule worth keeping is stated in the prompt,
   * where the model can act on it, rather than applied afterwards to an answer
   * this file did not write.
   *
   * THE ONE EXCEPTION IS THE SAME STRING TWICE, and it is an exception because
   * there is no judgement in it. Measured over a batch: a third of resumes
   * printed an identical entry twice - "python, sql, rest, postgresql, dbt, aws,
   * git" all doubled on one of them - usually because the same tool belongs in
   * two of the model's own groups and it wrote it in both. Removing the second
   * copy cannot be wrong and cannot be argued with.
   *
   * AND THE SAME STRING PLUS FILLER, which the operator reported as keyword
   * stuffing: "performance" beside "performance tuning", "GitHub Copilot"
   * beside "GitHub Copilot app", "agent runtime" beside "agent runtime
   * execution" - 3.1 entries per resume, measured over 70 of them. That used to
   * be left to the prompt on the grounds that "Spring" against "Spring
   * Framework" is a judgement. It is not, once the test is narrow enough:
   * `dropRestatedSkillsFromGroups` removes an entry only when every word it
   * adds is filler, which is why "AWS Lambda" still stands beside "AWS". What it
   * cannot see - "production pipeline operations" against "data pipelines" -
   * remains a judgement and remains in the prompt.
   *
   * The flat list is kept in step because templates, the DOCX writer and the
   * keyword measurement all read `hardSkills`.
   */
  /*
   * The entries are passed through UNTOUCHED, because they carry their kind.
   *
   * This used to coerce each one with `String(skill)`, which was right while an
   * entry was a bare string and became the bug that printed "LANGUAGES &
   * FRAMEWORKS: [object Object]" on every resume the moment the model started
   * labelling them: every entry stringified to the same six words, and the
   * exact-duplicate rule then collapsed the whole block to one. `parseSkillEntry`
   * takes either shape and does the trimming this used to do.
   */
  const modelSkillGroups = (content.skillGroups ?? [])
    .map((group) => ({
      category: String(group?.category ?? '').trim(),
      skills: Array.isArray(group?.skills) ? (group.skills as unknown[]) : [],
    }))
    .filter((group) => group.category);

  // Everything this posting named, for the count below of how much of the block it asked for.
  const postingVocabulary = normalizeSkillsList([
    ...getKeywordChecklist(jobAnalysis),
    ...getConceptKeywords(jobAnalysis),
  ]);

  // A re-parsed block was capitalised on its first pass; doing it again would
  // undo a name kept in lower case.
  const knownCasing = namesWithInnerCapitals([
    getTailoringSourceText(jobAnalysis),
    content.summary ?? '',
    ...(content.experience ?? []).flatMap((role) => role.achievements ?? []),
    profile?.summary ?? '',
    ...(profile?.skills ?? []),
    ...(profile?.experience ?? []).flatMap((role) => [
      role.description ?? '',
      ...(role.achievements ?? []),
      ...(role.skills ?? []),
    ]),
  ]);
  /*
   * A name stays in lower case only where a PERSON wrote it that way - the
   * posting or the candidate's profile. The models' own word is not enough: the
   * skills check once marked "terraform" as officially lower case, and the
   * posting it was answering wrote "Terraform".
   */
  const writtenByPeople = [
    getTailoringSourceText(jobAnalysis),
    profile?.summary ?? '',
    ...(profile?.skills ?? []),
    ...(profile?.experience ?? []).flatMap((role) => [
      role.description ?? '',
      ...(role.achievements ?? []),
      ...(role.skills ?? []),
    ]),
  ].join('\n');
  const confirmsLowercase = (name: string): boolean =>
    new RegExp(`(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`).test(writtenByPeople);
  const tidied = tidySkillGroups(modelSkillGroups, {
    capitalize: !options.alreadyRouted,
    knownCasing,
    // The posting's own terms: never deleted for repeating a heading, and the
    // form kept when one name is written two ways.
    asked: new Set(postingVocabulary.map((term) => term.toLowerCase())),
    confirmsLowercase,
  });
  const skillGroups = tidied.groups;
  const technicalGroups = skillGroups.filter((group) => !isSoftSkillsGroup(group.category));

  const said: string[] = [];
  const list = (entries: readonly string[], show: number) =>
    entries.slice(0, show).join(', ') + (entries.length > show ? ', ...' : '');
  if (tidied.report.repeated.length > 0) {
    said.push(`${tidied.report.repeated.length} repeated (${list(tidied.report.repeated, 6)})`);
  }
  if (tidied.report.routedToProse.length > 0) {
    said.push(
      `${tidied.report.routedToProse.length} the model labelled for the prose `
        + `(${list(tidied.report.routedToProse.slice(0, 4).map((entry) => `${entry.name} [${entry.kind}]`), 4)})`
    );
  }
  if (tidied.report.duplicates.length > 0) {
    said.push(
      `${tidied.report.duplicates.length} one name under two spellings `
        + `(${list(tidied.report.duplicates.slice(0, 4).map((pair) => `${pair.dropped} -> ${pair.kept}`), 4)})`
    );
  }
  if (tidied.report.trimmed.length > 0) {
    said.push(`${tidied.report.trimmed.length} past the ${MAX_SKILL_BLOCK_SIZE}-entry ceiling (${list(tidied.report.trimmed, 4)})`);
  }
  /*
   * An unlabelled block is an older prompt answering, or a custom one an admin
   * wrote. It is kept rather than emptied - see `parseSkillEntry` - and said
   * out loud, because nothing is being routed on a resume that arrives this way
   * and the block is only as clean as the model made it.
   */
  if (tidied.report.unlabelled.length > 0 && !options.alreadyRouted) {
    console.warn(
      `[Resume skills] ${profile?.name ?? 'resume'}: ${tidied.report.unlabelled.length} entry(ies) `
        + `arrived with no kind, so nothing could be routed on them - ${list(tidied.report.unlabelled, 5)}. `
        + `Is the tailoring prompt the current one?`
    );
  }
  if (said.length > 0) {
    console.log(`[Resume skills] ${profile?.name ?? 'resume'}: removed ${said.join('; ')}.`);
  }
  /*
   * Said apart from the removals above, because nothing was removed: a merge
   * costs the page a heading and keeps every skill under it.
   */
  if (tidied.report.mergedGroups.length > 0) {
    console.log(
      `[Resume skills] ${profile?.name ?? 'resume'}: joined `
        + `${tidied.report.mergedGroups.length} heading(s) to reach the ${MAX_SKILL_GROUPS}-group `
        + `maximum - ${tidied.report.mergedGroups
          .map((pair) => `${pair.kept} + ${pair.joined}`).join('; ')}.`
    );
  }

  const hardSkills = technicalGroups.length > 0
    ? technicalGroups.flatMap((group) => group.skills)
    // No groups in the answer - an older prompt, or a build with no posting to
    // tailor against. The model's flat list, then the profile's own skills.
    : normalizeSkillsList(content.hardSkills ?? content.skills ?? profile?.skills ?? []);

  reportSkillBlock(profile?.name ?? 'resume', technicalGroups, hardSkills, jobAnalysis);

  /*
   * HOW MUCH OF THE BLOCK THIS POSTING ACTUALLY ASKED FOR.
   *
   * MEASURED across five jobs for one profile: only five entries recurred on
   * every resume - C#, Docker, Git, Jenkins, Unreal Engine - but three of
   * those five appear ZERO times in the candidate's history and all three are
   * named as examples in this prompt's own layer checklist. Separately, 78 of
   * 183 delivered entries (43%) were product names the prompt uses as
   * illustrations.
   *
   * So the number worth watching is not the block's size, it is how much of it
   * the employer asked for. Counted here rather than argued about later.
   */
  if (jobAnalysis && hardSkills.length > 0) {
    const asked = new Set(postingVocabulary.map((term) => term.toLowerCase()));
    const matched = hardSkills.filter((skill) => asked.has(skill.toLowerCase()));
    console.log(
      `[Resume block] ${profile?.name ?? 'resume'}: ${hardSkills.length} entries, `
        + `${matched.length} named by this posting `
        + `(${Math.round((matched.length / hardSkills.length) * 100)}%); the rest come from the `
        + `candidate's history or are inferred from it.`
    );
  }

  const trimIncompleteEnd = (s: string): string =>
    s.trim().replace(/,+\s*$/, '').replace(/\s+(and|or)\s*$/i, '').trim();
  // Every prose funnel below starts here: the tag strip and the stand-in dashes
  // a model writes when told not to use em-dashes. Word choice is the prompt's.
  const stripBoldTags = (s: string): string =>
    normalizeDashes(s.replace(/<\/?strong>/gi, '').replace(/<\/?b>/gi, ''));
  const sanitizeResumeText = (s: string): string => {
    const clean = stripUnsafeResumeSentences(stripBoldTags(s), undefined);
    return isUnsafeJobPostingPhrase(clean) ? '' : clean;
  };

  const clampRoleBrief = (description: string, company?: string, title?: string): string => {
    const stripped = stripBoldTags(description).trim().replace(/\s+/g, ' ');
    const cleanBase = stripUnsafeResumeSentences(stripped, company);
    const fallback = buildFallbackExperienceDescription(title ?? '', jobAnalysis);
    const clean = cleanBase || fallback;
    if (isUnsafeJobPostingPhrase(clean) || isCompanyDescriptionLike(clean, company)) {
      return fallback;
    }
    if (clean.length <= MAX_ROLE_BRIEF_LENGTH) return trimIncompleteEnd(clean);
    const truncated = clean.slice(0, MAX_ROLE_BRIEF_LENGTH);
    let result: string;
    const lastSentenceEnd = Math.max(
      truncated.lastIndexOf('. '),
      truncated.lastIndexOf('! '),
      truncated.lastIndexOf('? ')
    );
    if (lastSentenceEnd >= MAX_ROLE_BRIEF_LENGTH - 80) {
      result = truncated.slice(0, lastSentenceEnd + 1).trim();
    } else {
      const lastComma = truncated.lastIndexOf(', ');
      if (lastComma >= MAX_ROLE_BRIEF_LENGTH - 50) {
        result = truncated.slice(0, lastComma).trim();
      } else {
        const lastSpace = truncated.trimEnd().lastIndexOf(' ');
        result = lastSpace > 0 && lastSpace >= MAX_ROLE_BRIEF_LENGTH - 40
          ? truncated.slice(0, lastSpace).trim()
          : truncated.trimEnd();
      }
    }
    return trimIncompleteEnd(result);
  };

  const normalizeSummary = (summary: string): string =>
    stripUnsafeResumeSentences(stripBoldTags(summary), undefined);

  // The cover letter is written by the same model call and carries the same
  // stand-in dashes. It is not prose the resume renders, so none of the
  // funnels above has seen it; an absent letter stays absent.
  const coverLetterFields = content.coverLetter
    ? { coverLetter: normalizeDashes(content.coverLetter) }
    : {};

  const cap = bulletCap();
  const trimmed: string[] = [];
  const normalizedExperience = (content.experience ?? []).map((item) => {
    const written = normalizeSkillsList(item.achievements).map(sanitizeResumeText).filter(Boolean);
    const achievements = written.length > 0
      ? chooseBullets(written, cap, jobAnalysis)
      : buildFallbackAchievements(jobAnalysis);
    if (written.length > achievements.length) {
      trimmed.push(`${item.company ?? item.title ?? 'a role'} ${written.length} -> ${achievements.length}`);
    }
    return {
      ...item,
      /*
       * No paragraph under the company name. A role used to open with two or
       * three sentences of scene-setting before the first bullet, and it was the
       * part of the page that read most like it had been generated: the bullets
       * say what the person did, and the paragraph said it again with adjectives.
       * Emptied here rather than left to each template, so the PDF, the DOCX and
       * the preview all drop it together.
       */
      description: '',
      achievements,
    };
  });

  if (trimmed.length > 0) {
    // Worth a line in the log rather than a silent trim: the prompt asks for at
    // most `cap` and a model that returns twenty-two is a model ignoring the
    // length budget, which is a prompt problem as well as a page problem.
    console.warn(
      `[Resume bullets] ${profile?.name ?? 'resume'}: over the ${cap}-bullet cap, ` +
        `kept the ones carrying the most checklist terms - ${trimmed.join(', ')}.`
    );
  }

  const strengthKeywordPool = normalizeSafeKeywordList([
    ...getRequiredSkills(jobAnalysis),
    ...getPreferredSkills(jobAnalysis),
    ...getKeywordChecklist(jobAnalysis),
    ...getIndustryTerms(jobAnalysis),
  ]).filter((keyword) => keyword.length >= 3);

  const fallbackStrengths = normalizeSafeResponsibilityList(getResponsibilities(jobAnalysis))
    .slice(0, 4)
    .map((item, index) => ({
      title: `Core Strength ${index + 1}`,
      description: `Demonstrated impact in ${item.trim().replace(/\.$/, '')}.`,
    }));

  const baseStrengths = (content.strengths ?? []).length > 0 ? (content.strengths ?? []) : fallbackStrengths;
  const normalizedStrengths = baseStrengths.map((strength, index) => {
    const title = capitalizeFirstCharacter(
      (strength?.title ?? `Core Strength ${index + 1}`).trim() || `Core Strength ${index + 1}`
    );
    const rawDescription = (strength?.description ?? '').trim();
    const keywordA = strengthKeywordPool[index % Math.max(strengthKeywordPool.length, 1)] ?? '';
    const keywordB = strengthKeywordPool[(index + 7) % Math.max(strengthKeywordPool.length, 1)] ?? '';
    const keywordSnippet = [keywordA, keywordB]
      .filter(Boolean)
      .join(' and ');

    const normalizedDescription = rawDescription && !isUnsafeJobPostingPhrase(rawDescription)
      ? stripBoldTags(rawDescription).replace(/\s+/g, ' ').replace(/\.$/, '')
      : 'Demonstrated impact in complex engineering environments';

    const hasKeyword = strengthKeywordPool.some((kw) =>
      normalizedDescription.toLowerCase().includes(kw.toLowerCase())
    );
    const suffix = hasKeyword || !keywordSnippet
      ? '.'
      : `. Focused on ${keywordSnippet}.`;

    return {
      title,
      description: `${normalizedDescription}${suffix}`,
    };
  });

  // The model's own wording, kept. Only sanitising and the three-sentence limit
  // run over it; the shape of the sentences is the model's to choose, and forcing
  // a lead sentence here is what made every summary read alike.
  const modelSummary = useNumeralsForExperienceYears(
    removeCompanyMentionsFromSummary(normalizeSummary((content.summary ?? '').trim()), profile)
  );
  // Last, after the sanitising, so the count is of what will print.
  const capped = capSummarySentences(modelSummary);
  if (capped.dropped > 0) {
    console.log(
      `[Resume summary] ${profile?.name ?? 'resume'}: dropped ${capped.dropped} sentence(s) past the `
        + `${MAX_SUMMARY_SENTENCES}-sentence limit.`
    );
  }
  if (capped.summary && capped.sentences < MIN_SUMMARY_SENTENCES) {
    console.warn(
      `[Resume summary] ${profile?.name ?? 'resume'}: one sentence, under the `
        + `${MIN_SUMMARY_SENTENCES}-${MAX_SUMMARY_SENTENCES} asked for.`
    );
  }
  const finalSummary = capped.summary || (profile ? buildFallbackSummary(profile) : '');

  // Measured on what will actually be rendered, after the summary has been
  // sanitised and the experience normalised. Measuring the model's raw answer
  // would count terms that the cleanup steps then removed.
  reportPlacement(profile?.name ?? 'resume', {
    summary: finalSummary,
    experience: normalizedExperience,
  }, jobAnalysis);

  /*
   * A technology the posting NAMED that reached the prose and not the block.
   *
   * REPORTED BY THE OPERATOR as "MCP and LLMs missing from the skills section
   * even though they are in the JD". Measured on a delivered resume: "Large
   * Language Models" and "RAG" were in the bullets and in neither group of the
   * block. The cause was upstream - those terms arrived on the PROSE checklist
   * because the skill library has no row for them - and that is fixed where
   * `promptSkills` is built. This is the check that says whether it held.
   *
   * Named technologies only, and only where the prose shows the model knew the
   * term: a posting term nobody wrote anywhere is an ordinary coverage miss and
   * the placement report above already counts it.
   */
  // A separator no term can span, so `containsTerm` cannot match across two
  // entries that happen to sit next to each other.
  const SKILL_TEXT_SEPARATOR = ' | ';
  const named = getJobNamedHardSkills(jobAnalysis);
  if (named.length > 0 && hardSkills.length > 0) {
    const blockText = hardSkills.join(SKILL_TEXT_SEPARATOR);
    const proseText = [finalSummary, ...normalizedExperience.flatMap((role) => role.achievements ?? [])].join(SKILL_TEXT_SEPARATOR);
    const proseOnly = named.filter((term) => containsTerm(proseText, term) && !containsTerm(blockText, term));
    if (proseOnly.length > 0) {
      console.warn(
        `[Resume skills] ${profile?.name ?? 'resume'}: ${proseOnly.length} technology(ies) this posting `
          + `named are in the bullets but not the block - ${proseOnly.slice(0, 6).join(', ')}`
          + `${proseOnly.length > 6 ? ', ...' : ''}`
      );
    }
  }

  /*
   * A concept taken out of the block has to turn up in a bullet.
   *
   * ASKED FOR: "regarding concepts, don't remove but add them to bullets of
   * experience section." The block loses it; the resume must not. The prompt
   * has required this for a long time - every concept it maps to a tool still
   * has to appear in a sentence, spelled as the posting spells it - and nothing
   * ever checked, which is how "tool calling" and "agent orchestration" ended
   * up listed in the block and written nowhere else.
   *
   * Reported, never inserted: putting the phrase into a bullet means rewriting
   * the sentence around it, and a bullet written by this file is the thing the
   * whole prompt exists to avoid.
   */
  // A separator no term can span, so a match cannot straddle two bullets.
  const PROSE_SEPARATOR = ' | ';
  if (tidied.report.routedToProse.length > 0) {
    const bullets = normalizedExperience.flatMap((role) => role.achievements ?? []).join(PROSE_SEPARATOR);
    const prose = `${finalSummary}${PROSE_SEPARATOR}${bullets}`;
    const stranded = tidied.report.routedToProse.filter((entry) => !containsTerm(prose, entry.name));
    if (stranded.length > 0) {
      console.warn(
        `[Resume routing] ${profile?.name ?? 'resume'}: ${stranded.length} of `
          + `${tidied.report.routedToProse.length} entry(ies) the model moved out of the block are `
          + `on no part of the page - `
          + `${stranded.slice(0, 6).map((entry) => `${entry.name} [${entry.kind}]`).join(', ')}`
          + `${stranded.length > 6 ? ', ...' : ''}. Each is a keyword the resume no longer has.`
      );
    } else {
      console.log(
        `[Resume routing] ${profile?.name ?? 'resume'}: all ${tidied.report.routedToProse.length} `
          + `entry(ies) moved out of the block appear in the prose.`
      );
    }
  }

  /*
   * THE HOLE THE CHECK ABOVE LEAVES, and the one the scans fell through.
   *
   * That check only looks at entries the MODEL wrote into the block and the
   * router then moved out. A concept the posting named and the model never
   * wrote anywhere is checked by nothing at all: it is not in the block, so
   * the router never saw it; it is not in a sentence; and it leaves no trace.
   *
   * MEASURED on two delivered resumes, against the scanner's own report: of
   * fourteen skills called missing, all fourteen were on no part of the page,
   * and eleven were concept or category phrases of exactly this kind.
   *
   * Reported, never inserted - the same rule as everywhere else here. What it
   * buys is the revision call, because `measureCoverageGap` counts these too.
   */
  if (jobAnalysis) {
    const blockText = hardSkills.join(SKILL_TEXT_SEPARATOR);
    const bullets = normalizedExperience.flatMap((role) => role.achievements ?? []).join(PROSE_SEPARATOR);
    const wholePage = `${finalSummary}${PROSE_SEPARATOR}${bullets}${PROSE_SEPARATOR}${blockText}`;
    const conceptsWanted = getConceptKeywords(jobAnalysis);
    const neverWritten = conceptsWanted.filter((term) => !containsTerm(wholePage, term));
    if (neverWritten.length > 0) {
      console.warn(
        `[Resume concepts] ${profile?.name ?? 'resume'}: ${neverWritten.length} of `
          + `${conceptsWanted.length} concept(s) this posting named are on NO part of the page - `
          + `${neverWritten.slice(0, 8).join(', ')}${neverWritten.length > 8 ? ', ...' : ''}. `
          + `A scanner counts each of these as a hard skill.`
      );
    } else if (conceptsWanted.length > 0) {
      console.log(
        `[Resume concepts] ${profile?.name ?? 'resume'}: all ${conceptsWanted.length} `
          + `concept(s) this posting named reached the page.`
      );
    }
  }
  // Separately, because this one needs the skills block as its vocabulary: a
  // bullet "names a tool" if it names one of the technologies THIS resume
  // claims, which is a sharper test than a list of tools kept in code.
  reportBulletShape(profile?.name ?? 'resume', normalizedExperience, hardSkills);

  // Issue 1 — phrases repeated three or more times on one resume.
  const repeated = repeatedPhrases(normalizedExperience, finalSummary);
  if (repeated.length > 0) {
    console.warn(
      `[Resume repetition] ${profile?.name ?? 'resume'}: `
        + `${repeated.length} phrase(s) repeated 3+ times: `
        + `${repeated.slice(0, 3).map((r) => `"${r.phrase}" ×${r.count}`).join(', ')}.`
    );
  }

  return {
    ...content,
    ...coverLetterFields,
    title: buildResumeHeadline(content.title, jobAnalysis, profile),
    summary: finalSummary,
    experience: normalizedExperience,
    hardSkills,
    skillGroups,
    // Empty: the soft skills print as the last group of `skillGroups`, chosen
    // by the model for this posting.
    softSkills: [],
    strengths: normalizedStrengths,
    // Keep legacy field aligned with hard skills for older templates/components.
    skills: hardSkills,
  };
}

export async function analyzeJobDescription(
  jobDescription: string,
  choice: AiChoice,
  promptId?: string,
  signal?: AbortSignal
): Promise<JobAnalysis> {
  const { provider, modelName } = choice;
  const resolvedPromptId = promptId?.trim() || DEFAULT_ANALYZE_JOB_PROMPT_ID;
  const promptValues = buildAnalyzeJobDescriptionPromptValues(jobDescription);
  const firstCallStartedAt = process.hrtime.bigint();

  /**
   * The cheapest token is the one never sent.
   *
   * This app re-analyses the same posting constantly: a sheet import re-run
   * after fixing one row, a batch regenerated against a different template, a
   * preview followed by the generate that writes the file. The call is
   * deterministic - fixed prompt, `temperature: 0` - so the same three inputs
   * give the same answer, and all three are in the key.
   *
   * The prompt's own TEXT is in it, not just its id: an admin who edits a
   * prompt and sees nothing change would have no way to tell the difference
   * between a cache and a prompt that does not work.
   */
  const promptRecord = await resolvePromptByExactId(resolvedPromptId).catch(() => null);
  const cacheKey = analysisCacheKey({
    jobDescription,
    promptText: promptRecord?.content ?? resolvedPromptId,
    model: `${provider}/${modelName}`,
  });
  const cached = readAnalysisCache<JobAnalysis>(cacheKey);
  if (cached) {
    console.log(
      '[Resume timing] First LLM call skipped: this job description was already analysed ' +
        `(${describeAiChoice(choice)})`
    );
    // The cache hands out its own copy; see `detach`. This only has to record
    // that the call took no time.
    resumeBuildTiming.set(cached, { firstCallEndedAt: process.hrtime.bigint() });
    return cached;
  }

  console.log(`[Resume timing] First LLM call started: analyze job description (${describeAiChoice(choice)})`);
  const content = await createPromptCompletion({
    promptId: resolvedPromptId,
    promptValues,
    fallbackProvider: provider,
    fallbackModelName: modelName,
    effort: choice.effort,
    thinking: choice.thinking,
    route: choice.route,
    maxTokens: 7000,
    temperature: 0,
    responseFormat: 'json',
    // Rendered by exact id, so resolved by exact id too. These used to
    // disagree: the text came from this literal record while the model
    // override came from whichever record was activated for the feature.
    useExactPromptId: true,
    signal,
  });
  const firstCallEndedAt = process.hrtime.bigint();
  console.log(`[Resume timing] First LLM call finished in ${formatDuration(firstCallStartedAt, firstCallEndedAt)}`);

  const analysis = parseJobAnalysisContent(content, jobDescription);
  writeAnalysisCache(cacheKey, analysis);
  resumeBuildTiming.set(analysis, { firstCallEndedAt });
  return analysis;
}

export async function analyzeJobDescriptionPromptRaw(
  jobDescription: string,
  choice: AiChoice,
  promptId?: string
): Promise<unknown> {
  const resolvedPromptId = promptId?.trim() || DEFAULT_ANALYZE_JOB_PROMPT_ID;
  const promptValues = buildAnalyzeJobDescriptionPromptValues(jobDescription);
  const content = await createPromptCompletion({
    promptId: resolvedPromptId,
    promptValues,
    fallbackProvider: choice.provider,
    fallbackModelName: choice.modelName,
    effort: choice.effort,
    thinking: choice.thinking,
    maxTokens: 7000,
    temperature: 0,
    responseFormat: 'json',
    useExactPromptId: true,
  });

  try {
    return JSON.parse(extractJSON(content));
  } catch (error) {
    console.error('Failed to parse raw prompt test response:', error, content);
    throw new Error('Failed to parse prompt test response');
  }
}

export function buildAnalyzeJobDescriptionPromptValues(jobDescription: string): Record<string, string> {
  return {
    jobDescription,
  };
}

export function parseJobAnalysisContent(content: string, jobDescription: string): JobAnalysis {
  try {
    const jsonText = extractJSON(content);
    const parsed = JSON.parse(jsonText) as RawNestedJobAnalysis;
    return normalizeJobAnalysisResponse(parsed, jobDescription);
  } catch (error) {
    console.error('Failed to parse model response:', error, content);
    throw new Error('Failed to parse job analysis response');
  }
}

export function buildTailorResumePromptValues(
  profile: Profile,
  jobAnalysis: JobAnalysis
): Record<string, string> {
  const { sourceJobDescription: _sourceJobDescription, ...jobAnalysisForPrompt } = jobAnalysis;
  const profileForPrompt = buildPromptProfile(profile);
  // Everything below is read off the analysis, which an AI call produced from
  // the posting. No list in this file decides what is a tool or a soft skill.
  const promptSkills = getJobNamedHardSkills(jobAnalysis);
  const conceptKeywords = getConceptKeywords(jobAnalysis);
  const conceptSet = new Set(conceptKeywords.map((keyword) => keyword.toLowerCase()));

  /*
   * Nothing the posting said is allowed to reach the prompt in no list at all.
   * Every term the analysis produced that no list above carries is appended to
   * the prose checklist, so a field somebody adds later is not silently lost.
   * Concepts have their own list and the two are kept disjoint.
   */
  const keywords = getKeywordChecklist(jobAnalysis);
  const spokenFor = [promptSkills, keywords, conceptKeywords,
    getResponsibilities(jobAnalysis), getDomainKnowledge(jobAnalysis)];
  const uncovered = findUncoveredKeywords(collectJobKeywords(jobAnalysis), spokenFor)
    .filter((keyword) => !conceptSet.has(keyword.toLowerCase()));

  const proseKeywords = normalizeSkillsList([
    ...keywords.filter((keyword) => !conceptSet.has(keyword.toLowerCase())),
    ...uncovered,
  ]);

  const promptValues = {
    profileJson: promptJson(profileForPrompt),
    jobAnalysisJson: promptJson(jobAnalysisForPrompt),
    jobTitle: getJobAnalysisTitle(jobAnalysis),
    skillsJSON: promptJson(promptSkills),
    // The same list under a second name. Kept because a custom prompt record an
    // admin wrote may reference either, and a variable a prompt names but the
    // code does not supply renders as the literal `[[hardSkillsJson]]`.
    // Unreferenced variables cost nothing: `assemblePrompt` substitutes, it
    // does not append.
    hardSkillsJson: promptJson(promptSkills),
    // The terms the Technical Skills block will NOT carry, because they name
    // ideas rather than tools and the block lists the tools instead. They are
    // still keywords an ATS scores, so the prompt is told to place each one in
    // the prose - which is where a concept belongs anyway, attached to
    // something the candidate actually did.
    conceptKeywordsJson: promptJson(conceptKeywords),
    // Disjoint from the list above, so a term is asked for once. Both are prose
    // checklists; splitting them lets the prompt say something specific about
    // concepts without saying it twice about everything else.
    keywordsJson: promptJson(proseKeywords),
    keyResponsibilitiesJson: promptJson(getResponsibilities(jobAnalysis)),

    // The five the posting leans on. The prompt builds bullets around these.
    topSkillsJson: promptJson(focusSkills(jobAnalysis)),
    // The kind of role this resume is aimed at, for the summary to name in its
    // own words. The head of the title only: a sentence can carry "Data & AI
    // Engineer" and cannot carry ", AWS, Java & Python".
    targetRoleTitle: shortRoleTitle(getJobAnalysisTitle(jobAnalysis)),
    domainKnowledge: promptJson([
      ...getDomainKnowledge(jobAnalysis),
      jobAnalysis.jobMeta.industry,
      jobAnalysis.jobMeta.department,
    ]),
  };

  return promptValues;
}

export function parseTailoredResumeContent(
  content: string,
  profile: Profile,
  jobAnalysis: JobAnalysis,
  /*
   * Set by the revision pass, which re-parses a block this function has
   * already routed. Those entries are plain strings by then - their kinds were
   * spent on the first pass - and without this every revised resume would
   * report "arrived with no kind", which is the warning that means the prompt
   * did not reach the model. A false alarm on a real failure signal is worth
   * one parameter.
   */
  options: { alreadyRouted?: boolean } = {}
): TailoredContent {
  const jsonText = extractJSON(content);
  const parsed = JSON.parse(jsonText) as TailoredContent;
  const finalResult = normalizeTailoredContent(parsed, jobAnalysis, profile, options);
  return {
    ...finalResult,
    softSkills: finalResult.softSkills,
    skills: finalResult.hardSkills,
  };
}

function getProfileResumePromptId(profile: Profile): string {
  return profile.profileSettings?.resumePromptId?.trim() || DEFAULT_RESUME_PROMPT_ID;
}

function getProfileCoverLetterPromptId(profile: Profile): string {
  return profile.profileSettings?.coverLetterPromptId?.trim() || DEFAULT_COVER_LETTER_PROMPT_ID;
}

export async function tailorResume(
  profile: Profile,
  jobAnalysis: JobAnalysis,
  choice: AiChoice,
  signal?: AbortSignal
): Promise<TailoredContent> {
  const { provider, modelName } = choice;
  const promptId = getProfileResumePromptId(profile);
  const promptValues = buildTailorResumePromptValues(profile, jobAnalysis);
  const secondCallStartedAt = process.hrtime.bigint();
  const timing = resumeBuildTiming.get(jobAnalysis);
  if (timing) {
    console.log(`[Resume timing] Time between first LLM finish and second LLM start: ${formatDuration(timing.firstCallEndedAt, secondCallStartedAt)}`);
  }
  console.log(`[Resume timing] Second LLM call started: tailor resume (${describeAiChoice(choice)})`);
  const content = await createPromptCompletion({
    promptId,
    // The prompt record can be a per-profile custom one; the timeout and the
    // usage bucket belong to the FEATURE, which is always this.
    callSite: DEFAULT_RESUME_PROMPT_ID,
    promptValues,
    fallbackProvider: provider,
    fallbackModelName: modelName,
    effort: choice.effort,
    thinking: choice.thinking,
    route: choice.route,
    maxTokens: 11000,
    temperature: 0.2,
    responseFormat: 'json',
    useExactPromptId: true,
    // Appended to the user turn rather than concatenated onto the rendered
    // text, which is what it used to be. That concatenation only reached
    // providers taking a single flat string, so the instruction was silently
    // absent on the structured path - and the code below assumes the model
    // obeyed it, because skills are decided here, not by the model.
    appendToUserBody: finalSkillOverride(),
    signal,
  });
  const secondCallEndedAt = process.hrtime.bigint();
  console.log(`[Resume timing] Second LLM call finished in ${formatDuration(secondCallStartedAt, secondCallEndedAt)}`);

  const checked = await checkSkillBlock(content, profile, jobAnalysis, choice, signal);

  let tailored: TailoredContent;
  try {
    tailored = parseTailoredResumeContent(checked.text, profile, jobAnalysis);
  } catch {
    console.error('Failed to parse model response:', content);
    throw new Error('Failed to parse tailored resume response');
  }

  /*
   * The floors, enforced rather than requested - but only where the call pays
   * for itself.
   *
   * WHAT THIS COST BEFORE THE GATE. The first version asked again whenever
   * anything at all was missing, which with a 100% floor over a 25-45 term
   * checklist is nearly every resume: a batch of 500 went from 0.84 hours of
   * working time to 2.21. Now a stray ordinary term is reported and left; a
   * missing FOCUS skill or concept, three or more missing terms, or a page
   * under the figure floor is what buys a call.
   *
   * And the call is a small one: its own short prompt, the draft's sentences,
   * and a patch back - not the whole 36,853-character tailoring prompt and the
   * whole resume, which is what made the second call cost as much as the first.
   *
   * If the revision fails, parses badly, or covers no more than the draft did,
   * the draft stands: a thin resume is worth more than no resume.
   */
  const gap = measureCoverageGap(tailored, jobAnalysis, checked.concepts);
  if (gap.inBlockOnly.length > 0) {
    console.log(
      `[Resume coverage] ${profile.name}: ${gap.inBlockOnly.length} checklist term(s) are in the `
        + `skills block and in no sentence. Counted as placed, not asked for again - `
        + `${gap.inBlockOnly.slice(0, 8).join(', ')}${gap.inBlockOnly.length > 8 ? ', ...' : ''}`
    );
  }
  const hasBullets = (tailored.experience ?? []).some((role) => (role.achievements ?? []).length > 0);
  if (!gap.short || !hasBullets || !coverageRevisionEnabled()) {
    if (gap.missingTerms.length > 0) {
      console.log(
        `[Resume coverage] ${profile.name}: ${gap.missingTerms.length} checklist term(s) missing, `
          + `not enough to pay for a revision. Missing: ${gap.missingTerms.slice(0, 8).join(', ')}`
      );
    }
    return tailored;
  }

  console.log(`[Resume coverage] ${profile.name}: ${gap.reason} - asking for a revision.`);
  try {
    const revisedText = await createPromptCompletion({
      promptId: RESUME_REVISION_PROMPT_ID,
      callSite: RESUME_REVISION_PROMPT_ID,
      promptValues: revisionPromptValues(tailored, gap),
      fallbackProvider: provider,
      fallbackModelName: modelName,
      effort: choice.effort,
      thinking: choice.thinking,
      route: choice.route,
      // A patch, not a resume: the summary and the bullets of the roles it
      // touched. A tenth of what the tailoring call has to produce.
      maxTokens: 2500,
      temperature: 0.2,
      responseFormat: 'json',
      useExactPromptId: true,
      signal,
    });

    const merged = mergeRevision(tailored, JSON.parse(extractJSON(revisedText)));
    if (!merged) {
      console.warn(`[Resume coverage] ${profile.name}: the revision changed nothing. Keeping the draft.`);
      return tailored;
    }

    // Back through the same normalisation the draft went through: the bullet
    // cap, the plain-language pass and the reports all apply to a revised
    // sentence exactly as they did to the first one.
    const revised = parseTailoredResumeContent(JSON.stringify({
      title: merged.title,
      summary: merged.summary,
      experience: merged.experience,
      skillGroups: merged.skillGroups,
      coverLetter: merged.coverLetter,
      // The block came back from the first pass already routed, so its entries
      // are names without kinds and there is nothing left to route.
    }), profile, jobAnalysis, { alreadyRouted: true });
    const after = measureCoverageGap(revised, jobAnalysis, checked.concepts);
    // Better on either axis, worse on neither: a revision that places three
    // terms by dropping two figures has not helped.
    const placedMore = after.missingTerms.length < gap.missingTerms.length;
    const countedMore = after.figures > gap.figures;
    // The summary counts as an axis of its own: one sentence made two or three
    // is better, and two or three made one is worse.
    const twoOrMore = (count: number) => count >= MIN_SUMMARY_SENTENCES;
    const fixedSummary = !twoOrMore(gap.summarySentences) && twoOrMore(after.summarySentences);
    const brokeSummary = twoOrMore(gap.summarySentences) && !twoOrMore(after.summarySentences);
    if ((placedMore || countedMore || fixedSummary) && after.missingTerms.length <= gap.missingTerms.length
      && after.figures >= gap.figures && !brokeSummary) {
      console.log(
        `[Resume coverage] ${profile.name}: revision placed `
          + `${gap.missingTerms.length - after.missingTerms.length} more term(s) and carries ${after.figures} figure(s)`
          + `${fixedSummary ? `, and the summary is now ${after.summarySentences} sentences` : ''}.`
      );
      return revised;
    }
    /*
     * WHICH CONDITION FAILED, and both numbers for each.
     *
     * "No better" covered three different outcomes - fewer terms placed, fewer
     * figures, or neither axis moved - and an operator reading it could not
     * tell which. The one that matters is a revision REJECTED for losing a
     * checklist term while adding the figures a page was short of: the gate
     * takes it whole or not at all, so a draft under the figure floor ships.
     */
    const lostTerms = after.missingTerms.length > gap.missingTerms.length;
    const lostFigures = after.figures < gap.figures;
    const why = brokeSummary
      ? 'it cut the summary to one sentence'
      : lostTerms && lostFigures
      ? 'it lost ground on both'
      : lostTerms
        ? 'it placed more figures but lost a checklist term, and the gate takes the revision whole'
        : lostFigures
          ? 'it placed more terms but lost a figure, and the gate takes the revision whole'
          : 'neither axis moved';
    console.warn(
      `[Resume coverage] ${profile.name}: the revision was rejected - ${why}. `
        + `Missing terms ${gap.missingTerms.length} -> ${after.missingTerms.length}, `
        + `figures ${gap.figures} -> ${after.figures} (floor ${FIGURE_FLOOR}). Keeping the draft.`
    );
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    /*
     * THE CALL FAILED, which is a different thing from the answer being no
     * better - and the two used to end in the same place, this catch, with the
     * draft shipping either way.
     */
    if (coverageRevisionFailureIsFatal()) {
      console.warn(
        `[Resume coverage] ${profile.name}: the revision call failed (${said}). `
          + `Failing the build so it is retried rather than shipped short. `
          + `Set RESUME_REVISION_SOFT_FAIL to keep the draft instead.`
      );
      throw asRevisionFailure(error);
    }
    console.warn(
      `[Resume coverage] ${profile.name}: the revision failed (${said}). Keeping the draft `
        + `(RESUME_REVISION_SOFT_FAIL).`
    );
  }
  return tailored;
}

/**
 * Generate a cover letter body when no job description is provided.
 * Returns only the body text (no salutation or sign-off).
 */
export async function generateCoverLetter(
  profile: Profile,
  companyName: string,
  role: string,
  choice: AiChoice,
  signal?: AbortSignal
): Promise<string> {
  const promptId = getProfileCoverLetterPromptId(profile);
  const promptValues = {
    // The same projection the tailoring call uses. A cover letter needs the
    // person's history and nothing about this installation - and it certainly
    // does not need their phone number, which is what the whole record carried.
    profileJson: promptJson(buildPromptProfile(profile)),
    companyName,
    role,
  };
  const content = await createPromptCompletion({
    promptId,
    callSite: DEFAULT_COVER_LETTER_PROMPT_ID,
    promptValues,
    fallbackProvider: choice.provider,
    fallbackModelName: choice.modelName,
    effort: choice.effort,
    thinking: choice.thinking,
    route: choice.route,
    maxTokens: 1500,
    // The only caller that wants sampling variety rather than determinism.
    // The CLI provider cannot honour it and says so once; pin this prompt to
    // the `claude` provider in the admin UI if the prose becomes too uniform.
    temperature: 0.7,
    responseFormat: 'text',
    useExactPromptId: true,
    signal,
  });
  return content.trim();
}

export async function extractTemplateFromPDF(
  pdfText: string,
  templateName: string,
  provider: AIProvider = DEFAULT_PROVIDER,
  signal?: AbortSignal
): Promise<{ html: string; css: string; sections: string[] }> {
  const promptValues = {
    pdfText,
    templateName,
  };
  const content = await createPromptCompletion({
    promptId: 'extract-template-from-pdf',
    signal,
    promptValues,
    fallbackProvider: provider,
    maxTokens: 8000,
    temperature: 0,
    responseFormat: 'json',
    // Runtime resolution on purpose: this feature's prompt can be replaced by
    // an activated custom variant in the admin panel, and pinning the exact id
    // would ignore it. (The tailor and analyze callers are exact because that
    // is what their rendering already used.)
  });

  try {
    const jsonText = extractJSON(content);
    return JSON.parse(jsonText);
  } catch {
    console.error('Failed to parse model response:', content);
    throw new Error('Failed to parse template extraction response');
  }
}

export async function extractProfileFromResume(
  resumeText: string,
  provider: AIProvider = DEFAULT_PROVIDER,
  signal?: AbortSignal
): Promise<Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>> {
  const promptValues = {
    resumeText,
  };
  const content = await createPromptCompletion({
    promptId: 'extract-profile-from-resume',
    signal,
    promptValues,
    fallbackProvider: provider,
    maxTokens: 4000,
    temperature: 0,
    responseFormat: 'json',
    // Runtime resolution: see the note in extractTemplateFromPDF.
  });

  try {
    const jsonText = extractJSON(content);
    return JSON.parse(jsonText);
  } catch {
    console.error('Failed to parse model response:', content);
    throw new Error('Failed to parse profile extraction response');
  }
}

export { DEFAULT_PROVIDER };
