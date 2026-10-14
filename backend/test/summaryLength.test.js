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

test('the prompt asks for the same 65 words, and sends the rest to the bullets', () => {
  /*
   * The cap and the prompt have to agree. If the prompt still asked for 80-120
   * words, every resume would be written long and then trimmed - and the terms
   * in the dropped sentences would be lost rather than placed in a bullet,
   * which is the half of this the operator actually asked for.
   *
   * READ FROM THE SHIPPED FILE, not through `resolvePromptByExactId`. A SAVED
   * prompt in the operator's database wins over the file at runtime, so both
   * were edited - but what the saved one says is this machine's own data, and a
   * test that asserted on it would be a test about the machine it runs on. That
   * mistake is already in this suite's history: three route tests passed only
   * because a real Chrome happened to be listening on the port the temp
   * database had registered.
   */
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', 'static', 'prompts', 'tailor-resume.json');
  const content = JSON.parse(fs.readFileSync(file, 'utf8')).content || '';

  assert.match(content, /AT MOST 65 words/);
  assert.doesNotMatch(content, /80-120 words/, 'the old budget must be gone, not merely outvoted');

  // ...and the keywords go somewhere, rather than being dropped with the words.
  assert.match(content, /MORE BULLETS, NOT A LONGER PARAGRAPH/);
  assert.match(content, /The summary is not the overflow bin/);
  assert.match(content, /SPREAD THEM\. AT MOST ONE in the summary/);
});
