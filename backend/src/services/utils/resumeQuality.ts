/**
 * The three faults that can be measured without reading the sentence.
 *
 * The operator's list of eight resume-quality faults is answered in the
 * tailoring prompt, under SEVEN FAULTS A HUMAN READER CATCHES BEFORE A SCANNER
 * DOES - that is where a rule can change what the model writes. Three of them
 * can also be checked afterwards by a machine, which is what this file is:
 *
 *   - a skills entry that is another entry written another way, which is
 *     REMOVED, because there is no judgement in it;
 *   - a figure of the shape "by 40 minutes to 6", which is REPORTED, because
 *     only the model can rewrite the bullet.
 *
 * Everything else on that list needs a sentence rewritten, and a rule in the
 * prompt is the only thing that can do it. Nothing here edits prose, and no
 * check here reads a fixed list of words.
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
 * The rules below read only the two strings - their letters, words and casing.
 * No table of names: a nickname or older name ("K8s", "Postgres") is caught by
 * the check-skills AI call, which is asked for exactly that.
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

const normalizedName = (skill: string) => skill.trim().toLowerCase().replace(/\s+/g, ' ');

/** The two entries name one thing, and this says which one to keep. */
export type DuplicateVerdict = { keep: string; drop: string } | null;

export function duplicateOf(first: string, second: string): DuplicateVerdict {
  const a = normalizedName(first);
  const b = normalizedName(second);
  if (!a || !b || a === b) return null;

  // 1. An acronym beside the words it stands for: "RAG" and "Retrieval-Augmented
  //    Generation", "AWS" and "Amazon Web Services". Read off the letters. The
  //    FIRST WRITTEN survives: the model orders the block most relevant first.
  if (isAcronymOf(first, second) || isAcronymOf(second, first)) return { keep: first, drop: second };

  const aWords = skillWords(first);
  const bWords = skillWords(second);

  /*
   * 2. The same name in singular and plural: "API" and "APIs", "REST API" and
   *    "REST APIs". The pair has to differ by exactly a trailing LOWER-CASE
   *    "s": a plural is written "APIs", while "HTTPS", "SASS" and "NATS" end in
   *    a capital because the S is part of the name.
   */
  const plural = (short: string, long: string, longWritten: string) =>
    long === `${short}s` && short.length >= 3 && longWritten.trim().endsWith('s');
  if (plural(a, b, second)) return { keep: first, drop: second };
  if (plural(b, a, first)) return { keep: second, drop: first };

  /*
   * 3. The bare name beside the same name with a word in front of it.
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
   * says what was automated and "Automation" says nothing, "AWS Secrets
   * Manager" says whose it is and "Secrets Manager" does not, and a scanner
   * looking for the bare name still matches it inside the longer one because
   * terms are matched on word boundaries.
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

/**
 * Whether `short` is the initials of `long`'s words, a plural "s" aside:
 * "LLMs" / "Large Language Models", "IaC" / "Infrastructure as Code".
 */
function isAcronymOf(short: string, long: string): boolean {
  const compact = short.trim();
  if (!compact || /\s/.test(compact)) return false;
  // Two capitals at least, so a word that happens to spell initials is not one.
  if ((compact.match(/[A-Z]/g) ?? []).length < 2) return false;
  const words = long.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length < 2) return false;
  const initials = words.map((word) => word[0]).join('');
  const letters = compact.toLowerCase().replace(/[^a-z0-9]/g, '');
  return letters === initials || letters === `${initials}s`;
}

export type RestatedSkill = { kept: string; dropped: string };

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

/** `keepCase`: the model says the name's official form starts in lower case ("dbt", "pytest"). */
export type SkillEntry = { name: string; kind: string; keepCase?: boolean };

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
  return { name, kind: kind || 'unlabelled', ...(record.keepCase === true ? { keepCase: true } : {}) };
}

/**
 * Whether an entry's own label says it belongs in the block, whoever wrote it.
 *
 * Block kinds and anything unlabelled or unrecognised are kept: a kind this
 * schema has never heard of is the model inventing one, which says nothing
 * about whether the thing is a tool.
 */
export function belongsInBlock(entry: SkillEntry): boolean {
  return !PROSE_KIND_SET.has(entry.kind);
}

/** The heading of the soft-skills group, which always prints last. */
export const SOFT_SKILLS_GROUP = 'Soft Skills';
const MAX_SOFT_SKILLS_IN_GROUP = 10;

export function isSoftSkillsGroup(category: string): boolean {
  return normalizedName(category) === normalizedName(SOFT_SKILLS_GROUP);
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
};

export function tidySkillGroups<T extends { category: string; skills: unknown[] }>(
  groups: readonly T[],
  options: {
    cap?: number;
    groupCap?: number;
    capitalize?: boolean;
    knownCasing?: ReadonlyMap<string, string>;
    /** Every term the posting asked for, lower-cased. */
    asked?: ReadonlySet<string>;
    /** Whether a person's own text writes this name in lower case; without it, a keepCase mark is trusted. */
    confirmsLowercase?: (name: string) => boolean;
  } = {}
): { groups: Array<{ category: string; skills: string[] }>; report: SkillBlockTidyReport } {
  const report: SkillBlockTidyReport = {
    repeated: [],
    routedToProse: [],
    duplicates: [],
    unlabelled: [],
    trimmed: [],
    mergedGroups: [],
  };

  // 1. Parse whatever shape arrived, and route on the label.
  const seen = new Set<string>();
  const keepCase = new Set<string>();
  const soft: string[] = [];
  const working = groups.map((group) => {
    const kept: string[] = [];
    // A re-parsed block arrives without kinds, so its soft group is known by heading.
    const softGroup = isSoftSkillsGroup(group.category);
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
      if (entry.keepCase) keepCase.add(key);

      if (softGroup || entry.kind === 'soft') {
        soft.push(entry.name);
        continue;
      }
      if (!belongsInBlock(entry)) {
        report.routedToProse.push({ name: entry.name, kind: entry.kind });
        continue;
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
   * twice. `duplicateOf` is mechanical - an acronym beside its expansion, a
   * singular beside its plural, a bare name beside its qualified form - read
   * off the two strings alone, with no table of names behind it.
   */
  /*
   * THE POSTING'S SPELLING WINS. Left to itself the rule keeps the first form
   * written, or the longer one - so "ML" written before "Machine Learning"
   * deleted the form the posting used, and "SQL" beside "Azure SQL" left only
   * "Azure SQL". When the form about to go is one the posting asked for, the
   * two swap; when the posting asked for both, both stay.
   */
  const asked = (name: string) => options.asked?.has(name.trim().toLowerCase()) ?? false;
  const placed: Array<{ name: string; group: number; index: number }> = [];
  const deduped = working.map((group) => ({ category: group.category, skills: [] as string[] }));
  working.forEach((group, groupIndex) => {
    for (const name of group.skills) {
      const clash = placed
        .map((entry) => ({ entry, verdict: duplicateOf(entry.name, name) }))
        .find((pair) => pair.verdict !== null && !(asked(pair.verdict.keep) && asked(pair.verdict.drop)));

      if (clash && clash.verdict) {
        const verdict = clash.verdict;
        const { keep, drop } = asked(verdict.drop) ? { keep: verdict.drop, drop: verdict.keep } : verdict;
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
   * 2.5. An entry that restates the group's own category name.
   *
   * "Automation" in the "CI/CD & Automation" group, "Monitoring" in the
   * "Monitoring" group - each is the heading repeated as though it were a
   * skill, so the entry is removed.
   *
   * A WHOLE PART OF THE HEADING, not any word in it: "AWS" under "AWS Cloud"
   * and "Python" under "Python Ecosystem" are skills, not the heading again.
   * And never a term the posting asked for - "AI" under "ML & AI" on an AI
   * posting is a core skill, whatever the heading says.
   */
  for (const group of deduped) {
    const headingParts = group.category
      .toLowerCase()
      .split(/\s*(?:&|,|\band\b)\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
    group.skills = group.skills.filter((skill) => {
      const skillLower = skill.toLowerCase().trim();
      if (headingParts.includes(skillLower) && !asked(skill)) {
        report.repeated.push(skill);
        return false;
      }
      return true;
    });
  }

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

  // 5. The soft skills, after every technical group and outside its counts.
  const technical = capped.groups.filter((group) => group.category && group.skills.length > 0);
  const printed = soft.length > 0
    ? [...technical, { category: SOFT_SKILLS_GROUP, skills: soft.slice(0, MAX_SOFT_SKILLS_IN_GROUP) }]
    : technical;
  return {
    groups: options.capitalize === false
      ? printed
      : printed.map((group) => ({
        category: group.category,
        skills: group.skills.map((name) => (
          keepCase.has(name.toLowerCase()) && (options.confirmsLowercase?.(name) ?? true)
            ? restoreKnownCasing(name, options.knownCasing)
            : capitalizeSkillWords(name, options.knownCasing))),
      })),
    report,
  };
}

/**
 * Every all-lowercase word of a skill entry gets a capital first letter:
 * "vector databases" -> "Vector Databases", "scikit-learn" -> "Scikit-Learn".
 * A word that already has a capital in it is the maker's own casing and is
 * left alone, so "iOS", "eBPF", "gRPC" and "PyTorch" are untouched.
 */
export function capitalizeSkillWords(name: string, known?: ReadonlyMap<string, string>): string {
  return name.replace(/[^\s/(-]+/g, (word) => {
    if (/[A-Z]/.test(word)) return word;
    return known?.get(word.toLowerCase()) ?? word.charAt(0).toUpperCase() + word.slice(1);
  });
}

/** An entry the model kept in lower case, unless real text writes the name with inner capitals. */
function restoreKnownCasing(name: string, known?: ReadonlyMap<string, string>): string {
  if (!known) return name;
  return name.replace(/[^\s/(-]+/g, (word) => (/[A-Z]/.test(word) ? word : known.get(word.toLowerCase()) ?? word));
}

/**
 * How names are cased in real text - the posting, the profile, the resume's own
 * sentences - for every word with a capital after its first letter: "NumPy",
 * "OpenAPI", "iOS". A model often writes a library as its lower-case import name
 * ("numpy"); a capital inside the word in real text is the maker's own casing.
 * All-capital words ("DBT", "AWS") are left out: they say nothing about casing.
 */
export function namesWithInnerCapitals(texts: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const text of texts) {
    for (const word of text.match(/[A-Za-z][A-Za-z0-9+#]*/g) ?? []) {
      if (!/[A-Z]/.test(word.slice(1)) || !/[a-z]/.test(word)) continue;
      const key = word.toLowerCase();
      if (!found.has(key)) found.set(key, word);
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
 * ─── A bullet that reads like a sentence somebody wrote ──────────────────────
 *
 * The last three faults on the operator's list cannot be repaired from here -
 * each needs the sentence rewritten, which only the model can do - but every
 * one of them can be COUNTED, and a writing rule nobody counts is a writing
 * rule that quietly stops holding. That is the same reason `echoingBullets`
 * exists beside the ban on a verb repeating its own noun.
 */

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
  roles: ReadonlyArray<{ achievements?: string[] }>,
  /*
   * The resume's own skills block. A bullet may open with a name its maker
   * writes in lower case - "dbt models were..." - and the block is where this
   * resume writes it that way; no list of such names is kept here.
   */
  vocabulary: readonly string[] = []
): BrokenBullet[] {
  const found: BrokenBullet[] = [];
  const lowerCaseNames = new Set(
    vocabulary.flatMap((name) => name.split(/\s+/)).filter((word) => /^[a-z]/.test(word)).map((word) => word.toLowerCase())
  );

  for (const role of roles) {
    for (const bullet of role.achievements ?? []) {
      const text = bullet.trim();
      if (!text) continue;

      const firstWord = (/^[A-Za-z][A-Za-z.-]*/.exec(text)?.[0] ?? '').toLowerCase();
      if (SELF_TALK.test(text)) found.push({ bullet: text, shape: 'self-talk' });
      else if (/^[a-z]/.test(text) && !lowerCaseNames.has(firstWord)) {
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
