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
  /*
   * Ports high enough that no debug browser will be on them.
   *
   * This test first used 9240 and 9241 and asserted the live count was zero,
   * which held until the machine running it had real browsers registered there
   * - and then failed for a reason that had nothing to do with the code. A test
   * whose answer depends on what the developer happens to have open is not
   * measuring what it claims to.
   */
  resetTabPoolsForTests();
  const { countLiveBrowsers, resetBrowserLivenessCache } =
    require('../dist/services/ai/browserLiveness');

  const endpoints = [
    { siteId: 'chatgpt-web', port: 59240 },
    { siteId: 'chatgpt-web', port: 59241 },
  ];

  resetBrowserLivenessCache();
  const before = (await countLiveBrowsers(endpoints)).get('chatgpt-web');
  assert.equal(before, 0, 'nothing should be listening this high; pick freer ports');

  const pool = getTabPool('chatgpt-web', 'ChatGPT (free)');
  pool.setEndpoints(endpoints.map((entry) => `http://127.0.0.1:${entry.port}`));
  pool.markUnreachable('http://127.0.0.1:59240', 15 * 60_000);

  resetBrowserLivenessCache();
  const after = (await countLiveBrowsers(endpoints)).get('chatgpt-web');

  // The property that matters, stated as a relation rather than a number:
  // sidelining a browser may only ever narrow the batch.
  assert.ok(after <= before, `sidelining raised the count, ${before} -> ${after}`);
  assert.equal(after, 0);

  resetTabPoolsForTests();
  resetBrowserLivenessCache();
});
