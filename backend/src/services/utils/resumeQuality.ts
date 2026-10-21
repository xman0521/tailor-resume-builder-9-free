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
 * ─── The same product under two names ────────────────────────────────────────
 *
 * MEASURED on five delivered blocks: the removal passes took NOTHING out of
 * four of them, and a reader could see "AWS" beside "Amazon Web Services",
 * "Azure" beside "Microsoft Azure", "Copilot" beside "GitHub Copilot",
 * "Secrets Manager" beside "AWS Secrets Manager", and "API, APIs, REST, REST
 * APIs" in one group.
 *
 * WHY `restatesSkill` MISSED THEM ALL. It only drops an entry whose extra words
 * are filler, and it exempts a vendor prefix outright so that "AWS Lambda"
 * survives beside "AWS". Both of those are right, and between them they let
 * every pair above through: "Amazon Web Services" shares no words with "AWS",
 * and "AWS Secrets Manager" is exempt for being vendor-prefixed.
 *
 * So three narrower rules, each of which answers one shape.
 */

/**
 * A name as a list of words, lower-cased and with plurals folded in.
 *
 * `+`, `#` and `.` survive the split, because they are part of the name in
 * "C++", "C#" and "Node.js". A trailing "s" comes off anything longer than
 * three letters, so "AWS", "ops" and "js" are left alone - and a word with a
 * dot keeps its "s", because "Node.js" wears it as part of the name.
 *
 * All that is left of the word-shape machinery: `duplicateOf` compares two
 * names that are both labelled things, and needs to know that "REST API" and
 * "REST APIs" are one of them.
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

/** Names of one thing, where a scanner reads two strings. */
const EQUIVALENT_NAMES: ReadonlyArray<readonly string[]> = [
  ['aws', 'amazon web services', 'amazon web service'],
  ['azure', 'microsoft azure', 'ms azure'],
  ['gcp', 'google cloud', 'google cloud platform'],
  ['k8s', 'kubernetes'],
  ['postgres', 'postgresql', 'postgre sql'],
  ['javascript', 'js'],
  ['typescript', 'ts'],
  ['github actions', 'gh actions'],
  ['node', 'node.js', 'nodejs'],
  ['dotnet', '.net', 'dot net'],
];

const EQUIVALENCE_OF = new Map<string, number>();
EQUIVALENT_NAMES.forEach((names, index) => {
  for (const name of names) EQUIVALENCE_OF.set(name, index);
});

/**
 * Words that identify WHOSE product it is.
 *
 * "Secrets Manager" and "AWS Secrets Manager" are one thing; "AWS" and "AWS
 * Lambda" are two, because Lambda is the product and AWS is the vendor. The
 * difference is which side the extra words sit on: a vendor in FRONT of a name
 * already written in full is a qualifier, not a different product.
 */
const VENDOR_WORDS = new Set([
  'aws',
  'amazon',
  'azure',
  'microsoft',
  'ms',
  'google',
  'gcp',
  'github',
  'gitlab',
  'apache',
  'oracle',
  'ibm',
  'atlassian',
  'hashicorp',
  'elastic',
  'confluent',
  'redhat',
  'jetbrains',
]);

/** Names whose final "s" is part of the word, not a plural. */
const NOT_A_PLURAL = new Set([
  'https',
  'sass',
  'less',
  'css',
  'aws',
  'ios',
  'redis',
  'kubernetes',
  'jenkins',
  'prometheus',
  'express',
  'rails',
  'docs',
  'nats',
]);

const normalizedName = (skill: string) => skill.trim().toLowerCase().replace(/\s+/g, ' ');

/** The two entries name one thing, and this says which one to keep. */
export type DuplicateVerdict = { keep: string; drop: string } | null;

export function duplicateOf(first: string, second: string): DuplicateVerdict {
  const a = normalizedName(first);
  const b = normalizedName(second);
  if (!a || !b || a === b) return null;

  // 1. An abbreviation beside its expansion. The FIRST WRITTEN survives, as
  //    everywhere else here: the model orders the block most relevant first,
  //    and the prompt tells it to lead with the form the posting leads with.
  const left = EQUIVALENCE_OF.get(a);
  const right = EQUIVALENCE_OF.get(b);
  if (left !== undefined && left === right) return { keep: first, drop: second };

  const aWords = skillWords(first);
  const bWords = skillWords(second);

  /*
   * 2. The same name in singular and plural: "API" and "APIs", "REST API" and
   *    "REST APIs". Compared as STRINGS rather than as singularised words,
   *    because the word-level rule read "HTTPS" as the plural of "HTTP" and
   *    deleted it - and the same trap waits for SASS against SAS. The pair has
   *    to differ by exactly a trailing "s", and the few names that end in one
   *    by coincidence are listed.
   */
  const plural = (short: string, long: string) =>
    long === `${short}s` && short.length >= 3 && !NOT_A_PLURAL.has(long);
  if (plural(a, b)) return { keep: first, drop: second };
  if (plural(b, a)) return { keep: second, drop: first };

  // 3. A bare product name beside its vendor-qualified form. The QUALIFIED one
  //    survives here, unlike every other rule in this file: "AWS Secrets
  //    Manager" says whose it is and "Secrets Manager" is ambiguous, and the
  //    same goes for "GitHub Copilot" against "Copilot".
  const qualified = (shortWords: string[], longWords: string[]) =>
    longWords.length > shortWords.length
    && longWords.slice(longWords.length - shortWords.length).every((word, i) => word === shortWords[i])
    && longWords.slice(0, longWords.length - shortWords.length).every((word) => VENDOR_WORDS.has(word));

  if (qualified(aWords, bWords)) return { keep: second, drop: first };
  if (qualified(bWords, aWords)) return { keep: first, drop: second };

  /*
   * 4. The bare noun beside the same noun with a word in front of it.
   *
   * REPORTED BY A REVIEWER on a delivered batch, and MEASURED at 93% of 60
   * resumes with a mean of 5.5 such pairs each: "Automation" beside "workflow
   * automation", "APIs" beside "LLM APIs", "data scaling" beside "data
   * normalization". Each pair spends two lines of a list a reader scans in two
   * seconds on one idea, which is what reads as padding.
   *
   * THE HEAD NOUN HAS TO MATCH, and that is what keeps this off real products.
   * "GitHub" and "GitHub Actions" end in different words, so do "Visual
   * Studio" and "Visual Studio Code", "Python" and "Python 3", "React" and
   * "React Native" - all four are two products and all four survive. What this
   * catches is the same noun twice with a qualifier on one of them.
   *
   * THE MORE SPECIFIC ONE SURVIVES, unlike rule 2 above: "workflow automation"
   * says what was automated and "Automation" says nothing, and a scanner
   * looking for the bare noun still matches it inside the longer phrase
   * because terms are matched on word boundaries.
   */
  const sameHeadNoun = (shortWords: string[], longWords: string[]) =>
    longWords.length > shortWords.length
    && shortWords.length >= 1
    && longWords[longWords.length - 1] === shortWords[shortWords.length - 1]
    && longWords.slice(longWords.length - shortWords.length).every((word, i) => word === shortWords[i]);

  if (sameHeadNoun(aWords, bWords)) return { keep: second, drop: first };
  if (sameHeadNoun(bWords, aWords)) return { keep: first, drop: second };

  return null;
}

export type RestatedSkill = { kept: string; dropped: string };

/*
 * ─── Two shapes a reviewer spots before a scanner does ───────────────────────
 *
 * Both were reported on a delivered batch and both are measurable, so they are
 * counted rather than argued about.
 */

/**
 * A soft skill bolted onto the end of a sentence about technical work.
 *
 * MEASURED at 87% of 60 resumes, 189 bullets: "Reviewed GitHub changes for
 * online banking features, applying accountability during code review",
 * "Practiced Curiosity when examining unfamiliar modules", "applying
 * Cross-functional collaboration and Decision making to resolve issues".
 *
 * It is what a rule asking for every soft skill to be WRITTEN IN A BULLET
 * produces: the sentence is finished, the keyword still has to go somewhere,
 * and a participle clause is where it goes. A reader sees a resume that was
 * filled in rather than written, which is the whole fault.
 *
 * The test is the shape, not the vocabulary: a soft-skill noun governed by one
 * of the joining words that attach a trailing clause. "Mentored two engineers
 * through their first on-call rotation" names no soft skill and trips nothing
 * - which is the sentence the rule is trying to encourage.
 */
const SOFT_SKILL_NOUNS = [
  'accountability', 'adaptability', 'ownership', 'collaboration', 'communication',
  'mentoring', 'mentorship', 'initiative', 'teamwork', 'empathy', 'curiosity',
  'attention to detail', 'problem solving', 'problem-solving', 'time management',
  'documentation', 'leadership', 'transparency', 'autonomy', 'onboarding',
  'decision making', 'critical thinking', 'flexibility', 'prioritization',
];

const BOLTED_ON = new RegExp(
  '(?:,\\s*)?\\b(?:with|while|applying|demonstrating|showing|practicing|practised|practiced|through|using|leveraging)\\s+'
  + '(?:[a-z-]+\\s+){0,2}(?:' + SOFT_SKILL_NOUNS.join('|') + ')\\b',
  'i'
);

export function bulletsWithBoltedSoftSkills(
  roles: ReadonlyArray<{ achievements?: string[] }>
): string[] {
  const hits: string[] = [];
  for (const role of roles) {
    for (const bullet of role.achievements ?? []) {
      if (typeof bullet === 'string' && BOLTED_ON.test(bullet)) hits.push(bullet);
    }
  }
  return hits;
}

/**
 * A bullet that stops at the activity instead of saying what changed.
 *
 * MEASURED at 73% of 1,246 delivered bullets. "Did X using Y" is a duty; the
 * shape that earns its line is "did X using Y, which changed Z". A figure is
 * the commonest way to end on an outcome but not the only one - "ended the
 * morning re-runs" is an outcome with no number in it - so this looks for the
 * turn towards a result rather than for a digit.
 */
const OUTCOME_SIGNAL = new RegExp(
  '\\b(?:cut|cutting|reduc\\w+|drop\\w+|rais\\w+|rose|grew|growing|sav\\w+|freed|ended|removed|'
  + 'eliminat\\w+|halv\\w+|doubl\\w+|shorten\\w+|took\\s+\\w+\\s+from|which\\s+\\w+ed|'
  + 'resulting in|so that|from\\s+[\\d$]|to\\s+[\\d$])\\b',
  'i'
);

export function bulletsWithoutAnOutcome(
  roles: ReadonlyArray<{ achievements?: string[] }>
): string[] {
  const hits: string[] = [];
  for (const role of roles) {
    for (const bullet of role.achievements ?? []) {
      if (typeof bullet === 'string' && bullet.trim() && !OUTCOME_SIGNAL.test(bullet)) hits.push(bullet);
    }
  }
  return hits;
}

/**
 * A phrase of three or four words written three or more times on one resume.
 *
 * MEASURED at 62% of 60 resumes, 2.2 phrases each: "attention to detail" four
 * times, "findings through technical documentation" three times. It is what a
 * checklist demanding every term, against a page with room for fourteen to
 * twenty-two sentences, produces.
 */
export function repeatedPhrases(
  roles: ReadonlyArray<{ achievements?: string[] }>,
  summary = ''
): Array<{ phrase: string; count: number }> {
  const text = [summary, ...roles.flatMap((role) => role.achievements ?? [])]
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ');
  const words = text.split(/\s+/).filter(Boolean);
  const counts = new Map<string, number>();
  for (let size = 3; size <= 4; size += 1) {
    for (let i = 0; i + size <= words.length; i += 1) {
      const phrase = words.slice(i, i + size).join(' ');
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }
  // A phrase that only repeats because a longer one does is not a second
  // finding, so the longest form of each run is what gets reported.
  const repeated = [...counts.entries()].filter(([, count]) => count >= 3);
  return repeated
    .filter(([phrase, count]) => !repeated.some(([other, otherCount]) =>
      other !== phrase && other.includes(phrase) && otherCount >= count))
    .map(([phrase, count]) => ({ phrase, count }))
    .sort((a, b) => b.count - a.count);
}

/*
 * TWO RESTATEMENT PASSES LIVED HERE - `dropRestatedSkills` and its group-aware
 * twin - and both are gone with the filler list they depended on. Their job was
 * to spot "Observability" beside "Observability implementation", which the
 * model's own label now settles: the second is a practice and leaves the block
 * before any comparison happens. What is left of that work is `duplicateOf`
 * above, which answers a different question - one name, two spellings - and
 * needs no judgement about what a thing is.
 */

/*
 * ─── The block is routed by LABEL, not guessed from word shapes ──────────────
 *
 * WHAT THIS REPLACED, and why. Deciding whether "MCP", "Prompt Engineering",
 * "Observability implementation" or "Agile" belonged in the skills block used
 * to be done here, from the shape of the words: an activity noun at the end, a
 * phrase with no capitals, a filler word bolted onto another entry. That took
 * nineteen hand-maintained lists and 480 terms, and it did not converge - every
 * complaint added one more. "MCP" needed a list entry. "Agile" needed another.
 * "LangGraph" would have needed a third, and whatever ships next quarter a
 * fourth.
 *
 * It was also wrong in both directions at once: it deleted "Prompt Engineering"
 * (an activity noun) while keeping "agent tooling" (none), because word shape
 * is not what makes something a tool.
 *
 * SO THE MODEL SAYS WHAT EACH ENTRY IS, as it writes it, and this routes by
 * that. The model has the posting and the candidate's history in front of it
 * and knows that MCP is a protocol and that "accuracy obsession" is not a
 * skill; a list in a file never will.
 *
 * THE KINDS BELOW ARE A SCHEMA, NOT A VOCABULARY. Thirteen words that describe
 * the KIND of a thing. They do not grow when the industry invents a tool, which
 * is the whole difference between this and the lists it replaced.
 *
 * NOTHING IS DELETED, IT IS ROUTED. An entry whose kind belongs in prose is
 * taken out of the block and reported, and the prompt requires it in a bullet -
 * because a string that leaves the page costs a keyword match, and 37% of what
 * the old rules removed vanished from the resume entirely.
 */

/** Kinds that are things: a reader screens for these, a scanner scores them. */
export const BLOCK_KINDS = [
  'language',
  'framework',
  'library',
  'tool',
  'platform',
  'database',
  'protocol',
  'methodology',
  /*
   * A named technology or standard a scanner scores as a hard skill even
   * though it is not a product anybody installs: LLMs, RAG, CI/CD, APIs.
   *
   * THIS IS WHY IT IS A KIND AND NOT AN EXCEPTION LIST. Those four were a
   * hand-kept list of six strings, bolted onto a rule that would otherwise
   * have deleted them - and the list needed an entry every time the industry
   * named something. As a kind, the model decides what qualifies, which is the
   * whole point of routing on the label.
   */
  'technology',
] as const;

/** Kinds that belong in a sentence, attached to work that was done. */
export const PROSE_KINDS = [
  'practice',
  'concept',
  'soft',
  'domain',
  'category',
] as const;

const BLOCK_KIND_SET = new Set<string>(BLOCK_KINDS);
const PROSE_KIND_SET = new Set<string>(PROSE_KINDS);

export type SkillEntry = { name: string; kind: string };

/**
 * One block entry, from whichever shape the model returned.
 *
 * A BARE STRING IS KEPT, not dropped. An older prompt - or a custom one an
 * admin wrote - returns `["Python", "React"]` with no labels at all, and a
 * router that deleted everything it could not classify would empty the block of
 * a resume that was fine. Unlabelled means "no opinion", which is treated as a
 * thing, and the report says how many arrived that way.
 */
export function parseSkillEntry(raw: unknown): SkillEntry | null {
  if (typeof raw === 'string') {
    const name = raw.trim().replace(/\s+/g, ' ');
    return name ? { name, kind: 'unlabelled' } : null;
  }
  if (!raw || typeof raw !== 'object') return null;

  const record = raw as Record<string, unknown>;
  const name = String(record.name ?? record.skill ?? record.term ?? '').trim().replace(/\s+/g, ' ');
  if (!name) return null;

  const kind = String(record.kind ?? record.type ?? '').trim().toLowerCase();
  return { name, kind: kind || 'unlabelled' };
}

/** Whether an entry's own label says it belongs in the block. */
/**
 * A capability phrase the POSTING named, which the block may carry after all.
 *
 * WHY THE EXCEPTION STOPPED BEING A LIST. The prompt has always carved out
 * "CI/CD", "APIs", "REST", "LLM", "RAG", "AI" and a dozen AI/ML terms, for a
 * reason that is right and general: each is a string a scanner weights
 * heavily, and taking it off the block costs more than the tidiness is worth.
 * The carve-out itself was twenty-one hardcoded terms, so a security posting
 * got none of it.
 *
 * MEASURED on two scans of delivered resumes: of fourteen skills the scanner
 * reported missing, ELEVEN were capability or category phrases - "Threat
 * hunting", "Data Modeling", "Cloud infrastructure", "Security Solutions" -
 * every one of them named in the job description, every one of them on no part
 * of the page.
 *
 * So the test is no longer what the phrase is, it is who said it. A phrase the
 * employer wrote down is a keyword; the same shape invented by the model -
 * "agent orchestration", "latency optimization", "fast iteration" - is the
 * padding the operator objected to, and it stays out.
 */
function namedByPosting(name: string, postingTerms: ReadonlySet<string>): boolean {
  if (postingTerms.size === 0) return false;
  return postingTerms.has(normalizedName(name));
}

export function belongsInBlock(entry: SkillEntry, postingTerms?: ReadonlySet<string>): boolean {
  if (PROSE_KIND_SET.has(entry.kind)) {
    return postingTerms ? namedByPosting(entry.name, postingTerms) : false;
  }
  // Block kinds and anything unlabelled or unrecognised: kept. A kind this
  // schema has never heard of is the model inventing one, which says nothing
  // about whether the thing is a tool.
  return true;
}

/** What a removal says about itself, for the report and for the prose check. */
export type RoutedSkill = { name: string; kind: string };

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

/**
 * The most headings the block may print.
 *
 * MEASURED ACROSS 100 DELIVERED RESUMES: a mean of 7.2 groups, a median of 7
 * and a maximum of 11, with 36% of them over the seven the prompt asks for -
 * while the blocks themselves averaged 35.3 entries against a ceiling of 45,
 * and 45% came in UNDER the floor of 35. The budget was going on headings
 * rather than on skills, and the rule saying so was a warning nobody enforced.
 */
export const MAX_SKILL_GROUPS = 7;

/**
 * Brings the block down to that many headings WITHOUT re-filing anything.
 *
 * THIS IS THE SECOND ATTEMPT AND THE DIFFERENCE IS THE HEADING. The first one
 * folded a thin group into a related one and kept the destination's name, so a
 * block with a two-entry AI group printed "LLM" and "RAG" under "CLOUD &
 * INFRASTRUCTURE" - filed under a heading that did not describe them, which is
 * worse than a short group and was reverted on sight.
 *
 * So nothing moves to a heading that does not name it: the two SMALLEST groups
 * are joined and so are their names, "Monitoring" and "Security" becoming
 * "Monitoring & Security". Every entry still sits under its own category, the
 * page loses a heading rather than a skill, and the report says which pairs
 * were joined so the operator can see it happen.
 *
 * Ties are broken by the shorter combined heading, which keeps the joined name
 * printable: a heading is drawn inline before its skills, and two long ones
 * joined would take the line the skills were supposed to go on.
 *
 * THE FLOOR IS NOT ENFORCED HERE and cannot be. Reaching five groups from three
 * means splitting a category or inventing one, and both are this file deciding
 * what a skill is - the judgement the whole refactor took out. A block under
 * the floor is reported and printed as it stands.
 */
export function capSkillGroups<T extends { category: string; skills: string[] }>(
  groups: readonly T[],
  cap: number = MAX_SKILL_GROUPS
): { groups: Array<{ category: string; skills: string[] }>; merged: Array<{ kept: string; joined: string }> } {
  const result = groups.map((group) => ({ category: group.category, skills: [...group.skills] }));
  const merged: Array<{ kept: string; joined: string }> = [];
  if (cap < 1) return { groups: result, merged };

  while (result.length > cap) {
    // The pair that costs the page least: fewest entries moved, and of those
    // the shortest heading to print.
    let best = { first: -1, second: -1, size: Infinity, heading: Infinity };
    for (let i = 0; i < result.length; i += 1) {
      for (let j = i + 1; j < result.length; j += 1) {
        const size = result[i].skills.length + result[j].skills.length;
        const heading = result[i].category.length + result[j].category.length;
        if (size < best.size || (size === best.size && heading < best.heading)) {
          best = { first: i, second: j, size, heading };
        }
      }
    }
    if (best.first === -1) break;

    const kept = result[best.first];
    const [joined] = result.splice(best.second, 1);
    merged.push({ kept: kept.category, joined: joined.category });
    // The earlier group keeps its position, because the model orders the block
    // most relevant first and a merge is not a reason to move a heading up.
    kept.category = `${kept.category} & ${joined.category}`;
    kept.skills.push(...joined.skills);
  }

  return { groups: result, merged };
}

/**
 * Everything the application takes out of the block, in one pass.
 *
 * The block is still the model's answer: nothing here reorders it, renames a
 * group, translates a term or adds anything. Two kinds of removal remain, and
 * neither needs a vocabulary:
 *
 *   - the same thing twice, which is arithmetic on strings;
 *   - an entry whose own label says it belongs in a sentence, which is the
 *     model's judgement rather than this file's.
 *
 * What left on a label is reported with that label, so the caller can check it
 * reached a bullet. A string that leaves the page costs a keyword match.
 */
export type SkillBlockTidyReport = {
  repeated: string[];
  /** Taken out because the model labelled them as belonging in the prose. */
  routedToProse: RoutedSkill[];
  /** One name under two spellings; see `duplicateOf`. */
  duplicates: RestatedSkill[];
  /** Arrived with no label at all, kept, and worth knowing about. */
  unlabelled: string[];
  trimmed: string[];
  /** Headings joined to bring the block within `MAX_SKILL_GROUPS`. */
  mergedGroups: Array<{ kept: string; joined: string }>;
  /**
   * Capability phrases kept because the POSTING named them.
   *
   * Reported so the share is visible: these are the entries that would have
   * been routed out under the old rule, and a block where they outnumber the
   * products is the one worth looking at.
   */
  keptByPosting: RoutedSkill[];
};

/**
 * At most this share of the block may be posting-named capability phrases.
 *
 * The exception above is a door, not a licence. A block that is half phrases is
 * the keyword-stuffed list the operator sent screenshots of, whoever wrote the
 * phrases - so the named products stay the bulk of it, and the phrases ride
 * along in the slots left over. The ones past the share are routed to the prose
 * like any other concept, most relevant first, so what is lost is the tail.
 */
const MAX_PHRASE_SHARE = 0.25;

export function tidySkillGroups<T extends { category: string; skills: unknown[] }>(
  groups: readonly T[],
  options: { cap?: number; groupCap?: number; postingTerms?: Iterable<string> } = {}
): { groups: Array<{ category: string; skills: string[] }>; report: SkillBlockTidyReport } {
  const report: SkillBlockTidyReport = {
    repeated: [],
    routedToProse: [],
    duplicates: [],
    unlabelled: [],
    trimmed: [],
    mergedGroups: [],
    keptByPosting: [],
  };

  const postingTerms = options.postingTerms
    ? new Set([...options.postingTerms].map((term) => normalizedName(term)).filter(Boolean))
    : undefined;
  // Counted against the whole block, so the share is a share of what prints.
  const totalEntries = groups.reduce((n, group) => n + (group.skills?.length ?? 0), 0);
  const phraseBudget = Math.floor(totalEntries * MAX_PHRASE_SHARE);
  let phrasesKept = 0;

  // 1. Parse whatever shape arrived, and route on the label.
  const seen = new Set<string>();
  const working = groups.map((group) => {
    const kept: string[] = [];
    for (const raw of group.skills ?? []) {
      const entry = parseSkillEntry(raw);
      if (!entry) continue;

      // The same string twice, first written winning. The oldest rule here.
      const key = entry.name.toLowerCase();
      if (seen.has(key)) {
        report.repeated.push(entry.name);
        continue;
      }
      seen.add(key);

      const isPhrase = PROSE_KIND_SET.has(entry.kind);
      const admitted = belongsInBlock(entry, postingTerms) && (!isPhrase || phrasesKept < phraseBudget);
      if (!admitted) {
        report.routedToProse.push({ name: entry.name, kind: entry.kind });
        continue;
      }
      if (isPhrase) {
        phrasesKept += 1;
        report.keptByPosting.push({ name: entry.name, kind: entry.kind });
      }
      if (entry.kind === 'unlabelled') report.unlabelled.push(entry.name);
      kept.push(entry.name);
    }
    return { category: group.category, skills: kept };
  });

  /*
   * 2. One name under two spellings.
   *
   * A LABEL CANNOT SETTLE THIS: "AWS" and "Amazon Web Services" are both tools
   * and both correctly labelled, and a reader still sees one thing written
   * twice. `duplicateOf` is mechanical - an abbreviation beside its expansion, a
   * singular beside its plural, a bare name beside its vendor-qualified form -
   * and it is the one place a short table of names survives, because those
   * three shapes are facts about English and about vendors rather than
   * judgements about what a thing is.
   */
  const placed: Array<{ name: string; group: number; index: number }> = [];
  const deduped = working.map((group) => ({ category: group.category, skills: [] as string[] }));
  working.forEach((group, groupIndex) => {
    for (const name of group.skills) {
      const clash = placed
        .map((entry) => ({ entry, verdict: duplicateOf(entry.name, name) }))
        .find((pair) => pair.verdict !== null);

      if (clash && clash.verdict) {
        const { keep, drop } = clash.verdict;
        report.duplicates.push({ kept: keep, dropped: drop });
        if (keep === name) {
          // The new one wins: it takes the earlier one's place, so the model's
          // ordering survives the substitution.
          deduped[clash.entry.group].skills[clash.entry.index] = name;
          clash.entry.name = name;
        }
        continue;
      }

      deduped[groupIndex].skills.push(name);
      placed.push({ name, group: groupIndex, index: deduped[groupIndex].skills.length - 1 });
    }
  });

  /*
   * 3. The heading count, before the entry ceiling and after the removals.
   *
   * BEFORE THE CEILING because the ceiling drops from the tail of the LONGEST
   * group, and joining two groups changes which one that is. AFTER the
   * removals because a group emptied by the router is not a heading anybody
   * has to merge - it is about to be filtered out below.
   */
  const withHeadings = capSkillGroups(
    deduped.filter((group) => group.category && group.skills.length > 0),
    options.groupCap
  );
  report.mergedGroups = withHeadings.merged;

  // 4. The ceiling, last, so it counts what will actually be printed.
  const capped = capSkillBlock(withHeadings.groups, options.cap);
  report.trimmed = capped.dropped;

  return {
    groups: capped.groups.filter((group) => group.category && group.skills.length > 0),
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
