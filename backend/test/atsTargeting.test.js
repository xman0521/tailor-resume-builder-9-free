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
  FILE_NAME_STYLES,
  FILE_NAME_STYLE_NAMES,
  pickFileNameStyle,
  renderOutputFileNameTemplate,
  renderStyledFileNames,
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

test('the file name carries the KIND of role, not the posting\'s own words', () => {
  /*
   * The names this replaced, both taken off disk:
   *   Weitian_Wu_Senior_Cloud_Engineer_Observability.pdf
   *   Weitian_Wu_DevOps_Engineer_III_AI_Business_Automation.pdf
   *
   * The full title still names the FOLDER, where telling two jobs at one
   * company apart is the point. A file name is read in a listing, and what an
   * operator wants there is the discipline.
   */
  const variables = {
    date: '2026-09-29',
    profileName: 'Weitian Wu',
    companyName: 'KeyCorp',
    rowNumber: '100',
    jobTitle: 'DevOps Engineer III - AI Business Automation',
    roleFamily: 'DevOps Engineer',
  };
  const render = (template) =>
    renderOutputFileNameTemplate(template, variables, DEFAULT_RESUME_FILE_NAME_TEMPLATE);

  assert.equal(DEFAULT_RESUME_FILE_NAME_TEMPLATE, '{{profile name}}_{{role family}}');
  assert.equal(DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE, '{{profile name}}_{{role family}}_cover_letter');
  assert.equal(render(DEFAULT_RESUME_FILE_NAME_TEMPLATE), 'Weitian_Wu_DevOps_Engineer');
  assert.equal(
    render(DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE),
    'Weitian_Wu_DevOps_Engineer_cover_letter'
  );

  // Every spelling anybody writes resolves: a token this table does not know
  // renders as its own literal text into the name on disk.
  for (const spelling of ['{{role family}}', '{{role type}}', '{{simple role}}', '{{simple role title}}', '{{discipline}}']) {
    assert.equal(render(`{{profile name}}_${spelling}`), 'Weitian_Wu_DevOps_Engineer', `${spelling} did not resolve`);
  }
  // And the posting's own title is still available under its own names.
  for (const spelling of ['{{job title}}', '{{target role title}}', '{{role}}']) {
    assert.equal(
      render(`{{profile name}}_${spelling}`),
      'Weitian_Wu_DevOps_Engineer_III_AI_Business_Automation',
      `${spelling} did not resolve`
    );
  }

  // A posting with no title of its own still names a file.
  assert.equal(
    renderOutputFileNameTemplate(
      DEFAULT_RESUME_FILE_NAME_TEMPLATE,
      { ...variables, jobTitle: '', roleFamily: '' },
      DEFAULT_RESUME_FILE_NAME_TEMPLATE
    ),
    'Weitian_Wu'
  );
});

test('the pair of file names takes one of six shapes, and takes it together', () => {
  /*
   * Five hundred files named to one pattern is the same tell as five hundred
   * resumes laid out to one pattern, which is why the skills block's look and
   * the headline's separator already vary. What must NOT vary inside one
   * application is the shape itself: a folder holding
   * "Weitian_Wu_DevOps_Engineer.pdf" beside "devops_engineer_weitian_wu_cl.pdf"
   * reads as two different people's work.
   */
  const variables = {
    date: '2026-09-30',
    profileName: 'Weitian Wu',
    companyName: 'KeyCorp',
    rowNumber: '100',
    jobTitle: 'DevOps Engineer III - AI Business Automation',
    roleFamily: 'DevOps Engineer',
  };

  const rendered = FILE_NAME_STYLES.map((style) => renderStyledFileNames(style, variables));
  assert.deepEqual(rendered, [
    { resume: 'Weitian_Wu_DevOps_Engineer', coverLetter: 'Weitian_Wu_DevOps_Engineer_cover_letter' },
    { resume: 'Weitian_Wu_Resume_DevOps_Engineer', coverLetter: 'Weitian_Wu_Cover_Letter_DevOps_Engineer' },
    { resume: 'Weitian_Wu_DevOps_Engineer_Resume', coverLetter: 'Weitian_Wu_DevOps_Engineer_Cover_Letter' },
    { resume: 'WeitianWu_DevOpsEngineer', coverLetter: 'WeitianWu_DevOpsEngineer_CoverLetter' },
    { resume: 'Weitian_Wu_KeyCorp_DevOps_Engineer', coverLetter: 'Weitian_Wu_KeyCorp_DevOps_Engineer_CL' },
    { resume: 'weitian_wu_devops_engineer', coverLetter: 'weitian_wu_devops_engineer_cover_letter' },
  ]);

  // Every shape leads with the candidate, so a listing still sorts by person
  // and a recruiter reads the name first.
  for (const { resume, coverLetter } of rendered) {
    for (const name of [resume, coverLetter]) assert.match(name, /^(?:Weitian_?Wu|weitian_wu)/, name);
    // The letter says it is one - the label moves around between shapes, so
    // this asks whether it is there rather than where.
    assert.match(coverLetter.toLowerCase(), /cover_?letter|_cl$/, coverLetter);
    // And the pair shares its case convention: a lowercase resume beside a
    // Title_Case letter is the tell this whole thing exists to avoid.
    assert.equal(
      resume === resume.toLowerCase(),
      coverLetter === coverLetter.toLowerCase(),
      `${resume} and ${coverLetter} disagree about case`
    );
  }

  // Underscores only, as the operator asked: no spaces, no punctuation.
  for (const { resume, coverLetter } of rendered) {
    for (const name of [resume, coverLetter]) assert.match(name, /^[A-Za-z0-9_]+$/, name);
  }

  // Drawn per application, and pinnable for a batch that should look the same.
  const seen = new Set();
  for (let run = 0; run < 300; run += 1) seen.add(pickFileNameStyle({}).name);
  assert.equal(seen.size, FILE_NAME_STYLE_NAMES.length, `only saw ${[...seen].join(', ')}`);
  assert.equal(pickFileNameStyle({ RESUME_FILE_NAME_STYLE: 'camel' }).name, 'camel');
  assert.equal(pickFileNameStyle({ RESUME_FILE_NAME_STYLE: ' CAMEL ' }).name, 'camel');
  assert.ok(FILE_NAME_STYLE_NAMES.includes(pickFileNameStyle({ RESUME_FILE_NAME_STYLE: 'nonsense' }).name));

  // A posting with no role family still names a pair of files.
  const bare = renderStyledFileNames(FILE_NAME_STYLES[0], { ...variables, roleFamily: '' });
  assert.equal(bare.resume, 'Weitian_Wu');
  assert.equal(bare.coverLetter, 'Weitian_Wu_cover_letter');
});

test('a profile that names its own template pins itself', async () => {
  /*
   * The pool is what a profile gets when it has not said otherwise. An operator
   * who wants every file for one candidate to look identical sets the template
   * in Admin, and the draw is skipped - which is also how the five live profiles
   * were pinned before this existed.
   */
  const { getGeneratedOutputPath, getResumeOutputFilename, getCoverLetterOutputFilename } =
    require('../dist/utils/generatedPath');
  const { useTempStorage } = require('./helpers');
  useTempStorage('file-name-style');

  const profile = {
    id: 'pinned', name: 'Weitian Wu', title: 'Software Engineer',
    profileSettings: {
      resumeFileNameTemplate: '{{profile name}}_{{role family}}',
      coverLetterFileNameTemplate: '{{profile name}}_{{role family}}_cover_letter',
    },
    contact: {}, summary: '', experience: [], strengths: [], skills: [],
    education: [], certifications: [], createdAt: '', updatedAt: '',
  };

  const names = new Set();
  for (let run = 0; run < 12; run += 1) {
    const info = await getGeneratedOutputPath(profile, 'KeyCorp', 'DevOps Engineer III - AI Business Automation', 100);
    names.add(`${getResumeOutputFilename(info, 'pdf')}|${getCoverLetterOutputFilename(info, 'pdf')}`);
  }
  assert.deepEqual(
    [...names],
    ['Weitian_Wu_DevOps_Engineer.pdf|Weitian_Wu_DevOps_Engineer_cover_letter.pdf']
  );
});
