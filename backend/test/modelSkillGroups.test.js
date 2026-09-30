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

test('the same string is not printed twice, and nothing subtler is touched', () => {
  /*
   * THE ONE THING CODE TAKES OUT of a block it otherwise prints verbatim, and
   * it is here because there is no judgement in it. Measured over a batch: a
   * third of resumes printed an identical entry twice - one carried "python,
   * sql, rest, postgresql, dbt, aws, git" all doubled - usually because a tool
   * belongs under two of the model's own headings and it wrote it under both.
   *
   * What is NOT taken out is anything that needs an opinion: "Spring" beside
   * "Spring Framework", "CI/CD" beside "CI/CD tools", "CSS" beside "SCSS". Which
   * form to keep is a decision about the posting, so it lives in the prompt, and
   * the losing forms go into the prose where a scanner reads them just as well.
   */
  const out = parseTailoredResumeContent(
    answer([
      { category: 'Languages', skills: ['Python', 'SQL', 'python'] },
      { category: 'Cloud', skills: ['AWS', 'Docker', 'Terraform'] },
      { category: 'DevOps', skills: ['Docker', 'Terraform', 'GitHub Actions'] },
    ]),
    profile(),
    analysis()
  );

  // First occurrence wins, in the model's own order, and the later copies go.
  assert.deepEqual(out.skillGroups, [
    { category: 'Languages', skills: ['Python', 'SQL'] },
    { category: 'Cloud', skills: ['AWS', 'Docker', 'Terraform'] },
    { category: 'DevOps', skills: ['GitHub Actions'] },
  ]);
  assert.deepEqual(out.hardSkills, ['Python', 'SQL', 'AWS', 'Docker', 'Terraform', 'GitHub Actions']);

  // A group left empty by the removal is dropped rather than printed headless.
  const emptied = parseTailoredResumeContent(
    answer([
      { category: 'Cloud', skills: ['AWS', 'Terraform'] },
      { category: 'Infrastructure', skills: ['aws', 'TERRAFORM'] },
    ]),
    profile(),
    analysis()
  );
  assert.deepEqual(emptied.skillGroups, [{ category: 'Cloud', skills: ['AWS', 'Terraform'] }]);

  // And the judgement cases survive untouched: this is not a synonym filter.
  const keptApart = parseTailoredResumeContent(
    answer([
      { category: 'Web', skills: ['CSS', 'SCSS', 'HTTP', 'HTTPS'] },
      { category: 'Delivery', skills: ['CI/CD', 'CI/CD tools', 'Spring', 'Spring Framework'] },
    ]),
    profile(),
    analysis()
  );
  assert.deepEqual(keptApart.skillGroups, [
    { category: 'Web', skills: ['CSS', 'SCSS', 'HTTP', 'HTTPS'] },
    { category: 'Delivery', skills: ['CI/CD', 'CI/CD tools', 'Spring', 'Spring Framework'] },
  ]);
});

test('the prompt decides which FORM of a thing the block shows', () => {
  /*
   * The other half, and the reason the code half stays narrow. The analyser is
   * told to emit both forms of every short name - a scanner matches literally,
   * so "LLMs" and "Large Language Models" both have to be on the page - and the
   * block, with a floor of about thirty entries, is the cheapest place to dump
   * them. The prompt now says the block shows one form and the prose carries
   * the rest, which is where they read like something that happened.
   */
  const { getStoredPrompt } = require('../dist/database/promptRepository');
  const fs = require('node:fs');
  const path = require('node:path');
  const running = getStoredPrompt('tailor-resume')?.content
    ?? JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'static', 'prompts', 'tailor-resume.json'), 'utf8')).content;

  assert.match(running, /ONE FORM OF A THING IN THE BLOCK, THE OTHERS IN THE PROSE/);
  assert.match(running, /THE BLOCK GETS ONE/);
  assert.match(running, /THE SENTENCES GET THE OTHERS/);
  // The rule that every other rule here needed before it held.
  assert.match(running, /BEFORE YOU RETURN, READ THE BLOCK AS A LIST OF STRINGS/);
  // And the same tool under two headings, which is what code now removes anyway.
  assert.match(running, /The same skill in two groups/);
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
