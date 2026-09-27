const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { launchBrowser } = require('../dist/config/browser');
const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
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

// ----------------------------------------------------------------- headline

test('the headline is the candidate\'s own title, and the posting is named elsewhere', () => {
  /*
   * THE FIFTH SHAPE OF THIS LINE, and worth reading as a whole because each
   * change was an answer to the last. It was rebuilt into a "Senior <domain>
   * Engineer" shape, which renamed the candidate. Then their own title with the
   * posting's discipline in parentheses, which the operator rejected. Then their
   * own title alone, which scored nothing on a check a scanner runs directly:
   * across 495 delivered resumes the posting's title appeared verbatim in 2% of
   * them. Then the posting's title, which won that check and read as somebody
   * else's job.
   *
   * It is the candidate's own title, and the posting's role is named ONCE in the
   * summary in the model's own words - "AI data engineering" for a posting
   * called "Data & AI Engineer - AWS, Java & Python". The claim is smaller, the
   * sentence is true, and the words are still on the page.
   *
   * Reaching for `parseTailoredResumeContent` rather than a helper, because the
   * helper was right every previous time and the pipeline threw its answer away.
   */
  const { parseTailoredResumeContent, buildTailorResumePromptValues } = require('../dist/services/resumeService');
  const p = profile({ title: 'Software Engineer' });
  const printed = (analysis) => parseTailoredResumeContent(
    JSON.stringify({ title: 'Engineer', summary: 'S.', experience: p.experience, strengths: [], coverLetter: 'x' }),
    p,
    analysis
  ).title;

  // Whatever the posting is called, the headline is the profile's own line.
  for (const posting of [
    'Mulesoft Integration Engineer',
    'Staff Data Engineer US Remote',
    'Sr DevOps Engineer - Remote (US) - Req #12345',
    'Data & AI Engineer - AWS, Java & Python',
    '',
  ]) {
    assert.equal(printed(analysisWithTitle(posting)), 'Software Engineer', `posting: ${posting}`);
  }
  assert.equal(printed(undefined), 'Software Engineer');

  // The model's own answer is never the headline either, and the work history
  // is still the candidate's.
  const out = parseTailoredResumeContent(
    JSON.stringify({ title: 'Engineer', summary: 'S.', experience: p.experience, strengths: [], coverLetter: 'x' }),
    p,
    analysisWithTitle('Staff Data Engineer')
  );
  assert.equal(out.title, 'Software Engineer');
  assert.equal(out.experience[0].title, p.experience[0].title);
  assert.equal(out.experience[0].company, p.experience[0].company);

  // And the role the summary is told to name: the head of the posting's title,
  // in words a sentence can carry.
  const values = (posting) => buildTailorResumePromptValues(p, analysisWithTitle(posting)).targetRoleTitle;
  assert.equal(values('Data & AI Engineer - AWS, Java & Python'), 'Data & AI Engineer');
  assert.equal(values('Software Engineer, Java/J2EE AML Applications'), 'Software Engineer');
  assert.equal(values('Staff Data Engineer US Remote'), 'Staff Data Engineer');
  assert.equal(values(''), '');
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
  // The prompt says every checklist term, so this says 1. It said 0.9, and 90%
  // of forty terms is four missing from every resume - chosen by the model, and
  // the ones it dropped were the awkward, specific, valuable ones.
  assert.equal(placementFloor({}), 1);
  assert.equal(placementFloor({ RESUME_KEYWORD_FLOOR: '0.75' }), 0.75);
  assert.equal(placementFloor({ RESUME_KEYWORD_FLOOR: '2' }), 1);
  assert.equal(placementFloor({ RESUME_KEYWORD_FLOOR: 'most' }), 1);
});
