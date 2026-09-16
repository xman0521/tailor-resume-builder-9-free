const assert = require('node:assert/strict');
const test = require('node:test');

const { ChatTurnError } = require('../dist/services/ai/providers/browserChat/tab');
const {
  TabPool, getSidelinedEndpoints, resetTabPoolsForTests, getTabPool,
} = require('../dist/services/ai/providers/browserChat/pool');

/**
 * The failure this exists to catch, measured on a real run: 360 resumes, 10
 * failures, and nearly all of them one signed-out ChatGPT browser.
 *
 * A signed-out tab answers the debug port perfectly well, so the liveness probe
 * called it live and the batch counted it toward capacity. A turn against it
 * timed out with "none of its assistant selectors matched anything at all" -
 * and a timeout was classified as NOT the browser's fault, so the endpoint was
 * never sidelined. It stayed in rotation, and each of the three unit retries
 * could land on the same dead tab.
 *
 * Two things had to become true: that particular timeout has to be attributable
 * to the browser, and a sidelined browser must stop counting toward capacity.
 */

test('a turn error can say whether the BROWSER is the suspect', () => {
  const stillWriting = new ChatTurnError('timeout', 'was still writing when the deadline passed');
  assert.equal(stillWriting.browserSuspect, false, 'a slow answer is not a broken browser');

  // Nothing may set it by accident: a throw site added later is innocent until
  // it says otherwise.
  assert.equal(new ChatTurnError('refused', 'wall').browserSuspect, false);
  assert.equal(new ChatTurnError('page', 'could not read').browserSuspect, false);
});

test('a pool reports which of its browsers it is currently refusing to use', () => {
  const pool = new TabPool('claude-web');
  pool.setEndpoints(['http://127.0.0.1:9222', 'http://127.0.0.1:9223']);
  assert.deepEqual(pool.sidelined(), []);

  pool.markUnreachable('http://127.0.0.1:9223', 60_000);
  assert.deepEqual(pool.sidelined(), ['http://127.0.0.1:9223']);

  // It is a statement about a moment, not a verdict: the cooldown expires.
  const later = Date.now() + 61_000;
  assert.deepEqual(pool.sidelined(later), []);
});

test('a sidelined browser is visible to whatever decides batch width', () => {
  resetTabPoolsForTests();
  const pool = getTabPool('chatgpt-web', 'ChatGPT (free)');
  pool.setEndpoints(['http://127.0.0.1:9230', 'http://127.0.0.1:9231']);

  assert.equal(getSidelinedEndpoints().size, 0);

  pool.markUnreachable('http://127.0.0.1:9231', 15 * 60_000);
  const sidelined = getSidelinedEndpoints();
  assert.equal(sidelined.has('http://127.0.0.1:9231'), true);
  assert.equal(sidelined.has('http://127.0.0.1:9230'), false, 'the working browser must keep taking work');

  resetTabPoolsForTests();
});

test('capacity drops a browser the pool has sidelined, without probing it', async () => {
  resetTabPoolsForTests();
  const { countLiveBrowsers, resetBrowserLivenessCache } =
    require('../dist/services/ai/browserLiveness');

  const endpoints = [
    { siteId: 'chatgpt-web', port: 9240 },
    { siteId: 'chatgpt-web', port: 9241 },
  ];

  resetBrowserLivenessCache();
  const before = await countLiveBrowsers(endpoints);
  const runningBefore = before.get('chatgpt-web');

  const pool = getTabPool('chatgpt-web', 'ChatGPT (free)');
  pool.setEndpoints(endpoints.map((entry) => `http://127.0.0.1:${entry.port}`));
  pool.markUnreachable('http://127.0.0.1:9240', 15 * 60_000);

  resetBrowserLivenessCache();
  const after = await countLiveBrowsers(endpoints);
  assert.ok(
    after.get('chatgpt-web') <= runningBefore,
    'sidelining a browser must never raise the count'
  );
  assert.equal(
    after.get('chatgpt-web'),
    0,
    'neither of these ports is a real browser, and one is sidelined besides'
  );

  resetTabPoolsForTests();
  resetBrowserLivenessCache();
});
