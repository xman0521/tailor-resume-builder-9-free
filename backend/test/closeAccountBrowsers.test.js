const assert = require('node:assert/strict');
const test = require('node:test');

const { closeAllAccountBrowsers } = require('../dist/services/ai');

/**
 * The "Close all browsers" button on the Settings page.
 *
 * WHY IT EXISTS. A run needs as many signed-in windows as there are accounts,
 * and when it is over they are fifty Chrome windows holding memory. This is the
 * counterpart to the chat-history button beside it, and it follows the same two
 * rules: it works through the list of browsers that page shows, and it leaves a
 * browser that is answering a request alone - closing the window a turn is
 * reading from would fail that turn, and the button can be pressed mid-batch.
 *
 * Everything here is injected, so no test ever reaches a real browser. The one
 * time an automatic sweep DID reach the operator's real browsers, it deleted an
 * account's chat history, and the lesson stuck.
 */

const browsers = [
  { port: 9222, siteId: 'claude-web' },
  { port: 9223, siteId: 'claude-web' },
  { port: 9224, siteId: 'chatgpt-web' },
];

test('every registered browser is closed, and the list says which', async () => {
  const closed = [];
  const logged = [];

  const results = await closeAllAccountBrowsers({
    browsers,
    close: async (endpoint) => { closed.push(endpoint); },
    leased: () => false,
    forget: () => {},
    env: {},
    log: (message) => logged.push(message),
  });

  assert.deepEqual(closed.sort(), [
    'http://127.0.0.1:9222',
    'http://127.0.0.1:9223',
    'http://127.0.0.1:9224',
  ]);
  assert.equal(results.length, 3);
  assert.ok(results.every((row) => row.closed));
  assert.match(logged[0], /3 of 3 closed/);
});

test('a browser in the middle of a call is left open', async () => {
  const closed = [];
  const results = await closeAllAccountBrowsers({
    browsers,
    close: async (endpoint) => { closed.push(endpoint); },
    leased: (endpoint) => endpoint.endsWith('9223'),
    forget: () => {},
    env: {},
    log: () => {},
  });

  assert.deepEqual(closed.sort(), ['http://127.0.0.1:9222', 'http://127.0.0.1:9224']);
  const busy = results.find((row) => row.port === 9223);
  assert.equal(busy.closed, false);
  assert.match(busy.note, /busy with a call/);
  assert.equal(busy.error, undefined, 'a skipped browser is not an error');
});

test('a browser that was not running is reported as such, not as a failure', async () => {
  const results = await closeAllAccountBrowsers({
    browsers: [{ port: 9222, siteId: 'claude-web' }, { port: 9223, siteId: 'claude-web' }],
    close: async (endpoint) => {
      if (endpoint.endsWith('9223')) {
        throw new Error('Could not reach a debug browser at http://127.0.0.1:9223: ECONNREFUSED');
      }
    },
    leased: () => false,
    forget: () => {},
    env: {},
    log: () => {},
  });

  const stopped = results.find((row) => row.port === 9223);
  assert.equal(stopped.closed, false);
  assert.match(stopped.note, /was not running/);
  assert.equal(stopped.error, undefined);
  // And it does not stop the others.
  assert.equal(results.find((row) => row.port === 9222).closed, true);
});

test('a browser that refuses to close is reported, and the rest still close', async () => {
  const results = await closeAllAccountBrowsers({
    browsers,
    close: async (endpoint) => {
      if (endpoint.endsWith('9223')) throw new Error('the window would not quit');
    },
    leased: () => false,
    forget: () => {},
    env: {},
    log: () => {},
  });

  const stuck = results.find((row) => row.port === 9223);
  assert.match(stuck.error, /would not quit/);
  assert.equal(results.filter((row) => row.closed).length, 2);
});

test('the cached handles are dropped afterwards, whatever happened', async () => {
  /*
   * A connection to a browser that has quit is not reusable, and reusing one is
   * how a driver reports healthy while answering nothing. So this runs even when
   * every close failed.
   */
  let forgotten = 0;
  await closeAllAccountBrowsers({
    browsers,
    close: async () => { throw new Error('nope'); },
    leased: () => false,
    forget: () => { forgotten += 1; },
    env: {},
    log: () => {},
  });
  assert.equal(forgotten, 1);

  // Nothing registered: nothing to close, and nothing to forget either.
  let touched = 0;
  const none = await closeAllAccountBrowsers({
    browsers: [],
    close: async () => { touched += 1; },
    leased: () => false,
    forget: () => { touched += 1; },
    env: {},
    log: () => {},
  });
  assert.deepEqual(none, []);
  assert.equal(touched, 0);
});

test('an explicit CDP url wins over the registered ports', async () => {
  // The same override the rest of this provider honours: one browser, named by
  // the environment, rather than the registered list.
  const closed = [];
  await closeAllAccountBrowsers({
    browsers,
    close: async (endpoint) => { closed.push(endpoint); },
    leased: () => false,
    forget: () => {},
    env: { AI_WEB_CDP_URL: 'http://127.0.0.1:9999' },
    log: () => {},
  });
  assert.deepEqual([...new Set(closed)], ['http://127.0.0.1:9999']);
});
