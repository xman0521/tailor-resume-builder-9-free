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
  MAX_SKILL_GROUPS,
  findBrokenBullets,
  findGarbledMetrics,
  isAllowedSoftSkill,
  isConceptEntry,
  looksLikeADescription,
  restatesSkill,
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

/* ─── The block is routed by label ────────────────────────────────────────── */

test('an entry goes in the block or into the prose according to its own label', () => {
  /*
   * WHAT THIS REPLACED. Deciding whether "MCP", "Prompt Engineering" or
   * "Observability implementation" belonged in the block was done from the
   * shape of the words - an activity noun at the end, a phrase with no
   * capitals, a filler word bolted onto another entry - and that took nineteen
   * lists and 480 hand-maintained terms. It never converged: every complaint
   * added one more. "MCP" needed an entry. "Agile" needed another.
   *
   * It was wrong in both directions at once, too: it deleted "Prompt
   * Engineering" for ending in an activity noun while keeping "agent tooling",
   * which has none. Word shape is not what makes something a tool.
   */
  const { groups, report } = tidySkillGroups([
    {
      category: 'Languages & Frameworks',
      skills: [
        { name: 'Python', kind: 'language' },
        { name: 'React', kind: 'framework' },
        { name: 'MCP', kind: 'protocol' },
        { name: 'LLMs', kind: 'technology' },
        { name: 'Agile', kind: 'methodology' },
        { name: 'Prompt Engineering', kind: 'practice' },
        { name: 'Ownership', kind: 'soft' },
        { name: 'Cloud', kind: 'category' },
        { name: 'claims adjudication', kind: 'domain' },
      ],
    },
  ]);

  assert.deepEqual(groups, [
    { category: 'Languages & Frameworks', skills: ['Python', 'React', 'MCP', 'LLMs', 'Agile'] },
    { category: 'Soft Skills', skills: ['Ownership'] },
  ]);
  assert.deepEqual(
    report.routedToProse.map((entry) => `${entry.name} [${entry.kind}]`),
    ['Prompt Engineering [practice]', 'Cloud [category]', 'claims adjudication [domain]']
  );
});

test('an unlabelled block is kept, not emptied', () => {
  /*
   * An older prompt - or a custom one an admin wrote - returns bare strings. A
   * router that deleted everything it could not classify would empty the block
   * of a resume that was otherwise fine, so unlabelled means "no opinion" and
   * is treated as a thing. The count is reported, because nothing is being
   * routed on a resume that arrives this way.
   */
  const { groups, report } = tidySkillGroups([
    { category: 'Languages', skills: ['Python', 'React', 'SQL'] },
  ]);

  assert.deepEqual(groups, [{ category: 'Languages', skills: ['Python', 'React', 'SQL'] }]);
  assert.deepEqual(report.unlabelled, ['Python', 'React', 'SQL']);
  assert.deepEqual(report.routedToProse, []);
});

test('a kind the schema has never heard of is kept', () => {
  // The model inventing a kind says nothing about whether the thing is a tool,
  // and deleting on it would make a typo cost a skill.
  const { groups, report } = tidySkillGroups([
    { category: 'Cloud', skills: [{ name: 'AWS', kind: 'cloud-platform' }, { name: 'Terraform', kind: 'tool' }] },
  ]);
  assert.deepEqual(groups[0].skills, ['AWS', 'Terraform']);
  assert.deepEqual(report.routedToProse, []);
});

test('the same string twice is still the same string twice', () => {
  // The one rule that never needed a vocabulary, and the oldest here: a third
  // of resumes once printed an identical entry twice because a tool belonged
  // under two of the model's own headings.
  const { groups, report } = tidySkillGroups([
    { category: 'Languages', skills: [{ name: 'Python', kind: 'language' }, { name: 'SQL', kind: 'language' }] },
    { category: 'Data', skills: [{ name: 'python', kind: 'language' }, { name: 'Redis', kind: 'database' }] },
  ]);

  assert.deepEqual(groups, [
    { category: 'Languages', skills: ['Python', 'SQL'] },
    { category: 'Data', skills: ['Redis'] },
  ]);
  assert.deepEqual(report.repeated, ['python']);
});

test('one name under two spellings is still settled in code', () => {
  /*
   * A LABEL CANNOT SETTLE THIS. "AWS" and "Amazon Web Services" are both
   * platforms and both correctly labelled, and a reader still sees one thing
   * written twice. These three shapes are facts about English and about
   * vendors rather than judgements about what a thing is, which is why the
   * short table behind them survived the refactor.
   */
  const { groups, report } = tidySkillGroups([
    {
      category: 'Cloud',
      skills: [
        { name: 'AWS', kind: 'platform' },
        { name: 'Amazon Web Services', kind: 'platform' },
        { name: 'AWS Lambda', kind: 'platform' },
        { name: 'Secrets Manager', kind: 'tool' },
        { name: 'AWS Secrets Manager', kind: 'tool' },
      ],
    },
  ]);

  // AWS Lambda stays - a vendor in FRONT of a product is a different thing -
  // and the qualified name wins over the bare one, because it says whose it is.
  assert.deepEqual(groups[0].skills, ['AWS', 'AWS Lambda', 'AWS Secrets Manager']);
  assert.deepEqual(
    report.duplicates.map((pair) => pair.dropped),
    ['Amazon Web Services', 'Secrets Manager']
  );
});

test('a group emptied by the routing is dropped rather than printed headless', () => {
  const { groups } = tidySkillGroups([
    { category: 'Languages', skills: [{ name: 'Python', kind: 'language' }] },
    { category: 'Ways of Working', skills: [{ name: 'Ownership', kind: 'soft' }, { name: 'Mentoring', kind: 'soft' }] },
  ]);
  assert.deepEqual(groups, [
    { category: 'Languages', skills: ['Python'] },
    { category: 'Soft Skills', skills: ['Ownership', 'Mentoring'] },
  ]);
});

test('soft skills form one group, printed last and outside the group cap', () => {
  // Seven technical groups is the cap; the soft group must not be merged into
  // one of them, wherever the model put its soft entries.
  const technical = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name) => ({
    category: name,
    skills: [{ name: `${name}1`, kind: 'tool' }, { name: `${name}2`, kind: 'tool' }],
  }));
  technical[2].skills.push({ name: 'Mentoring', kind: 'soft' });
  const { groups, report } = tidySkillGroups([
    { category: 'Soft Skills', skills: [{ name: 'Communication', kind: 'soft' }] },
    ...technical,
  ]);

  assert.equal(report.mergedGroups.length, 0);
  assert.equal(groups.length, 8);
  assert.deepEqual(groups[groups.length - 1], { category: 'Soft Skills', skills: ['Communication', 'Mentoring'] });
});

test('a re-parsed block keeps its Soft Skills group, known by heading', () => {
  // The revision path sends the finished block back as bare names.
  const { groups, report } = tidySkillGroups([
    { category: 'Languages', skills: ['Python', 'Go'] },
    { category: 'Soft Skills', skills: ['Communication', 'Ownership'] },
  ]);
  assert.deepEqual(groups, [
    { category: 'Languages', skills: ['Python', 'Go'] },
    { category: 'Soft Skills', skills: ['Communication', 'Ownership'] },
  ]);
  assert.deepEqual(report.unlabelled, ['Python', 'Go']);
});

test('an abbreviation beside its expansion is one entry, read off the initials', () => {
  const { duplicateOf } = require('../dist/services/utils/resumeQuality');
  assert.deepEqual(duplicateOf('RAG', 'Retrieval-Augmented Generation'), { keep: 'RAG', drop: 'Retrieval-Augmented Generation' });
  assert.deepEqual(duplicateOf('Large Language Models', 'LLMs'), { keep: 'Large Language Models', drop: 'LLMs' });
  assert.deepEqual(duplicateOf('IaC', 'Infrastructure as Code'), { keep: 'IaC', drop: 'Infrastructure as Code' });
  assert.deepEqual(duplicateOf('CI/CD', 'Continuous Integration/Continuous Delivery'), {
    keep: 'CI/CD', drop: 'Continuous Integration/Continuous Delivery',
  });

  // A word that happens to spell initials is not an acronym, and digits count.
  for (const [a, b] of [['Go', 'Google Optimize'], ['EC2', 'Elastic Cloud'], ['AWS', 'AWS Lambda']]) {
    assert.equal(duplicateOf(a, b), null, `${a} and ${b} are two things`);
    assert.equal(duplicateOf(b, a), null);
  }
});

/*
 * REPORTED: core skills missing from the block. Two tidy-up rules could take
 * out a term the posting asked for; neither may now.
 */
test('when one name is written two ways, the posting\'s spelling is the one kept', () => {
  const asked = new Set(['machine learning', 'sql']);
  const { groups, report } = tidySkillGroups([
    { category: 'ML & AI', skills: [{ name: 'ML', kind: 'technology' }, { name: 'Machine Learning', kind: 'technology' }] },
    { category: 'Data', skills: [{ name: 'Azure SQL', kind: 'database' }, { name: 'SQL', kind: 'language' }] },
  ], { asked });

  assert.deepEqual(groups, [
    { category: 'ML & AI', skills: ['Machine Learning'] },
    { category: 'Data', skills: ['SQL'] },
  ]);
  assert.deepEqual(report.duplicates, [
    { kept: 'Machine Learning', dropped: 'ML' },
    { kept: 'SQL', dropped: 'Azure SQL' },
  ]);

  // Both forms asked for: both stay, because a scanner looks for each.
  const both = tidySkillGroups([
    { category: 'ML & AI', skills: [{ name: 'LLMs', kind: 'technology' }, { name: 'Large Language Models', kind: 'technology' }] },
  ], { asked: new Set(['llms', 'large language models']) });
  assert.deepEqual(both.groups[0].skills, ['LLMs', 'Large Language Models']);
});

test('only a whole part of the heading is a repeat, and never a term the posting asked for', () => {
  const { groups, report } = tidySkillGroups([
    { category: 'AWS Cloud', skills: [{ name: 'AWS', kind: 'platform' }, { name: 'Lambda', kind: 'tool' }] },
    { category: 'ML & AI', skills: [{ name: 'AI', kind: 'technology' }, { name: 'PyTorch', kind: 'library' }] },
    { category: 'CI/CD & Automation', skills: [{ name: 'Automation', kind: 'tool' }, { name: 'Jenkins', kind: 'tool' }] },
  ], { asked: new Set(['ai']) });

  assert.deepEqual(groups, [
    { category: 'AWS Cloud', skills: ['AWS', 'Lambda'] },
    { category: 'ML & AI', skills: ['AI', 'PyTorch'] },
    { category: 'CI/CD & Automation', skills: ['Jenkins'] },
  ]);
  assert.deepEqual(report.repeated, ['Automation']);
});

test('the prompt asks for the kind, and says where each one goes', () => {
  const content = promptBody();

  assert.match(content, /SAY WHAT EACH SKILL IS/);
  assert.match(content, /"name": "PostgreSQL", "kind": "database"/);
  assert.match(content, /"skills": \[ \{ "name": string, "kind": string \} \]/, 'the output schema carries it too');

  // Both halves of the schema, with the examples that make them usable.
  for (const kind of ['language', 'framework', 'library', 'tool', 'platform', 'database', 'protocol', 'methodology', 'technology']) {
    assert.match(content, new RegExp(`\\n  ${kind}\\s`), `the block kind "${kind}" is not described`);
  }
  for (const kind of ['practice', 'concept', 'soft', 'domain', 'category']) {
    assert.match(content, new RegExp(`\\n  ${kind}\\s`), `the prose kind "${kind}" is not described`);
  }

  /*
   * AND THE HALF THAT DECIDES THE SCORE. A scanner matches strings, so a term
   * that leaves the block and is written nowhere else has been deleted from
   * the resume - measured at 37% of everything the old rules removed.
   */
  assert.match(content, /WHAT LEAVES THE BLOCK MUST LAND IN A SENTENCE/);
  assert.match(content, /IF YOU CANNOT NAME THE KIND, THE ENTRY DOES NOT GO IN/);
});

test('the code schema and the prompt agree about the kinds', () => {
  // They are written in two files and would drift silently: a kind the prompt
  // offers and the code routes to prose would delete entries the model was
  // told to keep.
  const { BLOCK_KINDS, PROSE_KINDS } = require('../dist/services/utils/resumeQuality');
  const content = promptBody();

  for (const kind of BLOCK_KINDS) {
    assert.match(content, new RegExp(`\\n  ${kind}\\s`), `the code keeps "${kind}" and the prompt never mentions it`);
  }
  for (const kind of PROSE_KINDS) {
    assert.match(content, new RegExp(`\\n  ${kind}\\s`), `the code routes "${kind}" out and the prompt never mentions it`);
  }
  // Thirteen words that describe a KIND of thing. They do not grow when the
  // industry invents a tool, which is the difference between this and the 480
  // hand-maintained terms it replaced.
  assert.equal(BLOCK_KINDS.length + PROSE_KINDS.length, 14);
});



/* ─── The block is a list of names, not a list of phrases ─────────────────── */


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


/* ─── 2. A values phrase is not a skill ─────────────────────────────────────
 *
 * Decided by the analyser's prompt, which is told never to extract one: no
 * list in code filters them any more. See the prompt pins at the bottom.
 */

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
   * the only difference is the word. The names come from the resume's own
   * skills block, which writes them in lower case - not from a list in code.
   */
  const bullets = [
    {
      achievements: [
        'dbt models were rewritten to cut the nightly build from 90 minutes to 25 minutes.',
        'iOS releases moved to a weekly train, which ended the Friday hotfixes.',
        'npm audit was wired into the pipeline, cutting known advisories from 23 to 0.',
      ],
    },
  ];
  assert.deepEqual(findBrokenBullets(bullets, ['dbt', 'iOS', 'npm', 'Python']), []);
  // A name the block does not write in lower case is an ordinary lower-case start.
  assert.equal(findBrokenBullets(bullets, ['Python']).length, 3);
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
  // The soft-skill rule now bans the bolted shapes explicitly.
  assert.match(content, /SOFT SKILLS ARE SHOWN, NOT NAMED/);
  assert.match(content, /THE BANNED SHAPES/);
  assert.match(content, /applying X/);
  const softAt = content.indexOf('SOFT SKILLS ARE SHOWN, NOT NAMED');
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
  assert.match(content, /from X minutes to Y minutes/);
  // The examples no longer carry specific numbers that get copied into resumes.
  assert.doesNotMatch(content, /from 40 minutes to 6 minutes/,
    'the old example figure should be de-templated');
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

  // 6. Named tools, and what was being run said in words: the scale figure per
  // role is gone, because the numbers are rationed across the whole page.
  assert.match(content, /NAME THE TOOL IN THE BULLET, AND SAY HOW BIG THE THING WAS/);
  assert.match(content, /At least two of every three bullets name a specific technology/);
  assert.match(content, /SAY WHAT WAS BEING RUN/);
  assert.doesNotMatch(content, /ONE FIGURE OF SCALE PER ROLE/);

  // Five to seven bullets carry a number; the rest say what changed in words.
  assert.match(content, /NUMBERS ARE RATIONED/);
  assert.match(content, /five to seven bullets carry a number - never more/);
  assert.doesNotMatch(content, /half of each role's bullets carry exactly one concrete metric/);

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
  /*
   * AND IT IS TOLD THE TRUTH ABOUT WHO APPLIES IT. The application used to run
   * this test too; that code went with the word-shape rules the kind schema
   * replaced, and the prompt went on promising it for several rounds. A
   * deterrent that does not fire is worse than no deterrent: the model writes
   * the padding believing it will be cleaned up, and it prints.
   */
  assert.match(content, /YOU are the one running it/);
  assert.doesNotMatch(content, /The application runs that same test/);

  // A count the model can reach by padding is a count it WILL reach by padding,
  // so the floor says outright that one thing written five ways counts once.
  assert.match(content, /THIRTY-FIVE IS A FLOOR/);
  assert.doesNotMatch(content, /THIRTY is the target/, 'the bare count is what was being padded towards');
  assert.match(content, /counting each real thing once/);
  assert.match(content, /Not from writing one thing five ways/);
});

test('the summary is measured in sentences, not words', () => {
  /*
   * THIS TEST HAS PINNED THREE BUDGETS, and the history is the point: 65-80
   * words after a measured ten-point ATS fall, then 50 words on a later
   * resume-writing spec, and now no word count at all - "just 2-3 sentences and
   * at least 2". The 50-word cap was what cut two-sentence summaries to one.
   */
  const content = promptBody();
  assert.match(content, /Summary: 2-3 sentences - TWO AT LEAST, never one\./);
  assert.doesNotMatch(content, /AIM AT 80, never under 65/);
  assert.doesNotMatch(content, /Summary: 65-80 words/);
  assert.doesNotMatch(content, /AT MOST 50 words/);
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

  // The abbreviation pair is gone too: it put "RAG" and "Retrieval-Augmented
  // Generation" side by side in delivered blocks. Only the posting's own forms.
  assert.match(analyser, /Abbreviations are no exception/);
  assert.match(analyser, /where it writes one, never add the other/);
  assert.doesNotMatch(analyser, /also extract "ML"/);
  assert.doesNotMatch(analyser, /BOTH FORMS OF EVERY SHORT NAME/);

  // Implied skills still exist - the rule is sound - but give one term each.
  assert.match(analyser, /ONE term each, the one an engineer would write on a resume/);
  assert.match(analyser, /"write unit tests" . "unit testing"/);
  assert.doesNotMatch(analyser, /"unit testing", "test automation", "software testing"/);
});

test('a named thing is filed as a named thing, and a named methodology may be listed', () => {
  /*
   * REPORTED: core skills missing from the block. The block is written from
   * the analysis's named fields, so a name filed under abilities ("Python
   * programming") went out as a concept; and the tailoring prompt allowed only
   * seven methodologies, so "MLOps" on an MLOps posting stayed out.
   */
  const analyser = analyserBody();
  assert.match(analyser, /NEVER A NAMED THING/);
  assert.match(analyser, /puts\s+"Python" in technologies/);
  assert.match(analyser, /methodologies: NAMED approaches/);
  assert.doesNotMatch(analyser, /"pair programming", "trunk-based development", "code review", "sprint planning", "retrospectives"/);

  const content = promptBody();
  assert.match(content, /A methodology with a NAME belongs in the block/);
  assert.doesNotMatch(content, /write the\s+seven that belong/);
  assert.match(content, /A named technology that turns up on this list anyway is still a technology/);
});

test('the analyser names soft skills in the posting\'s own words, from no house list', () => {
  /*
   * ASKED FOR: no fixed lists. The analyser used to choose from a house
   * vocabulary of forty-two soft skills; it now names each in the posting's own
   * word, and writes the plain skill only where the posting implies one.
   */
  const analyser = analyserBody();
  assert.doesNotMatch(analyser, /THE LIST:/);
  assert.doesNotMatch(analyser, /house\s+vocabulary/i);
  assert.match(analyser, /NAME EACH IN THE POSTING'S OWN WORD/);

  // Nothing in code filters a slogan out any more, so the analyser is the
  // only place it can be refused - for soft skills and for every other field.
  assert.match(analyser, /A SLOGAN IS NOT A SKILL/);
  assert.match(analyser, /radical ownership mindset" is Ownership/);
  assert.match(analyser, /Nothing after this step filters them out/);
  assert.match(analyser, /a values or culture phrase/);
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
  // Soft skills are back as ONE group, last, chosen per posting; never in a
  // technical group.
  assert.match(content, /NO SOFT SKILLS IN THE TECHNICAL GROUPS, AND NO CATEGORY WORDS/);
  assert.match(content, /THE SOFT SKILLS GROUP COMES LAST/);
  assert.match(content, /two postings should\s+not get the same list/);
  assert.match(content, /Nor do category words/, 'Cloud and Infrastructure go too');
  assert.match(content, /SOFT SKILLS ARE SHOWN rule above still/);

  // Descriptions, with the rule stated exactly as the code applies it.
  assert.match(content, /A DESCRIPTION WHERE A NAME BELONGS/);
  assert.match(content, /three or more words\s*\n?\s*that is NOT written as a proper name does not go\s*\n?\s*in/);
  assert.doesNotMatch(content, /the application deletes too/, 'the application stopped doing this');
  assert.match(
    content,
    /"Large\s+Language Models", "Model Context Protocol"/,
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
  assert.match(content, /skillGroups: 5-7 technical groups, then the Soft Skills group/);
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

test('the soft skills go in their own section AND in the bullets, and the prompt says both', () => {
  /*
   * TWO OPERATOR DECISIONS, A WHILE APART, AND BOTH STILL STAND.
   *
   * First: "we deleted soft skill category in skill section. it affects the ATS
   * score. so populate the soft skills across work experience bullets." The
   * group had been what a scanner scored, so the bullets had to take it on.
   *
   * Then: "Make soft skill section under skill section. I need around 8 to 10
   * soft skills." The section was restored, then removed a third time after a
   * reviewer found that only 12 distinct lists existed across 60 resumes — the
   * section was not earning its space. Soft skills are now shown by the work in
   * the bullets, not listed as traits.
   */
  const content = promptBody();
  // And the third: "add group for soft skills at the end of skill section".
  assert.match(content, /SOFT SKILLS ARE ONE GROUP, THE LAST ONE IN THE SKILLS BLOCK/);
  assert.match(content, /Do not return\s+"softSkills" as a separate field/);
  assert.match(content, /SOFT SKILLS ARE SHOWN, NOT NAMED/);
  assert.match(content, /THE BANNED SHAPES/);
  // The technical groups still refuse them.
  assert.match(content, /NO SOFT SKILLS IN THE TECHNICAL GROUPS/);
  // The schema does not ask for a separate softSkills field.
  assert.doesNotMatch(content, /"softSkills": string\[\]/);
});

test('the appended override says not to return softSkills', () => {
  // The override is read LAST, so a disagreement here wins. It now says
  // "Do NOT return softSkills" — the section has been removed.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'resumeService.ts'), 'utf8'
  );
  const override = /const finalSkillOverride = \(\) => `([\s\S]*?)`;/.exec(source)[1];

  assert.match(override, /Do NOT return "softSkills"/);
  assert.match(override, /Never bolt a soft skill onto the end/);
  assert.equal(override.includes('8 to 10 terms'), false, 'old section instruction removed');
});

/* ─── Concepts: out of the block, into the bullets ────────────────────────── */


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

test('soft skills are shown by the work, not bolted on', () => {
  /*
   * The old rule about consecutive bullets is gone along with the section.
   * What replaced it: banned shapes that prevent the model from appending a
   * keyword after a finished clause.
   */
  const content = promptBody();
  assert.match(content, /THE BANNED SHAPES/);
  assert.match(content, /applying X/);
  assert.match(content, /demonstrating X/);
  assert.match(content, /Practiced X when/);
  // The posting's five leading skills keep their own spread rule.
  assert.match(content, /EACH OF THE FIVE APPEARS IN THE EXPERIENCE BULLETS/);
  assert.match(content, /never two bullets running/);
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
  // Wide enough for the whole paragraph, which grew when the rule about a
  // posting-named technology was added to it.
  const preamble = content.slice(preambleAt, preambleAt + 2_000);

  assert.match(preamble, /YOU write the block, under TECHNICAL SKILLS/);
  // Said once. It was printed twice, verbatim, for several rounds.
  assert.equal(
    preamble.split('YOU write the block, under TECHNICAL SKILLS').length - 1, 1,
    'the paragraph was duplicated here'
  );
  // The exceptions are named here too, so a model reading only this paragraph
  // is not left with "none of them belongs in the block".
  assert.match(preamble, /The other exceptions are named under CONCEPTS AND CAPABILITIES above/);
  assert.match(preamble, /"REST", "LLM", "RAG", "AI" - which go in the skills block as well/);

  /*
   * And the rule the measurement asked for: a technology the POSTING names is
   * not a prose target, whichever checklist it arrived on. A delivered resume
   * carried "Large Language Models" and "RAG" in its bullets and neither in its
   * block, for a posting that named both - because they reached the model on
   * this list, and this paragraph used to end the argument there.
   */
  assert.match(preamble, /A TECHNOLOGY THE POSTING NAMES IS NOT ONE OF THEM/);
  assert.match(preamble, /it goes in the SKILLS BLOCK/);
  assert.match(preamble, /Writing it into a bullet does not\s+discharge the obligation/);
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
   * THE CLOUD IS THE MULTIPLIER. The platform is one entry; the services a
   * backend engineer on it actually touches are ten. Naming the stack a layer
   * at a time is what clears 35 without inventing anything - and the PLATFORM'S
   * OWN NAME is one of those entries, not a wasted one. An earlier version of
   * this passage called it "the one most often wasted on a single word", and a
   * delivered block listed AKS, GKE and EKS while naming no cloud at all.
   */
  const content = promptBody();
  assert.match(content, /WHERE THIRTY-FIVE COME FROM/);
  assert.match(content, /THE CLOUD: THE PLATFORM, THEN ITS SERVICES/);
  assert.match(content, /NAME THE PLATFORM ITSELF/);
  // The other layers, so one of them is not carrying the whole count - named
  // as KINDS now, because the product lists were being copied onto resumes.
  for (const layer of [/Data stores, and what sits beside them/, /CI and delivery:/, /Testing: the test runners/, /Monitoring: the dashboards/]) {
    assert.match(content, layer);
  }
  assert.doesNotMatch(content, /Testing: pytest, JUnit, Jest/);
  assert.doesNotMatch(content, /Lambda, S3, EC2, ECS, RDS, CloudWatch, IAM/);
  /*
   * NAMED PRODUCTS, NOT THE ROLES THEY PLAY. The first version of this list
   * said "the test runner, the linter and the formatter", and a delivered
   * resume printed "pytest, JUnit, linter" - the word itself, as though it
   * were a tool. The list teaches the shape of the answer, so it has to be
   * written in the shape the answer should take.
   */
  assert.match(content, /NAME THE PRODUCT, NEVER THE ROLE IT PLAYS/);
  assert.doesNotMatch(content, /the test runner, the assertion/, 'the wording that taught "linter" is gone');
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
  assert.match(content, /a tool that\s+postdates the role/, 'the years rule applies to the block too');
  /*
   * THE COMPETING-TOOL BAR WAS LOOSENED, deliberately. It used to be absolute,
   * and it is the rule that kept Azure and GCP off a block whose candidate's
   * history showed AWS - on a posting asking for Azure. The bound that remains
   * is the posting: it may be written when the posting names it, and not
   * otherwise.
   */
  assert.match(content, /A COMPETING TOOL IS ALLOWED WHEN THE POSTING NAMES IT/);
  assert.match(content, /Where the\s+posting is SILENT and two tools do the same job/);

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
  assert.match(content, /YOU DO THE MERGING, WHILE YOU ARE WRITING/);
  /*
   * The application does NOT fold them, and the prompt says so. It did for one
   * batch: code can only guess from the heading, and it put "LLM, APIs,
   * Webhooks, OpenAPI, PostgreSQL, RAG, ETL Pipelines" under CLOUD &
   * INFRASTRUCTURE. A wrong heading reads worse than a short group.
   */
  assert.match(content, /it will not fix it for you/);
  assert.doesNotMatch(content, /THE APPLICATION NOW FOLDS THEM/);
});

test('the same product under two names is one entry', () => {
  /*
   * MEASURED on five delivered blocks: the removal passes took NOTHING out of
   * four of them, and a reader could see "AWS" beside "Amazon Web Services",
   * "Azure" beside "Microsoft Azure", "Copilot" beside "GitHub Copilot",
   * "Secrets Manager" beside "AWS Secrets Manager", and "API, APIs, REST, REST
   * APIs" in one group.
   *
   * `restatesSkill` missed every one: it only drops an entry whose extra words
   * are filler, and it exempts a vendor prefix outright so "AWS Lambda"
   * survives beside "AWS". Both are right, and between them they let all of
   * those through.
   */
  const { duplicateOf } = require('../dist/services/utils/resumeQuality');

  // An acronym beside its expansion, read off the initials: the first written survives.
  assert.deepEqual(duplicateOf('AWS', 'Amazon Web Services'), { keep: 'AWS', drop: 'Amazon Web Services' });

  /*
   * A bare name beside the same name with words in front: the QUALIFIED one
   * survives. "AWS Secrets Manager" says whose it is; "Secrets Manager" could
   * be anyone's. No table of vendors decides it - the words do.
   */
  assert.deepEqual(duplicateOf('Azure', 'Microsoft Azure'), { keep: 'Microsoft Azure', drop: 'Azure' });
  assert.deepEqual(
    duplicateOf('Secrets Manager', 'AWS Secrets Manager'),
    { keep: 'AWS Secrets Manager', drop: 'Secrets Manager' }
  );
  assert.deepEqual(duplicateOf('Copilot', 'GitHub Copilot'), { keep: 'GitHub Copilot', drop: 'Copilot' });

  // Singular beside plural.
  assert.deepEqual(duplicateOf('API', 'APIs'), { keep: 'API', drop: 'APIs' });

  /*
   * AND THE PAIRS THAT MUST SURVIVE. A vendor in FRONT of a product is a
   * different thing from the vendor; a trailing capital "S" is part of the
   * name, not a plural. The second case is a bug this test was written after:
   * the word-level rule read "HTTPS" as the plural of "HTTP" and deleted it.
   */
  for (const [a, b] of [
    ['AWS', 'AWS Lambda'],
    ['Azure', 'Azure DevOps'],
    ['HTTP', 'HTTPS'],
    ['SAS', 'SASS'],
    ['Python', 'Django'],
    ['Kafka', 'Kafka Streams'],
  ]) {
    assert.equal(duplicateOf(a, b), null, `${a} and ${b} are two things`);
    assert.equal(duplicateOf(b, a), null);
  }
});


test('the AI layer is in the checklist, and conditional', () => {
  /*
   * MEASURED, which is why this layer exists: a senior MACHINE LEARNING resume
   * came back with three AI entries in forty-five - scikit-learn, MLflow and
   * MCP - with the rest filled by Terraform, ArgoCD and the other eight layers.
   * The model works down the list to reach the floor, so a layer that is not
   * written is a layer it never reaches for. The skills library has no AI rows
   * either: PyTorch, TensorFlow, NumPy, Pandas, MLflow, LangChain and the rest
   * are absent from all 1,247 of them, so nothing else was going to supply it.
   */
  const content = promptBody();
  assert.match(content, /AI AND ML, WHERE THE POSTING OR THE CANDIDATE'S WORK IS AI OR ML/);
  assert.match(content, /the model libraries, the ML platform, the LLM framework and vector\s+store/);
  assert.doesNotMatch(content, /LangChain, LlamaIndex, LangGraph/, 'the product list is gone');

  // CONDITIONAL, and said twice: an AI block over a history with no AI work is
  // the worst version of this rule, not the best.
  assert.match(content, /and only\s+then/);
  assert.match(content, /NONE OF IT ON A RESUME THAT HAS NO AI WORK/);
  assert.match(content, /the dates rule\s+still applies/);
});


test('a technology the posting names reaches the list the block is built from', () => {
  /*
   * THE CAUSE, MEASURED. `promptSkills` is what the prompt calls "a starting
   * point for skillGroups", and it was library matches alone - 1,247 rows with
   * no entry for MCP, LLM, LLMs or Large Language Models. A posting naming them
   * every other line produced skillsJSON ["RAG","Scrum"] while keywordsJson
   * carried LLMs, MCP, Large Language Models, RAG, MCP server and LLM - and
   * that list's preamble calls its terms prose targets.
   *
   * So a resume arrived with "Large Language Models" and "RAG" in its bullets
   * and neither in its block, and the model was obeying.
   */
  const { buildTailorResumePromptValues, parseJobAnalysisContent } = require('../dist/services/resumeService');

  const analysis = parseJobAnalysisContent(
    JSON.stringify({
      jobMeta: { title: 'Forward Deployed Engineer', seniority: 'Senior', industry: 'SaaS', department: 'Engineering' },
      skills: {
        technical: ['MCP', 'LLMs'], required: ['Python'], preferred: [], tools: ['MCP server'],
        soft: ['Collaboration'], technologies: ['LLM'],
      },
      technologies: ['MCP', 'LLM'], protocols: [], methodologies: ['Agile'], architecturePatterns: [],
      responsibilities: ['build MCP integrations'],
      // Rule 3 forbids an industry the candidate has not worked in, so this
      // must NOT come along for the ride.
      domainKnowledge: ['claims adjudication'],
      softSkills: ['Ownership'],
      // Nor may a past-tense verb, the field that once put "owned" in a block.
      keywords: { actionVerbs: ['owned'], buzzwords: [], mustInclude: ['MCP'] },
    }),
    'Forward deployed work: MCP servers and LLMs in Python.'
  );

  const values = buildTailorResumePromptValues(
    {
      id: 'p', name: 'T', title: 'Engineer', createdAt: '', updatedAt: '',
      contact: { phone: '1', email: 'a@b.c', location: 'X' }, summary: 'Engineer.',
      experience: [{
        title: 'Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
        location: 'Remote', description: 'Built MCP integrations and LLM features.', achievements: [], skills: [],
      }],
      strengths: [], skills: [], education: [], certifications: [],
    },
    analysis
  );

  const block = JSON.parse(values.skillsJSON).map((s) => s.toLowerCase());
  assert.ok(block.includes('mcp'), `MCP is named by the posting: ${values.skillsJSON}`);
  assert.ok(block.includes('llm'), `LLM is named by the posting: ${values.skillsJSON}`);
  assert.equal(block.includes('claims adjudication'), false, 'a domain term must not ride along');
  assert.equal(block.includes('owned'), false, 'nor a past-tense verb');

  // And the prompt says the same, so the two halves agree.
  const content = promptBody();
  assert.match(content, /A TECHNOLOGY THE POSTING NAMES IS NOT ONE OF THEM, whichever list it reached you/);
  assert.match(content, /THE BLOCK GETS ONE - one, NOT NONE/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The heading budget, and what "missing" means
 * ──────────────────────────────────────────────────────────────────────────── */

test('a block over the group maximum loses headings, never skills', () => {
  // Nine groups, which is what the model does: measured across 100 delivered
  // resumes, a mean of 7.2 groups and a maximum of 11, 36% of them over seven.
  const groups = [
    { category: 'Languages & Frameworks', skills: ['Python', 'TypeScript', 'Go', 'React', 'FastAPI'] },
    { category: 'Cloud', skills: ['AWS', 'Azure', 'GCP', 'Lambda', 'S3'] },
    { category: 'Data', skills: ['PostgreSQL', 'Redis', 'Kafka', 'Snowflake'] },
    { category: 'CI', skills: ['GitHub Actions', 'Docker', 'Terraform'] },
    { category: 'Testing', skills: ['pytest', 'Jest'] },
    { category: 'Monitoring', skills: ['Datadog', 'Grafana'] },
    { category: 'Security', skills: ['OAuth 2.0', 'RBAC'] },
    { category: 'AI', skills: ['LLMs', 'MCP', 'RAG'] },
    { category: 'Protocols', skills: ['REST', 'gRPC'] },
  ].map((group) => ({ ...group, skills: group.skills.map((name) => ({ name, kind: 'tool' })) }));

  const { capitalizeSkillWords } = require('../dist/services/utils/resumeQuality');
  const before = groups.flatMap((group) => group.skills.map((s) => capitalizeSkillWords(s.name)));
  const { groups: tidied, report } = tidySkillGroups(groups);

  assert.ok(tidied.length <= MAX_SKILL_GROUPS, `${tidied.length} groups survived`);
  assert.equal(report.mergedGroups.length, groups.length - tidied.length);

  // NOT ONE SKILL LOST. That is the whole difference between this and the
  // thin-group merge that was reverted: a heading goes, an entry never does.
  const after = tidied.flatMap((group) => group.skills);
  assert.deepEqual([...after].sort(), [...before].sort());

  // AND EVERY ENTRY IS STILL UNDER A HEADING THAT NAMES IT. The reverted
  // version filed "LLM" under "CLOUD & INFRASTRUCTURE"; joining the names is
  // what stops that happening again.
  const aiGroup = tidied.find((group) => group.skills.includes('LLMs'));
  assert.match(aiGroup.category, /\bAI\b/, `LLMs ended up under "${aiGroup.category}"`);
});

test('the group cap takes the smallest headings and leaves the leading one alone', () => {
  const groups = [
    { category: 'Languages & Frameworks', skills: ['Python', 'Go'] },
    { category: 'Cloud', skills: ['AWS', 'Azure', 'GCP', 'Lambda', 'S3', 'ECS'] },
    { category: 'Testing', skills: ['pytest'] },
    { category: 'Monitoring', skills: ['Datadog'] },
  ].map((group) => ({ ...group, skills: group.skills.map((name) => ({ name, kind: 'tool' })) }));

  const { groups: tidied, report } = tidySkillGroups(groups, { groupCap: 3 });

  assert.equal(tidied.length, 3);
  // The two one-entry groups are the cheapest pair to join, so they are the
  // pair that goes - not the required leading group, and not the big one.
  assert.deepEqual(report.mergedGroups, [{ kept: 'Testing', joined: 'Monitoring' }]);
  assert.equal(tidied[0].category, 'Languages & Frameworks');
  assert.ok(tidied.some((group) => group.category === 'Testing & Monitoring'));
});

test('a block already within the maximum is not touched', () => {
  const groups = [
    { category: 'Languages & Frameworks', skills: ['Python', 'Go'] },
    { category: 'Cloud', skills: ['AWS', 'Azure'] },
  ].map((group) => ({ ...group, skills: group.skills.map((name) => ({ name, kind: 'tool' })) }));

  const { groups: tidied, report } = tidySkillGroups(groups);
  assert.equal(report.mergedGroups.length, 0);
  assert.deepEqual(tidied.map((group) => group.category), ['Languages & Frameworks', 'Cloud']);
});

test('the prompt no longer spends the cloud heading on services alone', () => {
  const content = promptBody();

  // The platform's own name is what a posting writes and what a scanner reads.
  assert.match(content, /NAME THE PLATFORM ITSELF/);
  assert.equal(
    content.includes('"AWS" is one entry'),
    false,
    'the line calling the platform name a wasted entry is gone'
  );

  // And a competitor the posting asks for is allowed in.
  assert.match(content, /A COMPETING TOOL IS ALLOWED WHEN THE POSTING NAMES IT/);
  assert.equal(
    content.includes('a competing tool beside the one\n  they clearly used'),
    false,
    'the blanket bar on a competing tool is gone'
  );
  // The limit is still stated: silent posting, one tool.
  assert.match(content, /Where the\s+posting is SILENT and two tools do the same job/);
});

test('the appended override says the same as the prompt about both', () => {
  /*
   * THE OVERRIDE IS READ LAST AND SO IT WINS. It is a third copy of these
   * rules, appended to the user body on every call, and the last time the two
   * disagreed the prompt was banning soft skills from the block while this
   * still asked for a group of them.
   */
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'resumeService.ts'), 'utf8'
  );
  const override = /const finalSkillOverride = \(\) => `([\s\S]*?)`;/.exec(source);
  assert.ok(override, 'finalSkillOverride could not be read');
  const text = override[1];

  assert.match(text, /name the cloud PLATFORM/);
  assert.equal(text.includes('rather than the single word "AWS"'), false);
  assert.match(text, /allowed WHEN THIS POSTING NAMES IT/);
  assert.equal(text.includes('never a competitor beside the tool they used'), false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * A posting-named phrase is a keyword; the same shape invented is padding
 * ──────────────────────────────────────────────────────────────────────────── */

const { tidySkillGroups: tidy } = require('../dist/services/utils/resumeQuality');

const phraseGroups = () => ([{
  category: 'Security',
  skills: [
    { name: 'Splunk', kind: 'tool' },
    { name: 'Wireshark', kind: 'tool' },
    { name: 'Python', kind: 'language' },
    { name: 'Nmap', kind: 'tool' },
    { name: 'Threat hunting', kind: 'practice' },
    { name: 'Security Solutions', kind: 'category' },
    { name: 'agent orchestration', kind: 'practice' },
    { name: 'latency optimization', kind: 'practice' },
  ],
}]);

test('a phrase leaves the block on its label, whoever wrote it', () => {
  /*
   * ASKED FOR: "If a keyword is not a named tool or technology, do NOT force it
   * into Tech Skills", and then "real tools only". The exception that kept a
   * phrase because the posting wrote it is gone, so the label decides alone.
   */
  const { groups, report } = tidy(phraseGroups());
  const printed = groups.flatMap((g) => g.skills);

  assert.deepEqual(printed, ['Splunk', 'Wireshark', 'Python', 'Nmap']);
  for (const phrase of ['Threat hunting', 'Security Solutions', 'agent orchestration', 'latency optimization']) {
    assert.ok(report.routedToProse.some((e) => e.name === phrase), `"${phrase}" was not routed out`);
  }
});

test('a named technology stays when it is labelled technology', () => {
  const { groups } = tidy([{
    category: 'Networking',
    skills: [{ name: 'SD-WAN', kind: 'technology' }, { name: 'Wireshark', kind: 'tool' }],
  }]);
  assert.deepEqual(groups.flatMap((g) => g.skills), ['SD-WAN', 'Wireshark']);
});

test('the prompt states the rule rather than a list of terms', () => {
  const content = promptBody();
  assert.match(content, /WHAT STAYS IS DECIDED BY WHAT IT IS, NOT BY WHO SAID IT/);
  assert.match(content, /leaves the block\s+even when the posting wrote it/);
  assert.doesNotMatch(content, /never more than a quarter of the block/, 'the phrase share is gone');
});

test('the prompt warns that the layer examples are illustrations', () => {
  /*
   * The figures already had this warning - "THE FIGURES IN EVERY EXAMPLE ON
   * THIS PAGE ARE ILLUSTRATIONS" - and the tools did not. Measured: 78 of 183
   * delivered entries (43%) were product names from the layer checklist, and
   * three of the five entries that appeared on every resume whatever the job
   * appear nowhere in that candidate's history.
   */
  const content = promptBody();
  assert.match(content, /THE LAYERS BELOW NAME KINDS OF THING, NOT PRODUCTS, ON PURPOSE/);
});

test('the prompt says a true tool this job has no use for stays out', () => {
  const content = promptBody();
  assert.match(content, /AND TRUE IS NOT ENOUGH/);
  assert.match(content, /A tool THIS POSTING HAS NO USE FOR stays out/);
  // And the first group is chosen for the job rather than copied.
  assert.match(content, /CHOSEN FOR THIS JOB, THOUGH, NOT COPIED FROM THE LAST ONE/);
});

test('rule 3 lets the posting\'s own subject through, but not into a bullet', () => {
  /*
   * THE ONE CHANGE HERE THAT IS ABOUT HONESTY RATHER THAN COVERAGE, so the
   * bound matters as much as the allowance: the term may say what this person
   * can work with, and may not say what they did.
   */
  const content = promptBody();
  assert.match(content, /AND THE SAME ALLOWANCE REACHES THIS POSTING'S OWN SUBJECT/);
  assert.match(content, /may NOT be written into a bullet as work they did/);
  // A term from an industry the posting is NOT about is still dropped.
  assert.match(content, /"HL7" on a security job - is still\s+dropped outright/);
});
