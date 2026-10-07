const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { useTempStorage } = require('./helpers');

/**
 * "Turn off computer after complete", through the route that does it.
 *
 * THE PROPERTY WORTH A TEST OF ITS OWN: a run that did not ask for it does not
 * turn the machine off. Everything else here is recoverable; that is not. So the
 * batch is driven twice - once armed, once not - against a `run` that records the
 * command instead of issuing it, and the unarmed run has to leave no trace at
 * all: no report, no closed browsers, no shutdown.
 *
 * The rendering and the model call are stubbed. What is real is the route, the
 * flag's path through it, and the order the three steps happen in.
 */

const analysis = () => ({
  jobMeta: { title: 'Platform Engineer', seniority: 'senior', industry: 'SaaS', department: 'engineering' },
  skills: { technical: [], required: ['Kubernetes'], preferred: [], tools: [], soft: [], technologies: [] },
  technologies: [], protocols: [], methodologies: [], architecturePatterns: [],
  responsibilities: [], domainKnowledge: [], softSkills: [],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
});

async function withBatchServer(t, { failCompany, onShutdownCommand } = {}) {
  useTempStorage('shutdown-route');

  const execution = require('../dist/services/ai/promptExecution');
  const originalCompletion = execution.createPromptCompletion;
  execution.createPromptCompletion = async () => JSON.stringify({
    title: 'Senior Platform Engineer',
    summary: 'Engineer with 9 years of platform work.',
    experience: [], strengths: [], coverLetter: 'I build platforms.',
  });

  const generator = require('../dist/generators/pdfGenerator');
  const originalPdf = generator.generateResumePDF;
  generator.generateResumePDF = async (_profile, _template, _tailored, _pathInfo, companyName) => {
    // One company fails on purpose, so the report has something to say.
    if (failCompany && companyName === failCompany) throw new Error('browser did not answer in time');
    return 'stub.pdf';
  };

  const coverLetters = require('../dist/generators/coverLetterGenerator');
  const originalCover = coverLetters.saveCoverLetter;
  coverLetters.saveCoverLetter = async () => 'stub-cover.pdf';

  const templates = require('../dist/extractors/templateExtractor');
  const originalTemplate = templates.getTemplateById;
  templates.getTemplateById = async (id) => ({
    id, name: 'stub', description: 'stub', htmlContent: '<p>{{name}}</p>',
    cssContent: '', sections: [], createdAt: '', updatedAt: '',
  });

  const { saveProfile } = require('../dist/database/profileRepository');
  const { updateAppSettings } = require('../dist/config/aiModelConfig');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-shutdown-'));
  await updateAppSettings({ outputBaseDir: outDir });

  const profile = saveProfile({
    id: 'shutdown-profile', createdAt: '', updatedAt: '',
    name: 'Jordan Bracken', title: 'Software Engineer',
    contact: { phone: '555-555-5555', email: 'j@example.com', location: 'Austin, TX' },
    summary: 'Engineer.',
    experience: [{
      title: 'Software Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
      location: 'Remote', description: 'Built things.', achievements: ['Did work.'], skills: [],
    }],
    skills: [], education: [], certifications: [], strengths: [],
  });

  // The recorder. Nothing in this file is allowed near a real `shutdown`.
  const shutdown = require('../dist/services/shutdownAfterRun');
  const commands = [];
  const closed = [];
  const originalRun = shutdown.shutdownAfterRun;
  shutdown.shutdownAfterRun = (outcome) =>
    originalRun(outcome, {
      run: async (file, args) => {
        // Called while `shutdownAfterRun` is mid-flight, which is the only moment
        // the step order can be observed from outside.
        await onShutdownCommand?.(file, args);
        commands.push([file, ...args].join(' '));
      },
      closeBrowsers: async () => { closed.push('closed'); return [{ closed: true }]; },
      platform: 'win32',
      log: () => {},
    });

  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  delete require.cache[require.resolve('../dist/routes/resume')];
  app.use('/api/resume', require('../dist/routes/resume').default);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  t.after(async () => {
    execution.createPromptCompletion = originalCompletion;
    generator.generateResumePDF = originalPdf;
    coverLetters.saveCoverLetter = originalCover;
    templates.getTemplateById = originalTemplate;
    shutdown.shutdownAfterRun = originalRun;
    shutdown.resetPendingShutdownForTests();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  const port = server.address().port;
  const run = (body) =>
    fetch(`http://127.0.0.1:${port}/api/resume/generate-multi-job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: 'pdf',
        profileIds: [profile.id],
        jobs: [
          { companyName: 'Acme', role: 'Platform Engineer', jobDescription: 'x'.repeat(80), jobAnalysis: analysis(), sourceRowNumber: 12 },
          { companyName: 'Globex', role: 'Platform Engineer', jobDescription: 'x'.repeat(80), jobAnalysis: analysis(), sourceRowNumber: 18 },
        ],
        ...body,
      }),
    }).then((response) => response.json());

  return { run, commands, closed, outDir, port };
}

const reportsIn = (dir) => fs.readdirSync(dir).filter((name) => /^failed_profiles_.*\.txt$/.test(name));

test('a run that did not ask for it changes nothing', async (t) => {
  const { run, commands, closed, outDir } = await withBatchServer(t);

  const body = await run({});
  assert.equal(body.generated, 2, JSON.stringify(body).slice(0, 300));
  assert.equal(body.shutdown, undefined, 'an unarmed run must not report a shutdown');
  assert.deepEqual(commands, [], 'no shutdown was issued');
  assert.deepEqual(closed, [], 'the browsers were left alone');
  assert.deepEqual(reportsIn(outDir), [], 'no report file either');

  // Nor does anything else that merely looks like consent.
  for (const value of [false, 'true', 1, null]) {
    const again = await run({ shutdownAfterComplete: value });
    assert.equal(again.shutdown, undefined, `shutdownAfterComplete: ${JSON.stringify(value)} must not arm it`);
  }
  assert.deepEqual(commands, []);
});

test('an armed run writes the report, closes the browsers and schedules the shutdown', async (t) => {
  const { run, commands, closed, outDir } = await withBatchServer(t, { failCompany: 'Acme' });

  const body = await run({
    shutdownAfterComplete: true,
    priorFailures: [{ companyName: 'Hooli', sourceRowNumber: 90, error: 'the posting could not be downloaded' }],
  });

  assert.equal(body.failed, 1, JSON.stringify(body).slice(0, 300));
  assert.equal(body.shutdown.scheduled, true);
  assert.equal(body.shutdown.browsersClosed, 1);
  assert.deepEqual(closed, ['closed']);
  assert.match(commands[0], /^shutdown \/s \/t \d+ \/c /);

  // The response carries the deadline, because the banner counts down to the
  // same moment Windows is counting down to.
  assert.ok(body.shutdown.shutdownAt > Date.now(), 'the page needs a deadline in the future');

  const files = reportsIn(outDir);
  assert.equal(files.length, 1, `expected one report, got ${files.join(', ')}`);
  const text = fs.readFileSync(path.join(outDir, files[0]), 'utf8');
  // The failed profile and its row, which is what was asked for.
  assert.match(text, /Jordan Bracken\s+1 job\(s\): row 12/);
  // And the job that never got as far as a build, which this request only knows
  // about because the page passed it along.
  assert.match(text, /row 90\s+Hooli/);
  assert.equal(body.shutdown.reportPath, path.join(outDir, files[0]));
});

test('the report is on disk before the shutdown is issued', async (t) => {
  /*
   * The ordering that makes the feature worth having. If the shutdown were
   * issued first, a slow write would be racing a powering-down machine for the
   * only record of the night.
   *
   * Observed from INSIDE the shutdown command, which is the one moment the order
   * is visible from outside: by the time `shutdown` is called, the file is either
   * there or it is not.
   */
  let seen = null;
  let dir;
  const { run, outDir } = await withBatchServer(t, {
    failCompany: 'Globex',
    onShutdownCommand: () => { if (seen === null) seen = reportsIn(dir).length; },
  });
  dir = outDir;

  const body = await run({ shutdownAfterComplete: true });

  assert.equal(body.shutdown.scheduled, true);
  assert.equal(seen, 1, 'the shutdown was issued before the report was written');
});

test('the cancel route is reachable without an admin session', async (t) => {
  /*
   * The route that ARMS the shutdown is unauthenticated, so the route that stops
   * it must be too: a machine that can arm its own shutdown and then demand a
   * password to be stopped is worse than one that cannot do either.
   */
  const { port } = await withBatchServer(t);
  const response = await fetch(`http://127.0.0.1:${port}/api/resume/shutdown/abort`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(typeof (await response.json()).aborted, 'boolean');
});
