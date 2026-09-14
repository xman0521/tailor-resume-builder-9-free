const assert = require('node:assert/strict');
const test = require('node:test');

const {
  selectHardSkills,
  isConceptSkill,
  mapConceptToConcreteSkills,
  TARGET_HARD_SKILLS,
  MAX_HARD_SKILLS,
} = require('../dist/services/utils/hardSkillSelection');
const { readHardSkillRecords } = require('../dist/database/skillsDatabase');

const library = readHardSkillRecords();
const librarySkills = new Set(library.map((r) => r.skill.trim().toLowerCase().replace(/\s+/g, ' ')));

const has = (list, name) => list.some((s) => s.toLowerCase() === name.toLowerCase());

test('an idea is not a skill, and a tool is', () => {
  for (const concept of [
    'Microservices', 'Microservices architecture', 'Agile Development', 'CI/CD',
    'Distributed Systems', 'Event-driven architecture', 'Test Automation',
    'API design', 'Caching Strategies', 'SOLID Principles', 'Scalability Analysis',
    'Infrastructure', 'Static Analysis', 'Responsive Design',
  ]) {
    assert.ok(isConceptSkill(concept), `${concept} should be a concept`);
  }

  for (const tool of [
    'Docker', 'Kubernetes', 'React', 'PostgreSQL', 'Terraform', 'Apache Kafka',
    // Products whose names read like concepts. Treating these as ideas would
    // throw away real technologies.
    'Ant Design', 'Solidity', 'Solid.js', 'Power BI', 'Spring Integration',
    'Amazon API Gateway', 'Natural Language Processing',
  ]) {
    assert.ok(!isConceptSkill(tool), `${tool} should be concrete`);
  }
});

test('every concept the table names maps to skills the library actually has', () => {
  // The guard against this table becoming a source of invented skills: a target
  // that is misspelled, or that a later library edit removes, must drop out
  // rather than reach somebody's resume.
  for (const concept of ['Microservices', 'CI/CD', 'Caching', 'Agile Development', 'Observability']) {
    const mapped = mapConceptToConcreteSkills(concept, librarySkills);
    assert.ok(mapped.length > 0, `${concept} should map to something`);
    for (const skill of mapped) {
      assert.ok(
        librarySkills.has(skill.toLowerCase()),
        `${concept} mapped to "${skill}", which is not in the library`
      );
      assert.ok(!isConceptSkill(skill), `${concept} mapped to another concept, "${skill}"`);
    }
  }
});

test('concepts are translated into tools rather than listed', () => {
  const picked = selectHardSkills({
    jobSkills: ['Microservices', 'CI/CD', 'Caching Strategies', 'Agile Development'],
    experienceSkills: [],
    library,
  });

  for (const concept of ['Microservices', 'CI/CD', 'Caching Strategies', 'Agile Development']) {
    assert.ok(!has(picked, concept), `"${concept}" reached the resume as a skill`);
  }
  assert.ok(has(picked, 'Docker'), 'microservices should have produced Docker');
  assert.ok(has(picked, 'Redis'), 'caching should have produced Redis');
  assert.ok(
    has(picked, 'Jenkins') || has(picked, 'GitHub Actions'),
    'CI/CD should have produced a build tool'
  );
  assert.ok(picked.every((skill) => !isConceptSkill(skill)), 'no concept may survive selection');
});

test('one concept cannot spend the whole block on its own toolchain', () => {
  // Every concept is represented before any concept gets a second tool, so a
  // posting naming five things is not answered with three testing tools.
  const picked = selectHardSkills({
    jobSkills: ['Test Automation', 'Infrastructure as Code', 'CI/CD', 'Observability', 'Caching'],
    experienceSkills: [],
    library,
    target: 5,
    max: 5,
  });

  assert.equal(picked.length, 5);
  const testingTools = ['Selenium', 'Playwright', 'Cypress'].filter((t) => has(picked, t));
  assert.ok(testingTools.length <= 1, `test automation took ${testingTools.length} of five slots`);
});

test('what the job asks for outranks what only the profile shows', () => {
  const picked = selectHardSkills({
    jobSkills: ['Kubernetes'],
    experienceSkills: ['Fortran'],
    library,
    target: 2,
    max: 2,
  });
  assert.equal(picked[0], 'Kubernetes');
});

test('a skill the job asks for AND the profile shows comes first of all', () => {
  const picked = selectHardSkills({
    jobSkills: ['Kubernetes', 'Rust'],
    experienceSkills: ['Rust'],
    library,
    target: 2,
    max: 2,
  });
  assert.equal(picked[0], 'Rust', 'asked for and evidenced beats asked for alone');
});

test("the candidate's own history reaches the resume", () => {
  const picked = selectHardSkills({
    jobSkills: ['Python'],
    experienceSkills: ['Django', 'Redis', 'Docker'],
    library,
  });
  for (const skill of ['Django', 'Redis', 'Docker']) {
    assert.ok(has(picked, skill), `${skill} came from the candidate's roles and should be listed`);
  }
});

test('a thin job description still produces a full block', () => {
  const picked = selectHardSkills({ jobSkills: ['Python'], experienceSkills: [], library });
  assert.ok(
    picked.length >= TARGET_HARD_SKILLS - 2,
    `one anchor produced only ${picked.length} skills`
  );
  assert.ok(has(picked, 'Python'));
});

test('the top-up follows the ecosystem, it does not pad with unrelated skills', () => {
  // Weighting the fill by CATEGORY alone answered a one-line Python posting with
  // every language in the library, because one Python match made Languages the
  // heaviest category. A skills block listing fifteen languages is padding.
  const picked = selectHardSkills({ jobSkills: ['Python'], experienceSkills: [], library });
  const languages = new Set(
    library.filter((r) => r.category === 'Languages').map((r) => r.skill.toLowerCase())
  );
  const listed = picked.filter((skill) => languages.has(skill.toLowerCase()));
  assert.ok(listed.length <= 4, `padded with ${listed.length} languages: ${listed.join(', ')}`);

  // And what it did add belongs to Python's world.
  assert.ok(
    ['Django', 'Flask', 'FastAPI', 'Pytest', 'Pandas', 'NumPy'].some((s) => has(picked, s)),
    `nothing from Python's ecosystem was added: ${picked.join(', ')}`
  );
});

test('the block never exceeds the ceiling', () => {
  const many = library
    .filter((r) => !isConceptSkill(r.skill))
    .slice(0, 60)
    .map((r) => r.skill);
  const picked = selectHardSkills({ jobSkills: many, experienceSkills: [], library });
  assert.ok(picked.length <= MAX_HARD_SKILLS, `${picked.length} exceeds the ceiling`);
});

test('a dense posting keeps the skills it named, up to the ceiling', () => {
  // The ceiling was 24 and a posting naming forty technologies lost sixteen of
  // them - Docker, Kubernetes, Kafka, Azure, GraphQL among them. Every one had
  // been asked for by name, and every one is a term the resume is scored on.
  const named = library
    .filter((r) => !isConceptSkill(r.skill))
    .slice(0, 40)
    .map((r) => r.skill);
  const picked = selectHardSkills({ jobSkills: named, experienceSkills: [], library });
  assert.ok(picked.length >= 30, `a dense posting printed only ${picked.length}`);
  const kept = named.filter((s) => has(picked, s));
  assert.equal(kept.length, picked.length, 'everything printed was named by the job');
});

test('raising the ceiling did not loosen the padding', () => {
  // The guarantee that makes the higher ceiling safe: the top-up stops at the
  // TARGET, so the space between target and ceiling can only ever be filled by
  // skills the job or the profile actually named.
  for (const jobSkills of [[], ['Python'], ['Python', 'Docker', 'AWS']]) {
    const picked = selectHardSkills({ jobSkills, experienceSkills: [], library });
    assert.equal(
      picked.length,
      TARGET_HARD_SKILLS,
      `a posting naming ${jobSkills.length} produced ${picked.length}, not the target`
    );
  }
});

test('nothing is invented: every selected skill is a library skill', () => {
  const picked = selectHardSkills({
    jobSkills: ['Microservices', 'Not A Real Skill At All', 'Python'],
    experienceSkills: ['Another Invented Thing'],
    library,
  });
  for (const skill of picked) {
    assert.ok(
      librarySkills.has(skill.toLowerCase()),
      `"${skill}" is on the resume but not in the skill library`
    );
  }
});

test('no duplicates, whatever the input spelling', () => {
  const picked = selectHardSkills({
    jobSkills: ['python', 'Python', 'PYTHON', 'Docker'],
    experienceSkills: ['docker'],
    library,
  });
  const seen = new Set();
  for (const skill of picked) {
    const key = skill.toLowerCase();
    assert.ok(!seen.has(key), `"${skill}" listed twice`);
    seen.add(key);
  }
});

test('the block reaches the target however obscure the job is', () => {
  // The failure this pins, measured across the whole library: 1,105 of 1,165
  // skills used as a lone anchor produced FEWER THAN FIVE. The ecosystem map
  // covered 4% of the library, and when it ran dry the fill stopped after four.
  for (const anchor of ['COBOL', 'Elixir', 'Perl', 'MATLAB', 'Lua', 'Groovy', 'Objective-C', 'Rust']) {
    const picked = selectHardSkills({ jobSkills: [anchor], experienceSkills: [], library });
    assert.ok(
      picked.length >= TARGET_HARD_SKILLS,
      `"${anchor}" alone produced only ${picked.length}: ${picked.join(', ')}`
    );
    assert.ok(has(picked, anchor), `${anchor} itself must survive the fill`);
  }
});

test('a job naming nothing the library knows still produces a block', () => {
  // The fill used to need an already-selected skill to take a category from, so
  // nothing in meant nothing out - an EMPTY Technical Skills section on a real
  // resume, which is worse than any padding.
  const picked = selectHardSkills({ jobSkills: [], experienceSkills: [], library });
  assert.ok(picked.length > 0, 'the block must never be empty');
  assert.ok(picked.length >= TARGET_HARD_SKILLS, `only ${picked.length}`);
  assert.ok(picked.every((s) => !isConceptSkill(s)), 'and it still lists no concepts');
});

test("a job's concepts are translated even when the library has never heard of them", () => {
  // A posting written entirely in abilities names no library term at all. Its
  // concepts are the only thing left to anchor on, and the tools they imply
  // beat anything picked off the top of the library.
  const picked = selectHardSkills({
    jobSkills: [],
    experienceSkills: [],
    library,
    jobConceptSkills: ['Full-stack engineering', 'Cloud computing', 'Agile environment', 'Test automation'],
  });
  assert.ok(picked.length >= TARGET_HARD_SKILLS);
  assert.ok(
    ['AWS', 'Azure', 'Jira', 'Selenium', 'Playwright', 'Cypress'].some((t) => has(picked, t)),
    `nothing implied by the concepts was selected: ${picked.join(', ')}`
  );
  for (const concept of ['Full-stack engineering', 'Cloud computing', 'Agile environment', 'Test automation']) {
    assert.ok(!has(picked, concept), `"${concept}" was listed as a skill`);
  }
});

test('two library rows that print as one skill take one slot', () => {
  // "React" and "React.js" are one line on a resume. Counting them as two meant
  // a block selected at twenty printed at fifteen, because the renaming - and
  // the dedupe that comes with it - happened after the count was finished.
  const canonicalize = (skill) => (/^react(\.js)?$/i.test(skill) ? 'React' : skill);
  const picked = selectHardSkills({
    jobSkills: ['React', 'React.js'],
    experienceSkills: [],
    library,
    canonicalize,
    target: 6, max: 6,
  });
  const reacts = picked.filter((s) => /^react(\.js)?$/i.test(s));
  assert.equal(reacts.length, 1, `got ${reacts.join(', ')}`);
  assert.equal(picked.length, 6, 'and the block is still filled to the target');
});

test('the fill stays proportional rather than emptying one category', () => {
  // The per-category limit is what stopped a one-line Python posting being
  // answered with every language in the library, and the widening rounds must
  // not undo it.
  const picked = selectHardSkills({ jobSkills: ['Python'], experienceSkills: [], library });
  const languages = new Set(
    library.filter((r) => r.category === 'Languages').map((r) => r.skill.toLowerCase())
  );
  const listed = picked.filter((s) => languages.has(s.toLowerCase()));
  assert.ok(listed.length <= 8, `padded with ${listed.length} languages: ${listed.join(', ')}`);
});
