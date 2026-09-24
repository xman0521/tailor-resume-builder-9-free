/**
 * The resume's vocabulary, enforced in code rather than asked for in a prompt.
 *
 * WHY BOTH. The prompt now carries the style rules, and a model mostly follows
 * them - "mostly" being the problem. Measured over 120 finished resumes before
 * this existed, 39% carried at least one word from the list below. A rule that
 * holds 61% of the time is not a rule, so the words the operator banned are
 * taken out here, after the model has answered and before anything is printed.
 *
 * TWO KINDS OF EDIT, and the difference is deliberate.
 *
 * A DELETED ADJECTIVE loses nothing: "scalable backend services" and "backend
 * services" name the same thing, and the first is only louder. So the hype
 * adjectives are removed outright.
 *
 * A SWAPPED VERB does change the claim slightly - "designed" and "built" are
 * not synonyms - and that is the trade the operator asked for: a resume that
 * says "Built the ingest pipeline" reads as work done by a person, where
 * "Architected an event-driven data ingestion solution" reads as nobody. The
 * swaps are chosen to keep the sentence true and grammatical: each replaces one
 * word with one word of the same tense, and the ones that cannot be done that
 * way ("Contributed to X" -> "Helped with X") replace the whole phrase.
 *
 * Nothing here touches skill names, job titles, company names or dates. Those
 * are facts, and "Integration Engineer" is a title whatever this thinks of the
 * word.
 */

/** Deleted where they appear: each is decoration, not information. */
const HYPE_ADJECTIVES = [
  'seamless', 'seamlessly', 'robust', 'robustly', 'scalable', 'highly scalable',
  'cross-functional', 'cross functional', 'end-to-end', 'end to end',
  'innovative', 'dynamic', 'cutting-edge', 'cutting edge', 'state-of-the-art',
  'world-class', 'best-in-class', 'next-generation', 'holistic', 'transformative',
  'comprehensive', 'extensive', 'proven', 'strategic', 'sophisticated',
];

/**
 * One word for one word, same tense.
 *
 * `led` carries a guard rather than a plain swap: "led to" is not the verb this
 * bans, and "ran to a 40% reduction" is nonsense.
 */
const VERB_SWAPS: Array<[string, string]> = [
  ['leveraged', 'used'], ['leveraging', 'using'], ['leverages', 'uses'], ['leverage', 'use'],
  ['utilized', 'used'], ['utilizing', 'using'], ['utilizes', 'uses'], ['utilize', 'use'],
  ['spearheaded', 'ran'], ['spearheading', 'running'], ['spearheads', 'runs'], ['spearhead', 'run'],
  ['orchestrated', 'ran'], ['orchestrating', 'running'], ['orchestrates', 'runs'],
  ['orchestrate', 'run'],
  ['streamlined', 'simplified'], ['streamlining', 'simplifying'], ['streamlines', 'simplifies'],
  ['streamline', 'simplify'],
  ['maximized', 'raised'], ['maximizing', 'raising'], ['maximizes', 'raises'], ['maximize', 'raise'],
  ['architected', 'built'], ['architecting', 'building'], ['architects', 'builds'],
  ['designed', 'built'], ['designing', 'building'],
  ['delivered', 'shipped'], ['delivering', 'shipping'], ['delivers', 'ships'], ['deliver', 'ship'],
  ['drove', 'ran'], ['driving', 'running'],
  ['integrated', 'connected'], ['integrating', 'connecting'], ['integrates', 'connects'],
  ['integrate', 'connect'],
  ['managed', 'ran'], ['managing', 'running'], ['manages', 'runs'], ['manage', 'run'],
  ['supported', 'maintained'], ['supporting', 'maintaining'], ['supports', 'maintains'],
];

/** Phrases that need their object rewired, so the whole phrase is replaced. */
const PHRASE_SWAPS: Array<[string, string]> = [
  ['contributed to', 'helped with'],
  ['contributing to', 'helping with'],
  ['partnered with', 'worked with'],
  ['partnering with', 'working with'],
  ['collaborated with', 'worked with'],
  ['collaborating with', 'working with'],
];

/**
 * Left alone, and reported instead.
 *
 * A metaphor cannot be swapped for a word: "moved the needle on latency" has
 * to become a number, and only the model knows which. Logging it is what an
 * operator can act on - it says the prompt needs work, not this file.
 */
const METAPHORS = [
  'wear many hats', 'moving the needle', 'move the needle', 'north star',
  'in the trenches', 'hit the ground running', 'low-hanging fruit', 'bridge the gap',
  'from the ground up', 'heavy lifting', 'force multiplier', 'silver bullet',
  'deep dive', 'tip of the spear', 'the glue', 'swiss army', 'game-changer',
];

const word = (term: string): RegExp =>
  new RegExp(`(?<![\\w-])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'gi');

/** "Built" for "Designed", "built" for "designed". */
function matchCase(replacement: string, original: string): string {
  if (original === original.toUpperCase() && original.length > 1) return replacement.toUpperCase();
  if (original[0] === original[0]?.toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * A term the POSTING asked for, which this must not touch.
 *
 * The collision that made this parameter necessary: the analyser extracts
 * 15-25 past-tense action verbs per posting as required keywords, and its own
 * examples are "architected" and "orchestrated". The prompt then tells the
 * model to write every checklist term, and this file swapped them straight
 * back out - so the app asked for a word and then deleted it. Measured on a
 * model answer that placed every term perfectly: coverage fell from 34/34 to
 * 17/34, eleven of them lost here.
 *
 * Matched the way the coverage check matches, so a phrase counts the same way
 * it will be scored: "scalable systems" is protected whole, while a bare
 * "scalable" the model chose on its own is still deleted.
 */
function protectedPattern(term: string): RegExp {
  const body = term
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Spaces and hyphens are interchangeable, exactly as the coverage check
    // treats them: "end-to-end delivery" and "end to end delivery" are one term.
    .replace(/(\\s|\s|-)+/g, '[\\s-]+');
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'gi');
}

/** A character no resume contains, so a masked term cannot be edited. */
const MASK = '\u0000';

export function plainLanguage(text: string, protectedTerms: readonly string[] = []): string {
  let out = String(text ?? '');
  if (!out.trim()) return out;

  /*
   * Hidden before the rewrite and put back after, rather than checked at each
   * swap: a banned word can sit INSIDE a protected phrase ("cross-functional
   * collaboration"), and a swap that ran first would leave the phrase
   * unmatchable by the scanner it was written for.
   */
  const kept: string[] = [];
  for (const term of protectedTerms) {
    const trimmed = String(term ?? '').trim();
    if (!trimmed) continue;
    out = out.replace(protectedPattern(trimmed), (match) => {
      kept.push(match);
      return `${MASK}${kept.length - 1}${MASK}`;
    });
  }

  for (const [from, to] of PHRASE_SWAPS) {
    out = out.replace(word(from), (match) => matchCase(to, match));
  }

  for (const [from, to] of VERB_SWAPS) {
    out = out.replace(word(from), (match) => matchCase(to, match));
  }

  // "led to" survives; "led the migration" does not.
  out = out.replace(/(?<![\w-])led(?![\w-])(?!\s+to\b)/gi, (match) => matchCase('ran', match));

  /*
   * The comma inside a RUN of them goes too.
   *
   * "a robust, seamless integration" is one list of adjectives, and deleting
   * the words one at a time leaves the commas that separated them. A comma
   * before anything else belongs to the sentence - "ran deployments
   * end-to-end, simplifying the release" needs the one it has - so only a
   * comma standing between two banned adjectives is taken.
   */
  const anyAdjective = HYPE_ADJECTIVES.map((term) => term.replace(/[-\s]/g, '[\\s-]')).join('|');
  for (const adjective of HYPE_ADJECTIVES) {
    out = out.replace(
      new RegExp(`${word(adjective).source}\\s*(?:,|and)\\s*(?=(?:${anyAdjective})(?![A-Za-z0-9]))`, 'gi'),
      ''
    );
  }

  for (const adjective of HYPE_ADJECTIVES) {
    out = out.replace(word(adjective), '');
  }

  out = articles(tidy(out));
  return kept.length === 0
    ? out
    : out.replace(new RegExp(`${MASK}(\\d+)${MASK}`, 'g'), (_match, index: string) => kept[Number(index)]);
}

/**
 * The punctuation a deleted word leaves behind.
 *
 * "scalable, robust services" loses two words and would otherwise keep both
 * commas; "a scalable API" would keep a double space.
 */
function tidy(text: string): string {
  return text
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/,(\s*,)+/g, ',')
    /*
     * A comma the deleted word was holding up.
     *
     * "a robust, seamless integration" loses both adjectives and leaves "a,
     * integration" - that comma was separating them and now separates nothing.
     * A comma after any other word belongs to the sentence and stays, which is
     * why this asks what comes BEFORE it: "ran deployments end-to-end,
     * simplifying the release" must keep the comma it needs.
     */
    .replace(/(?<![\w-])(a|an|the|of|with|in|for|to|and|or)\s*,\s*/gi, '$1 ')
    .replace(/\(\s*\)/g, '')
    .replace(/,\s*\./g, '.')
    .replace(/\s+$/gm, '')
    .trim();
}

/**
 * "a integration" -> "an integration".
 *
 * Deleting an adjective can leave the article in front of a different word than
 * the one it agreed with, and a resume that says "a ingest path" reads as
 * broken English rather than as plain speech. Sound, not spelling: "an SLA" and
 * "a one-off" are both right, so the exceptions are listed.
 */
function articles(text: string): string {
  const vowelSound = (next: string): boolean => {
    const lower = next.toLowerCase();
    if (/^(one|once|uni|use|user|usab|euro|ubiqu)/.test(lower)) return false;
    if (/^(hour|honest|honou?r)/.test(lower)) return true;
    if (/^[aeiou]/.test(lower)) return true;
    // A letter read aloud: "an SLA", "an HTTP endpoint", "an XML feed".
    return /^[FHLMNRSX](?![a-z])/.test(next);
  };

  return text.replace(/(?<![\w-])(a|an|A|An)\s+([\w.$-]+)/g, (match, article: string, next: string) => {
    const wanted = vowelSound(next) ? 'an' : 'a';
    const cased = article[0] === article[0].toUpperCase() ? wanted[0].toUpperCase() + wanted.slice(1) : wanted;
    return `${cased} ${next}`;
  });
}

/** Every banned term still present, for the log. Metaphors included. */
export function bannedTermsIn(text: string, protectedTerms: readonly string[] = []): string[] {
  let value = String(text ?? '');
  // A term the posting asked for is not a style problem to report.
  for (const term of protectedTerms) {
    const trimmed = String(term ?? '').trim();
    if (trimmed) value = value.replace(protectedPattern(trimmed), ' ');
  }
  const found = new Set<string>();

  for (const [from] of [...PHRASE_SWAPS, ...VERB_SWAPS]) {
    if (word(from).test(value)) found.add(from);
  }
  if (/(?<![\w-])led(?![\w-])(?!\s+to\b)/i.test(value)) found.add('led');
  for (const adjective of HYPE_ADJECTIVES) {
    if (word(adjective).test(value)) found.add(adjective);
  }
  for (const metaphor of METAPHORS) {
    if (value.toLowerCase().includes(metaphor)) found.add(metaphor);
  }
  return [...found];
}
