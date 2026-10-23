const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseJobAnalysisContent,
  parseTailoredResumeContent,
  buildTailorResumePromptValues,
} = require('../dist/services/resumeService');

/**
 * The posting's soft skills, now that there is no section to put them in.
 *
 * The Soft Skills block used to satisfy a scanner whatever the prose did, so
 * removing it cost keyword matches. Nothing was dropped from the checklist -
 * the terms were always on it and always measured - but the prompt said
 * nothing about placing them, and what a scanner finds is what the sentences
 * carry. These pin the parts that are code's to keep: the terms reach the
 * prompt, they survive the vocabulary rewrite, and a run that loses them says
 * so.
 */

const SOFT = ['communication', 'ownership', 'collaboration', 'mentoring'];

const analysisFor = (soft = SOFT) => parseJobAnalysisContent(JSON.stringify({
  jobMeta: { title: 'Backend Engineer', seniority: 'Senior', industry: 'SaaS', department: 'Engineering' },
  skills: { technical: ['Python'], required: [], preferred: [], tools: [], soft, technologies: [] },
  technologies: [], protocols: [], methodologies: [], architecturePatterns: [],
  responsibilities: [], domainKnowledge: [], softSkills: soft,
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
}), `Backend role. Strong ${soft.join(', ')}.`);

const profile = () => ({
  id: 'p', name: 'Probe', title: 'Engineer',
  contact: { phone: '1', email: 'a@b.c', location: 'X' },
  summary: 'Engineer.',
  experience: [{
    title: 'Engineer', company: 'Acme', startDate: '01/2021', endDate: 'Present',
    location: 'Remote', description: '', achievements: [], skills: [],
  }],
  strengths: [], skills: [], education: [], certifications: [], createdAt: '', updatedAt: '',
});

const build = (summary, achievements, analysis = analysisFor()) => parseTailoredResumeContent(
  JSON.stringify({
    title: 'Engineer', summary,
    experience: [{ ...profile().experience[0], achievements }],
    strengths: [], skillGroups: [{ category: 'Languages', skills: ['Python'] }], coverLetter: 'x',
  }),
  profile(),
  analysis
);

test('every soft skill the posting named reaches the prompt', () => {
  const checklist = JSON.parse(buildTailorResumePromptValues(profile(), analysisFor()).keywordsJson)
    .map((term) => term.toLowerCase());

  for (const term of SOFT) {
    assert.ok(checklist.includes(term), `"${term}" never reached the prompt: ${checklist.join(', ')}`);
  }
});

test('the prompt says where they go and how they must not be placed', () => {
  const prompt = require('../static/prompts/tailor-resume.json').content;
  assert.match(prompt, /SOFT SKILLS ARE SHOWN, NOT NAMED/);
  /*
   * NAMED once, in the Soft Skills group that ends the skills block and is
   * chosen per posting; SHOWN in the bullets, never bolted onto a sentence.
   */
  assert.match(prompt, /SOFT SKILLS ARE ONE GROUP, THE LAST ONE IN THE SKILLS BLOCK/);
  assert.match(prompt, /THE BANNED SHAPES/);
  assert.match(prompt, /applying X/);
  assert.match(prompt, /demonstrating X/);
  assert.match(prompt, /Practiced X when/);
});

test('a run that places them, and one that loses them, are told apart', (t) => {
  /*
   * BOTH STREAMS. A run that loses its soft skills is now a console.warn, not a
   * console.log: the skills block no longer carries a group of them, so a
   * shortfall in the prose is a shortfall on the resume. Capturing only `log`
   * made this test see the good run and miss the bad one.
   */
  const lines = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (line) => lines.push(String(line));
  console.warn = (line) => lines.push(String(line));
  t.after(() => { console.log = realLog; console.warn = realWarn; });

  build('Engineer of 9 years on payments.', ['Cut p99 latency from 180ms to 118ms.']);
  const lost = lines.find((line) => line.includes('[Resume soft skills]'));

  lines.length = 0;
  build(
    'Engineer of 9 years, where communication across teams shaped the work.',
    [
      'Took ownership of the settlement path and cut repeat incidents from nine a quarter to one.',
      'Ran the schema migration with the data team, where collaboration decided the cutover order.',
      'Mentoring two engineers through their first on-call rotation cut acknowledge time to 4 minutes.',
    ]
  );
  const placed = lines.find((line) => line.includes('[Resume soft skills]'));
  console.log = realLog;
  console.warn = realWarn;

  assert.match(lost ?? '', /0\/4 placed/);
  assert.match(lost ?? '', /Missing: .*communication/);
  assert.match(placed ?? '', /4\/4 placed/);
});

test('the terms are counted where a scanner reads them, not in the cover letter', () => {
  // The letter is a separate document and is not scanned with the resume, so a
  // term that appears only there has not appeared.
  const lines = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (line) => lines.push(String(line));
  console.warn = (line) => lines.push(String(line));
  parseTailoredResumeContent(
    JSON.stringify({
      title: 'Engineer',
      summary: 'Engineer of 9 years on payments.',
      experience: [{ ...profile().experience[0], achievements: ['Cut p99 latency to 118ms.'] }],
      strengths: [],
      skillGroups: [{ category: 'Languages', skills: ['Python'] }],
      coverLetter: 'I bring communication, ownership, collaboration and mentoring to every team.',
    }),
    profile(),
    analysisFor()
  );
  console.log = realLog;

  assert.match(lines.find((line) => line.includes('[Resume soft skills]')) ?? '', /0\/4 placed/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The Soft Skills section, which prints under the technical block
 * ──────────────────────────────────────────────────────────────────────────── */

const fsNode = require('node:fs');
const pathNode = require('node:path');
const TEMPLATE_DIR = pathNode.join(__dirname, '..', 'static', 'templates');

const probeProfile = () => ({
  id: 'p', name: 'Probe', title: 'Engineer', profileSettings: {},
  contact: { email: 'a@b.c' }, summary: 'x', skills: [], strengths: [],
  certifications: [], education: [], createdAt: '', updatedAt: '',
  experience: [{
    title: 'Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
    location: 'R', description: '', achievements: ['Did work.'], skills: [],
  }],
});

const SECTION_SOFT = ['Communication', 'Collaboration', 'Ownership', 'Mentoring',
  'Problem Solving', 'Adaptability', 'Stakeholder Management', 'Documentation'];

const readTemplate = (file) =>
  JSON.parse(fsNode.readFileSync(pathNode.join(TEMPLATE_DIR, file), 'utf8'));

test('no template prints soft skills content when the data is empty', async () => {
  /*
   * The section has been removed: parseTailoredResumeContent returns
   * softSkills: [], and the prompt no longer asks for the field. Pass the same
   * empty array the code sends and confirm no template renders content.
   */
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  const tailored = {
    title: 'Engineer', summary: 's', experience: [], strengths: [], skills: [],
    hardSkills: [], softSkills: [],
    skillGroups: [{ category: 'Languages', skills: ['Python', 'Go'] }],
    coverLetter: 'x',
  };

  const printed = [];
  for (const file of fsNode.readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.json'))) {
    const html = await generatePreviewHTML(probeProfile(), readTemplate(file), tailored);
    // With softSkills: [], no content should appear even if the markup is there.
    if (html.includes('Stakeholder Management') || html.includes('Communication')) {
      printed.push(file);
    }
  }
  assert.deepEqual(printed, [], `Soft skills content printed in: ${printed.join(', ')}`);
});

const parseWith = (analysis, softFromModel) => {
  const { parseTailoredResumeContent } = require('../dist/services/resumeService');
  return parseTailoredResumeContent(JSON.stringify({
    title: 'E', summary: 's',
    experience: [{
      title: 'Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
      location: 'R', description: '', achievements: ['Built things with Python.'],
    }],
    skillGroups: [{ category: 'Languages', skills: [{ name: 'Python', kind: 'language' }] }],
    softSkills: softFromModel, coverLetter: 'x',
  }), probeProfile(), analysis);
};

const analysisWithSoft = (soft, modelSoft) => ({
  jobMeta: { title: 'Senior Engineer', seniority: 'Senior', industry: 'SaaS', department: 'Eng' },
  skills: { technical: [], required: [], preferred: [], tools: [], technologies: [], soft },
  technologies: [], protocols: [], methodologies: [], architecturePatterns: [],
  responsibilities: [], domainKnowledge: [], softSkills: modelSoft,
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
});

test('softSkills is empty regardless of what the posting names', () => {
  // These tests used to pin dedup and slogan filtering for the section. Since
  // the section is removed (softSkills: []), both are moot for the output.
  const out = parseWith(
    analysisWithSoft(
      [...SECTION_SOFT, 'Collaboration skills', 'accuracy obsession'],
      SECTION_SOFT
    ),
    SECTION_SOFT
  );
  assert.deepEqual(out.softSkills, []);
});

test('softSkills is always empty now that the section is removed', () => {
  /*
   * The section has been through three positions: removed, restored at operator
   * request for 8-10, and removed a third time after a reviewer found only 12
   * distinct lists across 60 resumes. The fill logic (softLimited) still runs
   * for the Unconfirmed Skills panel and coverage reports, but parseTailoredResumeContent
   * returns softSkills: [].
   */
  const out = parseWith(analysisWithSoft(['Ownership', 'Communication'], ['Ownership']), ['Ownership']);
  assert.deepEqual(out.softSkills, []);
});
