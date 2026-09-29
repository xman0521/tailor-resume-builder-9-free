const assert = require('node:assert/strict');
const test = require('node:test');

const {
  countFigures,
  parseJobAnalysisContent,
  tailorResume,
} = require('../dist/services/resumeService');

/**
 * The second call: when it is worth making, what it is sent, and what it costs.
 *
 * It began as a figures-only retry, then covered missing checklist terms too -
 * and that version asked again whenever ANYTHING was missing. With the keyword
 * floor at 100% of a 25-45 term checklist that is nearly every resume, and a
 * batch of 500 went from 0.84 hours of working time to 2.21. It also re-sent
 * the whole 36,853-character tailoring prompt and asked for the whole resume
 * back, because every call here opens a fresh conversation.
 *
 * So there are three things to hold: the gate that decides a call is worth it,
 * the small shape that call now takes, and the merge that keeps everything the
 * revision was not asked about - the skills block, the cover letter, the
 * employers and the dates - out of the model's hands entirely.
 */

const profile = () => ({
  id: 'p', name: 'Coverage Probe', title: 'Software Engineer',
  profileSettings: {},
  contact: { phone: '1', email: 'a@b.c', location: 'Austin, TX' },
  summary: 'Engineer.',
  experience: [{
    title: 'Senior Software Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
    location: 'Remote', description: '', achievements: ['Did work.'], skills: [],
  }],
  strengths: [], skills: [], education: [], certifications: [], createdAt: '', updatedAt: '',
});

/** Five focus skills, three concepts, and a handful of ordinary keywords. */
const analysis = () => parseJobAnalysisContent(JSON.stringify({
  jobMeta: { title: 'Senior AI Engineer', seniority: 'Senior', industry: 'SaaS', department: 'Engineering' },
  skills: {
    technical: ['Full-stack development', 'Web applications'],
    required: ['Go', 'Kubernetes', 'Terraform', 'Postgres', 'Kafka'],
    preferred: ['Datadog'],
    tools: ['Go', 'Kubernetes', 'Terraform', 'Postgres', 'Kafka', 'Datadog'],
    soft: ['Communication skills'], technologies: [],
  },
  technologies: [], protocols: [], methodologies: [], architecturePatterns: [],
  responsibilities: [], domainKnowledge: [], softSkills: ['Ownership'],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: ['Artificial intelligence'] },
}), 'An AI role: full-stack development of web applications with artificial intelligence, in Go on Kubernetes.');

const draft = (bullets, summary) => JSON.stringify({
  title: 'Model Title',
  summary,
  experience: [{
    title: 'Senior Software Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
    location: 'Remote', description: '', achievements: bullets,
  }],
  skillGroups: [{ category: 'Languages', skills: ['Go'] }],
  coverLetter: 'I build platforms, and I would like to build yours.',
});

/** Carries almost nothing: five focus skills and three concepts all missing. */
const THIN = draft(
  ['Built settlement services for the payments path.'],
  'Engineer of 9 years on payment platforms.'
);

/** Carries everything the checklist wants, and clears the figure floor. */
const FULL = draft(
  [
    'Built web applications in Go on Kubernetes and cut p99 latency from 180ms to 118ms.',
    'Took full-stack development of the checkout path from 40 minutes of Terraform deploys to 6.',
    'Shipped artificial intelligence features over Postgres and Kafka across 4 services, watching Datadog.',
    'Reviewed 30 changes a month, where communication skills and ownership kept releases predictable.',
  ],
  'Engineer of 9 years on payment platforms.'
);

/** What the revision returns now: only what it changed. */
const PATCH = JSON.stringify({
  summary: 'Engineer of 9 years on payment platforms, across full-stack development and artificial intelligence.',
  experience: [{
    company: 'Acme',
    title: 'Senior Software Engineer',
    achievements: [
      'Built web applications in Go on Kubernetes and cut p99 latency from 180ms to 118ms.',
      'Shipped artificial intelligence features over Postgres and Kafka across 4 services, watching Datadog.',
      'Wrote the Terraform modules for 6 environments, where communication skills and ownership kept releases predictable.',
    ],
  }],
});

const withStub = async (answers) => {
  const execution = require('../dist/services/ai/promptExecution');
  const original = execution.createPromptCompletion;
  const calls = [];
  execution.createPromptCompletion = async (request) => {
    calls.push(request);
    return answers[Math.min(calls.length - 1, answers.length - 1)];
  };
  try {
    const result = await tailorResume(profile(), analysis(), { provider: 'claude-web', modelName: 'chat' });
    return { calls, result };
  } finally {
    execution.createPromptCompletion = original;
  }
};

const prose = (content) => [content.summary, ...content.experience.flatMap((role) => role.achievements)].join(' ');

test('a draft missing the posting\'s leading terms is sent back', async () => {
  const { calls, result } = await withStub([THIN, PATCH]);

  assert.equal(calls.length, 2, 'the model should have been asked twice');

  // The second call is a SMALL one: its own prompt, not the tailoring prompt.
  const revision = calls[1];
  assert.equal(revision.promptId, 'revise-resume-coverage');
  assert.ok(revision.maxTokens <= 3000, `the revision asked for ${revision.maxTokens} tokens`);
  // It is sent the draft's own sentences and the terms that are missing.
  assert.match(revision.promptValues.draftJson, /settlement services/);
  assert.match(revision.promptValues.missingTermsJson, /Artificial intelligence/);
  assert.match(revision.promptValues.missingTermsJson, /Kubernetes/);

  // And the patch reached the page.
  assert.match(prose(result).toLowerCase(), /artificial intelligence/);
  assert.match(prose(result).toLowerCase(), /kubernetes/);
});

test('the revision cannot lose the cover letter, the skills or the dates', async () => {
  /*
   * The hole this closes: the old shape asked for the whole object back, and a
   * model told "do not touch the cover letter" would return one without it. An
   * absent letter sends the route off to write a new one - a THIRD model call.
   * The revision never carries those fields now, so nothing can drop them.
   */
  const { result } = await withStub([THIN, PATCH]);

  assert.equal(result.coverLetter, 'I build platforms, and I would like to build yours.');
  assert.deepEqual(result.skillGroups, [{ category: 'Languages', skills: ['Go'] }]);
  assert.equal(result.experience[0].company, 'Acme');
  assert.equal(result.experience[0].startDate, '01/2019');
  assert.equal(result.experience[0].endDate, 'Present');
});

test('one stray ordinary term is not worth a call', async () => {
  // Everything placed except a single ordinary keyword, and the figures fine.
  const nearlyComplete = draft(
    [
      'Built web applications in Go on Kubernetes and cut p99 latency from 180ms to 118ms.',
      'Took full-stack development of the checkout path from 40 minutes of Terraform deploys to 6.',
      'Shipped artificial intelligence features over Postgres and Kafka across 4 services.',
      'Reviewed 30 changes a month, where communication skills and ownership kept releases predictable.',
    ],
    'Engineer of 9 years on payment platforms.'
  );

  const { calls } = await withStub([nearlyComplete]);
  assert.equal(calls.length, 1, 'a single missing ordinary term should not buy a second call');
});

test('a draft that clears both floors costs one call', async () => {
  const { calls, result } = await withStub([FULL]);
  assert.equal(calls.length, 1);
  assert.ok(countFigures(result) >= 5);
});

test('a draft short on figures alone is still sent back', async () => {
  const noFigures = draft(
    [
      'Built web applications in Go on Kubernetes for the payments path.',
      'Took full-stack development of the checkout path through Terraform, Postgres and Kafka.',
      'Shipped artificial intelligence features, watching Datadog, where communication skills and ownership held.',
    ],
    'Engineer of 9 years on payment platforms.'
  );
  const { calls } = await withStub([noFigures, PATCH]);

  assert.equal(calls.length, 2);
  assert.match(calls[1].promptValues.figuresNote, /at least 5/);
});

test('a revision that is no better leaves the draft alone', async () => {
  // A patch that changes nothing the measurement cares about.
  const uselessPatch = JSON.stringify({
    experience: [{
      company: 'Acme', title: 'Senior Software Engineer',
      achievements: ['Built settlement services for the payments path, again.'],
    }],
  });

  const { calls, result } = await withStub([THIN, uselessPatch]);
  assert.equal(calls.length, 2);
  assert.match(result.experience[0].achievements[0], /settlement services for the payments path\./);
});

test('a revision that fails, or answers with nothing, leaves the draft alone', async () => {
  const empty = await withStub([THIN, JSON.stringify({})]);
  assert.equal(empty.calls.length, 2);
  assert.match(empty.result.experience[0].achievements[0], /settlement services/);

  const execution = require('../dist/services/ai/promptExecution');
  const original = execution.createPromptCompletion;
  const calls = [];
  execution.createPromptCompletion = async () => {
    calls.push(1);
    if (calls.length === 1) return THIN;
    throw new Error('provider went away');
  };
  try {
    const result = await tailorResume(profile(), analysis(), { provider: 'claude-web', modelName: 'chat' });
    assert.equal(calls.length, 2);
    assert.match(result.experience[0].achievements[0], /settlement services/);
  } finally {
    execution.createPromptCompletion = original;
  }
});

test('the revision prompt exists, resolves and renders', async () => {
  /*
   * The gap every other test here leaves open: they stub the model call, so the
   * prompt is never looked up. The first version of this feature was written
   * with a prompt file that the resolver could not see - a prompt has to be
   * registered as a FEATURE, not just dropped in the folder - and the whole
   * suite passed while every real revision would have thrown "not found".
   */
  const { resolvePromptByExactId, renderPromptByExactId } = require('../dist/services/promptService');

  const prompt = await resolvePromptByExactId('revise-resume-coverage');
  assert.ok(prompt, 'the revision prompt does not resolve');
  assert.deepEqual(prompt.validation.unknownVariables, []);

  const rendered = await renderPromptByExactId('revise-resume-coverage', {
    draftJson: '{"summary":"Engineer of 9 years."}',
    missingTermsJson: '["Kubernetes","Artificial intelligence"]',
    figuresNote: 'The draft carries enough figures. Do not add more.',
  });
  assert.equal((rendered.match(/\[\[\w+\]\]/g) ?? []).length, 0, 'a placeholder was left unfilled');
  assert.match(rendered, /Kubernetes/);

  // And it is the SMALL prompt: re-sending the tailoring rules is what made the
  // second call cost as much as the first.
  const tailor = await resolvePromptByExactId('tailor-resume');
  assert.ok(
    prompt.content.length < tailor.content.length / 4,
    `the revision prompt is ${prompt.content.length} chars against the tailor prompt's ${tailor.content.length}`
  );
});

test('the revision can be switched off, by either name', async () => {
  for (const name of ['RESUME_REVISION_OFF', 'RESUME_METRIC_RETRY_OFF']) {
    const pinned = process.env[name];
    process.env[name] = '1';
    try {
      const { calls } = await withStub([THIN, PATCH]);
      assert.equal(calls.length, 1, `no second call when ${name} is set`);
    } finally {
      if (pinned === undefined) delete process.env[name];
      else process.env[name] = pinned;
    }
  }
});
