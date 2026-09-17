import {
  isConceptSkill,
  looksLikeUnlistedHardSkill,
  isRedundantWithLibraryTerm,
} from './hardSkillSelection';

/**
 * Whether a term may be printed in the Technical Skills or Soft Skills block,
 * and if not, why not.
 *
 * WHY A REASON AND NOT A BOOLEAN. The rejections were already happening - a
 * concept, a job title, a prose clause, a term the library covers under another
 * name - but each one was a `continue` inside whichever function noticed, and
 * the term simply vanished. That is the wrong outcome twice over: the keyword
 * was in the posting, so a scanner will look for it, and the operator had no
 * way to see that anything had been dropped or on what grounds.
 *
 * Carrying the reason out lets the caller do the one thing that was missing:
 * put the term somewhere else. A skill that cannot be a bullet in the skills
 * block is still a word the resume should contain, and the prose sections are
 * where it belongs.
 */

export type SkillRejectionReason =
  | 'concept'
  | 'not-a-name'
  | 'covered-by-library-term'
  | 'duplicate'
  | 'over-capacity'
  | 'too-long'
  | 'empty';

export type SkillVerdict =
  | { ok: true; term: string }
  | { ok: false; term: string; reason: SkillRejectionReason; detail: string };

export const REJECTION_DETAIL: Record<SkillRejectionReason, string> = {
  concept: 'names an idea rather than something you can use; the tools it implies are listed instead',
  'not-a-name': 'reads as a phrase rather than a product name',
  'covered-by-library-term': 'says nothing the skill it reduces to does not already say',
  duplicate: 'already on the list under another spelling',
  'over-capacity': 'the block was already full',
  'too-long': 'too long to read as a skill',
  empty: 'blank once trimmed, so there is nothing to print',
};

const reject = (term: string, reason: SkillRejectionReason): SkillVerdict => ({
  ok: false,
  term,
  reason,
  detail: REJECTION_DETAIL[reason],
});

/**
 * The longest a skill may be before it stops reading as one.
 *
 * Not a style rule: the block is a list of short names, and a twelve-word entry
 * is a sentence that has wandered in. `looksLikeUnlistedHardSkill` applies a
 * tighter bound of its own to terms the library has never heard of; this is the
 * outer limit that applies to everything, library rows included.
 */
const MAX_SKILL_CHARACTERS = 48;

/**
 * Whether a term may be printed as a technical skill.
 *
 * `librarySkills` decides which of the two standards applies. A term the
 * library carries has been curated by somebody and only has to clear the
 * concept test; a term it has never heard of has to look like a product name,
 * because nothing else is vouching for it.
 */
export function validateHardSkill(
  term: string,
  librarySkills: ReadonlySet<string>
): SkillVerdict {
  const trimmed = String(term ?? '').trim();
  if (!trimmed) return reject(term, 'empty');
  if (trimmed.length > MAX_SKILL_CHARACTERS) return reject(trimmed, 'too-long');

  // A concept is refused whether the library carries it or not - that is the
  // whole point of the rule, and most of the concepts ARE library rows.
  if (isConceptSkill(trimmed)) return reject(trimmed, 'concept');

  const key = trimmed.toLowerCase().replace(/\s+/g, ' ');
  if (librarySkills.has(key)) return { ok: true, term: trimmed };

  if (isRedundantWithLibraryTerm(trimmed, librarySkills)) {
    return reject(trimmed, 'covered-by-library-term');
  }
  if (!looksLikeUnlistedHardSkill(trimmed)) return reject(trimmed, 'not-a-name');

  return { ok: true, term: trimmed };
}

/**
 * Phrases that are a description of work rather than a soft skill.
 *
 * A soft-skills block is read at a glance, so its entries have to be nameable
 * qualities. "Ability to work in a fast-paced environment" is the posting's
 * sentence, not a quality, and printing it verbatim is what makes a resume look
 * auto-filled - while the words in it still matter to a scanner, which is why
 * it is rejected here and written into the prose instead.
 */
const SOFT_SKILL_PROSE = [
  /^ability to\b/i,
  /^able to\b/i,
  /^experience (with|in)\b/i,
  /^comfortable\b/i,
  /^willing(ness)? to\b/i,
  /^proven track record\b/i,
  /^strong (sense|understanding|grasp)\b/i,
  /\bin a .*environment\b/i,
];

/** The longest a soft skill may be. Two or three words is the shape. */
const MAX_SOFT_SKILL_WORDS = 4;

export function validateSoftSkill(term: string): SkillVerdict {
  const trimmed = String(term ?? '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return reject(term, 'empty');

  if (SOFT_SKILL_PROSE.some((pattern) => pattern.test(trimmed))) {
    return reject(trimmed, 'not-a-name');
  }
  if (trimmed.split(' ').length > MAX_SOFT_SKILL_WORDS) return reject(trimmed, 'too-long');
  // Sentence punctuation means a clause was captured, not a quality.
  if (/[.!?;:]/.test(trimmed)) return reject(trimmed, 'not-a-name');

  return { ok: true, term: trimmed };
}

/**
 * Runs a list through one of the validators, keeping both halves.
 *
 * Both halves, always. The accepted terms are the block; the rejected ones are
 * the caller's obligation - every one of them is a keyword the posting used,
 * and dropping it here is the bug this module exists to stop.
 */
export function partitionSkills(
  terms: string[],
  validate: (term: string) => SkillVerdict
): { accepted: string[]; rejected: SkillVerdict[] } {
  const accepted: string[] = [];
  const rejected: SkillVerdict[] = [];
  const seen = new Set<string>();

  for (const term of terms) {
    const verdict = validate(term);
    if (!verdict.ok) {
      rejected.push(verdict);
      continue;
    }
    const key = verdict.term.toLowerCase();
    if (seen.has(key)) {
      rejected.push(reject(verdict.term, 'duplicate'));
      continue;
    }
    seen.add(key);
    accepted.push(verdict.term);
  }

  return { accepted, rejected };
}
