const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { closeBrowser } = require('../dist/config/browser');

/**
 * Closing a browser must not fail the work the browser already did.
 *
 * THE ERROR THIS IS ABOUT, off a 500-letter batch on Windows:
 *
 *   EBUSY: resource busy or locked, unlink
 *   'C:\\Users\\...\\Temp\\puppeteer_dev_chrome_profile-rGh3Db\\first_party_sets.db-journal'
 *
 * A launch with no `userDataDir` gets a scratch profile from puppeteer, and
 * `close()` deletes it once Chrome exits. On Windows Chrome's handles outlive
 * the exit by a moment, so the delete races them and loses. Our closes sit in
 * `finally` blocks, so that rejection replaced the real result: a cover letter
 * that had rendered came back as a failure over a scratch file nobody reads.
 *
 * Chrome is gone by then. So this swallows a file-system error on that one
 * directory, sweeps it in the background, and still throws anything else - a
 * browser that genuinely would not close has to stay visible.
 */

const scratch = (name) => path.join(os.tmpdir(), `puppeteer_dev_chrome_profile-${name}`);

const ebusy = (dir) => new Error(
  `EBUSY: resource busy or locked, unlink '${path.join(dir, 'first_party_sets.db-journal')}'`
);

test('a locked scratch profile does not fail the close', async () => {
  const dir = scratch('aTest1');
  await assert.doesNotReject(closeBrowser({
    close: async () => { throw ebusy(dir); },
  }));
});

test('the leftover directory is swept afterwards', async () => {
  const dir = scratch('aTest2');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'first_party_sets.db-journal'), 'x');

  await closeBrowser({ close: async () => { throw ebusy(dir); } });

  // The sweep is deliberately not awaited - the caller has its result already -
  // so this waits out the retries rather than asserting straight away.
  for (let waited = 0; waited < 3000 && fs.existsSync(dir); waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(fs.existsSync(dir), false, 'the scratch profile was left behind');
});

test('the other Windows lock codes are tolerated too', async () => {
  const dir = scratch('aTest3');
  for (const code of ['EPERM', 'ENOTEMPTY', 'EACCES', 'ENOENT']) {
    await assert.doesNotReject(
      closeBrowser({
        close: async () => { throw new Error(`${code}: unlink '${path.join(dir, 'lockfile')}'`); },
      }),
      `${code} should be tolerated`
    );
  }
});

test('a browser that would not close still throws', async () => {
  // Not a file-system error: the window is still up, holding memory, and a
  // batch that keeps launching more needs to hear about it.
  await assert.rejects(
    closeBrowser({ close: async () => { throw new Error('Protocol error: Target closed'); } }),
    /Target closed/
  );

  // A file-system error that is not about a scratch profile is someone else's
  // directory. It throws, and nothing of it is deleted.
  await assert.rejects(
    closeBrowser({ close: async () => { throw new Error("EBUSY: resource busy or locked, unlink '/var/lib/app/data.db'"); } }),
    /EBUSY/
  );
});

test('a path outside the temp directory is never swept', async () => {
  /*
   * The guard that matters. This runs from a catch block, deletes a directory
   * recursively, and takes the path out of an error message - so a path that
   * merely LOOKS like a scratch profile, somewhere real, must be left alone and
   * reported.
   */
  const planted = path.join(process.cwd(), 'test', 'puppeteer_dev_chrome_profile-notTemp');
  fs.mkdirSync(planted, { recursive: true });
  try {
    await assert.rejects(
      closeBrowser({
        close: async () => { throw new Error(`EBUSY: resource busy or locked, unlink '${planted}\\x'`); },
      }),
      /EBUSY/
    );
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(fs.existsSync(planted), true, 'a directory outside TEMP was deleted');
  } finally {
    fs.rmSync(planted, { recursive: true, force: true });
  }
});

test('an ordinary close stays ordinary', async () => {
  let closed = 0;
  await closeBrowser({ close: async () => { closed += 1; } });
  assert.equal(closed, 1);
});

test('a locked scratch profile does not take the server down, and nothing else is swallowed', (t) => {
  /*
   * REPORTED AS: "backend stopped working while generating resumes", with
   *
   *   Error: EBUSY: resource busy or locked, unlink
   *   '...\puppeteer_dev_chrome_profile-Yq4bwy\lockfile'
   *
   * `closeBrowser` above already tolerates this - but only where it is awaited.
   * Puppeteer removes that directory from its OWN cleanup too, which is not in
   * the chain `close()` returns, so the rejection reached nobody. With no
   * `unhandledRejection` handler in the server, Node's default applied and the
   * process died in the middle of a batch.
   */
  const {
    guardTemporaryProfileCleanup,
    resetTemporaryProfileGuardForTests,
  } = require('../dist/config/browser');

  const existing = process.listeners('unhandledRejection');
  for (const listener of existing) process.removeListener('unhandledRejection', listener);
  t.after(() => {
    for (const listener of process.listeners('unhandledRejection')) {
      process.removeListener('unhandledRejection', listener);
    }
    for (const listener of existing) process.on('unhandledRejection', listener);
    resetTemporaryProfileGuardForTests();
  });

  resetTemporaryProfileGuardForTests();
  const rethrown = [];
  const said = [];
  guardTemporaryProfileCleanup({ rethrow: (reason) => rethrown.push(reason), log: (line) => said.push(line) });

  const handlers = process.listeners('unhandledRejection');
  assert.equal(handlers.length, 1, 'the guard installs exactly one handler');
  // Installing twice must not stack handlers: the server start path and a test
  // can both call it, and two would re-throw the same reason twice.
  guardTemporaryProfileCleanup({ rethrow: (reason) => rethrown.push(reason) });
  assert.equal(process.listeners('unhandledRejection').length, 1, 'and only ever one');

  const guard = handlers[0];
  const locked = path.join(os.tmpdir(), 'puppeteer_dev_chrome_profile-Yq4bwy');

  // 1. The reported failure: swallowed, said out loud, and the process lives.
  guard(new Error(`EBUSY: resource busy or locked, unlink '${path.join(locked, 'lockfile')}'`));
  assert.deepEqual(rethrown, [], 'the server must stay up for this one');
  assert.ok(
    said.some((line) => /scratch profile/.test(line)),
    'it says what it swallowed, rather than swallowing it silently'
  );

  /*
   * 2. The half that keeps this honest. A handler that swallowed everything
   * would turn every future bug into a silent one, so anything else is passed
   * straight back out - where, in the real server, the absence of an
   * `uncaughtException` handler means Node behaves exactly as it did before.
   */
  const others = [
    new Error('something else went wrong entirely'),
    // The right shape of error on a path that is NOT a puppeteer scratch dir.
    new Error("EBUSY: resource busy or locked, unlink '/var/lib/app/data.db'"),
    // ...and the right path with an error that is not about the file system.
    new Error(`Protocol error: Target closed while deleting ${locked}`),
  ];
  for (const reason of others) guard(reason);
  assert.deepEqual(rethrown, others, 'everything that is not a locked scratch profile is re-thrown');
});
