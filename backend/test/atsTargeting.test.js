const assert = require('node:assert/strict');
const test = require('node:test');

const {
  countFigures,
  focusSkills,
  parseJobAnalysisContent,
} = require('../dist/services/resumeService');
const {
  DEFAULT_RESUME_FILE_NAME_TEMPLATE,
  DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE,
  renderOutputFileNameTemplate,
} = require('../dist/utils/outputStorage');

/**
 * The three things the operator asked for by number: the posting's five leading
 * skills, five figures on the page, and the target role in the file name.
 *
 * The first two are REPORTED per build rather than enforced - the model writes
 * the resume and nothing here rewrites it - so what these pin is that the
 * counting is right. A floor measured wrongly is worse than no floor: it says
 * the run was fine.
 */

const analysis = (skills) => parseJobAnalysisContent(JSON.stringify({
  jobMeta: { title: 'Senior Platform Engineer', seniority: 'Senior', industry: 'SaaS', department: 'Engineering' },
  skills: {
    technical: ['code review', 'debugging'],
    required: skills.required ?? [],
    preferred: skills.preferred ?? [],
    tools: skills.tools ?? [],
    soft: ['Communication skills'],
    technologies: skills.technologies ?? [],
  },
  technologies: skills.technologies ?? [],
  protocols: [], methodologies: [], architecturePatterns: [],
  responsibilities: [], domainKnowledge: [], softSkills: [],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
}), 'A platform role.');

test('the five focus skills are the posting\'s own technologies, required first', () => {
  const job = analysis({
    required: ['Kubernetes', 'Terraform', 'Go', 'incident response', 'Postgres', 'Kafka'],
    preferred: ['Datadog', 'ArgoCD'],
    tools: ['Datadog', 'ArgoCD', 'Kubernetes', 'Terraform', 'Postgres', 'Kafka'],
    technologies: ['Go'],
  });

  // Required, in the posting's own order, because that order is the employer's
  // ranking - and five of them, because a posting names thirty things and means
  // five.
  assert.deepEqual(focusSkills(job), ['Kubernetes', 'Terraform', 'Go', 'Postgres', 'Kafka']);

  // "Incident response" is a practice, not a thing to install. A bullet can be
  // built around Kubernetes; it cannot be built around a concept, and concepts
  // have their own checklist.
  assert.ok(!focusSkills(job).includes('incident response'));

  // Preferred fills up when required is short, and nothing is invented.
  assert.deepEqual(
    focusSkills(analysis({ required: ['Go'], preferred: ['Datadog'], tools: ['Go', 'Datadog'] })),
    ['Go', 'Datadog']
  );
  assert.deepEqual(focusSkills(analysis({})), []);
  assert.deepEqual(focusSkills(undefined), []);
});

test('figures are counted, versions and dates are not', () => {
  const resume = (bullets, summary = 'Engineer.') => ({
    summary,
    experience: [{ achievements: bullets }],
  });

  assert.equal(countFigures(resume([
    'Cut p99 latency from 180ms to 118ms.',
    'Migrated 40 services to Kubernetes.',
  ], 'Engineer of 9 years.')), 4);

  // What a scanner would NOT accept as a measurable result: a product's version,
  // a name with a number in it, a date. A resume of these has no figures at all.
  assert.equal(countFigures(resume([
    'Built services in Java with OAuth 2.0, S3 and Log4j since 01/2019.',
    'Worked on the 2019 migration to HTTP/2.',
  ])), 0);

  assert.equal(countFigures(resume([])), 0);
  assert.equal(countFigures({}), 0);

  // The floor the prompt states is five, so a resume at five has to count five.
  assert.ok(countFigures(resume([
    'Cut 40% of the manual steps.',
    'Ran 3 reviews a week.',
    'Held p99 under 200ms.',
    'Closed 15 defects before handover.',
  ], 'Engineer of 9 years.')) >= 5);
});

test('the file name carries the target role', () => {
  const variables = {
    date: '2026-09-26',
    profileName: 'Jonathan Lai',
    companyName: 'KeyCorp',
    rowNumber: '100',
    jobTitle: 'Senior Platform Engineer',
  };
  const render = (template) =>
    renderOutputFileNameTemplate(template, variables, DEFAULT_RESUME_FILE_NAME_TEMPLATE);

  assert.equal(DEFAULT_RESUME_FILE_NAME_TEMPLATE, '{{profile name}}_{{target role title}}');
  assert.equal(DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE, '{{profile name}}_{{target role title}}_cover_letter');
  assert.equal(render(DEFAULT_RESUME_FILE_NAME_TEMPLATE), 'Jonathan_Lai_Senior_Platform_Engineer');

  // The operator writes {{target role title}}; the path templates have always
  // said {{job title}}. A token this table does not know renders as its own
  // literal text into a file name, so every spelling anybody uses resolves.
  for (const spelling of ['{{target role title}}', '{{job title}}', '{{role}}', '{{target role}}', '{{role title}}']) {
    assert.equal(
      render(`{{profile name}}_${spelling}`),
      'Jonathan_Lai_Senior_Platform_Engineer',
      `${spelling} did not resolve`
    );
  }

  // A posting with no title of its own still names a file.
  assert.equal(
    renderOutputFileNameTemplate(
      DEFAULT_RESUME_FILE_NAME_TEMPLATE,
      { ...variables, jobTitle: '' },
      DEFAULT_RESUME_FILE_NAME_TEMPLATE
    ),
    'Jonathan_Lai'
  );
});
