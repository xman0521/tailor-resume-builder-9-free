const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseJobAnalysisContent,
  parseTailoredResumeContent,
  buildTailorResumePromptValues,
} = require('../dist/services/resumeService');
const { plainLanguage } = require('../dist/services/utils/plainLanguage');

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

test('the prompt says where they go, now that there is no section for them', () => {
  const prompt = require('../static/prompts/tailor-resume.json').content;
  assert.match(prompt, /SOFT SKILLS ARE PROSE, AND THEY ARE NOT OPTIONAL/);
  /*
   * The rules that decide whether a scanner finds them at all. "At least two in
   * the summary" became "three or four" when 15 scanned resumes came back with
   * soft skills as the weak band in every one, then "at most one" when the
   * summary was capped at 65 words, then "one or two" at 80, and now "one at
   * most, usually none" at 50. The count has changed four times; the
   * requirement that the prompt NAME where they go has not.
   *
   * AND THE BULLETS ARE NOW THE ONLY PLACE. The skills block used to end with a
   * group of soft skills, which satisfied a scanner whatever the sentences did.
   * The operator removed it - they are unprovable adjectives in a list - so a
   * soft skill that is not written into a bullet is not on the resume at all.
   */
  assert.match(prompt, /WRITE THE TERM ITSELF/);
  assert.match(prompt, /EVERY ONE OF THEM, AND COUNT THEM BEFORE YOU RETURN/);
  assert.match(prompt, /SPREAD THEM\. The summary is 50 words and holds ONE at most/);
  assert.match(prompt, /the rest go through the bullets/);
  assert.match(prompt, /there is no\s+soft-skill group in the skills block/);
});

test('a soft skill that is also a banned word survives when the posting asked for it', () => {
  // "strategic" is deleted as hype everywhere else. Asked for as a keyword, it
  // is the posting's word and stays - otherwise the app would ask for a term
  // and then remove it, which is the bug this rule was written for.
  assert.equal(
    plainLanguage('Brought strategic thinking to the roadmap.', ['strategic thinking']),
    'Brought strategic thinking to the roadmap.'
  );
  assert.equal(
    plainLanguage('Brought strategic thinking to the roadmap.'),
    'Brought thinking to the roadmap.'
  );
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

test('every installed template prints a Soft Skills section', async () => {
  /*
   * ASKED FOR: "Make soft skill section under skill section." Of the ten
   * templates profiles are actually rendered with, EIGHT had no soft-skills
   * markup of any kind, so the section is built at render time from the
   * template's own skills section - its wrapper, its heading element, its
   * classes - rather than edited into each file one at a time.
   */
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  const tailored = {
    title: 'Engineer', summary: 's', experience: [], strengths: [], skills: [],
    hardSkills: [], softSkills: SECTION_SOFT,
    skillGroups: [{ category: 'Languages', skills: ['Python', 'Go'] }],
    coverLetter: 'x',
  };

  const missing = [];
  for (const file of fsNode.readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.json'))) {
    const html = await generatePreviewHTML(probeProfile(), readTemplate(file), tailored);
    // The heading AND a term under it: a heading with nothing beneath it is
    // the failure the guard exists for.
    if (!/Soft Skills/i.test(html) || !html.includes('Stakeholder Management')) {
      missing.push(file);
    }
  }
  assert.deepEqual(missing, [], `no Soft Skills section in: ${missing.join(', ')}`);
});

test('the injected section disappears when there are no soft skills', async () => {
  // An empty heading over nothing is worse than no section, so the injected
  // markup carries its own guard.
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  const html = await generatePreviewHTML(probeProfile(), readTemplate('one-column-banded-serif.json'), {
    title: 'Engineer', summary: 's', experience: [], strengths: [], skills: [],
    hardSkills: [], softSkills: [],
    skillGroups: [{ category: 'Languages', skills: ['Python'] }], coverLetter: 'x',
  });

  assert.equal(/Soft Skills/i.test(html), false, 'an empty section should not print');
  assert.equal(html.includes('{{'), false, 'and no Handlebars left behind');
});

test('a template that already prints soft skills is not given a second section', async () => {
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  const template = readTemplate('template_Tommy_Margolis_fixed.json');
  assert.ok(/section-soft-skills/.test(template.htmlContent), 'this template has its own');

  const html = await generatePreviewHTML(probeProfile(), template, {
    title: 'Engineer', summary: 's', experience: [], strengths: [], skills: [],
    hardSkills: [], softSkills: ['Communication', 'Ownership'],
    skillGroups: [{ category: 'Languages', skills: ['Python'] }], coverLetter: 'x',
  });

  assert.equal(
    (html.match(/Soft Skills/gi) || []).length, 1,
    'the template own section must not be doubled'
  );
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

test('one soft skill under two spellings is one entry', () => {
  /*
   * MEASURED on the first run with the section back: a ten-term list held
   * "Collaboration" beside "Collaboration skills", and "Problem Solving"
   * beside "Strong problem-solving skills" - two of ten slots saying one thing
   * twice, in a section only eight to ten long. The three sources feeding it
   * spell terms differently, and `condenseSoftSkill` rewrites only the entries
   * too LONG to print, which these are not.
   */
  const out = parseWith(
    analysisWithSoft(
      [...SECTION_SOFT, 'Collaboration skills', 'Strong problem-solving skills', 'Excellent communication'],
      SECTION_SOFT
    ),
    SECTION_SOFT
  );

  const key = (s) => s.toLowerCase().replace(/[-_/]+/g, ' ')
    .replace(/^(?:strong|excellent)\s+/, '').replace(/\s+skills?$/, '');
  const keys = out.softSkills.map(key);
  assert.equal(new Set(keys).size, keys.length, `two spellings of one skill: ${out.softSkills.join(', ')}`);
  // The plainest spelling is the one kept.
  assert.ok(out.softSkills.includes('Collaboration'), out.softSkills.join(', '));
  assert.equal(out.softSkills.includes('Collaboration skills'), false);
});

test('the posting culture language never reaches the section', () => {
  /*
   * `validateSoftSkill` passes "accuracy obsession" and "valued all voices" -
   * they are soft-skill shaped, and the analyser files them under skills.soft.
   * The first run with the section back printed all three. A row of slogans is
   * what the operator objected to when the old group was removed, and bringing
   * the section back is not a reason to bring them with it.
   */
  const out = parseWith(
    analysisWithSoft(
      ['Ownership', 'Collaboration', 'valued all voices', 'accuracy obsession',
        'relentless bias toward action'],
      ['Ownership', 'Collaboration', 'accuracy obsession']
    ),
    ['Ownership', 'accuracy obsession']
  );

  /*
   * THE SLOGAN, not the word inside it. "Accuracy" on its own is an ordinary
   * soft skill and the library carries a row for it, so it may well appear -
   * what may not is the posting's phrase, which is what reads as recruiting
   * copy pasted into somebody's history.
   */
  for (const slogan of ['accuracy obsession', 'valued all voices', 'relentless bias toward action']) {
    assert.equal(
      out.softSkills.some((s) => s.toLowerCase() === slogan),
      false,
      `"${slogan}" reached the section: ${out.softSkills.join(', ')}`
    );
  }
  // Nothing multi-word that reads as a slogan rather than a skill.
  for (const term of out.softSkills) {
    assert.ok(
      term.split(/\s+/).length <= 3,
      `"${term}" is a phrase, not a soft skill: ${out.softSkills.join(', ')}`
    );
  }
  assert.ok(out.softSkills.includes('Ownership'));
});

test('the section is never padded to reach the floor', () => {
  // Under the floor is a warning, not a fabrication: the terms come from the
  // posting and the library, and inventing two more to reach eight would put
  // words on the page that nothing asked for.
  const out = parseWith(analysisWithSoft(['Ownership', 'Communication'], ['Ownership']), ['Ownership']);
  assert.ok(out.softSkills.length <= 10);
  for (const term of out.softSkills) {
    assert.ok(typeof term === 'string' && term.trim().length > 0);
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * The section is built from the posting, not from a list kept in code
 * ──────────────────────────────────────────────────────────────────────────── */

const POSTING = ['Curiosity', 'Written communication', 'Customer empathy', 'Pragmatism',
  'Technical mentorship', 'Async communication', 'Stakeholder management', 'Onboarding'];

const postingAnalysis = (soft) => ({
  jobMeta: { title: 'Applied AI Engineer', seniority: 'Senior', industry: 'SaaS', department: 'Eng' },
  skills: { technical: ['Python'], required: [], preferred: [], tools: [], technologies: [], soft },
  technologies: [], protocols: [], methodologies: [], architecturePatterns: [],
  responsibilities: ['collaboration across teams', 'reliable delivery'],
  domainKnowledge: [], softSkills: soft,
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
});

const runWith = (soft, modelSoft) => {
  const { parseTailoredResumeContent } = require('../dist/services/resumeService');
  return parseTailoredResumeContent(JSON.stringify({
    title: 'E', summary: 's',
    experience: [{
      title: 'Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
      location: 'R', description: '', achievements: ['Built things with Python.'],
    }],
    skillGroups: [{ category: 'Languages', skills: [{ name: 'Python', kind: 'language' }] }],
    softSkills: modelSoft, coverLetter: 'x',
  }), probeProfile(), postingAnalysis(soft));
};

test('the posting own soft skills outrank the canned ones', () => {
  /*
   * MEASURED across a delivered batch of five: a Data Developer role, an AI
   * Lead role and an Applied AI role all came back with near-identical
   * sections - "Supportive, Leadership, Reliability, Communication,
   * Collaboration skills, Cross-functional team" - because nine canned
   * canonicals were merged FIRST and the list is capped at ten.
   *
   * A scanner matches strings: "Cross-functional team" against a posting that
   * said "stakeholder management" scores nothing, and reads as a page nobody
   * wrote for this job.
   */
  const out = runWith(POSTING, POSTING);
  const carried = POSTING.filter((t) => out.softSkills.some((s) => s.toLowerCase() === t.toLowerCase()));

  assert.ok(
    carried.length >= 6,
    `only ${carried.length} of the posting's ${POSTING.length} terms printed: ${out.softSkills.join(', ')}`
  );
  // The canned canonicals are filler, so they may appear - but not instead of
  // the posting, and never as the majority of the section.
  const canned = out.softSkills.filter((s) => /^(Reliability|Supportive|Resilient|Cross-functional team|Eager to learn)$/i.test(s));
  assert.ok(
    canned.length < out.softSkills.length / 2,
    `the section is mostly canned vocabulary: ${out.softSkills.join(', ')}`
  );
});

test('a posting term is never rewritten into a different string', () => {
  /*
   * "Technical mentorship" used to come back as "Mentorship". The prompt
   * spends two sections insisting the posting's spelling is a quotation, and a
   * scanner looking for the posting's phrase does not find the shorter one.
   */
  const out = runWith(POSTING, POSTING);
  assert.ok(
    out.softSkills.includes('Technical mentorship'),
    `the posting's own spelling was not kept: ${out.softSkills.join(', ')}`
  );
  assert.equal(
    out.softSkills.includes('Mentorship'), false,
    `the rewritten form printed too: ${out.softSkills.join(', ')}`
  );
});

test('the generic inside the specific is not printed beside it', () => {
  // "Empathy" beside "Customer empathy", "Communication" beside "Written
  // communication": in a section eight to ten long that is a slot spent on a
  // weaker version of the line above.
  const out = runWith(POSTING, POSTING);

  assert.ok(out.softSkills.includes('Customer empathy'), out.softSkills.join(', '));
  assert.equal(out.softSkills.includes('Empathy'), false, out.softSkills.join(', '));
  assert.ok(out.softSkills.includes('Written communication'), out.softSkills.join(', '));
  assert.equal(out.softSkills.includes('Communication'), false, out.softSkills.join(', '));
});

test('the posting relevance order survives to the page', () => {
  /*
   * The prompt asks the model for its soft skills "most relevant first", and
   * a sort by signal-word count used to throw that away one step before the
   * ten-entry cap - so the terms that fell out were whichever the sort ranked
   * last, not whichever mattered least.
   */
  const ordered = ['Stakeholder management', 'Curiosity', 'Pragmatism', 'Async communication',
    'Technical mentorship', 'Customer empathy', 'Written communication', 'Onboarding'];
  const out = runWith(ordered, ordered);

  const printedOrder = ordered.filter((t) => out.softSkills.includes(t));
  const indexes = printedOrder.map((t) => out.softSkills.indexOf(t));
  const sorted = [...indexes].sort((a, b) => a - b);
  assert.deepEqual(indexes, sorted, `the posting's order was reshuffled: ${out.softSkills.join(', ')}`);
  assert.equal(out.softSkills[0], 'Stakeholder management', out.softSkills.join(', '));
});

test('a posting that names almost nothing still fills out from the fallbacks', () => {
  // The canonicals and the library are what a thin posting has left, so they
  // are kept as filler - demoted, not deleted.
  const out = runWith(['Communication'], ['Communication']);
  assert.ok(out.softSkills.length >= 1, 'something should print');
  assert.ok(out.softSkills.some((s) => /communication/i.test(s)), out.softSkills.join(', '));
});
