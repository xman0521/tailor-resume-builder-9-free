const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { useTempStorage } = require('./helpers');

useTempStorage('resume-quality');

const {
  bulletsNamingATool,
  capSkillBlock,
  dropRestatedSkillsFromGroups,
  findAnachronisms,
  findBrokenBullets,
  findGarbledMetrics,
  isAllowedSoftSkill,
  isConceptEntry,
  isValuesPhrase,
  looksLikeADescription,
  recentRolesWithoutScope,
  restatesSkill,
  roleEndYear,
  rolesWithoutScale,
  skillWords,
  tidySkillGroups,
} = require('../dist/services/utils/resumeQuality');
const {
  buildTailorResumePromptValues,
  parseJobAnalysisContent,
  parseTailoredResumeContent,
} = require('../dist/services/resumeService');

/**
 * The operator's eight resume-quality faults, as far as they can be measured.
 *
 * Seven of them are answered by rules in the tailoring prompt, which is the only
 * place that can change what the model writes - those are pinned at the bottom
 * of this file, against the SHIPPED file, for the reason summaryLength.test.js
 * gives: the saved record in the operator's database wins at runtime and both
 * were edited, but what the saved one says is this machine's own data and not
 * something a test can assert on.
 *
 * Three can also be checked after the answer arrives, and those are the
 * functions above: one of them removes, two only report.
 */

/* ─── 1. One entry per real skill ─────────────────────────────────────────── */

test('an entry that is another plus filler is dropped', () => {
  // The pairs the operator reported, measured at 3.1 per resume over 70 of them.
  for (const [kept, padded] of [
    ['performance', 'performance tuning'],
    ['GitHub Copilot', 'GitHub Copilot app'],
    ['agent runtime', 'agent runtime execution'],
    ['data pipelines', 'data pipeline operations'],
    ['Ownership', 'outcome ownership mindset'],
    ['CI/CD', 'CI/CD tools'],
    ['Spring', 'Spring Framework'],
    ['Python', 'Python scripting'],
    ['Google Cloud', 'Google Cloud Platform'],
    ['Observability', 'observability tooling'],
  ]) {
    assert.equal(restatesSkill(kept, padded), true, `${padded} restates ${kept}`);
    // Not symmetric: the shorter one is never the restatement of the longer.
    assert.equal(restatesSkill(padded, kept), false, `${kept} must not be dropped for ${padded}`);
  }
});

test('a product is not dropped for sharing a prefix with its vendor', () => {
  /*
   * THE REASON THE RULE IS NARROW. Every pair here would die under a plain
   * "one entry's words are inside another's" test, and each is a different
   * thing from its prefix: a resume that lost "AWS Lambda" because it also said
   * "AWS" would be worse off than one with a padded list.
   */
  for (const [vendor, product] of [
    ['AWS', 'AWS Lambda'],
    ['Azure', 'Azure DevOps'],
    ['Azure', 'Azure Pipelines'],
    ['SQL', 'SQL Server'],
    ['Spring', 'Spring Boot'],
    ['React', 'React Native'],
    ['Visual Studio', 'Visual Studio Code'],
    ['Kafka', 'Kafka Streams'],
    ['Google Cloud', 'Google Cloud Storage'],
    ['Java', 'JavaScript'],
  ]) {
    assert.equal(restatesSkill(vendor, product), false, `${product} is not ${vendor} plus filler`);
    assert.equal(restatesSkill(product, vendor), false);
  }
});

test('plurals and word order do not hide the padding', () => {
  // "data pipelines" and "data pipeline" are the same two words, and padding
  // written in a different order is still padding.
  assert.deepEqual(skillWords('Data Pipelines'), ['data', 'pipeline']);
  // Short names keep their letters: stripping an "s" from AWS or JS would be
  // the dedup inventing a different product.
  assert.deepEqual(skillWords('AWS'), ['aws']);
  assert.deepEqual(skillWords('Node.js / React'), ['node.js', 'react']);
  assert.equal(restatesSkill('pipeline monitoring', 'monitoring pipeline practices'), true);
});

test('the block is swept across groups, not one group at a time', () => {
  const { groups, restated } = dropRestatedSkillsFromGroups([
    { category: 'Monitoring', skills: ['Datadog', 'Performance'] },
    { category: 'Databases', skills: ['PostgreSQL', 'Performance tuning', 'AWS'] },
    { category: 'Cloud', skills: ['AWS Lambda', 'Performance management'] },
  ]);

  assert.deepEqual(
    groups.map((group) => group.skills),
    [['Datadog', 'Performance'], ['PostgreSQL', 'AWS'], ['AWS Lambda']]
  );
  // Across groups, not inside one: the pairs an operator sees are usually a
  // group apart, which is also why the prompt bans one thing in two groups.
  assert.deepEqual(
    restated.map((pair) => pair.dropped),
    ['Performance tuning', 'Performance management']
  );
  assert.equal(restated[0].kept, 'Performance');
});

test('the shorter wording survives, in the place of the longer one', () => {
  /*
   * MEASURED, over 198 delivered resumes: the pairs this finds are mostly the
   * posting's own term beside a padded version of it - "CI/CD" against "CI/CD
   * operations", "APIs" against "API development", "Ownership" against
   * "Ownership mindset". A scanner matches strings, and the short form is the
   * one the posting wrote and the one it will match, so keeping whichever came
   * first threw away the better half of five pairs out of seven.
   *
   * The POSITION is kept rather than the wording: the model writes the block
   * most relevant first, so where an entry sits is its judgement, and only the
   * spelling is the application's to settle. It is also what the prompt tells
   * the model to do, and the two have to agree.
   */
  const { groups, restated } = dropRestatedSkillsFromGroups([
    { category: 'Delivery', skills: ['CI/CD operations', 'Jenkins', 'CI/CD'] },
  ]);
  assert.deepEqual(groups[0].skills, ['CI/CD', 'Jenkins']);
  assert.deepEqual(restated, [{ kept: 'CI/CD', dropped: 'CI/CD operations' }]);

  // ...and when the shorter one came first, nothing moves at all.
  const already = dropRestatedSkillsFromGroups([
    { category: 'Delivery', skills: ['CI/CD', 'Jenkins', 'CI/CD operations'] },
  ]);
  assert.deepEqual(already.groups[0].skills, ['CI/CD', 'Jenkins']);
});

test('a block with nothing to remove comes back unchanged', () => {
  const input = [
    { category: 'Languages', skills: ['Python', 'TypeScript', 'Go'] },
    { category: 'Cloud', skills: ['AWS', 'AWS Lambda', 'Terraform'] },
  ];
  const { groups, restated } = dropRestatedSkillsFromGroups(input);
  assert.deepEqual(groups, input);
  assert.deepEqual(restated, []);
});

/* ─── The block is a list of names, not a list of phrases ─────────────────── */

test('a description is removed, and a long proper name is not', () => {
  /*
   * MEASURED over the nine delivered blocks the operator sent: 20% of the 399
   * entries were three words or longer, and almost all of them were sentences
   * about work rather than names of things. Length alone cannot decide it -
   * "Large Language Models" and "Infrastructure as Code" are long and belong -
   * so what decides it is whether the thing is NAMED. A product carries its
   * capitals; a description does not.
   */
  for (const phrase of [
    'Redis-backed caching and rate limiting',
    'security controls implementation',
    'debugging and diff-based validation',
    'AI product engineering roadmap',
    'production issue troubleshooting',
    'requirements gap handling',
    'multimodal AI pipeline development',
    'API gateway patterns',
    'instrumentation and monitoring',
    'modern testing practices',
  ]) {
    assert.equal(looksLikeADescription(phrase), true, `${phrase} describes rather than names`);
  }

  for (const name of [
    'Large Language Models',
    'Infrastructure as Code',
    'Model Context Protocol',
    'Amazon Web Services',
    'Red Hat OpenShift',
    'Azure Data Factory',
    // Two words are never touched: this is how an engineer writes them.
    'unit testing',
    'k-fold cross-validation',
    'data pipelines',
    'time-decay weighting',
    'GitHub Actions',
  ]) {
    assert.equal(looksLikeADescription(name), false, `${name} names a thing`);
  }
});

test('a bare past-tense verb is not a skill', () => {
  // "owned" reached a delivered block. The analyser is asked for past-tense
  // verbs under keywords.actionVerbs - they are what a bullet opens with - and
  // they go onto the same prose checklist as everything else.
  assert.equal(looksLikeADescription('owned'), true);
  assert.equal(looksLikeADescription('Managed'), true);
  assert.equal(looksLikeADescription('distributed'), true);
  // ...and the two words that would be caught by accident.
  assert.equal(looksLikeADescription('Embedded'), false, 'embedded work is a field');
  assert.equal(looksLikeADescription('Red'), false, 'three letters before the "ed"');
});

test('the soft-skill group takes only skills from the fixed list', () => {
  /*
   * REPORTED: "ambiguity tolerance", "early sharing", "decision agility", "high
   * bar for quality", "fast-paced execution", "reversible decision-making",
   * "working closely with design", "trust calibration for AI tools", "default
   * to collaborative action", "opinionated engineering judgments",
   * "taste-driven engineering decisions". Eighty entries across nine delivered
   * resumes - a fifth of every block - from one instruction telling the model
   * to use the soft skills "spelled as the posting spells them".
   *
   * AN ALLOWLIST, because the shapes are endless: a company writes a new one
   * every quarter, and a ban list is always a quarter behind.
   */
  for (const term of [
    'Communication',
    'Communication skills',
    'Collaboration',
    'Cross-functional collaboration',
    'Ownership',
    'Mentoring',
    'Troubleshooting',
    'written communication',
    'Adaptability',
    'accountability',
    'Stakeholder management',
    'Root cause analysis',
  ]) {
    assert.equal(isAllowedSoftSkill(term), true, `${term} is a skill a reader and a scanner both know`);
  }

  for (const slogan of [
    'ambiguity tolerance',
    'early sharing',
    'decision agility',
    'high bar for quality',
    'fast-paced execution',
    'reversible decision-making',
    'working closely with design',
    'trust calibration for AI tools',
    'taste-driven engineering decisions',
    'Clarity focus',
    'Acceptance',
    'Precision',
    'Execution',
    'Analytical',
    'Focus',
    'Innovation',
    'Responsibility',
    'owned',
  ]) {
    assert.equal(isAllowedSoftSkill(slogan), false, `${slogan} is not a skill a person holds`);
  }
});

test('the ceiling is enforced from the longest group, not the end of the block', () => {
  /*
   * The prompt has said "at most 40" for as long as the model has written the
   * block, and six of nine delivered blocks ran from 41 to 59. Nothing counted,
   * so nothing held.
   *
   * FROM THE LONGEST GROUP because each group is written most relevant first,
   * so its last entry is the least relevant one in the most padded group - and
   * because taking from the end of the BLOCK would delete the soft-skill group,
   * which the prompt puts last on purpose.
   */
  const big = (category, n, prefix) => ({
    category,
    skills: Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`),
  });
  const { groups, dropped } = capSkillBlock(
    [big('Languages', 6, 'lang'), big('Cloud', 30, 'cloud'), big('Ways of Working', 6, 'soft')],
    40
  );

  assert.equal(groups.reduce((n, g) => n + g.skills.length, 0), 40);
  assert.deepEqual(dropped, ['cloud30', 'cloud29']);
  assert.equal(groups[2].skills.length, 6, 'the soft-skill group is last and must survive the trim');
  assert.equal(groups[0].skills.length, 6);

  // A block already inside the ceiling is returned untouched.
  const small = [big('Languages', 5, 'lang')];
  assert.deepEqual(capSkillBlock(small, 40).dropped, []);
});

test('the whole tidy runs in the order the removals depend on', () => {
  /*
   * Descriptions and off-vocabulary soft skills go BEFORE the restatement pass,
   * so a phrase cannot survive by being the shorter half of a pair, and the
   * ceiling goes LAST, so it counts what will actually be printed rather than
   * what the model sent.
   */
  const { groups, report } = tidySkillGroups([
    { category: 'Delivery', skills: ['CI/CD', 'CI/CD', 'CI/CD pipeline development', 'security controls implementation'] },
    { category: 'Monitoring', skills: ['Observability', 'Observability implementation', 'Infrastructure', 'Datadog'] },
    { category: 'Ways of Working', skills: ['Ownership', 'high bar for quality', 'Mentoring', 'owned'] },
  ]);

  // The soft-skill group empties completely and is dropped: there is no group
  // of them any more, and the entries are checked by WHAT THEY ARE rather than
  // which heading they sit under, because the model renames that heading
  // freely - "Ways of Working", "Team and Collaboration", "Professional
  // Skills" all turned up in delivered resumes.
  // Only Datadog is left in Monitoring: "Observability" is a practice and its
  // tool is what the block wants, which is the operator's rule - and "CI/CD"
  // is deliberately exempt, being among the strings a scanner weights most.
  assert.deepEqual(groups, [
    { category: 'Delivery', skills: ['CI/CD'] },
    { category: 'Monitoring', skills: ['Datadog'] },
  ]);
  assert.deepEqual(report.concepts, ['Observability', 'Observability implementation']);
  assert.deepEqual(report.repeated, ['CI/CD']);
  assert.deepEqual(report.described, ['CI/CD pipeline development', 'security controls implementation', 'owned']);

  assert.deepEqual(report.softOrVague, ['Infrastructure', 'Ownership', 'high bar for quality', 'Mentoring']);
  // Nothing restates anything here any more: both halves of the pair are
  // concepts and both left before the restatement pass ran.
  assert.deepEqual(report.restated, []);
  assert.deepEqual(report.trimmed, []);
  // Which list a removal lands in is a reporting detail, and the two rules
  // overlap on purpose: "owned" goes as a past-tense verb and "high bar for
  // quality" as a named culture phrase. What matters is that neither reaches
  // the page.

});

test('a group emptied by the tidy is dropped rather than printed headless', () => {
  const { groups } = tidySkillGroups(
    [
      { category: 'Languages', skills: ['Python'] },
      { category: 'Practices', skills: ['security controls implementation', 'requirements gap handling'] },
    ]
  );
  assert.deepEqual(groups, [{ category: 'Languages', skills: ['Python'] }]);
});

test('a product whose name ends in a filler word keeps its place', () => {
  /*
   * "integration" is padding in "model registry integration" and part of the
   * name in "Spring Integration". The filler list cannot tell them apart, so
   * the products are named outright - and only the ones where BOTH halves of
   * the pair would plausibly be in one block, since an entry standing alone is
   * never compared to anything.
   */
  assert.equal(restatesSkill('Spring', 'Spring Integration'), false);
  assert.equal(restatesSkill('model registry', 'model registry integration'), true);
  assert.equal(restatesSkill('Kubernetes', 'Kubernetes orchestration'), true);
  assert.equal(restatesSkill('Observability', 'Observability implementation'), true);
  assert.equal(restatesSkill('Infrastructure', 'Infrastructure migration'), true);
});

/* ─── 2. A values phrase is not a skill ───────────────────────────────────── */

test('the posting culture language the operator reported is refused', () => {
  for (const phrase of [
    'radical ownership mindset',
    'accuracy obsession',
    'valued all voices',
    'relentless bias toward action',
    "what agents can and can't do",
    'ownership mindset',
    'customer obsession',
    'passion for data',
    'can-do attitude',
    'bias for action',
  ]) {
    assert.equal(isValuesPhrase(phrase), true, `${phrase} is a claim about character`);
  }
});

test('the soft skills a scanner actually scores still pass', () => {
  /*
   * THE HALF THAT KEEPS THIS SAFE. The prompt asks for every soft skill in
   * KEYWORDS and a scanner scores them as skills, so a filter that swept up
   * "Ownership" along with "radical ownership mindset" would cost real matches
   * in exchange for a style complaint. What is refused is the slogan built
   * around one.
   */
  for (const term of [
    'Ownership',
    'Collaboration',
    'Mentoring',
    'Communication',
    'Communication skills',
    'Troubleshooting',
    'attention to detail',
    'problem-solving',
    'root cause analysis',
    'incident response',
    // Terms that would die under a looser rule: a real ML task, a domain term,
    // a methodology, a field and a product category.
    'bias detection',
    'US GAAP',
    'extreme programming',
    'deep learning',
    'voice interfaces',
    'Python',
  ]) {
    assert.equal(isValuesPhrase(term), false, `${term} must survive`);
  }
});

const valuesAnalysis = () =>
  parseJobAnalysisContent(
    JSON.stringify({
      jobMeta: { title: 'Data Engineer', seniority: 'Senior', industry: 'SaaS', department: 'Engineering' },
      skills: {
        technical: ['data pipelines', 'radical ownership mindset'],
        tools: ['Airflow'],
        soft: ['collaboration', 'accuracy obsession', 'relentless bias toward action'],
      },
      technologies: ['Python'],
      protocols: [], methodologies: [], architecturePatterns: [],
      responsibilities: ['own the ingestion path'],
      domainKnowledge: [],
      softSkills: ['valued all voices', 'ownership'],
      keywords: { actionVerbs: [], buzzwords: [], mustInclude: ['Python'] },
    }),
    'A posting about data pipelines in Python, for somebody with a radical ownership mindset.'
  );

const dataProfile = () => ({
  id: 'p', name: 'Values Test', title: 'Data Engineer', createdAt: '', updatedAt: '',
  contact: { phone: '1', email: 'a@b.c', location: 'X' },
  summary: 'Engineer.',
  experience: [{
    title: 'Data Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
    location: 'Remote', description: 'Built Python pipelines on Airflow.', achievements: [], skills: [],
  }],
  strengths: [], skills: [], education: [], certifications: [],
});

const VALUES_PHRASES = [
  'radical ownership mindset',
  'accuracy obsession',
  'relentless bias toward action',
  'valued all voices',
];

test('a values phrase never reaches the model', () => {
  /*
   * A PROMPT RULE ALONE WOULD NOT HAVE HELD. These phrases arrive on the
   * analyser's own checklists, and the prompt is told to place EVERY term on
   * them - so the model was being asked for the thing fault 1 forbids, in the
   * same document, and the later instruction is the one it was counted against.
   * Taking them off the list is what settles it.
   */
  const values = buildTailorResumePromptValues(dataProfile(), valuesAnalysis());
  const sent = [
    values.skillsJSON,
    values.hardSkillsJson,
    values.keywordsJson,
    values.conceptKeywordsJson,
  ].join(' ').toLowerCase();

  for (const phrase of VALUES_PHRASES) {
    assert.equal(sent.includes(phrase), false, `${phrase} was still handed to the model`);
  }

  // And the real terms beside them are untouched, which is the point: this is a
  // filter on one shape of phrase, not a quieter checklist.
  assert.ok(sent.includes('data pipelines'));
  assert.ok(sent.includes('collaboration'));
  assert.ok(sent.includes('ownership'));
});

test('a term set aside is reported, and not then counted as one the resume missed', (t) => {
  /*
   * The second half of the same fix. The prose checklist feeds the coverage
   * measurement, the bullet chooser, and the gap that decides whether to pay
   * for a revision call - and that call's whole job is to write the missing
   * terms in. Left on the checklist, a values phrase would have been put back
   * by the app itself after the model correctly left it out.
   *
   * Read off the log lines, which is where the numbers an operator reacts to
   * come from.
   */
  const lines = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (line) => lines.push(String(line));
  console.warn = (line) => lines.push(String(line));
  t.after(() => { console.log = realLog; console.warn = realWarn; });

  const analysis = valuesAnalysis();
  buildTailorResumePromptValues(dataProfile(), analysis);
  parseTailoredResumeContent(
    JSON.stringify({
      title: 'Data Engineer',
      summary: 'Data engineering of 9 years across ingestion platforms, where ownership of the nightly path and collaboration with the analytics team shaped the work.',
      experience: [{
        title: 'Data Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
        location: 'Remote', description: '',
        achievements: ['Rebuilt the data pipelines in Python on Airflow, cutting failed runs from 9 a week to 1.'],
      }],
      strengths: [],
      skillGroups: [{ category: 'Data', skills: ['Python', 'Airflow'] }],
      coverLetter: 'I build pipelines.',
    }),
    dataProfile(),
    analysis
  );
  console.log = realLog;
  console.warn = realWarn;

  // Set aside out loud: a silent filter on the posting's own words would be
  // worse than the phrases it removes.
  assert.ok(
    lines.some((line) => /set aside \d+ values phrase/.test(line)),
    `the decision was not reported: ${lines.join(' | ').slice(0, 300)}`
  );

  // The set-aside line carries its own tag, so what the measurement says can be
  // read apart from what was deliberately left out.
  const measured = lines
    .filter((line) => /\[Resume (keywords|soft skills|concepts)\]/.test(line))
    .filter((line) => !/set aside/.test(line))
    .join(' ')
    .toLowerCase();
  assert.ok(measured.length > 0, 'nothing measured the coverage at all');
  for (const phrase of VALUES_PHRASES) {
    assert.equal(
      measured.includes(phrase),
      false,
      `${phrase} is still counted against the resume: ${measured.slice(0, 300)}`
    );
  }
});

/* ─── 3. Claims inside the years they could be true ───────────────────────── */

test('a claim newer than the role it sits in is found', () => {
  // The operator's example: LLM-as-a-judge, RAG, prompt injection testing and
  // agent orchestration under 2017-2019 roles.
  const found = findAnachronisms([
    {
      company: 'Globex',
      startDate: '03/2017',
      endDate: '12/2019',
      achievements: [
        'Built LLM-as-a-judge evaluation for agent orchestration across the telemetry pipeline.',
        'Ran prompt injection testing on the intake API.',
        'Shipped RAG retrieval over a vector database.',
        'Built the regression suite for the telemetry ETL jobs in Python.',
      ],
    },
  ]);

  const terms = found.map((hit) => hit.term);
  assert.ok(terms.includes('LLM-as-a-judge'));
  assert.ok(terms.includes('agent orchestration'));
  assert.ok(terms.includes('prompt injection'));
  assert.ok(terms.includes('RAG'));
  // The era-appropriate bullet is not a finding. ETL and a regression suite are
  // what that work WAS, which is the whole point of the rule.
  assert.equal(
    found.some((hit) => /regression suite/.test(hit.bullet)),
    false
  );
  assert.equal(found[0].company, 'Globex');
  assert.equal(found[0].endedIn, 2019);
});

test('one finding per thing named, not one per matching string', () => {
  // "LLM" is inside "LLM-as-a-judge" and both are dated, so a bullet with the
  // longer phrase would otherwise be counted twice and read as two faults.
  const found = findAnachronisms([
    { company: 'Globex', endDate: '12/2019', achievements: ['Built LLM-as-a-judge scoring.'] },
  ]);
  assert.deepEqual(found.map((hit) => hit.term), ['LLM-as-a-judge']);
});

test('a current role can carry anything, and a recent one carries its own era', () => {
  /*
   * "Present" means the work is still going on, so nothing in it can be too
   * new - and this must not be read as "this year", which would make every
   * current role a false report the moment a term is added to the list.
   */
  assert.equal(roleEndYear('Present'), null);
  assert.equal(roleEndYear('current'), null);
  assert.equal(roleEndYear(''), null);
  assert.equal(roleEndYear(undefined), null);
  assert.equal(roleEndYear('12/2019'), 2019);
  assert.equal(roleEndYear('Dec 2019'), 2019);

  assert.deepEqual(
    findAnachronisms([
      {
        company: 'Acme',
        endDate: 'Present',
        achievements: ['Built an agent orchestration layer in Python.', 'Shipped RAG retrieval.'],
      },
      {
        company: 'Hooli',
        endDate: '06/2025',
        achievements: ['Built an agent runtime on MCP.'],
      },
    ]),
    []
  );
});

test('a term is not found inside an ordinary word', () => {
  // "RAG" is three letters and lives inside "storage" and "ragged". A check
  // that matched those would report the fault on resumes that do not have it.
  assert.deepEqual(
    findAnachronisms([
      {
        company: 'Initech',
        endDate: '02/2016',
        achievements: [
          'Tuned the storage layer for the ragged nightly loads.',
          'Managed the agent pool for the build fleet.',
        ],
      },
    ]),
    []
  );
});

/* ─── 5. A figure a reader can parse ──────────────────────────────────────── */

test('the reported garbled shape is found', () => {
  const found = findGarbledMetrics([
    {
      achievements: [
        'Reduced deploy time by about 40 minutes to 6.',
        'Reduced incidents by 30 to 12.',
        'Cut p99 latency from 180ms to 118%.',
      ],
    },
  ]);
  assert.equal(found.length, 3);
  assert.deepEqual(found.map((hit) => hit.shape), ['by-then-to', 'by-then-to', 'unit-changed']);
});

test('the forms the prompt asks for are not reported', () => {
  /*
   * The half that keeps the check honest. A unit stated once for a pair is
   * ordinary English and is what the prompt offers as the fix, so flagging it
   * would report the correct answer as a fault.
   */
  assert.deepEqual(
    findGarbledMetrics([
      {
        achievements: [
          'Cut deploy time from 40 minutes to 6 minutes.',
          'Took failed runs from 9 a week to 1.',
          'Brought the error rate down from 30 to 12 incidents a week.',
          'Cut p99 latency from 180ms to 118ms.',
          'Cut cloud spend by 18% across 40 services.',
          'Rewrote the ingestion for 40 tables carrying 2B rows a day.',
        ],
      },
    ]),
    []
  );
});

/* ─── 4, 6 and 8. Counted, because a rule nobody counts stops holding ─────── */

test('a bullet that is not one finished sentence is found, by shape', () => {
  const found = findBrokenBullets([
    {
      company: 'Acme',
      achievements: [
        // The operator's own examples.
        'Built AI pipeline design experiments? No; instead ran a smaller trial.',
        'deterministically vs statistically evaluation of the model outputs.',
        'Rewrote the loan origination endpoints in Node.js and',
        'Reviewed the data pipeline for the data pipeline owners.',
        // ...and a bullet that is fine, which must not appear.
        'Rebuilt the nightly ingestion jobs in Airflow, which cut failed runs from 9 a week to 1.',
      ],
    },
  ]);

  assert.deepEqual(
    found.map((hit) => hit.shape),
    ['self-talk', 'lower-start', 'dangling-end', 'repeated-phrase']
  );
  assert.equal(found.some((hit) => /Rebuilt the nightly/.test(hit.bullet)), false);
});

test('a product that is written in lower case is not reported as a lowercase start', () => {
  /*
   * "dbt models were rewritten..." is correct and "built the..." is not, and
   * the only difference is the word. A check that reported the product names
   * would be the fastest way to get an operator to stop reading the log.
   */
  assert.deepEqual(
    findBrokenBullets([
      {
        achievements: [
          'dbt models were rewritten to cut the nightly build from 90 minutes to 25 minutes.',
          'iOS releases moved to a weekly train, which ended the Friday hotfixes.',
          'npm audit was wired into the pipeline, cutting known advisories from 23 to 0.',
        ],
      },
    ]),
    []
  );
});

test('a bullet names a tool when it names one this resume itself claims', () => {
  /*
   * The vocabulary is the resume's OWN skills block, not a list kept in code.
   * That is the sharper test: a bullet naming none of the technologies the
   * candidate is claiming describes nobody in particular, and a code list
   * would go stale against an industry larger than it.
   */
  const roles = [
    {
      achievements: [
        'Rebuilt the nightly ingestion jobs in Airflow, cutting failed runs from 9 a week to 1.',
        'Improved pipeline reliability and reduced job failures across the platform.',
        'Rewrote the reconciliation service in Python, taking the nightly close from 3 hours to 40 minutes.',
      ],
    },
  ];

  const measured = bulletsNamingATool(roles, ['Python', 'Airflow', 'Snowflake']);
  assert.deepEqual(measured, { bullets: 3, named: 2, share: 2 / 3 });

  // Bounded on both sides, so a tool is not found inside another word: "Go"
  // must not match "Google" and "R" must not match every sentence.
  assert.equal(bulletsNamingATool([{ achievements: ['Moved the Google Analytics tags.'] }], ['Go']).named, 0);
});

test('a role with only improvement figures is reported as having no scale', () => {
  // "40 tables carrying 2B rows a day" says what was being run; "cut failures
  // by 40%" says only that something got better, and a reader cannot tell a
  // weekend project from a payments platform.
  assert.deepEqual(
    rolesWithoutScale([
      { company: 'Acme', achievements: ['Cut failed runs by 40% and dropped p99 latency from 180ms to 118ms.'] },
      { company: 'Globex', achievements: ['Rewrote the ingestion across 40 tables carrying 2B rows a day.'] },
      { company: 'Initech', achievements: ['Ran the platform at 12k requests a second through two regions.'] },
      { company: 'Hooli', achievements: ['Mentored 3 engineers through the migration.'] },
    ]),
    ['Acme']
  );

  // A role with no bullets at all is not a role with no scale: there is
  // nothing to report, and a fallback bullet is not the model's answer.
  assert.deepEqual(rolesWithoutScale([{ company: 'Empty', achievements: [] }]), []);
});

test('ownership and mentoring are looked for in the two most recent roles only', () => {
  /*
   * The rule is that scope WIDENS, so an earliest role without an ownership
   * bullet is the rule working rather than failing. Checking every role would
   * report the correct shape as a fault on every resume.
   */
  const roles = [
    { company: 'Acme', achievements: ['Owned the release path for three services.'] },
    { company: 'Globex', achievements: ['Tuned the query plan for the reporting service.'] },
    { company: 'Initech', achievements: ['Fixed the nightly export job.'] },
  ];
  assert.deepEqual(recentRolesWithoutScope(roles), ['Globex']);

  assert.deepEqual(
    recentRolesWithoutScope([
      { company: 'Acme', achievements: ['Mentored two engineers through their first on-call rotation.'] },
      { company: 'Globex', achievements: ['Took ownership of the settlement path after two outages.'] },
      { company: 'Initech', achievements: ['Fixed the nightly export job.'] },
    ]),
    []
  );
});

/* ─── What only the prompt can fix ────────────────────────────────────────── */

const promptBody = () => {
  const file = path.join(__dirname, '..', 'static', 'prompts', 'tailor-resume.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')).content;
};

const analyserBody = () => {
  const file = path.join(__dirname, '..', 'static', 'prompts', 'analyze-job-description.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')).content;
};

test('the prompt carries the rules for the faults no code can repair', () => {
  const content = promptBody();

  // The section exists, and says it wins where it collides with the coverage
  // rules above it - without that line it is advice losing to an instruction.
  assert.match(content, /SEVEN FAULTS A HUMAN READER CATCHES BEFORE A SCANNER DOES/);
  assert.match(content, /this section wins/);

  // 2. Culture phrases, with the operator's own examples named so the model can
  // recognise the shape, and the rule about where a soft skill sits.
  for (const phrase of [
    'radical ownership mindset',
    'accuracy obsession',
    'valued all voices',
    'relentless bias toward action',
  ]) {
    assert.ok(content.includes(phrase), `${phrase} is not named as a phrase to drop`);
  }
  assert.match(content, /A VALUES PHRASE IS NOT A SOFT SKILL/);
  assert.match(content, /never appended after the\nresult/);
  // ...and the soft-skill rule that manufactured them points at it, because that
  // rule asks for EVERY soft skill in KEYWORDS and is read first.
  const softAt = content.indexOf('SOFT SKILLS ARE PROSE, AND THEY ARE NOT OPTIONAL');
  const pointerAt = content.indexOf('A VALUES PHRASE IS NOT A SOFT SKILL');
  assert.ok(softAt > 0 && pointerAt > softAt, 'the pointer belongs inside the rule it corrects');

  // 3. Anachronisms, with the years named rather than "recent".
  assert.match(content, /EVERY CLAIM STAYS INSIDE THE YEARS IT COULD BE TRUE/);
  assert.match(content, /NOT BEFORE 2023/);
  assert.match(content, /NOT BEFORE 2024/);
  assert.match(content, /FINE EARLIER/);
  assert.match(content, /ETL/);

  // 4. Leftover text, named by the strings that reached the page.
  assert.match(content, /EVERY BULLET IS ONE FINISHED SENTENCE/);
  assert.ok(content.includes('Built AI pipeline design experiments? No; instead'));
  assert.ok(content.includes('deterministically vs statistically'));

  // 5. Garbled metrics - and the example that taught the model the broken form
  // is gone, which is the part a rule alone would not have fixed.
  assert.match(content, /A BEFORE-AND-AFTER CARRIES ITS UNIT TWICE/);
  assert.ok(content.includes('from 40 minutes to 6 minutes'));
  assert.equal(
    /from 40 minutes to 6\b(?! minutes)/.test(content),
    false,
    'the prompt still shows a before-and-after with the unit on one end'
  );
  /*
   * AND THE EXAMPLE IS MARKED AS AN EXAMPLE, which is the half a corrected
   * illustration would not have fixed. Measured over 99 delivered resumes: "40
   * minutes" reached 26 of them and "40 minutes to 6" nineteen bullets -
   * attached to GC pauses, incident triage and regression runs, none of which
   * is a deploy pipeline. The model was lifting the example as a template, so
   * fixing its punctuation alone would have produced a correctly formatted
   * figure that is still about somebody else's work.
   */
  assert.match(content, /ARE ILLUSTRATIONS, NOT NUMBERS TO REUSE/);
  assert.match(content, /AND NOT A FIGURE OUT OF AN EXAMPLE/);

  // 6. Named tools and scale, as counts rather than as encouragement.
  assert.match(content, /NAME THE TOOL IN THE BULLET, AND GIVE EACH ROLE ONE FIGURE OF SCALE/);
  assert.match(content, /At least two of every three bullets name a specific technology/);
  assert.match(content, /ONE FIGURE OF SCALE PER ROLE/);

  // 7. Outcomes rather than activity chains.
  assert.match(content, /A BULLET ENDS ON THE RESULT, NOT ON ANOTHER ACTIVITY/);
  assert.match(content, /At most one "and" joining two actions/);

  // ...and the HARD RULES list carries each of them in one line, because that
  // list is the last thing the prompt says and a rule stated once in the middle
  // of 53,000 characters is a rule competing with everything after it.
  const hardRulesAt = content.lastIndexOf('HARD RULES');
  const hardRules = content.slice(hardRulesAt);
  assert.match(hardRules, /Never write a posting's culture language/);
  assert.match(hardRules, /Never name a technology in a role that ended before/);
  assert.match(hardRules, /Never write a figure as "by X to Y"/);
  assert.match(hardRules, /Every bullet is one finished sentence/);

  // 8. Expanding scope, ownership, mentoring - drawn from the profile only.
  assert.match(content, /THE ROLES HAVE TO SHOW SOMEBODY GROWING/);
  assert.match(content, /mentored two\nengineers/);
  assert.match(content, /Never a promotion, a\nheadcount/);
});

test('the skills block is told one entry per real skill, and the padding target is distinct things', () => {
  const content = promptBody();

  assert.match(content, /ONE ENTRY PER REAL SKILL/);
  // The operator's own example, so the model can see the shape it produces.
  assert.ok(content.includes('data pipeline operations, production pipeline operations'));
  assert.match(content, /keep the\s*\n?\s*shorter and delete the longer/);
  // It is told the application does the same, which is true as of this file.
  assert.match(content, /The application runs that same test before/);

  // A count the model can reach by padding is a count it WILL reach by padding,
  // so the floor says outright that one thing written five ways counts once.
  assert.match(content, /THIRTY-FIVE IS A FLOOR/);
  assert.doesNotMatch(content, /THIRTY is the target/, 'the bare count is what was being padded towards');
  assert.match(content, /counting each real thing once/);
  assert.match(content, /Not from writing one thing five ways/);
});

test('the summary is 50 words, which is a reversal the operator made knowingly', () => {
  /*
   * THIS TEST USED TO PIN THE OPPOSITE, and the history is the point.
   *
   * Asked whether fault 8's "2-3 plain sentences" should override the 65-80
   * words set after a measured ten-point ATS fall, the operator said "Leave the
   * summary as it is now". A later resume-writing spec asked for 50 words, they
   * were asked the same question again with the same measurement in front of
   * them, and that time chose 50: it reads better to a person, and a person is
   * who the resume is for.
   *
   * So the scanner numbers are expected to fall. That is the trade, not a
   * regression.
   */
  const content = promptBody();
  assert.match(content, /Summary: 2-3 sentences, AT MOST 50 words/);
  assert.doesNotMatch(content, /AIM AT 80, never under 65/);
  assert.doesNotMatch(content, /Summary: 65-80 words/);
});
test('the analyser no longer manufactures several strings per idea', () => {
  /*
   * THE UPSTREAM CAUSE of nine messy blocks. Four rules in the analyser each
   * multiplied one phrase from the posting into three or four strings, and
   * their own examples were printed verbatim on delivered resumes: "CI/CD
   * pipelines" gave "CI/CD" AND "pipeline automation", both of which appeared
   * in one group; "write unit tests" gave "unit testing", "test automation" and
   * "software testing", all three of which appeared side by side; "work with
   * product managers" gave "cross-functional collaboration" and "stakeholder
   * communication", which appeared in four of the nine blocks.
   *
   * The tailor prompt then says every checklist term must be on the page, and
   * the skills block is the cheapest place to put one - so the analyser decided
   * what the block looked like.
   */
  const analyser = analyserBody();

  assert.doesNotMatch(analyser, /Specificity ladder/, 'one phrase into four levels of generality');
  assert.doesNotMatch(analyser, /extract both the compound AND each meaningful part/);
  assert.doesNotMatch(analyser, /"distributed systems" . extract "distributed systems" AND/);
  assert.match(analyser, /ONE ENTRY PER THING THE POSTING ASKS FOR/);

  // The abbreviation pair survives, and is the only multiplier left: a scanner
  // matches strings and will not connect "LLM" to "Large Language Models".
  assert.match(analyser, /Abbreviations and their expansions are the ONE exception/);
  assert.match(analyser, /"machine learning" . also extract "ML"/);

  // Implied skills still exist - the rule is sound - but give one term each.
  assert.match(analyser, /ONE term each, the one an engineer would write on a resume/);
  assert.match(analyser, /"write unit tests" . "unit testing"/);
  assert.doesNotMatch(analyser, /"unit testing", "test automation", "software testing"/);
});

test('the analyser names soft skills from the list, not from the posting', () => {
  const analyser = analyserBody();
  assert.match(analyser, /NAMED FROM THE LIST BELOW and from nothing else/);
  assert.match(analyser, /NOT IN THE POSTING'S OWN WORDS/);

  // Every term the analyser is told to choose from is one the application will
  // accept. These are set in two files and would drift silently: the prompt
  // would ask for a term the code then deletes, and the group would come back
  // short with nobody able to see why.
  const listed = /THE LIST, and only these:\n([\s\S]*?)\n\n/.exec(analyser);
  assert.ok(listed, 'the analyser must carry the list itself');
  const terms = listed[1]
    .split(/[,.]/)
    .map((term) => term.trim())
    .filter(Boolean);
  assert.ok(terms.length >= 40, `only ${terms.length} terms listed`);
  for (const term of terms) {
    assert.equal(isAllowedSoftSkill(term), true, `the prompt asks for "${term}" and the code refuses it`);
  }
});

test('the tailor prompt describes the application that now exists', () => {
  /*
   * Every removal the code makes is a rule the prompt states, and the prompt
   * says which ones are enforced. A prompt that described a gentler application
   * than the one running would have the model writing entries that silently
   * vanish, and an operator reading a block they were never shown the reason
   * for.
   */
  const content = promptBody();

  /*
   * NO SOFT-SKILL GROUP AT ALL, which is the second decision made about this
   * section. It was first a group of the posting's own wording, which printed
   * "ambiguity tolerance" and "high bar for quality"; then a group restricted
   * to a fixed vocabulary; and now nothing - "show them through bullets
   * instead". Each step was the operator's, and the last gives up the scanner
   * match on Ownership, Collaboration and Mentoring in exchange for a block of
   * tools a reader believes.
   */
  assert.match(content, /NO SOFT SKILLS IN THIS BLOCK, AND NO CATEGORY WORDS/);
  assert.doesNotMatch(content, /THE LAST GROUP IS/, 'there is no last group of them any more');
  assert.doesNotMatch(content, /fill it with the soft skills this posting named/);
  assert.match(content, /Nor do category words/, 'Cloud and Infrastructure go too');
  // The prose rule is untouched, and is now the ONLY place a soft skill lands.
  assert.match(content, /SOFT SKILLS ARE PROSE rule above still/);

  // Descriptions, with the rule stated exactly as the code applies it.
  assert.match(content, /A DESCRIPTION WHERE A NAME BELONGS/);
  assert.match(content, /three or more words\s*\n?\s*that is NOT written as a proper name is deleted/);
  assert.match(
    content,
    /"Large\s+Language Models", "Infrastructure as Code"/,
    'the long names that survive are shown'
  );

  // The ceiling, enforced rather than suggested - and raised with the floor,
  // because 35 required against 40 allowed is too narrow a band to write in.
  assert.match(content, /At most 45\./);
  assert.match(content, /the application DELETES what is\s+over, from the end of the longest group/);
  assert.doesNotMatch(content, /At most 40/, 'the old ceiling would now collide with the floor');

  // A past-tense verb, which reached a delivered block as "owned".
  assert.match(content, /A past-tense verb\./);
});

test('degree notation is standardised only where the source is unambiguous', () => {
  /*
   * ASKED FOR: "Use standard degree notation (e.g. B.S. in Computer Science)".
   * Education is the one section the model never writes - it is passed to the
   * page from the profile - so nothing had ever normalised it.
   *
   * THE LINE THIS WILL NOT CROSS: "Bachelor's degree in Computer Science" may
   * be a B.S. or a B.A., the profile does not say, and guessing would put a
   * false claim on somebody's resume. Those are left exactly as written.
   */
  const { standardDegree, standardDegreeNotation } = require('../dist/services/utils/resumeQuality');

  assert.equal(standardDegree('Bachelor of Science in Computer Science'), 'B.S. in Computer Science');
  assert.equal(standardDegree('Bachelor of Science, Computer Science'), 'B.S. in Computer Science');
  assert.equal(standardDegree('BS Computer Science'), 'B.S. in Computer Science');
  assert.equal(standardDegree('B.Sc. Information Systems'), 'B.S. in Information Systems');
  assert.equal(standardDegree('Master of Science Data Science'), 'M.S. in Data Science');
  assert.equal(standardDegree('MBA'), 'M.B.A.');
  assert.equal(standardDegree('Ph.D in Machine Learning'), 'Ph.D. in Machine Learning');

  // Already correct, and not mangled by being run through twice.
  assert.equal(standardDegree('B.S. in Computer Science'), 'B.S. in Computer Science');
  assert.equal(standardDegree(standardDegree('BS Computer Science')), 'B.S. in Computer Science');

  // Ambiguous or simply not a degree of this shape: left alone.
  assert.equal(standardDegree("Bachelor's degree in Computer Science"), "Bachelor's degree in Computer Science");
  assert.equal(standardDegree('Diploma in Web Development'), 'Diploma in Web Development');
  assert.equal(standardDegree(''), '');

  // Across a profile's entries, touching nothing else on them.
  const entries = [
    { degree: 'Bachelor of Science in Computer Science', institution: 'State University', graduationDate: '2016' },
    { institution: 'A bootcamp' },
  ];
  assert.deepEqual(standardDegreeNotation(entries), [
    { degree: 'B.S. in Computer Science', institution: 'State University', graduationDate: '2016' },
    { institution: 'A bootcamp' },
  ]);
  assert.deepEqual(standardDegreeNotation(undefined), []);
});

test('the render data carries the standardised degree, not the raw one', () => {
  // The normaliser is only worth having where the page reads it: education is
  // spread onto the render data straight off the profile, so this is the one
  // line that decides whether any of it reaches a PDF.
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const data = prepareResumeRenderData({
    id: 'p', name: 'T', title: 'Engineer', createdAt: '', updatedAt: '',
    contact: { phone: '1', email: 'a@b.c', location: 'X' },
    summary: 'Engineer.', experience: [], strengths: [], skills: [], certifications: [],
    education: [{ degree: 'Bachelor of Science in Computer Science', institution: 'State University' }],
  });
  assert.equal(data.education[0].degree, 'B.S. in Computer Science');
  assert.equal(data.education[0].institution, 'State University');
});

test('the block has a required Languages group, in 5-7 of them', () => {
  /*
   * ASKED FOR: "Language & Framework category in the skill section is essential
   * and required" and "5-7 categories". The group count had just been cut to
   * 3-5 from a resume-writing spec; this is the operator putting it back with a
   * floor of their own, and naming the one group that may never be missing.
   *
   * REPORTED, NOT INVENTED. The entries would have to come from somewhere, and
   * a Languages group listing languages this candidate does not write is worse
   * than a block without the heading.
   */
  const content = promptBody();
  assert.match(content, /skillGroups: 5-7 groups/);
  assert.match(content, /THE FIRST GROUP IS LANGUAGES AND FRAMEWORKS, ALWAYS/);
  assert.match(content, /Required on every\s+resume, never merged into another group/);
  assert.match(content, /Five groups need\s+seven entries each; six groups need six; seven groups need five/);
  assert.match(content, /NEVER FEWER THAN FIVE IN A\s+GROUP/);
  assert.doesNotMatch(content, /skillGroups: 3-5 groups/, 'the shorter shape is gone');
});

test('there is no page limit left in the prompt', () => {
  // ASKED FOR: "remove 1 or 2 page limit". It was stated in four places - the
  // opening line, the budget heading, the bullet total and the role coverage -
  // and a limit left in one of them is the one the model would have obeyed.
  const content = promptBody();
  assert.match(content, /There is no page limit/);
  assert.match(content, /NO PAGE LIMIT, so there is nothing to be short for/);
  assert.doesNotMatch(content, /fits in 2 pages/);
  assert.doesNotMatch(content, /this is what keeps it to 2 pages/);
  assert.doesNotMatch(content, /two\s+pages at most/);
});

test('bullets have room for the tool, the figure and the soft skill', () => {
  /*
   * ASKED FOR: "you may increase word count of each bullet slightly". Slightly,
   * and for a reason: with the soft-skill group gone from the block, a bullet
   * now has to carry a named tool, a measurable result AND a soft skill in one
   * sentence. 26-36 did not leave room for the third.
   */
  const content = promptBody();
  assert.match(content, /Achievement bullet: 30-42 words/);
  assert.doesNotMatch(content, /26-36/, 'both places that quoted the old budget moved together');
  // Still one sentence and one idea: the extra room is not a second clause.
  assert.match(content, /Still one sentence and still one idea/);
});

test('five measurable results, counted in the bullets alone', () => {
  /*
   * ASKED FOR: "at least 5 measurable results (metrics) in bullet points". The
   * floor existed and was counted over the summary AND the bullets, which
   * inflated it by one on most resumes - so a resume with four figures in its
   * bullets passed. At 50 words the summary holds one figure at most, which
   * made counting it worth less than the confusion it caused.
   */
  const content = promptBody();
  assert.match(content, /AT LEAST FIVE MEASURABLE RESULTS IN THE BULLETS/);
  assert.match(content, /counted in the achievement bullets only/);
  assert.doesNotMatch(content, /AT LEAST FIVE FIGURES ON THE PAGE/);

  // And the code counts the same thing the prompt asks for.
  const { countFigures } = require('../dist/services/resumeService');
  const summaryOnly = {
    summary: 'Engineer of 9 years across 3 platforms clearing 40M transactions a day.',
    experience: [{ achievements: ['Rebuilt the ingestion in Airflow.'] }],
  };
  assert.equal(countFigures({ experience: summaryOnly.experience }), 0, 'the summary must not contribute');
  assert.ok(countFigures(summaryOnly) > 0, 'and countFigures itself still counts whatever it is given');
});

test('the soft skills have nowhere to go but the bullets, and the prompt says so', () => {
  /*
   * ASKED FOR: "we deleted soft skill category in skill section. it affects the
   * ATS score. so populate the soft skills across work experience bullets."
   * That is exactly right about the cost - the group was what a scanner scored
   * - so the rule that replaces it has to carry the whole section on its own.
   */
  const content = promptBody();
  assert.match(content, /THE BULLETS ARE NOW THE ONLY PLACE THEY LAND/);
  assert.match(content, /the score falls by exactly the number you leave out/);
  assert.match(content, /EVERY ONE OF THEM, AND COUNT THEM BEFORE YOU RETURN/);
  // The block still refuses them, so the two rules do not fight.
  assert.match(content, /NO SOFT SKILLS IN THIS BLOCK/);
});

/* ─── Concepts: out of the block, into the bullets ────────────────────────── */

test('a practice is removed from the block and a tool is not', () => {
  /*
   * ASKED FOR: "I don't need concepts in skill section, instead add real
   * tools." Measured over the nine delivered blocks, these were all printed as
   * skills: "tool calling", "agent orchestration", "quota enforcement",
   * "security hardening", "latency optimization", "feature extraction",
   * "Capacity Planning", "fast iteration", "research-driven goals".
   */
  for (const concept of [
    'tool calling',
    'agent orchestration',
    'quota enforcement',
    'security hardening',
    'latency optimization',
    'deployment automation',
    'feature extraction',
    'Capacity Planning',
    'Data Modeling',
    'Experiment Tracking',
    'API design',
    'unit testing',
    'Prompt Engineering',
    'Observability',
    'Observability implementation',
    'Infrastructure as Code',
    'research-driven goals',
    'fast iteration',
    'context graph',
    'text data',
  ]) {
    assert.equal(isConceptEntry(concept), true, `${concept} is a practice, not a thing`);
  }

  for (const tool of [
    'Python', 'TypeScript', 'React', 'Redis', 'Terraform', 'PostgreSQL', 'Kafka',
    'Airflow', 'Datadog', 'Kubernetes', 'MLflow', 'PyTorch', 'Jira', 'OpenShift',
    'GitHub Copilot', 'tRPC', 'WebRTC',
    // Lower case on purpose, and still products. A rule reading an all-lowercase
    // phrase as a description has to know about these or it eats them.
    'dbt', 'httpx', 'asyncio', 'scikit-learn', 'pgvector', 'webhooks',
  ]) {
    assert.equal(isConceptEntry(tool), false, `${tool} is a thing you install`);
  }
});

test('the strings a scanner weights most are deliberately exempt', () => {
  /*
   * THE LINE, and it is a judgement rather than a rule: each of these is a
   * concept by a strict reading, and each is among the terms a scanner scores
   * highest. Taking them off the block would cost more than the tidiness is
   * worth, so they stay there AND are required in the prose. The prompt says
   * the same, in the same words, so nobody later "fixes" one half.
   */
  for (const exempt of ['CI/CD', 'APIs', 'REST', 'Large Language Models', 'RAG', 'AI']) {
    assert.equal(isConceptEntry(exempt), false, `${exempt} must not be taken off the block`);
  }
  const content = promptBody();
  assert.match(content, /WHAT STAYS, despite being a concept by a strict reading/);

  /*
   * NAMED IN BOTH PLACES, which is the half that was missing and the reason
   * three of four delivered resumes left the whole LLM family out of the block.
   * The exception lived only under WHAT STAYS OUT, six hundred lines below the
   * rule that excludes concepts - and that rule is specific and carries a
   * worked example, so it won. An exception a model has to remember across six
   * hundred lines is an exception it does not apply.
   */
  const conceptsAt = content.indexOf('Concepts and capabilities do NOT appear in the skills list');
  const staysAt = content.indexOf('WHAT STAYS, despite being a concept');
  assert.ok(conceptsAt > 0 && staysAt > conceptsAt, 'the exclusion rule still comes first');
  assert.match(
    content.slice(conceptsAt, staysAt),
    /SIX EXCEPTIONS, AND THEY ARE NAMED HERE SO THIS RULE CANNOT SWALLOW THEM/,
    'the exception must sit beside the rule it corrects'
  );
  for (const where of [content.slice(conceptsAt, staysAt), content.slice(staysAt)]) {
    assert.match(where, /"CI\/CD", "APIs",/);
    assert.match(where, /"REST", "LLM" \(or "LLMs", or "Large Language Models"\), "RAG"/);
  }
});

test('the prompt says where a removed concept goes, and the code checks it got there', () => {
  /*
   * ASKED FOR, the second half: "regarding concepts, don't remove but add them
   * to bullets of experience section." A rule that only deletes would quietly
   * cost every concept keyword on the resume - the thing the block was wrongly
   * being used to cover.
   */
  const content = promptBody();
  assert.match(content, /WRITE THE TOOL INSTEAD/);
  assert.match(content, /AND THE CONCEPT ITSELF GOES IN A BULLET/);
  assert.match(content, /It is not dropped from the resume, it is\s+moved/);
  assert.match(content, /The application checks that each concept it deleted from the block/);

  // And the block does not simply get shorter: the freed slot takes a tool.
  assert.match(content, /A block that loses six concepts and gains\s+nothing is a thin block/);
});

test('the bullet floor is a floor, and the page has room for it', () => {
  /*
   * MEASURED, which is why this moved: the per-role guidance from the pasted
   * resume spec - 5-7 for the recent role, 2-3 for the rest - delivered TWELVE
   * bullets on a five-role profile, below the prompt's own minimum of fourteen,
   * against 20.3 on the batch before it. Everything else on the page needs a
   * sentence to live in, so a short page is why the soft skills, the checklist
   * terms and the five measurable results ran out of room at once.
   *
   * 5-8 and 3-4 on a five-role profile is 17-24, which clears the range.
   */
  const content = promptBody();
  assert.match(content, /the most recent and most relevant role gets 5-8/);
  assert.match(content, /Every older or shorter role gets 3-4/);
  assert.match(content, /Bullets across the whole resume: 14-22, and FOURTEEN IS A FLOOR/);
  assert.doesNotMatch(content, /role gets 5-7/, 'the shape that produced twelve bullets is gone');

  // And the application counts it, because a floor nobody counts is a request.
  const { countFigures } = require('../dist/services/resumeService');
  assert.equal(typeof countFigures, 'function');
});

test('soft skills may sit in consecutive bullets', () => {
  /*
   * THE CEILING BOUND BEFORE THE WRITING DID. "At most one per bullet, and
   * never two bullets running" caps a twelve-bullet resume at six soft skills,
   * and the postings ask for six to twelve - so the resume was full before the
   * model had placed what it was asked for. Measured: 6.8 placed against a
   * capacity of 6.
   *
   * What is still banned is two in one sentence, and a bullet written in order
   * to hold one - those are what make a page read as stuffed, and neither is
   * about adjacency.
   */
  const content = promptBody();
  assert.match(content, /CONSECUTIVE BULLETS MAY\s+EACH CARRY ONE/);
  assert.match(content, /What is still\s+banned is two in one sentence/);

  // The soft-skill rule only. The posting's five leading skills keep their own
  // spread rule, which is about visible keyword stuffing rather than capacity.
  const softAt = content.indexOf('SPREAD THEM.');
  const fiveAt = content.indexOf('EACH OF THE FIVE APPEARS IN THE EXPERIENCE BULLETS');
  assert.ok(fiveAt > 0 && fiveAt < softAt, 'the five-skill rule comes first and is untouched');
  assert.match(content.slice(fiveAt, softAt), /never two bullets running/);
});

test('the abbreviation rule no longer uses the one term the block must keep', () => {
  /*
   * THE SECOND HALF OF THE SAME FAULT. Of all the terms it could have
   * illustrated "write both forms, in a SENTENCE, not in the skills list" with,
   * the prompt picked "LLMs (Large Language Models)" - the exact term the
   * exception says belongs in the block. A worked example naming the term beats
   * a rule that merely covers it, so that example was doing the excluding.
   *
   * The rule itself is sound and stays: an abbreviation and its expansion are
   * two strings a scanner matches separately. It is illustrated with concepts
   * that genuinely have no place in the block.
   */
  const content = promptBody();
  const ruleAt = content.indexOf('BOTH FORMS OF A SHORT NAME');
  assert.ok(ruleAt > 0);
  const rule = content.slice(ruleAt, ruleAt + 900);

  assert.match(rule, /"IaC \(Infrastructure as Code\)"/);
  assert.doesNotMatch(rule, /"LLMs \(Large Language Models\)"/, 'the example that excluded it is gone');
  assert.match(rule, /belongs in a SENTENCE, not in the skills list/, 'the rule itself survives');
  // ...and it says outright which terms it is NOT about.
  assert.match(rule, /It is not about "LLM", "RAG" or\s+"CI\/CD"/);
});

test('the prompt no longer tells the model the skills block is not its to write', () => {
  /*
   * A LEFTOVER FROM WHEN CODE BUILT THE BLOCK. The KEYWORDS preamble said
   * "none of them belongs in hardSkills - that list is decided by code from the
   * named technologies and is not yours to add to". The library stopped
   * choosing the block some time ago; the model writes it. Left standing, the
   * sentence told the model to keep its hands off the list it is being asked to
   * fill - a third instruction pushing LLM out of it.
   */
  const content = promptBody();
  const preambleAt = content.indexOf('KEYWORDS and CONCEPT_KEYWORDS are');
  assert.ok(preambleAt > 0);
  const preamble = content.slice(preambleAt, preambleAt + 700);

  assert.match(preamble, /YOU write the block, under TECHNICAL SKILLS/);
  assert.match(preamble, /That has not been true\s+for some time/);
  // The exceptions are named here too, so a model reading only this paragraph
  // is not left with "none of them belongs in the block".
  assert.match(preamble, /The exceptions are named under CONCEPTS AND CAPABILITIES below/);
  assert.match(preamble, /"REST", "LLM", "RAG", "AI" - which go in the skills block as well/);
});

test('thirty-five is a floor, with the arithmetic and the ceiling to match', () => {
  /*
   * ASKED FOR BY NUMBER: "I need at least 35 skills in skill section."
   *
   * MEASURED before it moved: "about 30, at most 40" delivered 25.2 entries on
   * average across the batch - 17 on one resume, whose block held a group of
   * one tool. A ceiling stated hard and a floor stated soft is obeyed on one
   * side only, which is how a 65-word summary floor once produced 52 words.
   *
   * The ceiling went to 45 with it: 35 required against 40 allowed is a
   * ten-entry band, and the trim would have been firing on ordinary blocks.
   */
  const content = promptBody();
  assert.match(content, /THIRTY-FIVE IS A FLOOR/);
  assert.match(content, /At most 45\./);
  assert.match(content, /Five groups need\s+seven entries each/);

  // Prompt and code agree, in both directions.
  const { MAX_SKILL_BLOCK_SIZE } = require('../dist/services/utils/resumeQuality');
  assert.equal(MAX_SKILL_BLOCK_SIZE, 45, 'the code ceiling must match the prompt');
});

test('the prompt says where thirty-five entries come from', () => {
  /*
   * A floor without a procedure is the padding instruction all over again: the
   * cheapest way to reach a number is one thing written five ways, which is
   * what the operator reported two rounds ago.
   *
   * THE CLOUD IS THE MULTIPLIER. "AWS" is one entry; the services a backend
   * engineer on AWS actually touches are ten. Naming the stack a layer at a
   * time is what clears 35 without inventing anything.
   */
  const content = promptBody();
  assert.match(content, /WHERE THIRTY-FIVE COME FROM/);
  assert.match(content, /THE CLOUD, NAMED SERVICE BY SERVICE/);
  assert.match(content, /Lambda, S3, EC2, ECS, RDS, CloudWatch,\s+IAM, SQS/);
  // The other layers, so one of them is not carrying the whole count.
  for (const layer of [/Data stores, and what sits beside them/, /CI and delivery:/, /Testing: the test runner/, /Monitoring: the metrics store/]) {
    assert.match(content, layer);
  }
});

test('the inference the floor requires is bounded, and said out loud', () => {
  /*
   * THE COST, WHICH THE OPERATOR ASKED TO HAVE STATED. No posting names 35
   * tools and these profiles carry no skill list of their own - `skills: []` on
   * every one - so most of a 35-entry block is read off the candidate's work
   * rather than copied from the job description. That is the point of the
   * floor, and it is also its risk, so the prompt bounds it and the log
   * measures it.
   */
  const content = promptBody();
  assert.match(content, /WHAT YOU MAY INFER, AND WHAT YOU MAY NOT/);
  assert.match(content, /the ordinary companions of a\s+tool they plainly used/);
  assert.match(content, /YOU MAY NOT write a tool from an industry they have not worked in/);
  assert.match(content, /a competing tool beside the one\s+they clearly used/);
  assert.match(content, /a tool that\s+postdates the role/, 'the years rule applies to the block too');

  // And the limit that makes it checkable by a person rather than a rule.
  assert.match(content, /EVERY LINE IS A LINE SOMEBODY WILL BE ASKED ABOUT/);
  assert.match(content, /A shorter true block beats a full invented one/);
});

test('a thin group is reported, because it is how the floor is missed', () => {
  // "Security & Performance: Redis" - one tool under a heading of its own, from
  // a delivered resume. Five groups of seven, six of six or seven of five all
  // reach 35; a group of one makes the arithmetic impossible.
  const content = promptBody();
  assert.match(content, /NEVER FEWER THAN FIVE IN A\s+GROUP/);
  assert.match(content, /Security & Performance: Redis/);
  assert.match(content, /merged into its\s+neighbour/);
});
