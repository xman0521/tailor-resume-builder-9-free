const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

const { useTempStorage } = require('./helpers');
const { resolveBatchCapacity } = require('../dist/services/ai/batchCapacity');

/**
 * A run that needs account browsers, with none running.
 *
 * WHAT WAS REPORTED. "The progress bar shows 10/15 but no one generated. I
 * don't know why." Every item of a batch asks a signed-in browser for its
 * answer, so with none up every item fails - and a failed item is still an item
 * that finished, so the bar counted all ten as completed and moved. Fifteen
 * failures, several minutes, nothing saved, and no line anywhere saying what
 * was wrong.
 *
 * Two things fix it and both are tested here: the batch refuses before it
 * queues anything, and it says what to do about it.
 */

const browserChoice = { provider: 'chatgpt-web' };

// A probe that answered, and the answer was zero.
const nothingLive = async () => new Map([['chatgpt-web', 0]]);
// A probe that could not answer at all.
const probeFailed = async () => null;

test('nothing running is reported, with what is registered', async () => {
  const capacity = await resolveBatchCapacity(browserChoice, {}, nothingLive);
  assert.ok(capacity.noBrowsersRunning, 'the caller needs to know, to say it once');
  assert.deepEqual(capacity.noBrowsersRunning.sites, ['chatgpt-web']);
  // The capacity itself is unchanged: this is not a capacity problem, and
  // narrowing the batch would not describe it.
  assert.equal(capacity.limit, 1);
});

test('a probe that could not answer does not refuse the run', async () => {
  /*
   * The distinction the liveness probe is built around: not knowing is not the
   * same as knowing nothing is up. A batch refused over an unreadable probe
   * would be a worse failure than the one this guards against, because it would
   * stop runs that were going to work.
   */
  const capacity = await resolveBatchCapacity(browserChoice, {}, probeFailed);
  assert.equal(capacity.noBrowsersRunning, undefined);
});

test('a browser that is up is not reported as missing', async () => {
  const capacity = await resolveBatchCapacity(
    browserChoice,
    {},
    async () => new Map([['chatgpt-web', 2]])
  );
  assert.equal(capacity.noBrowsersRunning, undefined);
});

test('a provider that needs no browser is never refused', async () => {
  // The CLI provider and the default path do not ask a browser anything, so the
  // question does not apply to them.
  for (const choice of [{ provider: 'claude-cli' }, { provider: 'anthropic' }]) {
    const capacity = await resolveBatchCapacity(choice, {}, nothingLive);
    assert.equal(capacity.noBrowsersRunning, undefined, `${choice.provider} should not be refused`);
  }
});

test('the batch refuses before it queues anything, and says what to do', async (t) => {
  useTempStorage('no-browsers');

  const capacityModule = require('../dist/services/ai/batchCapacity');
  const originalCapacity = capacityModule.resolveBatchCapacity;
  capacityModule.resolveBatchCapacity = async () => ({
    limit: 1,
    reason: '0 chatgpt-web browsers running',
    noBrowsersRunning: { registered: 4, sites: ['chatgpt-web'] },
  });

  // If the guard works, nothing below is ever reached. Each one throws loudly
  // so a regression is reported as what it is rather than as a failed assertion
  // about a response body.
  const execution = require('../dist/services/ai/promptExecution');
  const originalCompletion = execution.createPromptCompletion;
  execution.createPromptCompletion = async () => {
    throw new Error('the model was called for a run that had no browser to call it with');
  };
  const generator = require('../dist/generators/pdfGenerator');
  const originalPdf = generator.generateResumePDF;
  generator.generateResumePDF = async () => {
    throw new Error('a resume was rendered for a run that should have been refused');
  };

  const { saveProfile } = require('../dist/database/profileRepository');
  const profile = saveProfile({
    id: 'no-browser-profile', createdAt: '', updatedAt: '',
    name: 'Jordan Bracken', title: 'Software Engineer',
    contact: { phone: '555', email: 'j@example.com', location: 'Austin, TX' },
    summary: 'Engineer.',
    experience: [{
      title: 'Software Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
      location: 'Austin, TX', description: '', achievements: ['Did work.'], skills: [],
    }],
    skills: [], education: [], certifications: [], strengths: [],
  });

  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  delete require.cache[require.resolve('../dist/routes/resume')];
  app.use('/api/resume', require('../dist/routes/resume').default);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  t.after(async () => {
    capacityModule.resolveBatchCapacity = originalCapacity;
    execution.createPromptCompletion = originalCompletion;
    generator.generateResumePDF = originalPdf;
    await new Promise((resolve) => server.close(resolve));
  });

  const progressId = 'no-browsers-run';
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/resume/generate-multi-job`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: 'pdf',
        profileIds: [profile.id],
        progressId,
        jobs: [
          { companyName: 'One', role: 'DevOps Engineer', jobDescription: 'x'.repeat(80), sourceRowNumber: 1 },
          { companyName: 'Two', role: 'DevOps Engineer', jobDescription: 'x'.repeat(80), sourceRowNumber: 2 },
        ],
      }),
    }
  );

  const body = await response.json();
  assert.equal(response.status, 503, JSON.stringify(body).slice(0, 300));
  // Named, counted, and with the command that fixes it - the operator reading
  // this is looking at an empty output folder.
  assert.match(body.error, /No AI account browser is running/);
  assert.match(body.error, /4 chatgpt-web browser\(s\) are registered but none are open/);
  assert.match(body.error, /npm run browser:debug/);

  // And no progress stream was opened for a run that never happened: a bar that
  // appears and sits at 0 is the thing being fixed, not a smaller version of it.
  const { getBatchProgress } = require('../dist/services/batchProgress');
  assert.equal(getBatchProgress(progressId), null);
});

test('a failing run says why, while it is still running', async () => {
  /*
   * The other half of the report. The batch's response lists every failure, but
   * it does not arrive until the last item is done - on a 500-build run, an hour
   * after the first one went wrong. The progress stream is the only thing the
   * page hears from in the meantime, and it carried a count and no reason.
   */
  const { startBatch, advanceBatch, watchBatch, getBatchProgress, resetBatchProgressForTests } =
    require('../dist/services/batchProgress');
  resetBatchProgressForTests();

  const seen = [];
  const stop = watchBatch('why', (progress) => seen.push(progress));
  startBatch('why', 15, 'Building resumes');

  advanceBatch('why', {
    ok: false,
    profileName: 'Jordan Bracken',
    companyName: 'Acme',
    error: 'ChatGPT (free): none of its assistant selectors matched anything at all.',
  });

  const afterFailure = getBatchProgress('why');
  assert.equal(afterFailure.failed, 1);
  assert.match(afterFailure.lastError, /none of its assistant selectors matched/);
  assert.ok(
    seen.some((p) => p.lastError && /assistant selectors/.test(p.lastError)),
    'the watching page is told as it happens, not at the end'
  );

  // A later success does not wipe it: a run producing nothing for one reason
  // should not have that reason blink out because one item got through.
  advanceBatch('why', { ok: true, profileName: 'Jordan Bracken', companyName: 'Globex' });
  assert.match(getBatchProgress('why').lastError, /assistant selectors/);
  assert.equal(getBatchProgress('why').failed, 1);
  assert.equal(getBatchProgress('why').completed, 2);

  // ...and a different failure replaces it, because the newest reason is the
  // one worth reading.
  advanceBatch('why', { ok: false, profileName: 'Leo Wu', companyName: 'Initech', error: 'was still writing when the deadline passed' });
  assert.match(getBatchProgress('why').lastError, /still writing/);

  stop();
  resetBatchProgressForTests();
});

test('a run says what it is working on before anything finishes', async () => {
  /*
   * The reported hang. A tailoring call against a free chat browser has a
   * five-minute budget, so the first item of a run can take minutes to land.
   * Until it did, the page had a count of zero and the words "preparing resume
   * generation" - a bar with nothing on it, which is what a hang looks like.
   */
  const { startBatch, beginBatchUnit, advanceBatch, getBatchProgress, finishBatch, resetBatchProgressForTests } =
    require('../dist/services/batchProgress');
  resetBatchProgressForTests();

  startBatch('inflight', 5, 'Building resumes');
  assert.deepEqual(getBatchProgress('inflight').inFlight ?? [], []);

  for (const name of ['Joshua Teramae', 'William Thompson', 'Jordan Bracken']) {
    beginBatchUnit('inflight', { profileName: name, companyName: 'Acme' });
  }

  const working = getBatchProgress('inflight');
  assert.equal(working.completed, 0, 'nothing has finished yet - that is the point');
  assert.deepEqual(working.inFlight, [
    'Joshua Teramae - Acme',
    'William Thompson - Acme',
    'Jordan Bracken - Acme',
  ]);

  // Finishing one takes it off the list and leaves the others on it.
  advanceBatch('inflight', { ok: true, profileName: 'William Thompson', companyName: 'Acme' });
  assert.deepEqual(getBatchProgress('inflight').inFlight, ['Joshua Teramae - Acme', 'Jordan Bracken - Acme']);
  assert.equal(getBatchProgress('inflight').completed, 1);

  // A failure clears its slot too, or a run that failed everything would show
  // five things forever "in progress".
  advanceBatch('inflight', { ok: false, profileName: 'Joshua Teramae', companyName: 'Acme', error: 'no reply' });
  assert.deepEqual(getBatchProgress('inflight').inFlight, ['Jordan Bracken - Acme']);

  // Two profiles can share a company, so only ONE slot is removed per finish.
  beginBatchUnit('inflight', { profileName: 'Jordan Bracken', companyName: 'Acme' });
  assert.equal(getBatchProgress('inflight').inFlight.length, 2);
  advanceBatch('inflight', { ok: true, profileName: 'Jordan Bracken', companyName: 'Acme' });
  assert.deepEqual(getBatchProgress('inflight').inFlight, ['Jordan Bracken - Acme']);

  // And a finished run is not still claiming to be working on something.
  finishBatch('inflight');
  assert.deepEqual(getBatchProgress('inflight').inFlight, []);
  resetBatchProgressForTests();
});
