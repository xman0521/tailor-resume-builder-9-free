const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  abortPendingShutdown,
  groupFailures,
  pendingShutdown,
  renderRunReport,
  resetPendingShutdownForTests,
  shutdownAfterRun,
  SHUTDOWN_GRACE_SECONDS,
} = require('../dist/services/shutdownAfterRun');

/**
 * "Turn off computer after complete".
 *
 * A 500-resume run takes hours; the operator starts it and leaves. Three things
 * have to happen at the end, IN ORDER: the failures are written somewhere that
 * outlives the machine, the account browsers are closed, and the machine goes
 * off. The order is the whole design - a report that loses the race with the
 * shutdown is the one record of the night, gone.
 *
 * `run` is injected in every test here, so nothing in this file can turn off a
 * real computer. That is not a precaution about CI: it is a precaution about the
 * machine this is developed on.
 */

const NOW = new Date('2026-10-06T07:12:04');

const failures = [
  { profileName: 'Weitian Wu', companyName: 'Acme', sourceRowNumber: 12, error: 'browser did not answer in time' },
  { profileName: 'Weitian Wu', companyName: 'Globex', sourceRowNumber: 18, error: 'browser did not answer in time' },
  { profileName: 'Jonathan Lai', companyName: 'Acme', sourceRowNumber: 12, error: 'browser did not answer in time' },
  { profileName: 'Jordan Bracken', companyName: 'Acme', sourceRowNumber: 12, error: 'rate limited' },
];

const outcome = { totalUnits: 30, profileCount: 3, failures };

test.afterEach(() => resetPendingShutdownForTests());

test('the report names the failed profiles and their rows', () => {
  const text = renderRunReport(outcome, NOW);

  assert.match(text, /30 requested, 26 delivered, 4 failed/);
  // The profile is the unit an operator re-queues; the row is what they open.
  assert.match(text, /Weitian Wu\s+2 job\(s\): row 12, 18/);
  assert.match(text, /Jonathan Lai\s+1 job\(s\): row 12/);
  // Row 12 lost all three profiles, which is a problem with the job and not
  // with the run - the distinction that decides whether re-running helps.
  assert.match(text, /FAILED FOR EVERY PROFILE[^\n]*\r?\n\s*row 12/);
  assert.ok(!/row 18[^\n]*\r?\n?$/.test(text.split('FAILED FOR EVERY PROFILE')[1].split('\n')[1] ?? ''),
    'row 18 failed for one profile and is not an every-profile row');
  // And the detail, so the error itself is recoverable in the morning.
  assert.match(text, /browser did not answer in time/);
  assert.match(text, /rate limited/);
});

test('a job with no row number is named by its company instead', () => {
  const text = renderRunReport(
    { totalUnits: 2, profileCount: 1, failures: [{ profileName: 'Leo Wu', companyName: 'Initech', error: 'no description' }] },
    NOW
  );
  assert.match(text, /Leo Wu\s+1 job\(s\): row "Initech"/);
});

test('jobs lost at analysis are in the report, not silently dropped', () => {
  /*
   * These never reached a build, so they are absent from the build counts and
   * from the failures the build request knows about. Left out, the file
   * describes a shorter run than the one that happened.
   */
  const text = renderRunReport(
    {
      totalUnits: 30,
      profileCount: 3,
      failures,
      priorFailures: [{ companyName: 'Hooli', sourceRowNumber: 90, error: 'the posting could not be downloaded' }],
    },
    NOW
  );
  assert.match(text, /NEVER REACHED A BUILD/);
  assert.match(text, /row 90\s+Hooli\s+- the posting could not be downloaded/);
});

test('a clean run still leaves a file, and it says so', () => {
  const text = renderRunReport({ totalUnits: 120, profileCount: 3, failures: [] }, NOW);
  assert.match(text, /All 120 build\(s\) succeeded\. Nothing to re-run\./);
  assert.ok(!text.includes('FAILED PROFILES'));
});

test('the file is written before anything else is attempted', async () => {
  /*
   * THE ORDER IS THE POINT. The report is the only thing that survives the
   * machine powering down, so it is finished before the browsers are touched and
   * long before the shutdown is issued.
   */
  const order = [];
  const result = await shutdownAfterRun(outcome, {
    writeReport: async () => { order.push('report'); return 'C:\\out\\failed_profiles.txt'; },
    closeBrowsers: async () => { order.push('browsers'); return [{ closed: true }, { closed: true }]; },
    run: async (file, args) => { order.push(`${file} ${args.join(' ')}`); },
    platform: 'win32',
    now: () => NOW,
    log: () => {},
  });

  assert.deepEqual(order, ['report', 'browsers', 'shutdown /s /t 90 /c Free Tailor: the run has finished.']);
  assert.equal(result.reportPath, 'C:\\out\\failed_profiles.txt');
  assert.equal(result.browsersClosed, 2);
  assert.equal(result.scheduled, true);
  assert.equal(result.shutdownAt, NOW.getTime() + SHUTDOWN_GRACE_SECONDS * 1000);
});

test('a report that cannot be written does not keep the machine on all night', async () => {
  // The operator asked for the machine to be off. Losing the summary is worth
  // reporting, not worth overriding them with.
  const logged = [];
  const result = await shutdownAfterRun(outcome, {
    writeReport: async () => { throw new Error('EACCES: output folder is read-only'); },
    closeBrowsers: async () => [{ closed: true }],
    run: async () => {},
    platform: 'win32',
    now: () => NOW,
    log: (message) => logged.push(message),
  });

  assert.equal(result.reportPath, null);
  assert.equal(result.scheduled, true);
  assert.ok(logged.some((line) => /Could not write the run report: EACCES/.test(line)));
});

test('a browser that will not quit does not stop the shutdown either', async () => {
  const result = await shutdownAfterRun(outcome, {
    writeReport: async () => 'C:\\out\\report.txt',
    closeBrowsers: async () => { throw new Error('the window would not quit'); },
    run: async () => {},
    platform: 'win32',
    now: () => NOW,
    log: () => {},
  });
  assert.equal(result.browsersClosed, 0);
  assert.equal(result.scheduled, true);
});

test('a shutdown command that refuses is reported, and nothing is pending', async () => {
  const result = await shutdownAfterRun(outcome, {
    writeReport: async () => 'C:\\out\\report.txt',
    closeBrowsers: async () => [],
    run: async () => { throw new Error('Access is denied.(5)'); },
    platform: 'win32',
    now: () => NOW,
    log: () => {},
  });

  assert.equal(result.scheduled, false);
  assert.equal(result.shutdownAt, null);
  assert.match(result.note, /Access is denied/);
  assert.equal(pendingShutdown(), null, 'nothing is counting down, so the banner must not claim one');
});

test('the delay is what makes the shutdown cancellable', async () => {
  /*
   * `shutdown /s /t 90` is a scheduled shutdown that `shutdown /a` aborts.
   * Issued with `/t 0` there would be nothing to cancel and no notice, and the
   * machine would go off while the response was still in flight.
   */
  const commands = [];
  await shutdownAfterRun(outcome, {
    writeReport: async () => 'x', closeBrowsers: async () => [],
    run: async (file, args) => commands.push([file, ...args].join(' ')),
    platform: 'win32', now: () => NOW, log: () => {},
  });
  assert.match(commands[0], /\/t 90\b/);
  assert.ok(pendingShutdown(), 'the page needs a deadline to count down to');

  const abort = await abortPendingShutdown({
    run: async (file, args) => commands.push([file, ...args].join(' ')),
    platform: 'win32',
    log: () => {},
  });
  assert.equal(abort.aborted, true);
  assert.equal(commands[1], 'shutdown /a');
  assert.equal(pendingShutdown(), null);
});

test('cancelling when nothing is pending leaves the machine on and says so', async () => {
  const abort = await abortPendingShutdown({
    // What Windows says when there is no scheduled shutdown to abort.
    run: async () => { throw new Error('Unable to abort the system shutdown because no shutdown was in progress.(1116)'); },
    platform: 'win32',
    log: () => {},
  });
  assert.equal(abort.aborted, false);
  assert.match(abort.note, /no shutdown was in progress/);
  assert.equal(pendingShutdown(), null, 'the state asked for is the state we are in');
});

test('on a unix host the delay is given in whole minutes', async () => {
  // `shutdown -h +0` is immediate and uncancellable; rounding up keeps a window.
  const commands = [];
  await shutdownAfterRun(outcome, {
    writeReport: async () => 'x', closeBrowsers: async () => [],
    run: async (file, args) => commands.push([file, ...args].join(' ')),
    platform: 'linux', graceSeconds: 90, now: () => NOW, log: () => {},
  });
  assert.equal(commands[0], 'shutdown -h +2');
});

test('the grouping the console prints and the file writes is the same grouping', () => {
  /*
   * One grouping for both, because the console summary and the file disagreeing
   * about which rows failed would be worse than either being wrong alone.
   */
  const grouped = groupFailures(failures, 3);
  assert.deepEqual([...grouped.rowsByProfile.keys()], ['Weitian Wu', 'Jonathan Lai', 'Jordan Bracken']);
  assert.deepEqual(grouped.rowsByProfile.get('Weitian Wu'), [12, 18]);
  assert.deepEqual(grouped.failedForEveryProfile, [12]);

  // Rows are ordered, not left in the order the failures happened to land in:
  // a batch finishes in completion order, which is not an order anyone reads.
  const jumbled = groupFailures(
    [44, 7, 102, 9].map((row) => ({ profileName: 'Shane Mays', companyName: 'C', sourceRowNumber: row, error: 'x' })),
    1
  );
  assert.deepEqual(jumbled.rowsByProfile.get('Shane Mays'), [7, 9, 44, 102]);
});

test('the file lands in the output folder, in Notepad-readable form', async (t) => {
  /*
   * Written where the resumes are, not beside the server: that folder is what
   * the operator opens in the morning. CRLF, because it is opened in Notepad.
   */
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-report-'));
  const config = require('../dist/config/aiModelConfig');
  const original = config.getOutputStorageSettings;
  config.getOutputStorageSettings = async () => ({ outputBaseDir: base, outputPathTemplate: '/x' });
  t.after(() => {
    config.getOutputStorageSettings = original;
    fs.rmSync(base, { recursive: true, force: true });
  });

  const { writeRunReport } = require('../dist/services/shutdownAfterRun');
  const file = await writeRunReport(outcome, NOW);

  assert.equal(path.dirname(file), base);
  assert.match(path.basename(file), /^failed_profiles_2026-10-06_07-12-04\.txt$/);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('\r\n'), 'Notepad needs CRLF');
  assert.match(text, /Weitian Wu\s+2 job\(s\): row 12, 18/);
});
