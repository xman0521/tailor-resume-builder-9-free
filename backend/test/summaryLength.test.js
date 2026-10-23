const assert = require('node:assert/strict');
const test = require('node:test');

const { useTempStorage } = require('./helpers');

useTempStorage('summary-length');

const { capSummarySentences, summarySentences } = require('../dist/services/resumeService');

/**
 * The summary is two or three sentences, at least two, with no word limit.
 *
 * ASKED FOR: "I don't need 50-word limit, just 2-3 sentences and at least 2."
 * The word cap was what produced one-sentence summaries - it dropped whole
 * sentences from the end until the paragraph was under 50 words - so it is
 * gone, and the only thing code does to a summary's length is drop a fourth
 * sentence and beyond. A one-sentence summary is the prompt's to prevent.
 */

const words = (value) => value.trim().split(/\s+/).filter(Boolean).length;

test('a summary of two or three sentences is returned exactly as written', () => {
  for (const summary of [
    'Platform engineer of 9 years building payment systems that clear 40M transactions a day. '
      + 'Work has centred on Kubernetes, Terraform and Go services.',
    'Platform engineer building payment systems. Across 9 years the work has been Go services. '
      + 'Runs the settlement path end to end.',
  ]) {
    const result = capSummarySentences(summary);
    assert.equal(result.summary, summary);
    assert.equal(result.dropped, 0);
  }
});

test('there is no word limit: long sentences are kept whole', () => {
  const summary =
    'Platform engineer building payment and logistics systems that clear 40 million transactions a day '
    + 'across Kubernetes, Terraform and Go services for teams in three regions. '
    + 'Across 9 years the work has been taking latency and cost out of the paths other teams depend on, '
    + 'from the settlement core to the reporting jobs that finance reads every morning before the markets open.';
  assert.ok(words(summary) > 50, 'the fixture has to be past the old cap to mean anything');

  const result = capSummarySentences(summary);
  assert.equal(result.summary, summary, 'both sentences survive, whatever their length');
  assert.equal(result.sentences, 2);
  assert.equal(result.dropped, 0);
});

test('a summary is held to three sentences, dropped whole from the end', () => {
  const summary = 'Engineer of 9 years. Builds payment systems. Runs them in production. Mentors the team.';
  const result = capSummarySentences(summary);
  assert.equal(result.summary, 'Engineer of 9 years. Builds payment systems. Runs them in production.');
  assert.equal(result.sentences, 3);
  assert.equal(result.dropped, 1);
});

test('one sentence is left as it is, and reported rather than rewritten', () => {
  const one = 'Platform engineer of 9 years building payment systems on Go and Kubernetes.';
  const result = capSummarySentences(one);
  assert.equal(result.summary, one);
  assert.equal(result.sentences, 1);
});

test('an empty summary stays empty, so the fallback can take over', () => {
  // The caller treats "" as "the model gave nothing" and builds a fallback from
  // the profile. Returning a space here would defeat that.
  for (const value of ['', '   ', '\n']) {
    const result = capSummarySentences(value);
    assert.equal(result.summary, '');
    assert.equal(result.dropped, 0);
  }
});

test('a stop inside a name or a number is not a sentence end, and nothing is lost', () => {
  // The old splitter skipped the text before "Node.js" when it had to trim.
  const summary = 'Backend engineer of 9.5 years on Node.js and ASP.NET services. Ships them weekly. '
    + 'Runs the on-call rotation. Reviews every schema change.';
  assert.deepEqual(summarySentences(summary), [
    'Backend engineer of 9.5 years on Node.js and ASP.NET services.',
    'Ships them weekly.',
    'Runs the on-call rotation.',
    'Reviews every schema change.',
  ]);
  assert.equal(
    capSummarySentences(summary).summary,
    'Backend engineer of 9.5 years on Node.js and ASP.NET services. Ships them weekly. Runs the on-call rotation.'
  );
});

test('the prompt asks for two or three sentences and names no word limit', () => {
  /*
   * READ FROM THE SHIPPED FILE, not through `resolvePromptByExactId`: a saved
   * prompt in the operator's database wins at runtime, so both were edited, but
   * what the saved one says is this machine's own data.
   */
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (id) => JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'static', 'prompts', `${id}.json`), 'utf8')
  ).content;
  const content = read('tailor-resume');

  assert.match(content, /Summary: 2-3 sentences - TWO AT LEAST, never one\./);
  assert.match(content, /keeps the first three sentences and drops any after them/);
  assert.match(content, /THE SUMMARY IS TWO OR THREE SENTENCES AND STATES THE YEARS/);
  assert.match(content, /LEAD WITH WHAT SETS THIS PERSON APART/, 'differentiator-first summary');
  assert.match(content, /The span of experience goes in the/, 'years are not the opener');
  assert.match(content, /Normal sentence\s+capitalisation/);
  assert.match(content, /no "Known for X and Y\."/, 'the shape the spec named is banned by name');

  // No word limit anywhere it used to be stated, in either prompt.
  for (const text of [content, read('revise-resume-coverage')]) {
    assert.doesNotMatch(text, /50 words|fifty words|AT MOST \d+ words/i);
  }

  // The keyword rules still point at the bullets.
  assert.match(content, /MORE BULLETS, NOT A LONGER PARAGRAPH/);
  assert.match(content, /The summary is\s+not the overflow bin/);
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

test('the analyser no longer carries its both-forms rule at all', () => {
  // It manufactured the pairs - "RAG" and "Retrieval-Augmented Generation" side
  // by side in one skills group - so it is gone, not just deduplicated.
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', 'static', 'prompts', 'analyze-job-description.json');
  const content = JSON.parse(fs.readFileSync(file, 'utf8')).content;

  assert.equal(content.includes('BOTH FORMS OF EVERY SHORT NAME'), false);
});
