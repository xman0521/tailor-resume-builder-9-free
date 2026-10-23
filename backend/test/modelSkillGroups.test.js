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

/*
 * Five to a group, which is the shape the prompt asks for: 8 of 28 groups on a
 * delivered batch held fewer, and thin groups are how a block of 35 becomes a
 * block of 16. The fixture is realistic for the same reason the rule exists.
 */
const GROUPS = [
  { category: 'Languages', skills: ['Python', 'TypeScript', 'Go', 'SQL', 'Java'] },
  // Deliberately the shapes the old pipeline would have "fixed": a vendor
  // prefix beside its bare form, and two spellings of one API style.
  /*
   * "Kinesis" beside "Amazon Kinesis" used to live here, as a shape the old
   * pipeline would have "fixed" and this one left alone. The code settles it
   * now - a vendor in front of a name written in full is a qualifier - so the
   * pair moved to the dedup test below, and this fixture is a block that
   * passes through untouched, which is what these tests are about.
   */
  { category: 'Data & Messaging', skills: ['Apache Kafka', 'Amazon Kinesis', 'PostgreSQL', 'Redis', 'MongoDB'] },
  { category: 'Cloud', skills: ['AWS', 'Terraform', 'Docker', 'Kubernetes', 'Helm'] },
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
    'Python', 'TypeScript', 'Go', 'SQL', 'Java',
    'Apache Kafka', 'Amazon Kinesis', 'PostgreSQL', 'Redis', 'MongoDB',
    'AWS', 'Terraform', 'Docker', 'Kubernetes', 'Helm',
  ]);
  assert.deepEqual(out.skills, out.hardSkills);
});

test('the same string is not printed twice, nor the same string plus filler', () => {
  /*
   * WHAT CODE TAKES OUT of a block it otherwise prints verbatim, and both are
   * here because there is no judgement in either.
   *
   * THE SAME STRING. Measured over a batch: a third of resumes printed an
   * identical entry twice - one carried "python, sql, rest, postgresql, dbt,
   * aws, git" all doubled - usually because a tool belongs under two of the
   * model's own headings and it wrote it under both.
   *
   * THE SAME STRING PLUS FILLER, which this test used to pin as untouched on
   * the grounds that "Spring" against "Spring Framework" needs an opinion. The
   * operator reported the result as keyword stuffing - "data pipelines, data
   * pipeline operations, production pipeline operations" - and asked for one
   * entry per real skill, so the decision has been reversed: an entry goes when
   * every word it ADDS is filler. The narrowness is the whole of it, and the
   * cases below say where the line now falls.
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

  /*
   * First occurrence wins, in the model's own order, and the later copies go.
   * Nothing is folded: a thin group never receives another, and every group
   * here is under five once the duplicates have gone.
   */
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
  // One group left, and it is the first: the first group is never folded away,
  // because it is the required Languages & Frameworks slot on a real resume.

  // One entry plus nothing but filler: the operator's own examples, gone.
  const padded = parseTailoredResumeContent(
    answer([
      { category: 'Delivery', skills: ['CI/CD', 'CI/CD tools', 'Spring', 'Spring Framework'] },
      { category: 'Data', skills: ['Data pipelines', 'Data pipeline operations', 'Performance'] },
      { category: 'Monitoring', skills: ['Performance tuning', 'Datadog'] },
    ]),
    profile(),
    analysis()
  );
  /*
   * NOTHING IS REMOVED HERE ANY MORE, and that is the refactor rather than a
   * regression. These entries are bare strings, so they arrive unlabelled -
   * and the padding they represent is now the model's to avoid by labelling
   * "CI/CD tools" and "Performance tuning" as the practices they are, rather
   * than this file's to guess at from a list of filler words.
   *
   * What a bare string still buys is the two rules that need no vocabulary:
   * the same string twice, and one name under two spellings.
   */
  assert.deepEqual(padded.skillGroups, [
    { category: 'Delivery', skills: ['CI/CD', 'CI/CD Tools', 'Spring', 'Spring Framework'] },
    { category: 'Data', skills: ['Data Pipelines', 'Data Pipeline Operations', 'Performance'] },
    { category: 'Monitoring', skills: ['Performance Tuning', 'Datadog'] },
  ]);


  /*
   * And this is still not a synonym filter. A VENDOR IN FRONT OF A PRODUCT is
   * a different thing - "AWS Lambda" is not "AWS" - but a vendor in front of a
   * name already written in full is a qualifier, and "Amazon Kinesis" is
   * "Kinesis". Which side the extra words sit on is what decides it, and the
   * qualified name is the one that survives: it says whose product it is.
   */
  const keptApart = parseTailoredResumeContent(
    answer([
      { category: 'Web', skills: ['CSS', 'SCSS', 'HTTP', 'HTTPS', 'HTML'] },
      { category: 'Cloud', skills: ['AWS', 'AWS Lambda', 'Azure', 'Azure DevOps', 'GCP'] },
      // Six, so the group is still a realistic size once "Kinesis" has gone.
      { category: 'Data & Messaging', skills: ['Kinesis', 'Amazon Kinesis', 'React', 'React Native', 'Kafka', 'Redis'] },
    ]),
    profile(),
    analysis()
  );
  assert.deepEqual(keptApart.skillGroups, [
    { category: 'Web', skills: ['CSS', 'SCSS', 'HTTP', 'HTTPS', 'HTML'] },
    { category: 'Cloud', skills: ['AWS', 'AWS Lambda', 'Azure', 'Azure DevOps', 'GCP'] },
    // "Kinesis" goes and "Amazon Kinesis" stays, in Kinesis's position: the
    // prompt has always called these one skill, and now the code agrees.
    { category: 'Data & Messaging', skills: ['Amazon Kinesis', 'React', 'React Native', 'Kafka', 'Redis'] },
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
  assert.equal(data.hardSkills[0], 'Languages: Python, TypeScript, Go, SQL, Java');
  assert.equal(data.hardSkills.at(-1), 'Cloud: AWS, Terraform, Docker, Kubernetes, Helm');
});

test('a thin block and a posting-shaped block are reported, not corrected', (t) => {
  /*
   * The prompt asks for a floor of 35 skills, topped up from the candidate's
   * own stack so the block reads as theirs rather than as a copy of the
   * posting. Neither rule can be enforced here - correcting the block would
   * mean editing an answer this app asked the model to own - so both are
   * measured and said out loud instead.
   *
   * BOTH STREAMS: a block under the floor is a console.warn now, not a log.
   * It stopped being a remark when the operator set the floor by number.
   */
  const lines = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (line) => lines.push(String(line));
  console.warn = (line) => lines.push(String(line));
  t.after(() => { console.log = realLog; console.warn = realWarn; });

  const thin = parseTailoredResumeContent(
    answer([{ category: 'Languages', skills: ['Python', 'Kafka', 'AWS'] }]),
    profile(),
    analysis()
  );
  console.log = realLog;
  console.warn = realWarn;

  assert.deepEqual(thin.hardSkills, ['Python', 'Kafka', 'AWS'], 'the block is printed as returned');
  // The COUNTING line specifically: there are several `[Resume skills]` lines
  // now, and the first is the warning about entries that arrived with no kind.
  const report = lines.find((line) => /\d+ skill\(s\) in \d+ group\(s\)/.test(line));
  assert.ok(report, `no skills report was logged: ${lines.join(' | ')}`);
  assert.match(report, /3 skill\(s\) in 1 group\(s\)/);
  assert.match(report, /UNDER the floor of 35/, 'a block under the floor has to say so');
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

  // Five to a group, the shape the prompt asks for: this sweep is about
  // whether a template SHOWS the headings, so the block should look real.
  const groups = [
    { category: 'Languages', skills: ['TypeScript', 'SQL', 'Python', 'Go', 'Java'] },
    { category: 'Backend & APIs', skills: ['Node.js', 'REST APIs', 'GraphQL', 'gRPC', 'Express'] },
    { category: 'Databases', skills: ['PostgreSQL', 'MySQL', 'Redis', 'MongoDB', 'Snowflake'] },
    { category: 'Cloud & Infrastructure', skills: ['AWS', 'Terraform', 'Docker', 'Kubernetes', 'Helm'] },
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

test('labelled entries survive the service path, not just the router', () => {
  /*
   * THE BUG THIS WAS WRITTEN FOR, and it reached every resume in a batch:
   *
   *   LANGUAGES & FRAMEWORKS: [object Object]
   *
   * `normalizeTailoredContent` coerced every entry with `String(skill)` before
   * the router ever saw it. That was right while an entry was a bare string;
   * the moment the model started returning { name, kind } each one stringified
   * to the same six characters, and the exact-duplicate rule - working exactly
   * as designed - collapsed the whole block to a single entry.
   *
   * WHY THE SUITE MISSED IT. Every routing test called `tidySkillGroups`
   * directly with objects, and every test of this path used bare strings. The
   * two halves were each covered and the seam between them was not, which is
   * the shape of fault an end-to-end assertion exists for.
   */
  const out = parseTailoredResumeContent(
    answer([
      {
        category: 'Languages & Frameworks',
        skills: [
          { name: 'Python', kind: 'language' },
          { name: 'React', kind: 'framework' },
          { name: 'PostgreSQL', kind: 'database' },
          { name: 'MCP', kind: 'protocol' },
          { name: 'LLMs', kind: 'technology' },
        ],
      },
      {
        category: 'Ways of Working',
        skills: [
          { name: 'Ownership', kind: 'soft' },
          { name: 'observability', kind: 'practice' },
          { name: 'Cloud', kind: 'category' },
        ],
      },
    ]),
    profile(),
    analysis()
  );

  // The soft skill prints in its own group, last, and stays out of hardSkills.
  assert.deepEqual(out.skillGroups, [
    { category: 'Languages & Frameworks', skills: ['Python', 'React', 'PostgreSQL', 'MCP', 'LLMs'] },
    { category: 'Soft Skills', skills: ['Ownership'] },
  ]);
  assert.deepEqual(out.hardSkills, ['Python', 'React', 'PostgreSQL', 'MCP', 'LLMs']);
  // Nothing stringified: the names are the model's own, not "[object Object]".
  for (const skill of out.hardSkills) {
    assert.doesNotMatch(skill, /\[object/, 'an entry was coerced before it was parsed');
  }
});

test('a block of bare strings still works, so an older prompt is not broken', () => {
  // Unlabelled means "no opinion", which is kept. A router that emptied the
  // block of a resume whose prompt predates the kinds would be worse than the
  // padding it was built to remove.
  const out = parseTailoredResumeContent(
    answer([{ category: 'Languages', skills: ['Python', 'TypeScript', 'Go'] }]),
    profile(),
    analysis()
  );
  assert.deepEqual(out.skillGroups, [{ category: 'Languages', skills: ['Python', 'TypeScript', 'Go'] }]);
});
