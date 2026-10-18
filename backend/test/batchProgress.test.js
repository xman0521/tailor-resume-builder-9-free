const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const express = require('express');

const {
  startBatch, advanceBatch, finishBatch, watchBatch, getBatchProgress, setBatchPhase,
  resetBatchProgressForTests,
} = require('../dist/services/batchProgress');
const resumeRouter = require('../dist/routes/resume').default;

/**
 * The failure this exists to catch: `/generate-multi-job` builds the whole
 * profile x job grid inside ONE request, so its response cannot report anything
 * until the last resume is done. A 360-resume run therefore sat on "0 / 360"
 * for an hour and read as frozen - and the line under the bar said "preparing
 * resume generation" the whole time, because the page derives that from
 * `completed > 0`.
 */

test('a page that subscribes before the batch starts misses nothing', () => {
  resetBatchProgressForTests();
  const seen = [];
  const stop = watchBatch('run', (p) => seen.push(`${p.completed}/${p.total}`));

  // Subscribing to a run the server has never heard of is the ORDINARY case:
  // the page opens the stream, then posts the work.
  assert.deepEqual(seen, ['0/0']);

  startBatch('run', 2, 'Building resumes');
  advanceBatch('run', { ok: true, profileName: 'A', companyName: 'X' });
  advanceBatch('run', { ok: false, profileName: 'B', companyName: 'Y' });
  finishBatch('run');

  assert.deepEqual(seen, ['0/0', '0/2', '1/2', '2/2', '2/2']);
  stop();

  const final = getBatchProgress('run');
  assert.equal(final.completed, 2);
  assert.equal(final.failed, 1, 'a failed unit still advances the bar');
  assert.equal(final.done, true);
});

test('the last unit to land is named, so the page can say what it is building', () => {
  resetBatchProgressForTests();
  startBatch('run', 1, 'Building resumes');
  advanceBatch('run', { ok: true, profileName: 'Jonathan Lai', companyName: 'Tempus AI' });

  const progress = getBatchProgress('run');
  assert.equal(progress.profileName, 'Jonathan Lai');
  assert.equal(progress.companyName, 'Tempus AI');
});

test('a late subscriber is told the run is over rather than left waiting', () => {
  resetBatchProgressForTests();
  startBatch('run', 1, 'Building resumes');
  advanceBatch('run', { ok: true });
  finishBatch('run');

  const seen = [];
  const stop = watchBatch('run', (p) => seen.push(p.done));
  assert.deepEqual(seen, [true]);
  stop();
});

test('calls for a run that was never started do nothing, rather than throwing', () => {
  resetBatchProgressForTests();
  advanceBatch('ghost', { ok: true });
  setBatchPhase('ghost', 'Building resumes');
  finishBatch('ghost');
  assert.equal(getBatchProgress('ghost'), null);
});

test('a listener whose socket died does not take the batch down', () => {
  // Including on the immediate first call, which is a different code path from
  // every later event and was not guarded at first.
  resetBatchProgressForTests();
  assert.doesNotThrow(() => watchBatch('run', () => { throw new Error('socket gone'); }));

  startBatch('run', 1, 'Building resumes');
  advanceBatch('run', { ok: true });
  assert.equal(getBatchProgress('run').completed, 1, 'the batch stopped advancing');
});

test('the stream is a real event-stream, and closes itself when the run ends', async () => {
  resetBatchProgressForTests();

  const app = express();
  app.use(express.json());
  app.use('/api/resume', resumeRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = server.address().port;
    const frames = [];
    /*
     * The batch is driven only once the client is listening.
     *
     * This used to be a 50ms timer, which is a race: `watchBatch` sends its
     * snapshot the moment a listener subscribes, so a run that starts and
     * finishes before the HTTP connection is established delivers ONE frame -
     * the final state - and the frame count below fails. 50ms is plenty on an
     * idle machine and not always enough while the rest of the suite runs
     * beside it, which is the kind of failure that teaches an operator to
     * re-run a suite instead of reading it.
     */
    let subscribed;
    const listening = new Promise((resolve) => { subscribed = resolve; });

    const finished = new Promise((resolve, reject) => {
      const request = http.get(
        `http://127.0.0.1:${port}/api/resume/batch-progress/run-http`,
        (response) => {
          assert.equal(response.statusCode, 200);
          assert.match(response.headers['content-type'], /text\/event-stream/);
          // Without this a proxy buffers the stream into uselessness.
          assert.equal(response.headers['x-accel-buffering'], 'no');

          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            for (const line of chunk.split('\n')) {
              if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
            }
            // The first frame is the snapshot `watchBatch` sends on subscribe,
            // so by here the listener is attached and no event can be missed.
            subscribed();
          });
          response.on('end', resolve);
          response.on('error', reject);
        }
      );
      request.on('error', reject);
    });

    await listening;
    startBatch('run-http', 2, 'Building resumes');
    advanceBatch('run-http', { ok: true, profileName: 'A', companyName: 'X' });
    advanceBatch('run-http', { ok: false, profileName: 'B', companyName: 'Y' });
    finishBatch('run-http');

    await finished;

    const last = frames[frames.length - 1];
    assert.equal(last.done, true, 'the server should end the stream on done');
    assert.equal(last.completed, 2);
    assert.equal(last.failed, 1);
    assert.ok(frames.length >= 4, `only ${frames.length} frames arrived, so the bar would jump`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
