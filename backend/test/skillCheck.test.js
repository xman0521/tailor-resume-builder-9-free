const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseJobAnalysisContent,
  tailorResume,
  buildSkillCheckPromptValuesForTests,
  applySkillCheckForTests,
} = require('../dist/services/resumeService');

/**
 * The skills check: a small second call that replaces every entry in the
 * technical block that is not a real tool with the tools that work is done
 * with, and hands the removed concepts to the revision so they reach a bullet.
 */

const profile = () => ({
  id: 'p', name: 'Skills Probe', title: 'Software Engineer',
  profileSettings: {},
  contact: { phone: '1', email: 'a@b.c', location: 'Austin, TX' },
  summary: 'Engineer.',
  experience: [{
    title: 'Machine Learning Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
    location: 'Remote', description: '', achievements: ['Did work.'], skills: [],
  }],
  strengths: [], skills: [], education: [], certifications: [], createdAt: '', updatedAt: '',
});

const analysis = () => parseJobAnalysisContent(JSON.stringify({
  jobMeta: { title: 'Machine Learning Engineer', seniority: 'Senior', industry: 'SaaS', department: 'Engineering' },
  skills: { technical: [], required: ['Python'], preferred: [], tools: ['Python', 'Datadog'], soft: [], technologies: [] },
  technologies: [], protocols: [], methodologies: [], architecturePatterns: [],
  responsibilities: [], domainKnowledge: [], softSkills: [],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
}), 'An ML role in Python, watched in Datadog.');

const BULLETS = [
  'Built the scoring service in Python and cut p99 latency from 180ms to 118ms.',
  'Moved 12 services onto Datadog dashboards, taking alert triage from 40 minutes to 9 minutes.',
  'Rewrote the nightly training job across 3 regions, cutting failed runs from 6 a week to 1.',
  'Reviewed 30 model changes a month across 4 teams, catching 5 regressions before release.',
  'Cut inference cost from $9,000 a month to $6,500 by batching requests on 2 GPU pools.',
];

const DRAFT = JSON.stringify({
  title: 'Machine Learning Engineer',
  summary: 'Machine learning work across 7 years has centred on production scoring services.',
  experience: [{
    title: 'Machine Learning Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
    location: 'Remote', description: '', achievements: BULLETS,
  }],
  skillGroups: [
    { category: 'Languages & Frameworks', skills: [{ name: 'Python', kind: 'language' }, { name: 'FastAPI', kind: 'framework' }] },
    {
      category: 'Monitoring',
      skills: [
        { name: 'Datadog', kind: 'tool' },
        { name: 'regression detection', kind: 'tool' },
        { name: 'model performance measurement', kind: 'technology' },
      ],
    },
    { category: 'Soft Skills', skills: [{ name: 'Mentoring', kind: 'soft' }] },
  ],
  coverLetter: 'I build models people rely on.',
});

const CHECKED = JSON.stringify({
  concepts: [
    { entry: 'regression detection', tools: ['pytest'], bullet: true },
    { entry: 'model performance measurement', tools: ['MLflow'], bullet: true },
  ],
  rename: [],
  remove: [],
  additions: [
    { name: 'NumPy', group: 'Languages & Frameworks' },
    { name: 'pandas', group: 'Languages & Frameworks' },
    { name: 'PyTorch', group: 'Languages & Frameworks' },
    { name: 'Prometheus', group: 'Monitoring' },
    { name: 'Grafana', group: 'Monitoring' },
  ],
});

const PATCH = JSON.stringify({
  experience: [{
    company: 'Acme',
    title: 'Machine Learning Engineer',
    achievements: [
      ...BULLETS.slice(0, 3),
      'Reviewed 30 model changes a month across 4 teams, adding regression detection that caught 5 failures before release.',
      'Tracked model performance measurement in MLflow while batching requests on 2 GPU pools, cutting inference cost from $9,000 a month to $6,500.',
    ],
  }],
});

const withStub = async (answers) => {
  const execution = require('../dist/services/ai/promptExecution');
  const original = execution.createPromptCompletion;
  const calls = [];
  execution.createPromptCompletion = async (request) => {
    calls.push(request);
    const answer = answers[request.promptId];
    if (answer === undefined) throw new Error(`unexpected call: ${request.promptId}`);
    return answer;
  };
  try {
    const result = await tailorResume(profile(), analysis(), { provider: 'claude-web', modelName: 'chat' });
    return { calls, result };
  } finally {
    execution.createPromptCompletion = original;
  }
};

const prose = (content) => [content.summary, ...content.experience.flatMap((role) => role.achievements)].join(' ');

test('the skills check prompt exists, resolves and renders', async () => {
  const { resolvePromptByExactId, renderPromptByExactId } = require('../dist/services/promptService');
  const prompt = await resolvePromptByExactId('check-skills');
  assert.ok(prompt, 'the skills check prompt does not resolve');
  assert.deepEqual(prompt.validation.unknownVariables, []);

  const values = buildSkillCheckPromptValuesForTests(
    [{ category: 'Monitoring', skills: ['Datadog', 'regression detection'] }],
    JSON.parse(DRAFT),
    analysis()
  );
  const rendered = await renderPromptByExactId('check-skills', values);
  assert.equal((rendered.match(/\[\[\w+\]\]/g) ?? []).length, 0, 'a placeholder was left unfilled');
  assert.match(rendered, /regression detection/);
  assert.match(rendered, /Machine Learning Engineer/);
});

test('concepts in the block become tools, and the concepts go to the bullets', async () => {
  const { calls, result } = await withStub({
    'tailor-resume': DRAFT,
    'check-skills': CHECKED,
    'revise-resume-coverage': PATCH,
  });

  assert.deepEqual(calls.map((call) => call.promptId), ['tailor-resume', 'check-skills', 'revise-resume-coverage']);

  // The check is sent the technical block only.
  const check = calls[1];
  assert.match(check.promptValues.skillGroupsJson, /regression detection/);
  assert.doesNotMatch(check.promptValues.skillGroupsJson, /Mentoring/);

  // The moved concepts are what the revision is asked to place.
  assert.match(calls[2].promptValues.missingTermsJson, /regression detection/);
  assert.match(calls[2].promptValues.missingTermsJson, /model performance measurement/);

  const printed = result.skillGroups.flatMap((group) => group.skills);
  assert.ok(printed.includes('MLflow') && printed.includes('Pytest'), printed.join(', '));
  assert.equal(printed.includes('regression detection'), false);
  assert.equal(printed.includes('model performance measurement'), false);
  assert.deepEqual(result.skillGroups[result.skillGroups.length - 1], { category: 'Soft Skills', skills: ['Mentoring'] });
  assert.equal(result.hardSkills.includes('Mentoring'), false);

  assert.match(prose(result), /regression detection/);
  assert.match(prose(result), /model performance measurement/);
});

test('an answer applied to the block: in place, renamed, removed, added, and the posting\'s tools kept', () => {
  const technical = [
    { category: 'Languages & Frameworks', skills: ['Python', 'C Sharp', 'FastAPI'] },
    { category: 'Cloud & Infrastructure', skills: ['AWS', 'Amazon Web Services', 'MLOps', 'Rhino'] },
    { category: 'Monitoring', skills: ['Datadog', 'regression detection', 'run'] },
  ];
  const answer = {
    concepts: [
      { entry: 'MLOps', tools: ['MLflow', 'Kubeflow'], bullet: true },
      { entry: 'regression detection', tools: ['pytest'] },
      { entry: 'run', tools: [], bullet: false },
      // A tool the posting names is never a concept, whatever the model says.
      { entry: 'Rhino', tools: [], bullet: true },
    ],
    rename: [{ entry: 'C Sharp', name: 'C#' }],
    remove: ['Amazon Web Services'],
    additions: [
      { name: 'Grafana', group: 'monitoring' },
      { name: 'PostgreSQL', group: 'Data & Storage' },
      { name: 'Pydantic', group: 'Languages & Frameworks' },
    ],
  };

  const out = applySkillCheckForTests(technical, answer, ['Python', 'Rhino']);
  assert.deepEqual(out.groups, [
    { category: 'Languages & Frameworks', skills: ['Python', 'C#', 'FastAPI', 'Pydantic'] },
    { category: 'Cloud & Infrastructure', skills: ['AWS', 'MLflow', 'Kubeflow', 'Rhino'] },
    { category: 'Monitoring', skills: ['Datadog', 'pytest', 'Grafana'] },
    { category: 'Data & Storage', skills: ['PostgreSQL'] },
  ]);
  // "run" is a bare verb and goes nowhere; the others go to the bullets.
  assert.deepEqual(out.concepts, ['MLOps', 'regression detection']);
});

test('a name the posting gives is never removed, renamed away or made a concept', () => {
  /*
   * REPORTED: core skills missing from the block. The check's "remove" list
   * was applied to anything, and a rename could swap the posting's spelling
   * for another one - "Postgres" for "PostgreSQL" - which a scanner reading
   * for the posting's word then misses. Fixing the capitals is allowed.
   */
  const technical = [
    { category: 'Data & Storage', skills: ['Postgres', 'Kafka', 'mlflow', 'Redis'] },
    { category: 'ML & AI', skills: ['MLOps', 'PyTorch', 'TensorFlow', 'scikit-learn', 'pandas', 'NumPy', 'Pinecone'] },
  ];
  const answer = {
    concepts: [{ entry: 'MLOps', tools: ['MLflow'], bullet: true }],
    rename: [{ entry: 'Postgres', name: 'PostgreSQL' }, { entry: 'mlflow', name: 'MLflow' }],
    remove: ['Kafka', 'Redis'],
  };
  const out = applySkillCheckForTests(technical, answer, ['Postgres', 'Kafka', 'MLflow', 'MLOps']);

  assert.deepEqual(out.groups, [
    { category: 'Data & Storage', skills: ['Postgres', 'Kafka', 'MLflow'] },
    { category: 'ML & AI', skills: ['MLOps', 'PyTorch', 'TensorFlow', 'scikit-learn', 'pandas', 'NumPy', 'Pinecone'] },
  ]);
  assert.deepEqual(out.concepts, []);
});

test('an entry the writing call labelled a concept is held back from the check and leaves the block', async () => {
  /*
   * REPORTED: "General Ledger", "Month-End Close", "Helpdesk Ticketing" printed
   * in the block. The check was sent every entry and handed every survivor back
   * labelled "tool", so the writing call's own "domain" or "practice" label was
   * lost and the tidy-up never routed on it.
   */
  process.env.RESUME_REVISION_OFF = '1';
  try {
    const draft = JSON.parse(DRAFT);
    draft.skillGroups[1].skills.push({ name: 'General Ledger', kind: 'domain' }, { name: 'incident review', kind: 'practice' });
    const { calls, result } = await withStub({ 'tailor-resume': JSON.stringify(draft), 'check-skills': CHECKED });

    assert.doesNotMatch(calls[1].promptValues.skillGroupsJson, /General Ledger|incident review/);
    const printed = result.skillGroups.flatMap((group) => group.skills);
    assert.equal(printed.includes('General Ledger'), false, printed.join(', '));
    assert.equal(printed.includes('Incident Review'), false, printed.join(', '));
    assert.ok(printed.includes('Datadog') && printed.includes('MLflow'), printed.join(', '));
  } finally {
    delete process.env.RESUME_REVISION_OFF;
  }
});

test('a lower-case mark needs a person to have written the name that way', async () => {
  /*
   * REPORTED: "terraform" printed in lower case. The check listed it as an
   * officially lower-case name; the posting it answered wrote "Terraform".
   * dbt, written in lower case by the posting, keeps it.
   */
  process.env.RESUME_REVISION_OFF = '1';
  try {
    const checked = JSON.parse(CHECKED);
    checked.additions.push({ name: 'terraform', group: 'Monitoring' }, { name: 'dbt', group: 'Languages & Frameworks' });
    checked.lowercase = ['terraform', 'dbt'];
    const execution = require('../dist/services/ai/promptExecution');
    const original = execution.createPromptCompletion;
    execution.createPromptCompletion = async (request) => (
      request.promptId === 'tailor-resume' ? DRAFT : JSON.stringify(checked)
    );
    let result;
    try {
      const posting = parseJobAnalysisContent(JSON.stringify({
        jobMeta: { title: 'Machine Learning Engineer', seniority: 'Senior', industry: 'SaaS', department: 'Engineering' },
        skills: { technical: [], tools: ['Python', 'Datadog', 'Terraform', 'dbt'], soft: [] },
        technologies: [], protocols: [], methodologies: [], architecturePatterns: [],
        responsibilities: [], domainKnowledge: [],
        keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
      }), 'An ML role in Python with Terraform and dbt, watched in Datadog.');
      result = await tailorResume(profile(), posting, { provider: 'claude-web', modelName: 'chat' });
    } finally {
      execution.createPromptCompletion = original;
    }
    const printed = result.skillGroups.flatMap((group) => group.skills);
    assert.ok(printed.includes('Terraform'), printed.join(', '));
    assert.ok(printed.includes('dbt'), printed.join(', '));
  } finally {
    delete process.env.RESUME_REVISION_OFF;
  }
});

test('the check prompt keeps names, and the posting\'s names above all', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const content = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'static', 'prompts', 'check-skills.json'), 'utf8')
  ).content;
  // "MLOps" was one of the prompt's own examples of a concept to take out.
  assert.doesNotMatch(content, /"Experiment Tracking", "MLOps"/);
  assert.match(content, /named methodologies and named technologies - Agile, Scrum, MLOps/);
  assert.match(content, /Never remove, rename or replace an entry from TOOLS AND TECHNOLOGIES THE JOB POSTING NAMES/);
});

test('the analysis\'s named methodologies are on the tool list the check protects', () => {
  const { buildSkillCheckPromptValuesForTests } = require('../dist/services/resumeService');
  const named = parseJobAnalysisContent(JSON.stringify({
    jobMeta: { title: 'Senior MLOps Engineer', seniority: 'Senior', industry: 'SaaS', department: 'Engineering' },
    skills: { technical: ['model monitoring'], tools: ['MLflow'], soft: [] },
    technologies: ['Python'], protocols: [], methodologies: ['MLOps', 'CI/CD'], architecturePatterns: [],
    responsibilities: [], domainKnowledge: [],
    keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
  }), 'An MLOps role.');
  const values = buildSkillCheckPromptValuesForTests(
    [{ category: 'Languages & Frameworks', skills: ['Python'] }],
    { experience: [] },
    named
  );
  const tools = JSON.parse(values.postingToolsJson);
  for (const name of ['MLflow', 'Python', 'MLOps', 'CI/CD']) assert.ok(tools.includes(name), `${name} is not protected`);
  assert.ok(!tools.includes('model monitoring'), 'an ability is not a named thing');
});

test('an answer with too few tools keeps the draft\'s block', async () => {
  process.env.RESUME_REVISION_OFF = '1';
  try {
    const { result } = await withStub({
      'tailor-resume': DRAFT,
      'check-skills': JSON.stringify({
        concepts: [
          { entry: 'regression detection', tools: [], bullet: true },
          { entry: 'model performance measurement', tools: [], bullet: true },
        ],
      }),
    });
    const printed = result.skillGroups.flatMap((group) => group.skills);
    assert.ok(printed.includes('Datadog') && printed.includes('FastAPI'), printed.join(', '));
    assert.deepEqual(result.skillGroups[result.skillGroups.length - 1], { category: 'Soft Skills', skills: ['Mentoring'] });
  } finally {
    delete process.env.RESUME_REVISION_OFF;
  }
});

test('RESUME_SKILL_CHECK_OFF skips the check', async () => {
  process.env.RESUME_SKILL_CHECK_OFF = '1';
  process.env.RESUME_REVISION_OFF = '1';
  try {
    const { calls } = await withStub({ 'tailor-resume': DRAFT });
    assert.deepEqual(calls.map((call) => call.promptId), ['tailor-resume']);
  } finally {
    delete process.env.RESUME_SKILL_CHECK_OFF;
    delete process.env.RESUME_REVISION_OFF;
  }
});

test('every word of every skill entry starts with a capital letter', () => {
  const { capitalizeSkillWords, tidySkillGroups } = require('../dist/services/utils/resumeQuality');
  assert.equal(capitalizeSkillWords('pytest'), 'Pytest');
  assert.equal(capitalizeSkillWords('scikit-learn'), 'Scikit-Learn');
  assert.equal(capitalizeSkillWords('vector databases'), 'Vector Databases');
  assert.equal(capitalizeSkillWords('PyTorch'), 'PyTorch');
  assert.equal(capitalizeSkillWords('GitHub Actions'), 'GitHub Actions');
  assert.equal(capitalizeSkillWords('CI/CD'), 'CI/CD');
  // A capital inside a word is the maker's own casing, and stays.
  assert.equal(capitalizeSkillWords('iOS'), 'iOS');
  assert.equal(capitalizeSkillWords('eBPF'), 'eBPF');
  assert.equal(capitalizeSkillWords('gRPC'), 'gRPC');

  // A name the model marks as officially lower case stays lower case; an
  // unmarked lower-case entry is capitalised.
  const { groups } = tidySkillGroups([
    {
      category: 'Data',
      skills: [
        { name: 'dbt', kind: 'tool', keepCase: true },
        { name: 'pandas', kind: 'library', keepCase: true },
        { name: 'vector databases', kind: 'tool' },
      ],
    },
    { category: 'Soft Skills', skills: [{ name: 'written communication', kind: 'soft' }] },
  ]);
  assert.deepEqual(groups.flatMap((group) => group.skills), ['dbt', 'pandas', 'Vector Databases', 'Written Communication']);

  // And a re-parsed block, already capitalised once, is left as it is.
  const reparsed = tidySkillGroups([{ category: 'Data', skills: ['dbt', 'Pandas'] }], { capitalize: false });
  assert.deepEqual(reparsed.groups[0].skills, ['dbt', 'Pandas']);
});

test('the skills check names the tools written in lower case, and they keep it', () => {
  const technical = [{ category: 'Data', skills: ['DBT', 'Snowflake', 'pytest', 'Airflow', 'PostgreSQL', 'Redis', 'Kafka', 'Python', 'Spark', 'Docker'] }];
  const out = applySkillCheckForTests(technical, { lowercase: ['dbt', 'pytest'] }, []);
  assert.deepEqual(out.groups[0].skills.slice(0, 3), ['dbt', 'Snowflake', 'pytest']);
  assert.deepEqual(out.keepCase, ['dbt', 'pytest']);
});

test('a lower-case import name takes the casing real text gives it', () => {
  const { tidySkillGroups, namesWithInnerCapitals } = require('../dist/services/utils/resumeQuality');
  const knownCasing = namesWithInnerCapitals(['We use NumPy, SciPy and OpenAPI specs.', 'Build with DBT and AWS.']);
  assert.equal(knownCasing.get('numpy'), 'NumPy');
  assert.equal(knownCasing.has('dbt'), false, 'an all-capital word says nothing about casing');

  const { groups } = tidySkillGroups([{
    category: 'ML & AI',
    skills: [
      { name: 'numpy', kind: 'library', keepCase: true },
      { name: 'scipy', kind: 'library' },
      { name: 'openapi', kind: 'protocol' },
      { name: 'dbt', kind: 'tool', keepCase: true },
      { name: 'networkx', kind: 'library' },
    ],
  }], { knownCasing });
  // A wrong keepCase flag loses to real text; a right one stays; nothing known is capitalised.
  assert.deepEqual(groups[0].skills, ['NumPy', 'SciPy', 'OpenAPI', 'dbt', 'Networkx']);
});
