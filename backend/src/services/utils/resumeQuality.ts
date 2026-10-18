/**
 * The three faults that can be measured without reading the sentence.
 *
 * The operator's list of eight resume-quality faults is answered in the
 * tailoring prompt, under SEVEN FAULTS A HUMAN READER CATCHES BEFORE A SCANNER
 * DOES - that is where a rule can change what the model writes. Three of them
 * can also be checked afterwards by a machine, which is what this file is:
 *
 *   - a skills entry that is another entry plus nothing but filler words,
 *     which is REMOVED, because there is no judgement in it;
 *   - a technology named in a role that ended before it existed, which is
 *     REPORTED, because only the model can rewrite the bullet;
 *   - a figure of the shape "by 40 minutes to 6", which is REPORTED for the
 *     same reason.
 *
 * Everything else on that list - culture phrases, activity chains, missing
 * tools, missing scale, expanding scope - needs a sentence rewritten, and a
 * rule in the prompt is the only thing that can do it. Nothing here edits
 * prose.
 */

/*
 * ─── One entry per real skill ────────────────────────────────────────────────
 *
 * REPORTED AS keyword stuffing: "data pipelines, data pipeline operations,
 * production pipeline operations, pipeline monitoring, data pipeline
 * management". Measured over 70 delivered resumes, 3.1 entries per resume were
 * another entry of the same block plus a word or two - "performance" beside
 * "performance tuning", "GitHub Copilot" beside "GitHub Copilot app", "agent
 * runtime" beside "agent runtime execution".
 *
 * THE RULE IS DELIBERATELY NARROW. The entry is only dropped when its extra
 * words are ALL from the list below: words that describe an activity or a
 * quality around a thing and are never the distinguishing part of a product's
 * name. That is what keeps "AWS Lambda" beside "AWS", "SQL Server" beside
 * "SQL", "Azure DevOps" beside "Azure" and "React Native" beside "React" -
 * every one of those would die under a plain "one entry's words are inside
 * another's" test, and each is a different thing from its prefix.
 *
 * What the list cannot catch - "production pipeline operations" against "data
 * pipelines", where the head words differ - stays a judgement, and judgements
 * stay in the prompt.
 */
const FILLER_SKILL_WORDS = [
  'operation',
  'operations',
  'management',
  'administration',
  'optimization',
  'optimisation',
  'tuning',
  'execution',
  'lifecycle',
  'methodology',
  'methodologies',
  'practice',
  'practices',
  'process',
  'processes',
  'procedures',
  'workflow',
  'workflows',
  'strategy',
  'strategies',
  'technique',
  'techniques',
  'skill',
  'skills',
  'expertise',
  'experience',
  'knowledge',
  'proficiency',
  'fundamentals',
  'concepts',
  'principles',
  'mindset',
  'outcome',
  'outcomes',
  'app',
  'apps',
  'application',
  'applications',
  'framework',
  'frameworks',
  'library',
  'libraries',
  'tool',
  'tools',
  'tooling',
  'platform',
  'system',
  'systems',
  'technology',
  'technologies',
  'stack',
  'development',
  'engineering',
  'programming',
  'scripting',
  'usage',
  /*
   * Added after nine delivered blocks were read entry by entry. Each of these
   * turned up only as padding on a term already in the same block:
   * "Observability implementation", "AI compliance implementation", "automated
   * testing implementation", "Kubernetes orchestration", "model registry
   * integration", "Infrastructure migration", "requirements gap handling",
   * "risk identification", "emerging techniques adoption". Forty-five such
   * pairs, none of which the first list caught.
   */
  'implementation',
  'integration',
  'orchestration',
  'migration',
  'validation',
  'identification',
  'adoption',
  'handling',
];

/**
 * Products whose name ends in one of those words.
 *
 * "integration" earns its place on the list above and also ends the name of a
 * real product, so the pair "Spring" and "Spring Integration" would lose the
 * product. These are checked before anything is dropped. The list is short
 * because it only needs the cases where BOTH halves of the pair would be in
 * one block - a product standing alone is never compared to anything.
 */
const PRODUCTS_ENDING_IN_FILLER = new Set([
  'spring integration',
  'azure integration services',
  'oracle integration cloud',
  'sap integration suite',
  'adobe experience platform',
  'power platform',
  'power apps',
  'azure automation',
  'camel integration',
]);

/**
 * A skill as a list of words, lower-cased and with plurals folded in.
 *
 * `+`, `#` and `.` survive the split, because they are part of the name in
 * "C++", "C#" and "Node.js". A trailing "s" comes off anything longer than
 * three letters, so "data pipelines" and "data pipeline" are the same two
 * words - and "AWS", "ops" and "js" are short enough to be left alone.
 *
 * A word with a dot in it keeps its "s": "Node.js" and "Next.js" wear it as
 * part of the name, and a plural rule that turned them into "node.j" would be
 * comparing a product against something that does not exist.
 */
export function skillWords(skill: string): string[] {
  const singular = (word: string) =>
    word.length > 3 && word.endsWith('s') && !word.includes('.') ? word.slice(0, -1) : word;

  return skill
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter(Boolean)
    .map(singular);
}

const FILLER_WORD_SET = new Set(FILLER_SKILL_WORDS.flatMap((word) => skillWords(word)));

/**
 * Whether `longer` is `shorter` with nothing added but filler.
 *
 * Both are compared as sets of words, so "pipeline operations data" would count
 * as well - a reordering is the same padding written differently.
 */
export function restatesSkill(shorter: string, longer: string): boolean {
  if (PRODUCTS_ENDING_IN_FILLER.has(longer.trim().toLowerCase().replace(/\s+/g, ' '))) return false;

  const base = new Set(skillWords(shorter));
  const extended = new Set(skillWords(longer));
  if (base.size === 0 || extended.size <= base.size) return false;

  for (const word of base) {
    if (!extended.has(word)) return false;
  }

  for (const word of extended) {
    if (!base.has(word) && !FILLER_WORD_SET.has(word)) return false;
  }

  return true;
}

/** The two entries of a pair, in the order they were written. */
export type RestatedSkill = { kept: string; dropped: string };

/**
 * Removes the entries that only restate one already in the block.
 *
 * THE SHORTER WORDING SURVIVES, in the EARLIER one's position.
 *
 * Measured over 198 delivered resumes, the pairs this finds are mostly a
 * posting's own term beside a padded version of it - "CI/CD" against "CI/CD
 * operations", "APIs" against "API development", "Ownership" against
 * "Ownership mindset", "GitHub Copilot" against "GitHub Copilot app". A
 * scanner matches strings, and the short form is the one the posting wrote and
 * the one it will match, so keeping whichever happened to be written first
 * threw away the better half of five pairs out of seven.
 *
 * The POSITION is kept rather than the wording, because the model is asked to
 * write the block most relevant first and that order is its judgement. So the
 * survivor sits where the first of the pair sat, spelled as the shorter of the
 * two.
 *
 * This is also what the prompt tells the model to do - "keep the shorter and
 * delete the longer" - and the two have to agree, or the prompt is describing
 * an application that does something else.
 */
export function dropRestatedSkills(skills: readonly string[]): {
  skills: string[];
  restated: RestatedSkill[];
} {
  const kept: string[] = [];
  const restated: RestatedSkill[] = [];

  for (const skill of skills) {
    // `restatesSkill(a, b)` is true when b is a plus filler, so a is the
    // shorter of the two in the first branch and the longer in the second.
    const longerAt = kept.findIndex((earlier) => restatesSkill(skill, earlier));
    if (longerAt >= 0) {
      restated.push({ kept: skill, dropped: kept[longerAt] });
      kept[longerAt] = skill;
      continue;
    }

    const shorter = kept.find((earlier) => restatesSkill(earlier, skill));
    if (shorter) restated.push({ kept: shorter, dropped: skill });
    else kept.push(skill);
  }

  return { skills: kept, restated };
}

/**
 * The same removal, across the groups the block is printed in.
 *
 * One pass over the whole block rather than one per group: the pairs an
 * operator sees are often a group apart - "Performance" under Monitoring and
 * "Performance tuning" under Databases - and the prompt bans the same thing in
 * two groups for exactly that reason. A survivor that arrives later keeps the
 * earlier entry's place, group included, for the reason given above.
 */
export function dropRestatedSkillsFromGroups<T extends { category: string; skills: string[] }>(
  groups: readonly T[]
): { groups: T[]; restated: RestatedSkill[] } {
  const result = groups.map((group) => ({ ...group, skills: [] as string[] }));
  const restated: RestatedSkill[] = [];
  // Where each surviving entry sits, so a shorter wording arriving later can
  // take the place of the longer one it replaces.
  const placed: Array<{ skill: string; group: number; index: number }> = [];

  groups.forEach((group, groupIndex) => {
    for (const skill of group.skills) {
      const longer = placed.find((entry) => restatesSkill(skill, entry.skill));
      if (longer) {
        restated.push({ kept: skill, dropped: longer.skill });
        result[longer.group].skills[longer.index] = skill;
        longer.skill = skill;
        continue;
      }

      const shorter = placed.find((entry) => restatesSkill(entry.skill, skill));
      if (shorter) {
        restated.push({ kept: shorter.skill, dropped: skill });
        continue;
      }

      result[groupIndex].skills.push(skill);
      placed.push({ skill, group: groupIndex, index: result[groupIndex].skills.length - 1 });
    }
  });

  return { groups: result as T[], restated };
}

/*
 * ─── The block is a list of names, not a list of phrases ─────────────────────
 *
 * REPORTED, with nine delivered blocks as the evidence: "Redis-backed caching
 * and rate limiting", "security controls implementation", "debugging and
 * diff-based validation", "AI product engineering roadmap", "requirements gap
 * handling". Measured over those 399 entries, 20% were three words or longer
 * and 43% ended in an abstract suffix. A reader scans this block in about two
 * seconds, and a sentence in it costs more than the keyword it carries.
 *
 * A PROPER NAME IS ALLOWED TO BE LONG. "Large Language Models", "Infrastructure
 * as Code", "Model Context Protocol" and "Amazon Web Services" are all three
 * words or more and all belong, so length alone cannot decide it. What decides
 * it is whether the thing is NAMED: a product carries its capitals, and a
 * description does not.
 */

/** Words a name may contain in lower case without being a description. */
const NAME_PARTICLES = new Set(['as', 'of', 'for', 'in', 'on', 'to', 'the', 'a', 'an', 'with', 'by']);

/**
 * Whether an entry describes a thing rather than naming one.
 *
 * Deliberately not applied to one and two word entries: "unit testing",
 * "k-fold cross-validation" and "data pipelines" are how an engineer would
 * write them, and a rule that reached them would be rewriting the block rather
 * than tidying it.
 */
export function looksLikeADescription(entry: string): boolean {
  const text = entry.trim();
  if (!text) return false;

  /*
   * A bare past-tense verb, which reached a delivered block as "owned". The
   * analyser is asked for past-tense verbs under `keywords.actionVerbs` - they
   * are what a bullet opens with - and they go onto the same prose checklist as
   * everything else, so the model parked one in the skills block. It is
   * something the candidate DID, not something they know.
   *
   * "Embedded" is the exception a reader would object to: embedded work is a
   * field, and the word is a skill in a way "owned" never is. Three letters
   * before the "ed", so "Red" and "Fred" are not read as verbs.
   */
  if (/^[a-z]{3,}ed$/i.test(text) && text.toLowerCase() !== 'embedded') return true;
  // A name joining two things with "and" is a sentence fragment, at any length:
  // "instrumentation and monitoring" is two entries written as one.
  if (/\band\b/i.test(text)) return true;

  const words = text.split(/\s+/);
  if (words.length < 3) return false;

  const significant = words.filter((word) => !NAME_PARTICLES.has(word.toLowerCase()));
  const named = significant.filter((word) => /^[A-Z0-9]/.test(word)).length;
  return named < significant.length;
}

/*
 * ─── The soft-skill group is a short list of recognisable skills ─────────────
 *
 * REPORTED: "ambiguity tolerance", "early sharing", "decision agility", "high
 * bar for quality", "fast-paced execution", "reversible decision-making",
 * "working closely with design", "trust calibration for AI tools", "default to
 * collaborative action", "opinionated engineering judgments", "taste-driven
 * engineering decisions", "iteration and willingness to discard work". Eighty
 * of 399 entries - a fifth of every block - came from one instruction telling
 * the model to fill the last group with the soft skills the posting named,
 * "spelled as the posting spells them". The posting spells them as its own
 * recruiting copy, so that is what the resume printed.
 *
 * AN ALLOWLIST, NOT A BAN LIST, because the shapes are endless and a company
 * writes a new one every quarter. These are the terms a reader recognises as a
 * skill and a scanner scores as one; anything else is the posting describing
 * itself.
 *
 * THE COST, STATED PLAINLY: where a posting writes "ambiguity tolerance" and
 * the resume writes "Adaptability", a scanner matching that exact string does
 * not match. That is the trade the operator chose after seeing nine blocks of
 * it, and it is a trade rather than a win.
 */
export const SOFT_SKILL_VOCABULARY = [
  'accountability',
  'adaptability',
  'analytical thinking',
  'attention to detail',
  'coaching',
  'code review',
  'collaboration',
  'communication',
  'communication skills',
  'conflict management',
  'continuous learning',
  'critical thinking',
  'cross-functional collaboration',
  'customer focus',
  'decision making',
  'design review',
  'documentation',
  'empathy',
  'flexibility',
  'initiative',
  'knowledge sharing',
  'leadership',
  'mentoring',
  'negotiation',
  'onboarding',
  'ownership',
  'presentation skills',
  'prioritization',
  'prioritisation',
  'problem solving',
  'project management',
  'relationship building',
  'requirements gathering',
  'root cause analysis',
  'self-motivated',
  'stakeholder communication',
  'stakeholder management',
  'teamwork',
  'technical writing',
  'time management',
  'troubleshooting',
  'verbal communication',
  'written communication',
];

/**
 * The same terms as a posting might hyphenate or pluralise them.
 *
 * Only spelling variants of a term already on the list - this is not a synonym
 * table, and "ambiguity tolerance" does not map to "Adaptability". A phrase the
 * list does not hold is refused, not translated, because translating it would
 * put words in the candidate's mouth that the posting chose.
 */
const SOFT_SKILL_SPELLINGS = new Set(
  SOFT_SKILL_VOCABULARY.flatMap((term) => [
    term,
    term.replace(/-/g, ' '),
    term.replace(/\s/g, '-'),
    `${term}s`,
    `${term} skills`,
  ])
);

/**
 * Vague category words, which the operator named beside the soft skills.
 *
 * "Cloud" and "Infrastructure" are not things anybody installs; they are the
 * heading a group of real tools sits under, printed as though they were one of
 * the tools. A block that lists AWS, Terraform AND "Infrastructure" has said
 * the same thing twice, once with nothing in it.
 */
const VAGUE_SKILL_WORDS = new Set([
  'cloud',
  'cloud platforms',
  'cloud platform',
  'infrastructure',
  'platform',
  'platforms',
  'systems',
  'data',
  'software',
  'technology',
  'technologies',
  'tools',
  'tooling',
  'applications',
  'engineering practices',
  'practices',
  'best practices',
  'methodologies',
  'frameworks',
  'libraries',
  /*
   * Single abstract nouns, which the analyser and the old skill library both
   * produced and which survived the first pass of this rule: "Focus",
   * "Innovation", "Reliability", "Responsibility", "Acceptance", "Precision",
   * "Clarity", "Execution", "Analytical" all printed in delivered blocks. None
   * is a thing anybody installs or a skill anybody screens for, and unlike
   * "Logs" or "Echo" none is also a product, so there is nothing to weigh.
   */
  'focus',
  'accuracy',
  'innovation',
  'reliability',
  'responsibility',
  'acceptance',
  'precision',
  'clarity',
  'execution',
  'analytical',
  'quality',
  'efficiency',
  'performance',
  'scalability',
  'availability',
  'maintainability',
]);

/** Whether an entry names a category rather than a thing. */
export function isVagueSkill(entry: string): boolean {
  return VAGUE_SKILL_WORDS.has(entry.trim().toLowerCase().replace(/\s+/g, ' '));
}

/**
 * Whether an entry is a soft skill.
 *
 * NOW A DETECTOR, NOT AN ALLOWLIST. It was written to decide which soft skills
 * could stand in the block's last group; the operator then asked for no soft
 * skills in the block at all - "show them through bullets instead" - so the
 * same list now says which entries to take OUT, wherever they appear. The
 * prose rules are untouched: every one of these is still required in a
 * sentence, under SOFT SKILLS ARE PROSE, which is where a reader believes them.
 */
export function isAllowedSoftSkill(entry: string): boolean {
  const text = entry.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return false;
  return SOFT_SKILL_SPELLINGS.has(text) || SOFT_SKILL_SPELLINGS.has(text.replace(/ skills$/, ''));
}

/*
 * ─── Forty, enforced where it is counted ─────────────────────────────────────
 *
 * The prompt has said "at most 40, past which nobody reads the list" for as
 * long as the model has written the block, and six of nine delivered blocks ran
 * from 41 to 59. The ceiling is 45 now, raised with the floor: at 35 required
 * and 40 allowed the band was too narrow to write in. Nothing counted, so nothing held - the same shape as the
 * bullet cap, which IS enforced, and for the same reason: a ceiling nobody
 * applies is a suggestion.
 *
 * FROM THE LONGEST GROUP'S TAIL. The model writes each group most relevant
 * first, so the last entry of the longest group is the least relevant entry in
 * the most padded group. Taking it from the end of the BLOCK would delete the
 * soft-skill group, which the prompt puts last on purpose.
 */
export const MAX_SKILL_BLOCK_SIZE = 45;

export function capSkillBlock<T extends { category: string; skills: string[] }>(
  groups: readonly T[],
  cap: number = MAX_SKILL_BLOCK_SIZE
): { groups: T[]; dropped: string[] } {
  const result = groups.map((group) => ({ ...group, skills: [...group.skills] }));
  const dropped: string[] = [];

  const total = () => result.reduce((count, group) => count + group.skills.length, 0);
  while (total() > cap) {
    let longest = 0;
    for (let i = 1; i < result.length; i += 1) {
      if (result[i].skills.length > result[longest].skills.length) longest = i;
    }
    if (result[longest].skills.length === 0) break;
    dropped.push(result[longest].skills.pop() as string);
  }

  return { groups: result as T[], dropped };
}

/*
 * ─── A concept is not a thing you install ────────────────────────────────────
 *
 * ASKED FOR: "I don't need concepts in skill section, instead add real tools.
 * And regarding concepts, don't remove but add them to bullets of experience
 * section." Both halves matter: the block loses the concept, the resume does
 * not. The prompt has said this for a long time - A CONCEPT BECOMES THE TOOL IT
 * IS BUILT WITH, and the concept itself goes in a sentence - and nothing ever
 * checked, so delivered blocks carried "tool calling", "agent orchestration",
 * "quota enforcement", "security hardening", "latency optimization", "feature
 * extraction", "fast iteration" and "research-driven goals".
 *
 * WHY NOT `isConceptSkill`, which already exists in hardSkillSelection. It was
 * built to choose entries out of a 1,492-row library, and measured against
 * these blocks it disagrees with the operator in both directions at once: it
 * takes out "CI/CD", "APIs", "Observability", "DevOps" and "Large Language
 * Models" - the highest-value strings a scanner matches - while leaving "tool
 * calling", "agent orchestration", "feature extraction" and "fast iteration"
 * in. A second, narrower rule is worth more than a shared one that is wrong.
 */

/**
 * The last word of a practice.
 *
 * "Capacity Planning", "Data Modeling", "Experiment Tracking", "API design",
 * "quota enforcement", "latency optimization", "security hardening" - the head
 * noun names an activity, and the thing it is done WITH is what the block
 * wants. Case-insensitive on purpose: the posting's capitalisation decides
 * nothing here, and "Prompt Engineering" is the same entry as "prompt
 * engineering".
 */
const CONCEPT_HEAD_WORDS = new Set([
  'engineering',
  'optimization',
  'optimisation',
  'automation',
  'orchestration',
  'management',
  'monitoring',
  'planning',
  'tracking',
  'modeling',
  'modelling',
  'validation',
  'scoring',
  'hardening',
  'enforcement',
  'limiting',
  'troubleshooting',
  'identification',
  'iteration',
  'calling',
  'tuning',
  'testing',
  'analysis',
  'design',
  'deployment',
  'governance',
  'provisioning',
  'instrumentation',
  'administration',
  'maintenance',
  'refactoring',
  'debugging',
  'extraction',
  'transformation',
  'ingestion',
  'migration',
  'integration',
  'integrations',
  'lifecycle',
  'readiness',
  'resilience',
  'weighting',
  'serving',
  'explanations',
  'practices',
  'methodology',
  'methodologies',
  'principles',
  'strategy',
  'goals',
  'logic',
  // Added after reading the first pass over nine delivered blocks: these got
  // through, and each named an activity. "Observability implementation" is the
  // one worth naming - it survived because its shorter half, "Observability",
  // had already been removed as a concept, so nothing was left for it to
  // restate.
  'implementation',
  'operations',
  'operation',
  'compliance',
  'oversight',
]);

/** Concepts that are one word, or whose head noun is ordinary. */
const CONCEPT_EXACT = new Set([
  'observability',
  'devops',
  'mlops',
  'dataops',
  'devsecops',
  'authentication',
  'authorization',
  'authorisation',
  'microservices',
  'serverless',
  'event-driven',
  'event driven',
  'infrastructure as code',
  'continuous integration',
  'continuous delivery',
  'continuous deployment',
  'agile',
  'scrum',
  'kanban',
  'test-driven development',
  'pair programming',
  'event sourcing',
  'feature flags',
  'error budgets',
  'api contracts',
  'backtesting',
  'autoscaling',
  'telephony',
  'embeddings',
]);

/**
 * Lowercase names that really are products.
 *
 * The second rule below reads an all-lowercase phrase as a description of work,
 * which is true of "tool calling" and "feature extraction" and false of these.
 * A product missing from this list is reported and removed, which is the cost
 * of the rule - so it holds the ones this stack actually uses.
 */
const LOWERCASE_PRODUCTS = new Set([
  'dbt',
  'httpx',
  'asyncio',
  'aiohttp',
  'scikit-learn',
  'numpy',
  'pandas',
  'pytest',
  'pytorch',
  'nginx',
  'npm',
  'pnpm',
  'yarn',
  'webpack',
  'vite',
  'eslint',
  'prettier',
  'pgvector',
  'psycopg',
  'sqlalchemy',
  'fastapi',
  'uvicorn',
  'gunicorn',
  'celery',
  'kubectl',
  'helm',
  'terraform',
  'ansible',
  'grpc',
  'graphql',
  'webhooks',
  'websockets',
  'cron',
  'bash',
  'curl',
  'git',
  'jq',
]);

/**
 * Whether a block entry names a practice rather than a thing.
 *
 * TWO RULES, and both are narrow on purpose:
 *
 *   1. The head noun is an activity: "Capacity Planning", "API design".
 *      Case-insensitive, so the posting's capitals cannot smuggle one through.
 *   2. Every word is lower case and there are two or more of them: "tool
 *      calling", "context graph", "text data", "research-driven goals". A
 *      product keeps its capitals - Redis, Airflow, PostgreSQL, tRPC - and the
 *      lowercase ones that do not are named above.
 *
 * WHAT THIS DELIBERATELY LEAVES IN: "CI/CD", "APIs", "REST", "Large Language
 * Models", "RAG", "AI". Each is a concept by a strict reading and each is among
 * the strings a scanner weights most, so taking them out of the block would
 * cost more than the tidiness is worth. They are also required in the prose,
 * where they are attached to work - which is the half of the rule that makes
 * leaving them here defensible rather than lazy.
 */
export function isConceptEntry(entry: string): boolean {
  const text = entry.trim().replace(/\s+/g, ' ');
  if (!text) return false;

  const lower = text.toLowerCase();
  if (LOWERCASE_PRODUCTS.has(lower)) return false;
  if (CONCEPT_EXACT.has(lower)) return true;

  const words = lower.split(/[\s]+/).filter(Boolean);
  const head = words[words.length - 1].replace(/[^a-z-]/g, '');
  if (CONCEPT_HEAD_WORDS.has(head)) return true;

  // Rule 2: a phrase written the way work is described, not the way a product
  // is named. One word is not enough to tell - "telephony" and "genomics" read
  // the same as "kubectl" - so those are decided by the lists above alone.
  if (words.length < 2) return false;
  if (/[A-Z0-9]/.test(text)) return false;
  return !words.some((word) => LOWERCASE_PRODUCTS.has(word));
}

/**
 * Everything the application takes out of the block, in one pass.
 *
 * The block is still the model's answer: nothing here reorders it, renames a
 * group, translates a term or adds anything. Each removal is a rule the prompt
 * already states, applied where it can be counted - and the prompt says so, so
 * that the two describe the same application.
 */
export type SkillBlockTidyReport = {
  repeated: string[];
  restated: RestatedSkill[];
  described: string[];
  softOrVague: string[];
  concepts: string[];
  trimmed: string[];
};

export function tidySkillGroups<T extends { category: string; skills: string[] }>(
  groups: readonly T[],
  options: { cap?: number } = {}
): { groups: T[]; report: SkillBlockTidyReport } {
  const report: SkillBlockTidyReport = {
    repeated: [],
    restated: [],
    described: [],
    softOrVague: [],
    concepts: [],
    trimmed: [],
  };

  // 1. The same string twice, first written winning. The oldest rule here, and
  //    the only one that was ever enforced.
  const seen = new Set<string>();
  let working = groups.map((group) => ({
    ...group,
    skills: group.skills.filter((skill) => {
      const key = skill.toLowerCase();
      if (seen.has(key)) {
        report.repeated.push(skill);
        return false;
      }
      seen.add(key);
      return true;
    }),
  }));

  // 2. Descriptions and off-vocabulary soft skills, before the restatement
  //    pass, so a phrase cannot survive by being the shorter half of a pair.
  working = working.map((group) => ({
    ...group,
    skills: group.skills.filter((skill) => {
      // Soft skills and category words, wherever they sit. Checked by what the
      // entry IS rather than which group it is under, because the group that
      // carried them was named by the model and it renamed it freely - "Ways
      // of Working", "Team and Collaboration", "Professional Skills".
      if (isAllowedSoftSkill(skill) || isVagueSkill(skill) || isValuesPhrase(skill)) {
        report.softOrVague.push(skill);
        return false;
      }
      if (looksLikeADescription(skill)) {
        report.described.push(skill);
        return false;
      }
      // A practice rather than a thing. The entry leaves the block and the
      // caller checks that the bullets picked it up: the operator asked for
      // concepts moved, not deleted.
      if (isConceptEntry(skill)) {
        report.concepts.push(skill);
        return false;
      }
      return true;
    }),
  }));

  // 3. One entry that is another plus filler.
  const restatement = dropRestatedSkillsFromGroups(working);
  report.restated = restatement.restated;

  // 4. The ceiling, last, so it counts what will actually be printed.
  const capped = capSkillBlock(restatement.groups, options.cap);
  report.trimmed = capped.dropped;

  return {
    groups: capped.groups.filter((group) => group.category && group.skills.length > 0) as T[],
    report,
  };
}

/*
 * ─── Claims inside the years they could be true ──────────────────────────────
 *
 * REPORTED AS anachronisms: LLM-as-a-judge, RAG, prompt injection testing and
 * agent orchestration written into 2017-2019 roles, because the posting asked
 * for them and every role is tailored towards the posting. It is the fault that
 * ends an interview - an engineer who reads "RAG pipelines" under a 2018 role
 * knows a machine wrote the page.
 *
 * The years are the ones the words could first be used of production work, not
 * the first research paper: the RAG paper is 2020 and nobody shipped one until
 * 2023; ChatGPT is November 2022; agent frameworks and MCP are 2024. A role
 * that ENDED before the year beside a term cannot carry it.
 *
 * ONLY TERMS THAT MEAN ONE THING. "Guardrails" is on the prompt's list and not
 * on this one, because engineers put guardrails on deploy pipelines years before
 * anybody put them on a model: a word with an older ordinary sense cannot be
 * dated by a machine, and a false report is worse than none.
 */
const EARLIEST_USE: ReadonlyArray<{ term: string; from: number }> = [
  { term: 'LLM', from: 2023 },
  { term: 'LLMs', from: 2023 },
  { term: 'Large Language Model', from: 2023 },
  { term: 'Large Language Models', from: 2023 },
  { term: 'LLM-as-a-judge', from: 2023 },
  { term: 'ChatGPT', from: 2023 },
  { term: 'GPT-3', from: 2021 },
  { term: 'GPT-4', from: 2023 },
  { term: 'prompt engineering', from: 2023 },
  { term: 'prompt injection', from: 2023 },
  { term: 'RAG', from: 2023 },
  { term: 'retrieval-augmented generation', from: 2023 },
  { term: 'vector database', from: 2023 },
  { term: 'vector databases', from: 2023 },
  { term: 'LangChain', from: 2023 },
  { term: 'Copilot', from: 2022 },
  { term: 'GitHub Copilot', from: 2022 },
  { term: 'generative AI', from: 2023 },
  { term: 'GenAI', from: 2023 },
  { term: 'agentic', from: 2024 },
  { term: 'AI agent', from: 2024 },
  { term: 'AI agents', from: 2024 },
  { term: 'agent orchestration', from: 2024 },
  { term: 'agent runtime', from: 2024 },
  { term: 'multi-agent', from: 2024 },
  { term: 'MCP', from: 2024 },
  { term: 'Model Context Protocol', from: 2024 },
  { term: 'Kubernetes', from: 2016 },
  { term: 'Terraform', from: 2015 },
];

export type Anachronism = {
  company: string;
  /** The year the role ended, which is the year the claim has to fit inside. */
  endedIn: number;
  term: string;
  from: number;
  bullet: string;
};

/**
 * The year a role ended, or null when it has not.
 *
 * A current role is given no year at all rather than this year's, because
 * "Present" means the work is still going on and nothing in it can be too new.
 */
export function roleEndYear(endDate: string | undefined): number | null {
  const value = (endDate ?? '').trim();
  if (!value) return null;
  if (/present|current|now|ongoing/i.test(value)) return null;

  const year = /\b(19|20)\d{2}\b/.exec(value);
  return year ? Number.parseInt(year[0], 10) : null;
}

/** Bounded on both sides, so "RAG" does not match "storage". */
function namesTerm(text: string, term: string): boolean {
  const pattern = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]+');
  return new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, 'i').test(text);
}

/**
 * Every claim in the bullets that is newer than the role it sits in.
 *
 * ONE FINDING PER THING NAMED. "LLM" is inside "LLM-as-a-judge" and both are on
 * the list, so a bullet carrying the longer one would be reported twice and the
 * count would read as two faults where a reader sees one phrase. The shorter
 * term is dropped when a longer match covers it; two genuinely different claims
 * in one bullet are still two findings.
 */
export function findAnachronisms(
  roles: ReadonlyArray<{ company?: string; endDate?: string; achievements?: string[] }>
): Anachronism[] {
  const found: Anachronism[] = [];

  for (const role of roles) {
    const endedIn = roleEndYear(role.endDate);
    if (endedIn === null) continue;

    for (const bullet of role.achievements ?? []) {
      const hits = EARLIEST_USE.filter(
        (entry) => endedIn < entry.from && namesTerm(bullet, entry.term)
      );
      const specific = hits.filter(
        (entry) =>
          !hits.some(
            (other) =>
              other !== entry && other.term.toLowerCase().includes(entry.term.toLowerCase())
          )
      );
      for (const { term, from } of specific) {
        found.push({ company: role.company ?? 'a role', endedIn, term, from, bullet });
      }
    }
  }

  return found;
}

/*
 * ─── A figure a reader can parse ─────────────────────────────────────────────
 *
 * REPORTED AS garbled metrics: "reduced deploy time by about 40 minutes to 6".
 * It is two measurements collided - "by 34 minutes" and "to 6 minutes" - and it
 * came straight out of this prompt, whose own before-and-after example was
 * written "40 minutes to 6" with the unit on one end. Both have been fixed; this
 * counts what still arrives.
 *
 * DELIBERATELY NOT CHECKED: a unit stated once for a pair, as in "from 9 a week
 * to 1" or "from 30 to 12 incidents a week". That is ordinary English and the
 * prompt offers it as the right form, so a check that flagged it would report
 * the correct answer as a fault.
 *
 * KNOWN OVER-REPORT: "by 400 items to 1,200" has a legitimate reading - fell by
 * 400, arriving at 1,200 - and is flagged anyway, because it is the same shape
 * as the broken one and a reader has to stop and work out which was meant. These
 * are warnings in a log, nothing is rewritten, and a bullet worth a second look
 * is worth the line.
 */
const BY_THEN_TO = /\bby\s+(?:about\s+|around\s+|roughly\s+|some\s+)?[\d.,]+\s*[A-Za-z%]{0,12}\s+to\s+[\d.,]+/i;

/** "from 180ms to 118%": the unit changed between the two ends. */
const PERCENT_ON_ONE_END = /\bfrom\s+[\d.,]+\s*%\s+to\s+[\d.,]+\s*(?!%)[A-Za-z]|\bfrom\s+[\d.,]+\s*(?!%)[A-Za-z]{1,12}\s+to\s+[\d.,]+\s*%/i;

export type GarbledMetric = { bullet: string; shape: 'by-then-to' | 'unit-changed' };

/** Figures whose two ends do not describe one measurement. */
export function findGarbledMetrics(
  roles: ReadonlyArray<{ achievements?: string[] }>
): GarbledMetric[] {
  const found: GarbledMetric[] = [];

  for (const role of roles) {
    for (const bullet of role.achievements ?? []) {
      if (BY_THEN_TO.test(bullet)) found.push({ bullet, shape: 'by-then-to' });
      else if (PERCENT_ON_ONE_END.test(bullet)) found.push({ bullet, shape: 'unit-changed' });
    }
  }

  return found;
}

/*
 * ─── A values phrase is not a skill ──────────────────────────────────────────
 *
 * REPORTED AS pasted job-description phrases: "radical ownership mindset",
 * "accuracy obsession", "valued all voices", "relentless bias toward action",
 * "what agents can and can't do" - tacked onto the ends of bullets, where they
 * break the sentence. The operator asked for them deleted.
 *
 * A PROMPT RULE ALONE COULD NOT HAVE DONE IT, which is why this exists. Those
 * phrases arrive on the analyser's KEYWORDS list, and three places in this file
 * then push them onto the page: the prompt is told to place EVERY keyword, the
 * coverage measurement counts a missing one as a shortfall, and a shortfall
 * large enough buys a second model call whose whole job is to write the missing
 * terms in. A model obeying fault 1 would have been corrected by a revision
 * pass. So the phrase is taken off the list instead - the model never sees it,
 * nothing counts it missing, and no revision asks for it.
 *
 * SET ASIDE, NOT A SHORTFALL. This is the same decision rule 3 of the prompt
 * makes about an industry the candidate has not worked in: a term deliberately
 * left off the page is not a term the resume failed to carry.
 */

/** Words that only ever belong to a claim about character. */
const VALUES_WORDS = [
  'mindset',
  'mentality',
  'obsession',
  'obsessed',
  'attitude',
  'ethos',
  'passion',
  'passionate',
  'grit',
  'hunger',
  'humility',
  'scrappy',
  'scrappiness',
  'voices',
  'radical',
  'relentless',
  'relentlessly',
  'insatiable',
  'unwavering',
  'fierce',
  'fiercely',
  'uncompromising',
  'obsessive',
  'maniacal',
  'dogged',
];

/**
 * "bias toward action" is a slogan; "bias detection" is a real piece of ML
 * work, so the word alone cannot decide it.
 */
const VALUES_PATTERNS = [
  /\bbias (?:toward|towards|for)\b/i,
  /\blove (?:of|for)\b/i,
  /\bcan-do\b/i,
  /\bfirst-principles\b/i,
  // A clause rather than a noun phrase: "what agents can and can't do", "we
  // value curiosity". Nothing a reader would put after "experience with ___".
  /\b(?:can|cannot|can't|should|must)\b.*\b(?:do|be|say|know)\b/i,
  // "us" is deliberately absent: "US GAAP" and "US regulations" are domain
  // terms, and a pronoun check that ate them would drop real keywords.
  /\b(?:we|our|you|your)\b/i,
  /\?/,
];

const VALUES_WORD_SET = new Set(VALUES_WORDS);

/**
 * The phrases themselves, where no word in them is a tell.
 *
 * "Ambiguity tolerance" and "decision agility" carry none of the words above
 * and are two words long, so neither the marker list nor the description rule
 * reaches them - and with the soft-skill group gone, the allowlist that used to
 * refuse them is gone too. They are named outright instead.
 *
 * A CLOSED LIST CANNOT CATCH THE NEXT ONE, and this does not pretend to: a
 * company writes a new values phrase every quarter. What makes it enough is
 * that the ANALYSER no longer produces them - `skills.soft` now names its
 * entries from a fixed vocabulary - so this is the second line rather than the
 * first.
 */
const KNOWN_CULTURE_PHRASES = new Set([
  'ambiguity tolerance',
  'early sharing',
  'decision agility',
  'high bar for quality',
  'fast-paced execution',
  'reversible decision-making',
  'reversible decision making',
  'engineering teamwork',
  'clarity focus',
  'bias to action',
  'extreme ownership',
  'growth mindset',
  'first principles thinking',
  'intellectual honesty',
  'low ego',
  'high agency',
  'strong opinions loosely held',
  'disagree and commit',
  'move fast',
  'think big',
  'customer first',
]);

/**
 * Whether a checklist term is a claim about character rather than a skill.
 *
 * "Ownership", "Collaboration" and "Mentoring" are soft skills and must pass:
 * the prompt asks for every one of them, and dropping those would cost real
 * matches. What fails is the slogan built around one.
 */
export function isValuesPhrase(term: string): boolean {
  const cleaned = term.trim();
  if (!cleaned) return false;

  // One of the words above is enough on its own, which is why that list holds
  // only words that cannot mean anything else. "Ownership", "Collaboration" and
  // "Mentoring" are not on it and never fail here.
  if (KNOWN_CULTURE_PHRASES.has(cleaned.toLowerCase().replace(/\s+/g, ' '))) return true;

  const words = cleaned.toLowerCase().split(/[^a-z'-]+/).filter(Boolean);
  if (words.some((word) => VALUES_WORD_SET.has(word))) return true;

  return VALUES_PATTERNS.some((pattern) => pattern.test(cleaned));
}

/** The checklist without the claims about character, and what was set aside. */
export function withoutValuesPhrases(terms: readonly string[]): {
  terms: string[];
  setAside: string[];
} {
  const kept: string[] = [];
  const setAside: string[] = [];
  for (const term of terms) {
    if (isValuesPhrase(term)) setAside.push(term);
    else kept.push(term);
  }
  return { terms: kept, setAside };
}

/*
 * ─── A bullet that reads like a sentence somebody wrote ──────────────────────
 *
 * The last three faults on the operator's list cannot be repaired from here -
 * each needs the sentence rewritten, which only the model can do - but every
 * one of them can be COUNTED, and a writing rule nobody counts is a writing
 * rule that quietly stops holding. That is the same reason `echoingBullets`
 * exists beside the ban on a verb repeating its own noun.
 */

/**
 * Names that are written in lower case on purpose.
 *
 * A bullet opening "dbt models were..." is correct and a bullet opening "built
 * the..." is not, and the only difference is the word. Without this list the
 * check would report the product names as faults, which is the fastest way to
 * get an operator to stop reading the log.
 */
const LOWERCASE_NAMES = new Set([
  'dbt',
  'ios',
  'ipados',
  'macos',
  'npm',
  'nginx',
  'pandas',
  'numpy',
  'pytest',
  'pytorch',
  'scikit-learn',
  'jquery',
  'grpc',
  'eslint',
  'webpack',
  'kubectl',
  'bash',
  'curl',
  'cron',
  'tvos',
  'watchos',
  'ggplot',
  'matplotlib',
  'jupyter',
  'airflow',
  'dbeaver',
]);

/** A clause left hanging where the outcome should be. */
const DANGLING_END = /(?:,|\band|\bor|\bwith|\busing|\bto|\bfor|\bthe|\bof|\bin|\bon|\bat|\bby)\s*\.?$/i;

/** Thinking out loud, or a note to oneself, that reached the page. */
const SELF_TALK = /\?|\bno;|\binstead\s*\.\.\.|\bnote:|\bTODO\b|\bN\/A\b/i;

export type BrokenBullet = {
  bullet: string;
  shape: 'self-talk' | 'lower-start' | 'dangling-end' | 'repeated-phrase';
};

/** A phrase of three or more words that the bullet says twice. */
function repeatsAPhrase(bullet: string): boolean {
  const words = bullet.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  for (let i = 0; i + 3 <= words.length; i += 1) {
    const phrase = words.slice(i, i + 3).join(' ');
    if (seen.has(phrase)) return true;
    seen.add(phrase);
  }
  return false;
}

/**
 * Bullets that are not one finished sentence.
 *
 * REPORTED BY THE OPERATOR as broken or leftover text: "Built AI pipeline
 * design experiments? No; instead...", "deterministically vs statistically
 * evaluation", duplicated phrases, lowercase bullet starts.
 */
export function findBrokenBullets(
  roles: ReadonlyArray<{ achievements?: string[] }>
): BrokenBullet[] {
  const found: BrokenBullet[] = [];

  for (const role of roles) {
    for (const bullet of role.achievements ?? []) {
      const text = bullet.trim();
      if (!text) continue;

      const firstWord = (/^[A-Za-z][A-Za-z.-]*/.exec(text)?.[0] ?? '').toLowerCase();
      if (SELF_TALK.test(text)) found.push({ bullet: text, shape: 'self-talk' });
      else if (/^[a-z]/.test(text) && !LOWERCASE_NAMES.has(firstWord)) {
        found.push({ bullet: text, shape: 'lower-start' });
      } else if (DANGLING_END.test(text)) found.push({ bullet: text, shape: 'dangling-end' });
      else if (repeatsAPhrase(text)) found.push({ bullet: text, shape: 'repeated-phrase' });
    }
  }

  return found;
}

/**
 * How many bullets name one of the technologies this resume itself claims.
 *
 * REPORTED BY THE OPERATOR as no named tools: bullets with no cloud,
 * orchestration, database or observability tool in them. The vocabulary is the
 * resume's OWN skills block rather than a fixed list, because that is the set
 * of tools this candidate is claiming - a bullet naming none of them describes
 * nobody in particular.
 */
export function bulletsNamingATool(
  roles: ReadonlyArray<{ achievements?: string[] }>,
  vocabulary: readonly string[]
): { bullets: number; named: number; share: number } {
  const terms = vocabulary.map((term) => term.trim()).filter((term) => term.length > 1);
  const patterns = terms.map(
    (term) =>
      new RegExp(
        `(?<![A-Za-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]+')}(?![A-Za-z0-9])`,
        'i'
      )
  );

  let bullets = 0;
  let named = 0;
  for (const role of roles) {
    for (const bullet of role.achievements ?? []) {
      if (!bullet.trim()) continue;
      bullets += 1;
      if (patterns.some((pattern) => pattern.test(bullet))) named += 1;
    }
  }

  return { bullets, named, share: bullets === 0 ? 1 : named / bullets };
}

/**
 * A figure saying how big the thing was, rather than how much it improved.
 *
 * "40 Snowflake tables carrying 2B rows a day" is scale; "cut failures by 40%"
 * is an improvement, and a role carrying only the second never says what was
 * being run. The nouns are the ones an engineer measures a system in.
 */
const SCALE_FIGURE = new RegExp(
  String.raw`\b[\d.,]+\s*(?:[kmb]\+?|million|billion|thousand)?\s*(?:\+\s*)?` +
    String.raw`(?:rows|events|requests|queries|transactions|records|users|customers|accounts|` +
    String.raw`services|microservices|endpoints|apis|tables|datasets|jobs|pipelines|repos|` +
    String.raw`repositories|clusters|nodes|engineers|developers|teams|markets|countries|stores|` +
    String.raw`devices|tenants|merchants|files|documents|messages|tb|gb|pb)\b` +
    String.raw`|\b(?:qps|rps|tps|req/s)\b`,
  'i'
);

/** Roles whose bullets never say how big the work was. */
export function rolesWithoutScale(
  roles: ReadonlyArray<{ company?: string; achievements?: string[] }>
): string[] {
  return roles
    .filter((role) => (role.achievements ?? []).some((bullet) => bullet.trim()))
    .filter((role) => !(role.achievements ?? []).some((bullet) => SCALE_FIGURE.test(bullet)))
    .map((role) => role.company ?? 'a role');
}

/**
 * Owning something, deciding something, or bringing other engineers along.
 *
 * The operator's eighth fault: "show expanding scope, ownership, or mentoring".
 * The prompt asks for one such bullet in each of the two most recent roles,
 * drawn only from what the profile shows, and this says whether it arrived.
 * Checked on the two most recent roles ONLY, because the rule is about scope
 * WIDENING - an earliest role without one is the rule working.
 */
const SCOPE_WORDS = /\b(?:owned|ownership|mentored|mentoring|mentor|coached|onboarded|design review|set the standard)\b/i;

export function recentRolesWithoutScope(
  roles: ReadonlyArray<{ company?: string; achievements?: string[] }>
): string[] {
  return roles
    .slice(0, 2)
    .filter((role) => (role.achievements ?? []).some((bullet) => bullet.trim()))
    .filter((role) => !(role.achievements ?? []).some((bullet) => SCOPE_WORDS.test(bullet)))
    .map((role) => role.company ?? 'a role');
}

/*
 * ─── Standard degree notation ────────────────────────────────────────────────
 *
 * ASKED FOR: "Use standard degree notation (e.g. B.S. in Computer Science)".
 * Profiles carry whatever the person typed - "Bachelor of Science", "BS",
 * "B.Sc", "Bachelor of Science Computer Science" - and education is passed to
 * the page from the profile untouched, so the notation is the one thing on the
 * resume nothing has ever normalised.
 *
 * ONLY WHERE THE SOURCE IS UNAMBIGUOUS. "Bachelor of Science" is a B.S. and
 * there is nothing to decide. "Bachelor's degree in Computer Science" is NOT:
 * it may be a B.S. or a B.A., the profile does not say, and writing the wrong
 * one puts a false claim on somebody's resume. Those are left exactly as the
 * person wrote them.
 */
const DEGREE_FORMS: ReadonlyArray<{ match: RegExp; write: string }> = [
  { match: /^bachelor(?:'s)?\s+(?:of\s+)?science\b/i, write: 'B.S.' },
  { match: /^b\.?\s?sc?\.?\b/i, write: 'B.S.' },
  { match: /^bachelor(?:'s)?\s+(?:of\s+)?arts\b/i, write: 'B.A.' },
  { match: /^b\.?\s?a\.?\b/i, write: 'B.A.' },
  { match: /^bachelor(?:'s)?\s+(?:of\s+)?engineering\b/i, write: 'B.E.' },
  { match: /^bachelor(?:'s)?\s+(?:of\s+)?technology\b/i, write: 'B.Tech.' },
  { match: /^master(?:'s)?\s+(?:of\s+)?science\b/i, write: 'M.S.' },
  { match: /^m\.?\s?sc?\.?\b/i, write: 'M.S.' },
  { match: /^master(?:'s)?\s+(?:of\s+)?arts\b/i, write: 'M.A.' },
  { match: /^master(?:'s)?\s+(?:of\s+)?business\s+administration\b/i, write: 'M.B.A.' },
  { match: /^m\.?\s?b\.?\s?a\.?\b/i, write: 'M.B.A.' },
  { match: /^master(?:'s)?\s+(?:of\s+)?engineering\b/i, write: 'M.Eng.' },
  { match: /^doctor(?:ate)?\s+(?:of\s+)?philosophy\b/i, write: 'Ph.D.' },
  { match: /^ph\.?\s?d\.?\b/i, write: 'Ph.D.' },
  { match: /^associate(?:'s)?\s+(?:of\s+)?science\b/i, write: 'A.S.' },
  { match: /^associate(?:'s)?\s+(?:of\s+)?arts\b/i, write: 'A.A.' },
];

/** One degree line, in standard notation, or exactly as it was. */
export function standardDegree(degree: string): string {
  const text = (degree ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return degree ?? '';

  for (const { match, write } of DEGREE_FORMS) {
    const hit = match.exec(text);
    if (!hit) continue;

    // What follows the degree name: the field, with "in", a comma or nothing
    // between. "B.S. in Computer Science" is the form asked for.
    // The dot is part of the class because an abbreviation matches without its
    // final stop: "B.S. in Computer Science" leaves ". in Computer Science".
    const rest = text
      .slice(hit[0].length)
      .replace(/^[\s,.:-]+/, '')
      .replace(/^in\s+/i, '');
    return rest ? `${write} in ${rest}` : write;
  }

  return text;
}

/** The same, across a profile's education entries. Nothing else is touched. */
export function standardDegreeNotation<T extends { degree?: string }>(
  entries: readonly T[] | undefined
): T[] {
  return (entries ?? []).map((entry) =>
    entry?.degree ? { ...entry, degree: standardDegree(entry.degree) } : entry
  );
}
