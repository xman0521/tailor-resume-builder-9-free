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
  // The two rules that decide whether a scanner finds them at all.
  assert.match(prompt, /WRITE THE TERM ITSELF/);
  assert.match(prompt, /At least two in the summary/);
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
  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(String(line));
  t.after(() => { console.log = realLog; });

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

  assert.match(lost ?? '', /0\/4 placed/);
  assert.match(lost ?? '', /Missing: .*communication/);
  assert.match(placed ?? '', /4\/4 placed/);
});

test('the terms are counted where a scanner reads them, not in the cover letter', () => {
  // The letter is a separate document and is not scanned with the resume, so a
  // term that appears only there has not appeared.
  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(String(line));
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
