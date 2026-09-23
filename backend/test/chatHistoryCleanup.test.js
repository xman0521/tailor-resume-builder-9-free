const assert = require('node:assert/strict');
const test = require('node:test');

const {
  clearClaudeHistory,
  clearChatGptHistory,
} = require('../dist/services/ai/providers/browserChat/history');
const { clearAllChatHistory } = require('../dist/services/ai/providers/browserChat');

/**
 * Emptying the account browsers' chat lists after a run.
 *
 * One conversation per call is what makes reading the reply sound, so a batch
 * of 500 resumes leaves 500 chats in each account. These two scripts run INSIDE
 * the signed-in tab, which is the only place the account's own session exists -
 * so the only way to check them without an account is to call them here with
 * `fetch` stubbed, which is why they are written to use nothing else.
 */

/** A fake site: a list of conversations, and the requests made against it. */
function fakeSite({ conversations, deleteFails = false, bulk = true, orgs = ['org-1'] }) {
  const state = { conversations: [...conversations], calls: [] };

  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    state.calls.push(`${method} ${url}`);
    const json = (body, ok = true, status = ok ? 200 : 500) => ({
      ok,
      status,
      json: async () => body,
    });

    if (url === '/api/organizations') return json(orgs.map((uuid) => ({ uuid })));

    // claude.ai
    const claudeList = /^\/api\/organizations\/([^/]+)\/chat_conversations\?/.exec(url);
    if (claudeList) return json(state.conversations.slice(0, 50).map((uuid) => ({ uuid })));
    const claudeDelete = /^\/api\/organizations\/[^/]+\/chat_conversations\/(.+)$/.exec(url);
    if (claudeDelete && method === 'DELETE') {
      if (deleteFails) return json(null, false, 403);
      state.conversations = state.conversations.filter((uuid) => uuid !== claudeDelete[1]);
      return json({ ok: true });
    }

    // chatgpt.com
    if (url === '/api/auth/session') return json({ accessToken: 'token-123' });
    if (url.startsWith('/backend-api/conversations?')) {
      return json({ total: state.conversations.length, items: state.conversations.slice(0, 50).map((id) => ({ id })) });
    }
    if (url === '/backend-api/conversations' && method === 'PATCH') {
      if (!bulk) return json(null, false, 404);
      state.conversations = [];
      return json({ success: true });
    }
    const gptHide = /^\/backend-api\/conversation\/(.+)$/.exec(url);
    if (gptHide && method === 'PATCH') {
      state.conversations = state.conversations.filter((id) => id !== gptHide[1]);
      return json({ success: true });
    }

    return json(null, false, 404);
  };

  return state;
}

test('every Claude conversation is deleted, however many pages it takes', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  // More than one page, which is the ordinary case after a batch.
  const site = fakeSite({ conversations: Array.from({ length: 120 }, (_, i) => `c-${i}`) });
  const result = await clearClaudeHistory();

  assert.deepEqual(result, { deleted: 120, failed: 0 });
  assert.equal(site.conversations.length, 0);
  // Always asked for from offset 0: the list shrinks underneath, so an
  // advancing offset would step over whatever moved up behind it.
  assert.ok(site.calls.every((call) => !call.includes('offset=50')), 'the offset must not advance');
});

test('two organizations are both cleared', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  fakeSite({ conversations: ['a', 'b'], orgs: ['org-1', 'org-2'] });
  const result = await clearClaudeHistory();
  assert.equal(result.deleted, 2);
});

test('a list that refuses to delete stops rather than looping forever', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  // The same page comes back every time: without the guard this never ends.
  fakeSite({ conversations: ['a', 'b', 'c'], deleteFails: true });
  const result = await clearClaudeHistory();
  assert.equal(result.deleted, 0);
  assert.equal(result.failed, 3, 'each refusal is counted once, then it gives up');
});

test('a signed-out browser reports why instead of appearing to succeed', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => null });
  assert.match((await clearClaudeHistory()).note ?? '', /HTTP 401/);
  assert.match((await clearChatGptHistory()).note ?? '', /HTTP 401/);
});

test('ChatGPT uses its own delete-all, and falls back to one at a time', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  const bulkSite = fakeSite({ conversations: Array.from({ length: 80 }, (_, i) => `g-${i}`) });
  assert.deepEqual(await clearChatGptHistory(), { deleted: 80, failed: 0 });
  assert.equal(bulkSite.conversations.length, 0);
  assert.equal(
    bulkSite.calls.filter((call) => call.startsWith('PATCH /backend-api/conversation/')).length,
    0,
    'the bulk call makes the per-conversation loop unnecessary'
  );

  // The bulk endpoint is undocumented and may go away; the loop is the backstop.
  const oneByOne = fakeSite({ conversations: ['g-1', 'g-2', 'g-3'], bulk: false });
  assert.deepEqual(await clearChatGptHistory(), { deleted: 3, failed: 0 });
  assert.equal(oneByOne.conversations.length, 0);
});

test('nothing to delete is not an error', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  fakeSite({ conversations: [] });
  assert.deepEqual(await clearClaudeHistory(), { deleted: 0, failed: 0 });
  assert.deepEqual(await clearChatGptHistory(), { deleted: 0, failed: 0 });
});

// ------------------------------------------------------------- the sweep

// High ports nothing listens on. The sweep is always handed its browsers and
// its clear function here: pointed at the real settings it would reach the
// operator's signed-in browsers, which is exactly what happened once.
const BROWSERS = [
  { port: 59281, siteId: 'claude-web' },
  { port: 59282, siteId: 'chatgpt-web' },
];

test('every registered browser is cleared, and the counts are reported', async () => {
  const swept = [];
  const results = await clearAllChatHistory({
    browsers: BROWSERS,
    leased: () => false,
    log: () => {},
    clear: async (endpoint, siteId) => {
      swept.push(`${endpoint} ${siteId}`);
      return { deleted: 7, failed: 0 };
    },
  });

  assert.deepEqual(swept.sort(), ['http://127.0.0.1:59281 claude-web', 'http://127.0.0.1:59282 chatgpt-web']);
  assert.equal(results.reduce((total, row) => total + row.deleted, 0), 14);
  // Rows come back in the order the page lists the browsers, whatever order
  // they finished in, so the page can show them against its own list.
  assert.deepEqual(results.map((row) => row.port), [59281, 59282]);
});

test('a browser in the middle of a call is left alone', async () => {
  // Deleting the conversation a turn is reading would break that turn, and the
  // button can be pressed while a batch is running.
  const swept = [];
  const results = await clearAllChatHistory({
    browsers: BROWSERS,
    leased: (endpoint) => endpoint.endsWith('59281'),
    log: () => {},
    clear: async (endpoint) => {
      swept.push(endpoint);
      return { deleted: 3, failed: 0 };
    },
  });

  assert.deepEqual(swept, ['http://127.0.0.1:59282']);
  assert.match(results[0].note ?? '', /busy/);
});

test('one browser failing does not stop the others', async () => {
  const results = await clearAllChatHistory({
    browsers: BROWSERS,
    leased: () => false,
    log: () => {},
    clear: async (endpoint) => {
      if (endpoint.endsWith('59281')) throw new Error('browser is not running');
      return { deleted: 5, failed: 0 };
    },
  });

  assert.match(results[0].error ?? '', /not running/);
  assert.equal(results[1].deleted, 5);
});

test('no registered browsers is nothing to do, not an error', async () => {
  assert.deepEqual(await clearAllChatHistory({ browsers: [], log: () => {} }), []);
});

test('generating resumes never clears chat history by itself', () => {
  /*
   * It used to run at the end of every batch; the operator asked for that to
   * stop and for a button instead. A trigger inside a route is also reached
   * by anything that drives the route - which is how a test once aimed it at
   * real browsers. So the batch routes must not reach it at all: the only
   * caller is the admin route behind the Settings button.
   */
  const fs = require('node:fs');
  const path = require('node:path');
  const routes = path.join(__dirname, '..', 'dist', 'routes');

  const callers = fs
    .readdirSync(routes)
    .filter((file) => file.endsWith('.js'))
    .filter((file) => fs.readFileSync(path.join(routes, file), 'utf8').includes('clearAllChatHistory'));

  assert.deepEqual(callers, ['admin.js'], 'only the admin route may clear chat history');

  const admin = fs.readFileSync(path.join(routes, 'admin.js'), 'utf8');
  assert.match(admin, /router\.post\('\/browser\/clear-history', auth_1\.authMiddleware/,
    'and only behind the admin sign-in');
});
