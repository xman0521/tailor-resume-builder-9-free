const assert = require('node:assert/strict');
const test = require('node:test');

const { useTempStorage } = require('./helpers');

useTempStorage('summary-length');

const { capSummaryWords } = require('../dist/services/resumeService');

/**
 * The summary is at most 65 words, and the keywords it used to carry go into
 * the bullets instead.
 *
 * WHY A CODE CEILING AND NOT JUST A PROMPT RULE. The prompt asked for 80-120
 * words and got paragraphs that filled a third of the first page before a
 * reader reached anything the candidate had done. A prompt rule is a request; a
 * cap is a fact. Both are in place - the prompt so the model writes to the
 * right length and spends its keywords in the bullets, this so a long one
 * cannot reach the page.
 */

const words = (value) => value.trim().split(/\s+/).filter(Boolean).length;

test('a summary within the cap is returned exactly as written', () => {
  const summary =
    'Platform engineer of 9 years building payment systems that clear 40M transactions a day. '
    + 'Work has centred on Kubernetes, Terraform and Go services.';
  const result = capSummaryWords(summary, 65);

  assert.equal(result.summary, summary.trim());
  assert.equal(result.dropped, 0);
  assert.ok(result.words <= 65);
});

test('a long summary loses whole sentences from the end, not a clause', () => {
  /*
   * The cut has to land on a sentence boundary. A paragraph chopped at the 65th
   * word ends mid-clause, and it is the first thing anybody sees on the page.
   */
  const summary = [
    'Platform engineer of 9 years building payment and logistics systems.',
    'Work has centred on Kubernetes, Terraform and Go services across three teams.',
    'A practice built around distributed systems and the cost of running them.',
    'Reliability work has reduced incident response times across several platforms.',
    'Mentoring and design review are a regular part of the week, across two offices.',
  ].join(' ');

  const result = capSummaryWords(summary, 30);

  assert.ok(result.words <= 30, `${result.words} words is over the cap`);
  assert.ok(result.dropped > 0, 'something should have been dropped');
  // Whole sentences: what survives still ends in a stop, and every sentence it
  // kept is one the model actually wrote.
  assert.match(result.summary, /[.!?]$/, 'the trimmed paragraph must still end in a stop');
  for (const sentence of result.summary.split(/(?<=[.!?])\s+/)) {
    assert.ok(summary.includes(sentence.trim()), `invented or cut a sentence: ${sentence}`);
  }
});

test('one sentence longer than the whole budget is left alone', () => {
  /*
   * There is no cut that improves it. Halving a sentence would be the renderer
   * rewriting the candidate's prose, and a slightly long paragraph is the
   * lesser fault - the run logs it instead.
   */
  const oneLongSentence =
    'Platform engineer of 9 years building payment and logistics systems that clear 40 million '
    + 'transactions a day across Kubernetes, Terraform and Go services, with a record of taking '
    + 'latency and cost out of the paths that other teams depend on every single day.';
  assert.ok(words(oneLongSentence) > 40, 'the fixture has to exceed the cap to mean anything');

  const result = capSummaryWords(oneLongSentence, 40);
  assert.equal(result.summary, oneLongSentence.trim(), 'kept whole');
  assert.equal(result.dropped, 0);
  assert.ok(result.words > 40, 'and reported as over, rather than quietly cut');
});

test('an empty summary stays empty, so the fallback can take over', () => {
  // The caller treats "" as "the model gave nothing" and builds a fallback from
  // the profile. Returning a space here would defeat that.
  for (const value of ['', '   ', '\n']) {
    const result = capSummaryWords(value, 65);
    assert.equal(result.summary, '');
    assert.equal(result.dropped, 0);
  }
});

test('the cap can be moved without editing the source', () => {
  // The same escape hatch the bullet cap has: an operator changing their mind
  // about 65 should not need a rebuild.
  const summary = 'One two three four five six seven eight nine ten.';
  assert.equal(capSummaryWords(summary, 100).words, 10);

  const original = process.env.RESUME_MAX_SUMMARY_WORDS;
  process.env.RESUME_MAX_SUMMARY_WORDS = '5';
  try {
    // Called with no explicit cap, so it reads the environment.
    const result = capSummaryWords('One two three. Four five six. Seven eight nine.');
    assert.ok(result.words <= 5, `${result.words} words ignored the override`);
  } finally {
    if (original === undefined) delete process.env.RESUME_MAX_SUMMARY_WORDS;
    else process.env.RESUME_MAX_SUMMARY_WORDS = original;
  }
});

test('the prompt asks for the same 80 words, with a floor so the model fills it', () => {
  /*
   * The cap and the prompt have to agree, and the FLOOR is the half that was
   * missing. Measured over 60 delivered resumes per run: asked only for "at
   * most 65", the model wrote a median of 52 and not one summary was trimmed by
   * the code - it retreated from a ceiling rather than filling it, and the share
   * of skills terms also appearing in the summary fell from 16% to 4%. The ATS
   * average fell about ten points with it.
   *
   * READ FROM THE SHIPPED FILE, not through `resolvePromptByExactId`: a saved
   * prompt in the operator's database wins at runtime, so both were edited, but
   * what the saved one says is this machine's own data.
   */
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', 'static', 'prompts', 'tailor-resume.json');
  const content = JSON.parse(fs.readFileSync(file, 'utf8')).content;

  assert.match(content, /Summary: 65-80 words, 4-5 sentences/);
  assert.match(content, /AIM AT 80, never under 65/, 'a ceiling alone is what produced 52-word summaries');
  assert.doesNotMatch(content, /AT MOST 65 words/, 'the ceiling-only wording must be gone');
  assert.doesNotMatch(content, /80-120 words/, 'and so must the budget before it');

  // The keyword rules still point at the bullets, which is the half that was
  // asked for separately and must not be undone by widening the paragraph.
  assert.match(content, /MORE BULLETS, NOT A LONGER PARAGRAPH/);
  assert.match(content, /The summary is not the overflow bin/);

  // Every reference to the old budget moved together. A rule still citing 65 as
  // the ceiling would be arguing with the one above it.
  assert.doesNotMatch(content, /65 words/, 'no rule may still quote 65 as the budget');
});

test('the code ceiling matches the budget the prompt asks for', () => {
  // They are set in different files and drift silently: a prompt asking for 80
  // against a cap of 65 would have every summary trimmed on arrival, which is
  // the mirror image of the bug this pair was written for.
  const { capSummaryWords } = require('../dist/services/resumeService');

  const seventy = Array.from({ length: 70 }, (_, i) => `word${i}`).join(' ') + '.';
  const result = capSummaryWords(seventy);
  assert.equal(result.dropped, 0, 'a 70-word summary is inside the budget and must not be trimmed');
  assert.equal(result.words, 70);
});

test('the skills block gets one form of a thing, and the rules do not contradict each other', () => {
  /*
   * REPORTED AS duplicate skills: "LLMs, Large Language Models", "CI/CD, CI/CD
   * pipelines", "AWS, Amazon Web Services". The code dedup is exact-match only
   * and cannot see those as the same thing, so the prompt decides - and the
   * prompt was arguing with itself in three places:
   *
   *   - near the top: "both forms ... both go on the page", with no mention of
   *     where, which reads as "put both in the block";
   *   - 100 lines later: "THE BLOCK GETS ONE ... drop the rest from the list";
   *   - inside that same section, with no heading between them: "BOTH FORMS OF
   *     A SHORT NAME ... write both", which is about the CONCEPTS checklist and
   *     read as being about the block.
   *
   * The duplicates the operator saw were the example strings from those rules.
   * Read from the shipped file for the reason the summary test above gives: the
   * saved record is this machine's own data.
   */
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', 'static', 'prompts', 'tailor-resume.json');
  const content = JSON.parse(fs.readFileSync(file, 'utf8')).content;

  // The global rule now says WHERE each form goes, rather than only that both
  // belong somewhere.
  assert.doesNotMatch(
    content,
    /both forms are on the checklist\s*\n\s*and both go on the page\./,
    'the bare "both go on the page" is what made the block the obvious place for both'
  );
  assert.match(content, /both go on the page - but NOT in the same place/);
  assert.match(content, /The skills block takes one\s*\n\s*of them; the prose takes the other/);

  // The concepts rule has a heading of its own, so "both forms" is visibly not
  // about the block, and its referent is named rather than "These".
  assert.match(content, /CONCEPTS AND CAPABILITIES: BOTH FORMS, IN THE PROSE/);
  assert.match(content, /Concepts and capabilities do NOT appear in the skills list/);
  assert.doesNotMatch(content, /These do NOT appear in the skills list/, 'an unnamed "These" is what made it ambiguous');

  // ...and it points back at the rule that settles the block, so the two are
  // read together rather than as rivals.
  const conceptsAt = content.indexOf('CONCEPTS AND CAPABILITIES: BOTH FORMS');
  const blockAt = content.indexOf('THE BLOCK GETS ONE');
  assert.ok(blockAt > 0 && conceptsAt > blockAt, 'the block rule still comes first');
  assert.match(content, /the block gets ONE form of a thing, never two/);
  assert.match(content, /and that entry belongs in a SENTENCE, not in the skills list/);
});

test('the analyser no longer carries its both-forms rule twice', () => {
  // A bad patch had duplicated the whole paragraph, doubling the emphasis on
  // the one instruction that manufactures the pairs. The operator removed it
  // from the saved record; this pins the shipped file, which a fresh install
  // reads and which still had both copies.
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', 'static', 'prompts', 'analyze-job-description.json');
  const content = JSON.parse(fs.readFileSync(file, 'utf8')).content;

  const occurrences = content.split('BOTH FORMS OF EVERY SHORT NAME').length - 1;
  assert.equal(occurrences, 1, `the paragraph appears ${occurrences} times`);
});
