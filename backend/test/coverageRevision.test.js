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

test('a revision that answers with nothing leaves the draft alone', async () => {
  // The model ANSWERED. An answer that changes nothing is a judgement about
  // the draft, not a failure, and the draft standing is the right outcome.
  const empty = await withStub([THIN, JSON.stringify({})]);
  assert.equal(empty.calls.length, 2);
  assert.match(empty.result.experience[0].achievements[0], /settlement services/);
});

test('a revision call that FAILS fails the build, so the unit is retried', async () => {
  /*
   * REPORTED: "even when the account browsers didn't respond after receiving
   * prompt, our program finished generating resumes saying 5 out of 5
   * generated successfully." They had - the draft was complete and a PDF was
   * written - and the browser that took the prompt and never answered left
   * nothing behind but a console warning.
   *
   * A failed call is a failed build now, which is what puts it through the
   * batch retry: that re-enters the tab pool and takes whichever browser is
   * free, which is the only reason a second attempt has a chance.
   */
  const execution = require('../dist/services/ai/promptExecution');
  const original = execution.createPromptCompletion;
  const calls = [];
  execution.createPromptCompletion = async () => {
    calls.push(1);
    if (calls.length === 1) return THIN;
    throw new Error('claude.ai did not return at all within 545s');
  };
  try {
    await assert.rejects(
      () => tailorResume(profile(), analysis(), { provider: 'claude-web', modelName: 'chat' }),
      /did not return at all/,
      'the revision failure must reach the caller'
    );
    assert.equal(calls.length, 2, 'the draft was written before the revision was asked for');
  } finally {
    execution.createPromptCompletion = original;
  }
});

test('the failure keeps the provider\'s own retry classification', async () => {
  /*
   * `isRetryableFailure` reads `retryable` off an AIProviderError, and that
   * flag comes from the KIND. Wrapping the failure in a plain Error would make
   * every one of them retryable - including `auth` and `locked`, which say
   * something about the installation that three more attempts cannot change.
   */
  const { AIProviderError } = require('../dist/services/ai/errors');
  const { isRetryableFailure } = require('../dist/services/ai/retry');
  const execution = require('../dist/services/ai/promptExecution');
  const original = execution.createPromptCompletion;

  for (const [kind, retryable] of [['timeout', true], ['auth', false]]) {
    const calls = [];
    execution.createPromptCompletion = async () => {
      calls.push(1);
      if (calls.length === 1) return THIN;
      throw new AIProviderError({ provider: 'claude-web', kind, detail: 'the tab never answered' });
    };
    try {
      await tailorResume(profile(), analysis(), { provider: 'claude-web', modelName: 'chat' });
      assert.fail(`a ${kind} failure should have reached the caller`);
    } catch (error) {
      assert.equal(isRetryableFailure(error), retryable, `${kind} should be retryable=${retryable}`);
      // And it says which call failed, so a batch summary can be read.
      assert.match(error.message, /coverage revision/);
      assert.match(error.message, /the tab never answered/);
    } finally {
      execution.createPromptCompletion = original;
    }
  }
});

test('the old behaviour is one environment variable away', async () => {
  // This change can turn a batch that was shipping into a batch that fails, so
  // there has to be a way back that is not a code edit.
  const execution = require('../dist/services/ai/promptExecution');
  const original = execution.createPromptCompletion;
  const calls = [];
  execution.createPromptCompletion = async () => {
    calls.push(1);
    if (calls.length === 1) return THIN;
    throw new Error('provider went away');
  };
  process.env.RESUME_REVISION_SOFT_FAIL = '1';
  try {
    const result = await tailorResume(profile(), analysis(), { provider: 'claude-web', modelName: 'chat' });
    assert.equal(calls.length, 2);
    assert.match(result.experience[0].achievements[0], /settlement services/);
  } finally {
    delete process.env.RESUME_REVISION_SOFT_FAIL;
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

  /*
   * Every value the prompt names, supplied from the SAME function the run uses,
   * so a variable added to one and not the other fails here rather than at the
   * first revision of a live batch - which is how `softSkillsNote` was caught.
   */
  const { buildRevisionPromptValuesForTests } = require('../dist/services/resumeService');
  const values = buildRevisionPromptValuesForTests(
    { summary: 'Engineer of 9 years.', experience: [] },
    {
      missingTerms: ['Kubernetes', 'Artificial intelligence'],
      missingImportant: [],
      missingSoft: ['Mentoring', 'Ownership'],
      figures: 6,
      short: true,
      reason: 'test',
    }
  );
  const rendered = await renderPromptByExactId('revise-resume-coverage', values);
  assert.equal((rendered.match(/\[\[\w+\]\]/g) ?? []).length, 0, 'a placeholder was left unfilled');
  assert.match(rendered, /Kubernetes/);

  // The soft skills are named in the call, not merely pooled into the term
  // list: with no group in the skills block, a bullet is the only place they
  // can appear, and the instruction most likely to be obeyed is the one that
  // says which words and which sentences.
  assert.match(rendered, /THE SOFT SKILLS ARE THE WEAKEST BAND ON THIS RESUME/);
  assert.match(rendered, /Mentoring, Ownership/);
  assert.match(rendered, /a bullet is the only place a scanner can find them/);

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

test('a draft missing only its soft skills is sent back', async () => {
  /*
   * THE GAP THIS CLOSES. Soft skills used to be pooled with every other
   * checklist term, so a draft missing two of them and nothing else fell under
   * the floor of three and was shipped as it stood. That was tolerable while
   * the skills block ended with a group of them - a scanner found them there
   * whatever the sentences did - and stopped being tolerable when the group was
   * removed: measured over the batch that prompted this, soft-skill presence
   * fell from 8.8 terms per resume to 6.8, and the bullets picked up less than
   * a third of what the block had been carrying.
   *
   * Everything else here is placed and the figure floor is clear, so the soft
   * skills are the only thing buying the call.
   */
  const softSkillsMissing = draft(
    [
      'Built web applications in Go on Kubernetes and cut p99 latency from 180ms to 118ms.',
      'Took full-stack development of the checkout path from 40 minutes of Terraform deploys to 6 minutes.',
      'Shipped artificial intelligence features over Postgres and Kafka across 4 services, watching Datadog.',
      'Reviewed 30 changes a month and kept 12 releases a quarter predictable.',
    ],
    'Engineer of 9 years on payment platforms.'
  );

  const { calls } = await withStub([softSkillsMissing, PATCH]);
  assert.equal(calls.length, 2, 'two missing soft skills must buy the call on their own');

  // And the call is TOLD about them, by name and by destination. Pooling them
  // into the term list was what the draft already had and did not act on.
  const note = calls[1].promptValues.softSkillsNote;
  assert.match(note, /THE SOFT SKILLS ARE THE WEAKEST BAND/);
  assert.match(note, /Communication skills/);
  assert.match(note, /Ownership/);
  assert.match(note, /a bullet is the only place a scanner can find them/);
  // Not by asserting them: a term with nothing to attach to is left out.
  assert.match(note, /leave it out rather than asserting it/);
});

test('one missing soft skill is not worth a call', async () => {
  /*
   * The floor is two, not one, and the reason is the bill: an earlier version
   * of this gate revised whenever anything was missing and took a batch of 500
   * from 0.84 hours to 2.21. One term is worth a fraction of a point.
   */
  const oneMissing = draft(
    [
      'Built web applications in Go on Kubernetes and cut p99 latency from 180ms to 118ms.',
      'Took full-stack development of the checkout path from 40 minutes of Terraform deploys to 6 minutes.',
      'Shipped artificial intelligence features over Postgres and Kafka across 4 services, watching Datadog.',
      'Reviewed 30 changes a month, where communication skills kept 12 releases a quarter predictable.',
    ],
    'Engineer of 9 years on payment platforms.'
  );

  const { calls } = await withStub([oneMissing]);
  assert.equal(calls.length, 1, 'a single missing soft skill should not buy a second call');
});

test('a draft carrying its soft skills is told not to add more', async () => {
  // The other half of the note: a revision bought for some other reason must
  // not take "soft skills" as an invitation to sprinkle them.
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
  assert.match(calls[1].promptValues.softSkillsNote, /Do not add more/);
});

test('a revised resume does not report its block as unlabelled', async () => {
  /*
   * The warning "entries arrived with no kind" means the tailoring prompt did
   * not reach the model, which is worth seeing. The revision pass re-parses a
   * block this app has ALREADY routed - plain names by then, their kinds spent
   * on the first pass - so without a flag every revised resume would raise it,
   * and a signal that cries wolf on half a batch is no signal.
   */
  const lines = [];
  const realWarn = console.warn;
  console.warn = (line) => lines.push(String(line));
  try {
    const noFigures = draft(
      [
        'Built web applications in Go on Kubernetes for the payments path.',
        'Took full-stack development of the checkout path through Terraform, Postgres and Kafka.',
        'Shipped artificial intelligence features, watching Datadog, where communication skills and ownership held.',
      ],
      'Engineer of 9 years on payment platforms.'
    );
    const { calls } = await withStub([noFigures, PATCH]);
    assert.equal(calls.length, 2, 'this draft should have bought a revision');
  } finally {
    console.warn = realWarn;
  }

  /*
   * ONE, NOT TWO. The fixture's block is bare strings, so the FIRST pass warns
   * and is right to - that is the signal working. The revision re-parses the
   * same block and must stay quiet, so a second identical line is the false
   * alarm this test exists for.
   */
  const unlabelled = lines.filter((line) => /arrived with no kind/.test(line));
  assert.equal(
    unlabelled.length,
    1,
    `expected only the first pass to warn, got ${unlabelled.length}: ${unlabelled.join(' | ')}`
  );
});

test('a term sitting in the skills block is not asked for again', async () => {
  /*
   * MEASURED, and the reason this changed: the checklist the coverage pass
   * measures is `getKeywordChecklist`, which reads the posting's TOOLS,
   * TECHNOLOGIES and PROTOCOLS along with its ideas - so most of what is on it
   * belongs in the skills block and is put there, correctly, by the model. The
   * measurement asked the PROSE only, so a draft that had done everything right
   * came back "missing" its whole stack.
   *
   * On a posting naming Azure, GCP, Bash, LLMs and MCP: 30 of 30 terms counted
   * missing, SIXTEEN of them printed in the block of the same resume. That list
   * is what the revision call receives, and it is told a bullet may carry two
   * or three of these - so the terms with nowhere else to go, the soft skills
   * and the concepts, were competing against sixteen already on the page.
   */
  const blockCarriesTheStack = JSON.stringify({
    title: 'Model Title',
    summary: 'Engineer of 9 years on payment platforms.',
    experience: [{
      title: 'Senior Software Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
      location: 'Remote', description: '',
      achievements: ['Built settlement services for the payments path.'],
    }],
    skillGroups: [
      { category: 'Languages & Frameworks', skills: ['Go'] },
      { category: 'Cloud', skills: ['Kubernetes', 'Terraform'] },
      { category: 'Data', skills: ['Postgres', 'Kafka'] },
      { category: 'Monitoring', skills: ['Datadog'] },
    ],
    coverLetter: 'I build platforms, and I would like to build yours.',
  });

  const { calls } = await withStub([blockCarriesTheStack, PATCH]);
  assert.equal(calls.length, 2, 'the draft is still thin enough to buy a call');
  const asked = JSON.parse(calls[1].promptValues.missingTermsJson);

  // Printed in the block, so not missing from the page, so not asked for.
  for (const term of ['Kubernetes', 'Terraform', 'Postgres', 'Kafka', 'Datadog', 'Go']) {
    assert.equal(
      asked.some((t) => t.toLowerCase() === term.toLowerCase()),
      false,
      `${term} is in the skills block and should not be asked for again: ${calls[1].promptValues.missingTermsJson}`
    );
  }

  // On no part of the page, so still asked for - which is the whole point of
  // clearing the others out of the way.
  assert.ok(
    asked.some((t) => /artificial intelligence/i.test(t)),
    `"artificial intelligence" is on no part of the page: ${calls[1].promptValues.missingTermsJson}`
  );
  assert.ok(
    asked.some((t) => /communication skills|ownership/i.test(t)),
    'the soft skills have nowhere but a bullet to go'
  );
});

test('a block term still counts as missing when the block does not carry it', async () => {
  // The other direction, so the change cannot be read as "stop asking".
  const { calls } = await withStub([THIN, PATCH]);
  const asked = JSON.parse(calls[1].promptValues.missingTermsJson);
  assert.ok(asked.some((t) => t.toLowerCase() === 'kubernetes'),
    `the THIN draft's block holds only Go: ${calls[1].promptValues.missingTermsJson}`);
});
