const assert = require('node:assert/strict');
const test = require('node:test');

const {
  renderConcurrency,
  withRenderPermit,
  getRenderConcurrencyStats,
  resetRenderConcurrencyForTests,
} = require('../dist/generators/renderConcurrency');
const { resolveBatchCapacity } = require('../dist/services/ai/batchCapacity');
const { BROWSER_CHAT_MAX_ENDPOINTS } = require('../dist/config/aiModelConfig');

/**
 * The failure this exists to catch.
 *
 * Batch width is taken from how many chat browsers are registered, because that
 * is what bounds the MODEL calls. Every item then renders a document, which is
 * a different resource - a tab in the shared Chrome for a resume, a whole
 * Chrome for a cover letter - and nothing bounded it. `MAX_BATCH_CONCURRENCY`
 * was silently holding the line for both at 16, so raising it to match the
 * 50-browser cap would have meant fifty simultaneous renders.
 */

test('the render knob has a default, a floor and a ceiling', () => {
  assert.equal(renderConcurrency({}), 4);
  assert.equal(renderConcurrency({ PDF_RENDER_CONCURRENCY: '8' }), 8);
  assert.equal(renderConcurrency({ PDF_RENDER_CONCURRENCY: '1' }), 1);
  // Nonsense and out-of-range values fall back or clamp rather than throwing.
  assert.equal(renderConcurrency({ PDF_RENDER_CONCURRENCY: '999' }), 16);
  assert.equal(renderConcurrency({ PDF_RENDER_CONCURRENCY: '0' }), 4);
  assert.equal(renderConcurrency({ PDF_RENDER_CONCURRENCY: '-3' }), 4);
  assert.equal(renderConcurrency({ PDF_RENDER_CONCURRENCY: 'many' }), 4);
});

test('renders never exceed the permit count, however many are asked for at once', async () => {
  resetRenderConcurrencyForTests();
  const limit = getRenderConcurrencyStats().limit;

  let inFlight = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 40 }, () =>
      withRenderPermit(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      })
    )
  );

  assert.equal(peak, limit, `40 renders at once peaked at ${peak}, limit is ${limit}`);
  assert.equal(inFlight, 0);
});

test('a render that throws still gives its permit back', async () => {
  resetRenderConcurrencyForTests();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await assert.rejects(
      withRenderPermit(async () => {
        throw new Error('render blew up');
      }),
      /render blew up/
    );
  }

  const stats = getRenderConcurrencyStats();
  assert.equal(stats.inFlight, 0, 'permits leaked on the failure path');
  assert.equal(stats.queued, 0);

  // And the pool still works afterwards.
  assert.equal(await withRenderPermit(async () => 'ok'), 'ok');
});

test('the render bound is independent of the batch width', async () => {
  // The point of the split: model calls may run far wider than renders.
  const wide = await resolveBatchCapacity({ provider: 'claude-web', route: 'hybrid' });
  assert.ok(
    wide.limit <= BROWSER_CHAT_MAX_ENDPOINTS,
    `batch width ${wide.limit} exceeds the browser cap ${BROWSER_CHAT_MAX_ENDPOINTS}`
  );
  assert.ok(
    getRenderConcurrencyStats().limit < BROWSER_CHAT_MAX_ENDPOINTS,
    'the render bound must be tighter than the browser cap, or it is not a bound'
  );
});

test('batch width can now exceed the old ceiling of 16', () => {
  // Regression guard for the constant this change exists to lift: it was a
  // hard 16, so registering more browsers bought nothing past sixteen.
  assert.ok(
    BROWSER_CHAT_MAX_ENDPOINTS > 16,
    'the browser cap should allow more than the old batch ceiling'
  );
});
