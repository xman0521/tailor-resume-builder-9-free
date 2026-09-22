/**
 * Turns a model's stand-in dashes into ordinary punctuation.
 *
 * WHY. Both prompts say "Never use em-dashes", and a model that wants one
 * anyway writes the ASCII stand-in instead: "platform engineering -- and what
 * I think makes someone good at it -- is the combination". It reaches the page
 * exactly like that, because nothing between the model and the PDF touches
 * punctuation. Measured on the 150 most recent documents of each kind, one
 * cover letter and one resume carried it - rare, and visible on the page every
 * time it happens.
 *
 * Wording the prompt harder does not close it: the instruction is already
 * there, in both prompts, and this is what obeying it looks like. So the
 * substitution is undone in code, where it cannot be argued with.
 *
 * A dash standing between clauses is standing in for a comma, so that is what
 * it becomes. Two cases are not commas: a span of numbers keeps a hyphen, and
 * a dash with nothing after it is dropped rather than turned into a comma that
 * leads nowhere. A single hyphen is never touched - "multi-account" and
 * "Full-Stack" are spelled that way.
 */

/** Two or more hyphens, or any of the real dashes: figure, en, em, horizontal bar. */
const DASH_RUN = '(?:--+|[\\u2012-\\u2015])';

export function normalizeDashes(text: string): string {
  const source = String(text ?? '');
  if (!source) return source;

  return source
    // A span of numbers is a range: "2019 -- 2021", "10--20%".
    .replace(new RegExp(`(\\d)\\s*${DASH_RUN}\\s*(\\d)`, 'g'), '$1-$2')
    // Opening a line, it is a bullet marker or a stray, not punctuation.
    .replace(new RegExp(`^[ \\t]*${DASH_RUN}[ \\t]*`, 'gm'), '')
    // Nothing follows it: at the end of a line, or right before other punctuation.
    .replace(new RegExp(`\\s*${DASH_RUN}\\s*$`, 'gm'), '')
    .replace(new RegExp(`\\s*${DASH_RUN}\\s*(?=[)\\]},.;:!?])`, 'g'), '')
    // Everything left stands between clauses, which is a comma's job.
    .replace(new RegExp(`\\s*${DASH_RUN}\\s*`, 'g'), ', ')
    // The dash may have sat next to a comma already.
    .replace(/,\s*,/g, ',')
    .replace(/\s+,/g, ',');
}
