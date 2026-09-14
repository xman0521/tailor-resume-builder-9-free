const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveBatchCapacity } = require('../dist/services/ai/batchCapacity');
const {
  countLiveBrowsers,
  resetBrowserLivenessCache,
} = require('../dist/services/ai/browserLiveness');
const { webTimeoutMs, defaultTimeoutMsFor } = require('../dist/services/ai/promptExecution');
const { minAnswerMs, answerBudgetMs } = require('../dist/services/ai/providers/browserChat');
const { getBrowserChatEndpoints } = require('../dist/config/aiModelConfig');

/**
 * The failure this exists to catch, seen on a real run:
 *
 *   Claude (free) was still writing when the deadline passed
 *
 * Sixteen ChatGPT browsers were registered and two were running. Batch width
 * came from the REGISTERED count, so eighteen units were dispatched onto four
 * live browsers, and because a single deadline covers both the wait for a
 * browser and the answer itself, the tail of that queue reached the composer
 * with seconds left and died mid-sentence. The message blamed the model for
 * time the queue had spent.
 *
 * Three things had to change, and each is pinned below.
 */

test('batch width counts browsers that are running, not rows that were saved', async () => {
  resetBrowserLivenessCache();
  const endpoints = await getBrowserChatEndpoints();
  const live = await countLiveBrowsers(endpoints);

  assert.ok(live, 'the probe should answer on a local machine');

  const registered = endpoints.length;
  const running = [...live.values()].reduce((sum, count) => sum + count, 0);
  assert.ok(running <= registered, `${running} running exceeds ${registered} registered`);

  const capacity = await resolveBatchCapacity({ provider: 'claude-web', route: 'hybrid' });
  assert.ok(
    capacity.limit <= Math.max(1, registered),
    `width ${capacity.limit} exceeds what is registered`
  );
  assert.match(capacity.reason, /running$/, `reason should say what it counted: "${capacity.reason}"`);
});

test('a browser that is down is not counted for its site', async () => {
  resetBrowserLivenessCache();
  // Ports nothing is listening on. The probe must report them down rather than
  // throw, because one dead browser is an ordinary state, not an outage.
  const live = await countLiveBrowsers([
    { siteId: 'claude-web', port: 59731 },
    { siteId: 'chatgpt-web', port: 59732 },
  ]);

  assert.ok(live);
  assert.equal(live.get('claude-web'), 0);
  assert.equal(live.get('chatgpt-web'), 0);
});

test('an empty registration asks nothing and answers nothing', async () => {
  resetBrowserLivenessCache();
  const live = await countLiveBrowsers([]);
  assert.deepEqual([...live.entries()], []);
});

test('the live count is cached, so a batch does not re-probe per item', async () => {
  resetBrowserLivenessCache();
  const endpoints = [{ siteId: 'claude-web', port: 59733 }];

  const first = Date.now();
  await countLiveBrowsers(endpoints);
  const cold = Date.now() - first;

  const second = Date.now();
  for (let i = 0; i < 25; i += 1) await countLiveBrowsers(endpoints);
  const warm = Date.now() - second;

  assert.ok(warm <= cold + 50, `25 cached reads took ${warm}ms against a ${cold}ms probe`);
});

test('a turn gets a full answer window however long it queued', () => {
  const floor = minAnswerMs({});
  assert.equal(floor, 180_000);

  // The case that was failing: the queue ate the budget.
  assert.equal(answerBudgetMs(0), floor, 'a turn with no time left got no time to answer');
  assert.equal(answerBudgetMs(1_000), floor);

  // And a call that still has plenty keeps all of it - the floor is a floor,
  // not a cap.
  assert.equal(answerBudgetMs(600_000), 600_000);
});

test('the answer floor is configurable', () => {
  assert.equal(minAnswerMs({ AI_WEB_MIN_ANSWER_MS: '240000' }), 240_000);
  assert.equal(minAnswerMs({ AI_WEB_MIN_ANSWER_MS: '0' }), 180_000);
  assert.equal(minAnswerMs({ AI_WEB_MIN_ANSWER_MS: 'soon' }), 180_000);
});

test('browser providers have their own timeout knob', () => {
  assert.equal(webTimeoutMs({}), 300_000);
  assert.equal(webTimeoutMs({ AI_WEB_TIMEOUT_MS: '600000' }), 600_000);
  assert.equal(webTimeoutMs({ AI_WEB_TIMEOUT_MS: '-1' }), 300_000);
  assert.equal(webTimeoutMs({ AI_WEB_TIMEOUT_MS: '' }), 300_000);
});

test('the knob reaches the chat providers and leaves the others alone', () => {
  const original = process.env.AI_WEB_TIMEOUT_MS;
  process.env.AI_WEB_TIMEOUT_MS = '600000';
  try {
    assert.equal(defaultTimeoutMsFor('claude-web'), 600_000);
    assert.equal(defaultTimeoutMsFor('chatgpt-web'), 600_000);
    // An API provider is not answering at reading speed and keeps the default.
    assert.equal(defaultTimeoutMsFor('openai'), 300_000);
    assert.equal(defaultTimeoutMsFor('claude-cli'), 300_000);
  } finally {
    if (original === undefined) delete process.env.AI_WEB_TIMEOUT_MS;
    else process.env.AI_WEB_TIMEOUT_MS = original;
  }
});
