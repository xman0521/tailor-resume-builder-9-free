const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseTailoredResumeContent,
  parseJobAnalysisContent,
} = require('../dist/services/resumeService');
const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');

/**
 * The Technical Skills block, written by the tailor call and printed as given.
 *
 * WHAT THIS REPLACED. The block used to be chosen by code from a 1,492-row
 * skill library: matched, mapped, collapsed, ordered, padded to a category
 * count and truncated. What the library curated reached every resume - "Echo",
 * "Logs", "Reflection", "Behave", "Amazon Kinesis" printed beside "Kinesis",
 * "REST" beside "REST API" - and each rule added for one of those found the
 * next row with the next gap. The library is out of this path entirely, so
 * these tests are about one thing: nothing changes the model's answer.
 */

const profile = (overrides = {}) => ({
  id: 'p', name: 'Test Person', title: 'Software Engineer',
  profileSettings: { technicalSkillsLayout: 'flat' },
  contact: { phone: '1', email: 'a@b.c', location: 'X' },
  summary: 'Engineer.',
  experience: [{
    title: 'Software Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
    location: 'Remote', description: '', achievements: ['Cut p99 latency from 180ms to 118ms.'], skills: [],
  }],
  strengths: [], skills: ['Python'], education: [], certifications: [], createdAt: '', updatedAt: '',
  ...overrides,
});

const analysis = () => parseJobAnalysisContent(JSON.stringify({
  jobMeta: { title: 'Backend Engineer', seniority: 'Senior', industry: 'SaaS', department: 'Engineering' },
  skills: { technical: ['Python', 'Kafka'], required: ['AWS'], preferred: [], tools: [], soft: [], technologies: [] },
  technologies: [], protocols: [], methodologies: [], architecturePatterns: [],
  responsibilities: [], domainKnowledge: [], softSkills: [],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
}), 'Backend role using Python, Kafka and AWS.');

const GROUPS = [
  { category: 'Languages', skills: ['Python', 'TypeScript', 'Go'] },
  // Deliberately the shapes the old pipeline would have "fixed": a vendor
  // prefix beside its bare form, and two spellings of one API style.
  { category: 'Data & Messaging', skills: ['Apache Kafka', 'Kinesis', 'Amazon Kinesis', 'PostgreSQL'] },
  { category: 'Cloud', skills: ['AWS', 'Terraform'] },
];

const answer = (groups = GROUPS) => JSON.stringify({
  title: 'Engineer',
  summary: 'Engineer of 10 years on backend platforms.',
  experience: [profile().experience[0]],
  strengths: [],
  skillGroups: groups,
  coverLetter: 'x',
});

test('the groups come through exactly as the model returned them', () => {
  const out = parseTailoredResumeContent(answer(), profile(), analysis());

  assert.deepEqual(out.skillGroups, GROUPS);
  // Order, spelling and near-duplicates all survive: this block is the answer,
  // not a suggestion for code to improve on.
  assert.deepEqual(out.hardSkills, [
    'Python', 'TypeScript', 'Go',
    'Apache Kafka', 'Kinesis', 'Amazon Kinesis', 'PostgreSQL',
    'AWS', 'Terraform',
  ]);
  assert.deepEqual(out.skills, out.hardSkills);
});

test('nothing from the skill library is added to the block', () => {
  // The old selection topped a thin block up from the library and padded each
  // heading to a minimum. Three skills stay three skills.
  const out = parseTailoredResumeContent(
    answer([{ category: 'Languages', skills: ['Python', 'Go', 'SQL'] }]),
    profile(),
    analysis()
  );
  assert.deepEqual(out.skillGroups, [{ category: 'Languages', skills: ['Python', 'Go', 'SQL'] }]);
  assert.deepEqual(out.hardSkills, ['Python', 'Go', 'SQL']);
});

test('an empty heading or an empty group is dropped, and nothing else is', () => {
  const out = parseTailoredResumeContent(
    answer([
      { category: '  ', skills: ['Python'] },
      { category: 'Cloud', skills: [] },
      { category: '  Cloud & Infrastructure  ', skills: ['AWS', '  ', 'Terraform'] },
    ]),
    profile(),
    analysis()
  );
  assert.deepEqual(out.skillGroups, [{ category: 'Cloud & Infrastructure', skills: ['AWS', 'Terraform'] }]);
});

test('an answer with no groups falls back rather than printing nothing', () => {
  const out = parseTailoredResumeContent(
    JSON.stringify({
      title: 'Engineer', summary: 'S.', experience: [profile().experience[0]],
      strengths: [], hardSkills: ['Python', 'Kafka'], coverLetter: 'x',
    }),
    profile(),
    analysis()
  );
  assert.deepEqual(out.skillGroups, []);
  assert.deepEqual(out.hardSkills, ['Python', 'Kafka']);
});

test('the renderer prints the model grouping even when the profile asks for a flat list', () => {
  /*
   * The layout setting decided the block's SHAPE while code decided its
   * contents. The contents now arrive already grouped, and re-flattening them
   * would throw away the headings the operator asked the model to write.
   */
  const tailored = parseTailoredResumeContent(answer(), profile(), analysis());
  const data = prepareResumeRenderData(profile(), tailored);

  assert.deepEqual(
    data.skillCategories.map((group) => group.category),
    ['Languages', 'Data & Messaging', 'Cloud']
  );
  // Templates that predate categories read `hardSkills`, one line per heading.
  assert.equal(data.hardSkills[0], 'Languages: Python, TypeScript, Go');
  assert.equal(data.hardSkills.at(-1), 'Cloud: AWS, Terraform');
});

test('a thin block and a posting-shaped block are reported, not corrected', (t) => {
  /*
   * The prompt asks for about 18 skills, topped up from the candidate's own
   * stack so the block reads as theirs rather than as a copy of the posting.
   * Neither rule can be enforced here - correcting the block would mean
   * editing an answer this app asked the model to own - so both are measured
   * and said out loud instead.
   */
  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(String(line));
  t.after(() => { console.log = realLog; });

  const thin = parseTailoredResumeContent(
    answer([{ category: 'Languages', skills: ['Python', 'Kafka', 'AWS'] }]),
    profile(),
    analysis()
  );
  console.log = realLog;

  assert.deepEqual(thin.hardSkills, ['Python', 'Kafka', 'AWS'], 'the block is printed as returned');
  const report = lines.find((line) => line.includes('[Resume skills]'));
  assert.ok(report, `no skills report was logged: ${lines.join(' | ')}`);
  assert.match(report, /3 skill\(s\) in 1 group\(s\)/);
  assert.match(report, /thin/, 'a block under 18 has to say so');
  // Every one of those three is a term this posting named, which is the shape
  // a reader recognises as written for them.
  assert.match(report, /100% are terms this posting named/);
});

test('every installed template renders the grouping, whatever its markup', async () => {
  /*
   * The swap used to be pattern-matched against the markup shapes that had
   * been seen - a box per skill, a chip per skill, a span with a dot between.
   * Eleven of the installed templates wrote a shape none of the rules knew,
   * `{{#each hardSkills}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}`, and
   * turned the grouped lines into one sentence on the page: "Languages:
   * TypeScript, JavaScript, Backend & APIs: Node.js, ...". A twelfth pattern
   * would have left a thirteenth shape, so the swap finds the BLOCK instead.
   */
  const fs = require('node:fs');
  const path = require('node:path');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');

  const groups = [
    { category: 'Languages', skills: ['TypeScript', 'SQL'] },
    { category: 'Backend & APIs', skills: ['Node.js', 'REST APIs'] },
    { category: 'Databases', skills: ['PostgreSQL'] },
    { category: 'Cloud & Infrastructure', skills: ['AWS'] },
  ];
  const tailored = {
    ...parseTailoredResumeContent(answer(groups), profile(), analysis()),
  };

  const dir = path.join(__dirname, '..', 'static', 'templates');
  const flat = [];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json'))) {
    let template;
    try { template = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
    const html = await generatePreviewHTML(profile(), template, tailored);

    // The headings have to be elements of their own. Rendered flat they end up
    // inside one comma list, which is the failure this pins.
    const separated = groups.every((group) => new RegExp(`>[^<]*${group.category.replace('&', '&amp;')}`).test(html));
    const runOn = /Languages:\s*TypeScript[^<]*Backend/.test(html.replace(/\s+/g, ' '));
    if (!separated || runOn) flat.push(file);
  }

  assert.deepEqual(flat, [], `these templates do not show the grouping: ${flat.join(', ')}`);
});
