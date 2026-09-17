const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { launchBrowser } = require('../dist/config/browser');
const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
const { withTargetTitle, titleDisciplines } = require('../dist/services/resumeService');
const {
  measurePlacement, renderedProse, containsTerm, placementFloor,
} = require('../dist/services/utils/placementCoverage');

/**
 * Three defects found by measuring finished resumes rather than reading code,
 * each of which cost ATS points on every document this app produced.
 */

const TEMPLATES = path.join(__dirname, '..', 'static', 'templates');
const EMAIL = 'jonalai0897@gmail.com';

const profile = (overrides = {}) => ({
  id: 'p', name: 'Jonathan Lai', title: 'Senior Software Engineer',
  profileSettings: { technicalSkillsLayout: 'flat' },
  contact: {
    phone: '(214) 865-9131', email: EMAIL,
    linkedin: 'linkedin.com/in/jonathan-l-61539a150', location: 'The Colony, TX',
  },
  summary: 'Senior engineer.',
  experience: [{
    title: 'Senior Software Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
    location: 'Remote', description: 'Built MuleSoft integration flows.', achievements: ['Did a thing.'], skills: [],
  }],
  strengths: [], skills: ['MuleSoft', 'Integration', 'Kubernetes'],
  education: [], certifications: [], createdAt: '', updatedAt: '',
  ...overrides,
});

const analysisWithTitle = (title) => ({
  jobMeta: { title, seniority: '', industry: '', department: '' },
  skills: { technical: [], required: [], preferred: [], tools: [], soft: [], technologies: [] },
  technologies: [], protocols: [], methodologies: [], architecturePatterns: [],
  responsibilities: [], domainKnowledge: [], softSkills: [],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
});

// ------------------------------------------------------------------ contact

test('the contact fields are separated by a real character, not a flex gap', async (t) => {
  /*
   * Measured across 60 finished resumes before this fix: an email was present
   * in 60 and cleanly delimited in 0. `display:flex; gap:14px` separates boxes,
   * not text, so the PDF carried
   *   (214) 865-9131jonalai0897@gmail.comlinkedin.com/in/...The Colony, TX
   * and a scanner reading the email got "@gmail.comlinkedin.com".
   */
  let pdfParse;
  try { pdfParse = require('pdf-parse'); } catch { t.skip('pdf-parse unavailable'); return; }

  const templates = fs.readdirSync(TEMPLATES)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(TEMPLATES, file), 'utf8')))
    .filter((template) => (template.htmlContent || '').includes('contact.email'));

  assert.ok(templates.length > 0, 'no template has a contact line; this test proves nothing');

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const glued = [];
    for (const template of templates) {
      await page.setContent(await generatePreviewHTML(profile(), template), { waitUntil: 'load' });
      const buffer = Buffer.from(await page.pdf({ format: 'A4', printBackground: true }));
      const text = (await pdfParse(buffer)).text.replace(/\n/g, ' ');

      // What a parser would pull out. Anything glued to either end is a
      // different address to the one on the page.
      const found = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0];
      if (found !== EMAIL) glued.push(`${template.name}: ${found}`);
    }
    assert.deepEqual(glued, [], `the email does not extract cleanly from: ${glued.join(' | ')}`);
  } finally {
    await browser.close();
  }
});

// -------------------------------------------------------------------- title

test('a title is reduced to the discipline it names', () => {
  /*
   * The version this replaced put the posting's WHOLE title in parentheses, and
   * only when every meaningful word of it already appeared in the candidate's
   * history. Across ten real resumes it fired zero times: a posting says
   * "Mulesoft Integration Engineer" and a profile says "built integrations",
   * which shares one word of three. A rule that never fires is a dead rule, not
   * a careful one.
   */
  const cases = [
    ['Mulesoft Integration Engineer', ['Integration']],
    ['Senior Machine Learning Engineer', ['AI/ML']],
    ['Full Stack Software Engineer (Node.js)', ['Full-Stack']],
    ['Backend Engineer - AI Platform and Cloud Native Services', ['Backend', 'AI/ML', 'Cloud']],
    ['AWS DevOps', ['DevOps']],
    ['Senior Engineer I, DevOps', ['DevOps']],
    ['Staff Data Engineer', ['Data Engineer']],
  ];

  for (const [title, expected] of cases) {
    assert.deepEqual(titleDisciplines(title), expected, `"${title}" was read wrong`);
  }
});

test('a cloud vendor does not make a job a cloud job', () => {
  // "AWS DevOps" is a DevOps job that happens to run on AWS. Tagging it
  // (Cloud, DevOps) would say something the posting did not.
  assert.deepEqual(titleDisciplines('AWS DevOps'), ['DevOps']);
  assert.deepEqual(titleDisciplines('Azure Data Engineer'), ['Data Engineer']);
  // The word itself does mean it.
  assert.ok(titleDisciplines('Cloud Native Services Engineer').includes('Cloud'));
});

test('the disciplines come out in the order the title names them', () => {
  // A backend job with AI and cloud in it is a backend job first. Alphabetical
  // order would call it an AI job.
  assert.deepEqual(
    titleDisciplines('Backend Engineer - AI Platform and Cloud Native Services'),
    ['Backend', 'AI/ML', 'Cloud']
  );
});

// A fixed list, so these do not depend on what an operator has added in Admin.
const SKILLS = [
  'Java', 'Python', 'Go', '.NET', 'C#', 'C', 'R', 'SQL', 'SQL Server', 'Ruby', 'Ruby on Rails',
  'DevSecOps', 'MLOps', 'Node.js', 'PL/SQL', 'Aurora', 'Rocket', 'Echo', 'Spring', 'Engineering',
];

test('a title with no known field is tagged from the skill list or not at all', () => {
  /*
   * Every one of these reached a printed headline when the fallback took the
   * first word left over: a company, a team, a rank, a level and an
   * arrangement. None names a field or a skill, so none gets a tag. ("Senior
   * Statistician", the job-noun case, now maps to Data Science.)
   */
  const untagged = [
    'EverHealth - Senior Software Engineer (Remote - US)',
    'Staff Software Engineer, Experience',
    'Executive Director, Engineering (AA)',
    'Software Engineer L4 (Remote)',
    'Software Engineer (Part-time)',
    'Part Time Software Engineer',
    'Remote Software Engineer ($90-140/hour)',
    'Senior Fraud Strategist',
    'Senior Software Engineer',
    '',
  ];
  for (const title of untagged) {
    assert.deepEqual(titleDisciplines(title, SKILLS), [], `"${title}" should carry no tag`);
  }

  // A skill it does name comes out as the list spells it.
  assert.deepEqual(titleDisciplines('Senior Software Engineer (.NET)', SKILLS), ['.NET']);
  assert.deepEqual(titleDisciplines('SQL Programmer', SKILLS), ['SQL']);
  assert.deepEqual(titleDisciplines('DevSecOps Engineer', SKILLS), ['DevSecOps']);
  assert.deepEqual(titleDisciplines('Senior Software Engineer - Platform (MLOps)', SKILLS), ['MLOps']);
  assert.deepEqual(titleDisciplines('Senior Software Engineer (Node.js, Python)', SKILLS), ['Node.js']);
});

test('the skill check prefers the longest name and splits paired skills', () => {
  assert.deepEqual(titleDisciplines('Ruby on Rails Developer', SKILLS), ['Ruby on Rails']);
  assert.deepEqual(titleDisciplines('Software Engineer (SQL Server)', SKILLS), ['SQL Server']);
  assert.deepEqual(titleDisciplines('Java/Python Developer', SKILLS), ['Java']);
  // One skill with a slash in its name stays whole.
  assert.deepEqual(titleDisciplines('PL/SQL Developer', SKILLS), ['PL/SQL']);
});

test('skills that are also ordinary words do not tag a title', () => {
  // "Aurora" here is a town and "Rocket" a company.
  assert.deepEqual(titleDisciplines('L2 Field Engineer (Aurora)', SKILLS), []);
  assert.deepEqual(titleDisciplines('Rocket Mobius Developer', SKILLS), []);
  assert.deepEqual(titleDisciplines('Echo Team Engineer', SKILLS), []);
  // A noise word that happens to be on the list is still noise.
  assert.deepEqual(titleDisciplines('Engineering Lead', SKILLS), []);
  // One letter is a language only with its marks.
  assert.deepEqual(titleDisciplines('R&D Engineer', SKILLS), []);
  assert.deepEqual(titleDisciplines('Software Engineer (C#)', SKILLS), ['C#']);
  // "Go" the language, not "go" the verb.
  assert.deepEqual(titleDisciplines('Senior Software Engineer (Go)', SKILLS), ['Go']);
  assert.deepEqual(titleDisciplines('Go-To-Market Engineer', SKILLS), []);
  assert.deepEqual(titleDisciplines('Engineer who will go far', SKILLS), []);
});

test('named products get a tag even where the skill list lacks or respells them', () => {
  assert.deepEqual(titleDisciplines('Lead Software Engineer (Golang, TypeScript, React)', []), ['Go']);
  assert.deepEqual(titleDisciplines('Senior ServiceNow Developer', []), ['ServiceNow']);
  assert.deepEqual(titleDisciplines('SAP Data Conversion Engineer', []), ['SAP']);
  assert.deepEqual(titleDisciplines('Oracle EBS Developer', []), ['Oracle']);
  assert.deepEqual(titleDisciplines('Drupal Developer', []), ['Drupal']);
});

test('common titles that used to go untagged name their field', () => {
  // Each taken from the untagged list of real titles.
  const cases = [
    ['Senior Software Test Engineer', ['QA']],
    ['Test Engineering Lead', ['QA']],
    ['Senior Software Quality Engineer', ['QA']],
    ['Mobile Test Engineer', ['Mobile', 'QA']],
    ['Senior Data Warehouse Engineer', ['Data Engineer']],
    ['Staff Software Engineer, Data Lakehouse', ['Data Engineer']],
    ['Agentic Engineer', ['AI/ML']],
    ['RL Environment Software Engineer', ['AI/ML']],
    ['Senior Data Analyst, Business Operations', ['Data Science']],
    ['Senior Statistician', ['Data Science']],
    ['Senior Build Engineer', ['DevOps']],
    ['Build & Release Engineer', ['DevOps']],
    ['Senior Fortinet Engineer', ['Security']],
    ['API Engineering Lead', ['Backend']],
  ];
  for (const [title, expected] of cases) {
    assert.deepEqual(titleDisciplines(title, []), expected, `"${title}" was read wrong`);
  }
  // "rl" in lower case is not reinforcement learning.
  assert.deepEqual(titleDisciplines('Engineer, url routing', []), []);
});

test('IT is tagged only when the title says IT', () => {
  assert.deepEqual(titleDisciplines('IT Engineer, First IT Hire', []), ['IT']);
  assert.deepEqual(titleDisciplines('Service Desk Analyst', []), ['IT']);
  // Support engineering is a different job, and "it" is an English word.
  assert.deepEqual(titleDisciplines('Technical Support Engineer (Tier 1)', []), []);
  assert.deepEqual(titleDisciplines('Product Support Engineer', []), []);
  assert.deepEqual(titleDisciplines('Build & Release Support Engineer (CI/CD)', []), ['DevOps']);
  assert.deepEqual(titleDisciplines('Engineer - Make it Happen', []), []);
});

test('the headline carries the discipline, and skips one it already states', () => {
  const p = profile();
  assert.equal(
    withTargetTitle('Senior Software Engineer', analysisWithTitle('Mulesoft Integration Engineer'), p),
    'Senior Software Engineer (Integration)'
  );
  assert.equal(
    withTargetTitle('Senior Software Engineer', analysisWithTitle('Backend Engineer - AI Platform and Cloud Native'), p),
    'Senior Software Engineer (Backend, AI/ML, Cloud)'
  );

  // Already said, so not said twice.
  assert.equal(
    withTargetTitle('Senior Data Engineer', analysisWithTitle('Staff Data Engineer'), p),
    'Senior Data Engineer'
  );
  // Nothing to add.
  assert.equal(
    withTargetTitle('Senior Software Engineer', analysisWithTitle('Senior Software Engineer'), p),
    'Senior Software Engineer'
  );
});

test('the profile headline is printed unchanged, not rebuilt', () => {
  /*
   * The failure this pins, seen on a finished resume: a profile whose title is
   * "Software Engineer" was printed as "Senior Software Engineer". The headline
   * used to be rebuilt into a fixed `Senior <domain> Engineer` shape from
   * whichever title could be found, which handed the candidate a promotion and,
   * when the posting won, renamed them for the job - "Senior Mulesoft
   * Integration Engineer".
   *
   * Reaching for `parseTailoredResumeContent` rather than the helper, because
   * the helper was right last time and the pipeline threw its answer away.
   */
  const { parseTailoredResumeContent } = require('../dist/services/resumeService');
  const p = profile({ title: 'Software Engineer' });

  const out = parseTailoredResumeContent(
    JSON.stringify({ title: 'Engineer', summary: 'S.', experience: p.experience, strengths: [], coverLetter: 'x' }),
    p,
    analysisWithTitle('Mulesoft Integration Engineer')
  );

  assert.equal(out.title, 'Software Engineer (Integration)');
  assert.equal(
    out.title.startsWith('Software Engineer'),
    true,
    'the candidate\'s own headline must survive verbatim'
  );

  // No posting at all leaves it exactly as written.
  const plain = parseTailoredResumeContent(
    JSON.stringify({ title: 'Engineer', summary: 'S.', experience: p.experience, strengths: [], coverLetter: 'x' }),
    p,
    undefined
  );
  assert.equal(plain.title, 'Software Engineer');
});

test('an abbreviated grade is not mistaken for a discipline', () => {
  // "(Sr.)" reached a printed resume: the token was "Sr." and the noise list
  // held "sr", so the two never met.
  assert.deepEqual(titleDisciplines('Sr. Software Engineer'), []);
  assert.deepEqual(titleDisciplines('Jr. Developer'), []);
  // The grade going away must not take the discipline with it.
  assert.deepEqual(titleDisciplines('Sr. DevOps Engineer'), ['DevOps']);
});

test('the headline stays a headline', () => {
  const p = profile();
  const long = withTargetTitle(
    'Senior Distributed Systems and Platform Reliability Engineer',
    analysisWithTitle('Backend Engineer - AI Platform and Cloud Native Services'),
    p
  );
  assert.ok(long.length <= 72, `the headline ran to ${long.length} characters: ${long}`);
});

test('a headline that already says it is left alone', () => {
  assert.equal(
    withTargetTitle('Senior Software Engineer', analysisWithTitle('Senior Software Engineer'), profile()),
    'Senior Software Engineer'
  );
  assert.equal(withTargetTitle('Senior Software Engineer', analysisWithTitle(''), profile()), 'Senior Software Engineer');
});

// ---------------------------------------------------------------- placement

test('placement is measured on what is rendered, not on the model answer', () => {
  const content = {
    summary: 'Engineer who ran Kubernetes for the payments path.',
    experience: [{ description: 'Owned the platform.', achievements: ['Operated PostgreSQL at scale.'] }],
    // Neither of these is scanned with the resume, so neither may count.
    coverLetter: 'I love Kafka and Datadog.',
    hardSkills: ['Kafka', 'Datadog'],
  };

  const prose = renderedProse(content);
  assert.ok(prose.includes('Kubernetes'));
  assert.equal(prose.includes('Kafka'), false, 'the cover letter must not count towards coverage');
  assert.equal(prose.includes('Datadog'), false, 'the skills block must not count towards coverage');

  const report = measurePlacement(prose, ['Kubernetes', 'PostgreSQL', 'Kafka', 'Datadog']);
  assert.equal(report.total, 4);
  assert.equal(report.placed, 2);
  assert.equal(report.ratio, 0.5);
  assert.deepEqual(report.missing.sort(), ['Datadog', 'Kafka']);
});

test('a term is matched as a term, not as a run of letters', () => {
  assert.equal(containsTerm('We use Go for services', 'Go'), true);
  assert.equal(containsTerm('We googled it', 'Go'), false, '"Go" must not match inside "googled"');
  assert.equal(containsTerm('attention to detail', 'AI'), false, '"AI" must not match inside "detail"');

  // A model that writes "full stack" for "full-stack" has placed the keyword.
  assert.equal(containsTerm('full stack engineering work', 'full-stack engineering'), true);
  assert.equal(containsTerm('event-driven services', 'event driven'), true);
});

test('an empty checklist is full coverage, not a division by zero', () => {
  const report = measurePlacement('anything', []);
  assert.equal(report.ratio, 1);
  assert.equal(report.total, 0);
  assert.deepEqual(report.missing, []);
});

test('the floor matches the prompt, and a bad value falls back', () => {
  assert.equal(placementFloor({}), 0.9);
  assert.equal(placementFloor({ RESUME_KEYWORD_FLOOR: '0.75' }), 0.75);
  assert.equal(placementFloor({ RESUME_KEYWORD_FLOOR: '2' }), 0.9);
  assert.equal(placementFloor({ RESUME_KEYWORD_FLOOR: 'most' }), 0.9);
});
