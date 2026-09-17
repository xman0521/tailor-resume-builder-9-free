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

test('an unrecognised title falls back to one real word, not to noise', () => {
  // Measured against 493 real postings; these are the shapes that were coming
  // out wrong before the noise list grew.
  assert.deepEqual(titleDisciplines('Senior Fraud Strategist'), ['Fraud']);
  assert.deepEqual(titleDisciplines('IT Engineer, First IT Hire'), ['IT']);

  // A title made only of grades and role nouns names no discipline, and saying
  // so is better than inventing one.
  assert.deepEqual(titleDisciplines('Senior Software Engineer'), []);
  assert.deepEqual(titleDisciplines(''), []);
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
