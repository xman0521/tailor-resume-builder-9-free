const assert = require('node:assert/strict');
const test = require('node:test');

const { useTempStorage } = require('./helpers');

/**
 * How wide a batch runs, and why it is not one number.
 *
 * The free chat providers hold one conversation per browser window: two prompts
 * typed into one composer do not queue, they interleave, and both answers are
 * lost. So the ceiling is exactly how many debug browsers the operator started
 * - and a fan-out above it is not throughput, it is a queue with a longer wait
 * at the end. The subscription seat spawns a process per call and has an
 * entirely different ceiling.
 *
 * Fixed at four, a batch on one browser queued three calls behind every answer
 * while a batch on six left four idle for the whole run. Neither is visible
 * from the page; both look like the app being slow.
 */

function loadCapacity() {
  useTempStorage('batch-capacity');
  delete require.cache[require.resolve('../dist/services/ai/batchCapacity')];
  return require('../dist/services/ai/batchCapacity');
}

/**
 * Stands in for the liveness probe.
 *
 * Width is counted from browsers that are RUNNING, and the real reader opens
 * sockets to localhost - so without this the answers below would depend on
 * which debug browsers the developer had open. `allRunning` restores what these
 * tests were written to assert: every registered browser is up.
 */
const allRunning = (endpoints) => {
  const counts = new Map([['claude-web', 0], ['chatgpt-web', 0]]);
  for (const entry of endpoints) counts.set(entry.siteId, (counts.get(entry.siteId) ?? 0) + 1);
  return Promise.resolve(counts);
};

/** Nothing is up, however much is registered. */
const noneRunning = () => Promise.resolve(new Map([['claude-web', 0], ['chatgpt-web', 0]]));

/** The probe could not answer at all - not the same as "nothing is up". */
const probeUnavailable = () => Promise.resolve(null);

test('an operator override wins over everything worked out', async () => {
  const { resolveBatchCapacity } = loadCapacity();
  const capacity = await resolveBatchCapacity(
    { provider: 'claude-web' },
    { AI_BATCH_CONCURRENCY: '3' }
  );
  assert.equal(capacity.limit, 3);
  assert.match(capacity.reason, /AI_BATCH_CONCURRENCY=3/);
});

test('the subscription seat runs at its own process limit', async () => {
  const { resolveBatchCapacity, cliConcurrency } = loadCapacity();
  const capacity = await resolveBatchCapacity({ provider: 'claude-cli' }, { AI_CLI_CONCURRENCY: '6' });
  assert.equal(capacity.limit, 6);
  assert.match(capacity.reason, /Claude CLI slot/);

  // The same variable and the same default the provider's own semaphore uses.
  // Two readers disagreeing would show up as a batch that queues against a
  // limit nobody configured.
  assert.equal(cliConcurrency({}), 4, 'the default both sides fall back to');
  assert.equal(cliConcurrency({ AI_CLI_CONCURRENCY: '0' }), 1, 'clamped, as the provider clamps it');
  assert.equal(cliConcurrency({ AI_CLI_CONCURRENCY: '99' }), 32);
  assert.equal(cliConcurrency({ AI_CLI_CONCURRENCY: 'lots' }), 4);
});

test('a free provider runs at exactly its browser count', async () => {
  const { resolveBatchCapacity } = loadCapacity();
  const { updateAppSettings } = require('../dist/config/aiModelConfig');
  await updateAppSettings({
    browserChatEndpoints: [
      { siteId: 'claude-web', port: 9222 },
      { siteId: 'claude-web', port: 9223 },
      { siteId: 'chatgpt-web', port: 9224 },
    ],
  });

  const claude = await resolveBatchCapacity({ provider: 'claude-web' }, {}, allRunning);
  assert.equal(claude.limit, 2, 'two browsers, two calls at a time');

  const chatgpt = await resolveBatchCapacity({ provider: 'chatgpt-web' }, {}, allRunning);
  assert.equal(chatgpt.limit, 1, 'one browser, one call at a time');
});

test('a browser that is registered but not started does not widen the batch', async () => {
  /*
   * The failure this pins. Sixteen registered and two running produced a batch
   * sixteen wide, and since one deadline covers both the wait for a browser and
   * the answer, the tail of that queue reached the composer with seconds left
   * and died as "still writing when the deadline passed".
   */
  const { resolveBatchCapacity } = loadCapacity();
  const { updateAppSettings } = require('../dist/config/aiModelConfig');
  await updateAppSettings({
    browserChatEndpoints: Array.from({ length: 16 }, (_, index) => ({
      siteId: 'chatgpt-web',
      port: 9222 + index,
    })),
  });

  const twoUp = () => Promise.resolve(new Map([['claude-web', 0], ['chatgpt-web', 2]]));
  const capacity = await resolveBatchCapacity({ provider: 'chatgpt-web' }, {}, twoUp);
  assert.equal(capacity.limit, 2, 'width should follow what is running, not what is saved');
  assert.match(capacity.reason, /2 of 16/, `the reason should explain the gap: "${capacity.reason}"`);
});

test('nothing running still runs, one at a time', async () => {
  const { resolveBatchCapacity } = loadCapacity();
  const { updateAppSettings } = require('../dist/config/aiModelConfig');
  await updateAppSettings({
    browserChatEndpoints: [
      { siteId: 'claude-web', port: 9222 },
      { siteId: 'chatgpt-web', port: 9223 },
    ],
  });
  const capacity = await resolveBatchCapacity({ provider: 'claude-web' }, {}, noneRunning);
  assert.equal(capacity.limit, 1, 'the first call reports "no browser" far better than a refusal');
});

test('a probe that cannot answer falls back to the registered count', async () => {
  // Not knowing is not the same as knowing nothing is up, and only the second
  // is grounds for narrowing a batch to one.
  const { resolveBatchCapacity } = loadCapacity();
  const { updateAppSettings } = require('../dist/config/aiModelConfig');
  await updateAppSettings({
    browserChatEndpoints: [
      { siteId: 'claude-web', port: 9222 },
      { siteId: 'claude-web', port: 9223 },
      { siteId: 'claude-web', port: 9224 },
    ],
  });
  const capacity = await resolveBatchCapacity({ provider: 'claude-web' }, {}, probeUnavailable);
  assert.equal(capacity.limit, 3);
});

test('a hybrid run gets both accounts added together', async () => {
  // The three-queue arrangement: Claude's browsers and ChatGPT's each pull from
  // their own line as they free up, so the batch has to offer enough work to
  // keep both fed. Offering only one site's worth would leave the other idle.
  const { resolveBatchCapacity } = loadCapacity();
  const { updateAppSettings } = require('../dist/config/aiModelConfig');
  await updateAppSettings({
    browserChatEndpoints: [
      { siteId: 'claude-web', port: 9222 },
      { siteId: 'claude-web', port: 9223 },
      { siteId: 'chatgpt-web', port: 9224 },
    ],
  });

  const hybrid = await resolveBatchCapacity({ provider: 'claude-web', route: 'hybrid' }, {}, allRunning);
  assert.equal(hybrid.limit, 3);
  assert.match(hybrid.reason, /claude-web/);
  assert.match(hybrid.reason, /chatgpt-web/);
});

test('no browsers registered still runs, one at a time', async () => {
  // A batch that refused over capacity would report a capacity problem where
  // the real one is "there is no browser running" - which the first call says
  // far better, and says once rather than once per item.
  const { resolveBatchCapacity } = loadCapacity();
  const { updateAppSettings } = require('../dist/config/aiModelConfig');
  await updateAppSettings({ browserChatEndpoints: [] });
  const capacity = await resolveBatchCapacity({ provider: 'claude-web' }, {}, allRunning);
  assert.equal(capacity.limit, 1);
});

test('the fan-out is capped however many browsers are registered', async () => {
  // Each in-flight item is a model call and, later, a Chrome tab rendering a
  // PDF. Twenty browsers should not mean twenty simultaneous renders.
  const { resolveBatchCapacity } = loadCapacity();
  const { updateAppSettings } = require('../dist/config/aiModelConfig');
  await updateAppSettings({
    browserChatEndpoints: Array.from({ length: 16 }, (_, index) => ({
      siteId: index % 2 === 0 ? 'claude-web' : 'chatgpt-web',
      port: 9300 + index,
    })),
  });
  const capacity = await resolveBatchCapacity({ provider: 'claude-web', route: 'hybrid' }, {}, allRunning);
  assert.ok(capacity.limit <= 16, `${capacity.limit} is above the ceiling`);
});

test('a metered provider keeps the number this app has always used', async () => {
  const { resolveBatchCapacity } = loadCapacity();
  for (const provider of ['claude', 'openai', 'deepseek']) {
    const capacity = await resolveBatchCapacity({ provider }, {});
    assert.equal(capacity.limit, 4, `${provider} has no local resource to count`);
  }
});

test('an unreadable settings row slows the batch rather than failing it', async () => {
  // The capacity is only needed in order to go faster. A batch must not fail
  // over it.
  delete require.cache[require.resolve('../dist/services/ai/batchCapacity')];
  // A path under a regular FILE, so the directory creation fails immediately
  // with ENOTDIR rather than on a permission check that varies by platform.
  process.env.DB_DIR = '/etc/hosts/not-a-directory';
  const { resolveBatchCapacity } = require('../dist/services/ai/batchCapacity');
  const capacity = await resolveBatchCapacity({ provider: 'claude-web' }, {});
  assert.equal(capacity.limit, 1);
});
