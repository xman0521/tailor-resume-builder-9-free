const assert = require('node:assert/strict');
const test = require('node:test');

const {
  countFigures,
  parseJobAnalysisContent,
  tailorResume,
} = require('../dist/services/resumeService');

/**
 * The floors, enforced by one extra call when a draft comes back short.
 *
 * It began as a prompt rule with a log line beside it - the prompt asked for
 * five figures, the report counted them, and a resume that came back with one
 * went out with one - and it covered figures only. Then a scan of a finished
 * resume reported twenty-two hard skills missing, all of them capabilities
 * rather than products: "Artificial intelligence", "Full-stack development",
 * "Web applications". Every one had been given to the model. Nothing was wrong
 * upstream; nothing asked twice.
 *
 * So the revision covers what the draft is MISSING as well as what it cannot
 * count. The extra call is the cost, so these also pin when it does not happen.
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

const analysis = () => parseJobAnalysisContent(JSON.stringify({
  jobMeta: { title: 'Senior AI Engineer', seniority: 'Senior', industry: 'SaaS', department: 'Engineering' },
  skills: {
    technical: ['Full-stack development', 'Web applications'], required: ['Go'], preferred: [],
    tools: ['Go'], soft: [], technologies: [],
  },
  technologies: [], protocols: [], methodologies: [], architecturePatterns: [],
  responsibilities: [], domainKnowledge: [], softSkills: [],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: ['Artificial intelligence'] },
}), 'An AI role: full-stack development of web applications with artificial intelligence, in Go.');

const answer = (bullets, summary) => JSON.stringify({
  title: 'Model Title',
  summary,
  experience: [{
    title: 'Senior Software Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
    location: 'Remote', description: '', achievements: bullets,
  }],
  skillGroups: [{ category: 'Languages', skills: ['Go'] }],
  coverLetter: 'x',
});

/** Carries none of the checklist and one figure. */
const THIN = answer(
  ['Built settlement services in Go for the payments path.'],
  'Engineer of 9 years on payment platforms.'
);

/** Carries every checklist term and clears the figure floor. */
const FULL = answer(
  [
    'Built web applications in Go and cut p99 latency from 180ms to 118ms.',
    'Took full-stack development of the checkout path from 40 minutes of deploys to 6.',
    'Shipped artificial intelligence features across 4 services, reviewing 30 changes a month.',
  ],
  'Engineer of 9 years on payment platforms.'
);

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

test('a draft missing checklist terms is sent back, and the revision is used', async () => {
  const { calls, result } = await withStub([THIN, FULL]);

  assert.equal(calls.length, 2, 'the model should have been asked twice');
  const revision = calls[1].appendToUserBody;
  assert.match(revision, /REVISION - COVERAGE/);
  // It names what is missing, verbatim, so there is nothing to guess.
  for (const term of ['Full-stack development', 'Web applications', 'Artificial intelligence']) {
    assert.ok(revision.includes(term), `the revision did not name ${term}`);
  }
  // And it says what may still be left out, which is the one honest exception.
  assert.match(revision, /naming an INDUSTRY this candidate has not\s+worked in/);
  // The skills instruction rides along, because the revision returns everything.
  assert.match(revision, /FINAL SKILL OVERRIDE/);

  for (const term of ['web applications', 'full-stack development', 'artificial intelligence']) {
    assert.match(prose(result).toLowerCase(), new RegExp(term), `the revision was not used: ${term}`);
  }
});

test('a draft short on figures alone is still sent back', async () => {
  // Every term placed, one figure: the other half of the floor.
  const noFigures = answer(
    [
      'Built web applications in Go for the payments path.',
      'Took full-stack development of the checkout path from idea to release.',
      'Shipped artificial intelligence features across the settlement services.',
    ],
    'Engineer of 9 years on payment platforms.'
  );
  const { calls, result } = await withStub([noFigures, FULL]);

  assert.equal(calls.length, 2);
  assert.match(calls[1].appendToUserBody, /at least 5/);
  assert.ok(countFigures(result) >= 5, `figures: ${countFigures(result)}`);
});

test('a draft that clears both floors costs one call', async () => {
  const { calls, result } = await withStub([FULL]);
  assert.equal(calls.length, 1);
  assert.ok(countFigures(result) >= 5);
});

test('a revision that is no better leaves the draft alone', async () => {
  const { calls, result } = await withStub([THIN, THIN]);
  assert.equal(calls.length, 2);
  assert.equal(result.experience[0].achievements.length, 1);
  assert.match(result.experience[0].achievements[0], /settlement services in Go/);
});

test('a revision that trades one floor for the other is refused', async () => {
  // Places the missing terms and loses the figures: not an improvement, and the
  // draft it would replace is the one the scanner would have scored higher.
  const tradedAway = answer(
    [
      'Built web applications in Go, with full-stack development across the checkout path.',
      'Shipped artificial intelligence features for the settlement services.',
    ],
    'Engineer on payment platforms.'
  );
  const richDraft = answer(
    [
      'Built services in Go and cut p99 latency from 180ms to 118ms.',
      'Took deploys from 40 minutes to 6 across 4 services, reviewing 30 changes a month.',
    ],
    'Engineer of 9 years on payment platforms.'
  );

  const { calls, result } = await withStub([richDraft, tradedAway]);
  assert.equal(calls.length, 2);
  // The draft stands, figures intact.
  assert.ok(countFigures(result) >= 5, `figures: ${countFigures(result)}`);
  assert.doesNotMatch(prose(result).toLowerCase(), /artificial intelligence/);
});

test('a revision that fails leaves the draft alone', async () => {
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
    assert.match(result.experience[0].achievements[0], /settlement services in Go/);
  } finally {
    execution.createPromptCompletion = original;
  }
});

test('the revision can be switched off, by either name', async () => {
  for (const name of ['RESUME_REVISION_OFF', 'RESUME_METRIC_RETRY_OFF']) {
    const pinned = process.env[name];
    process.env[name] = '1';
    try {
      const { calls } = await withStub([THIN, FULL]);
      assert.equal(calls.length, 1, `no second call when ${name} is set`);
    } finally {
      if (pinned === undefined) delete process.env[name];
      else process.env[name] = pinned;
    }
  }
});
