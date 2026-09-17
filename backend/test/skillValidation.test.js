const assert = require('node:assert/strict');
const test = require('node:test');

const {
  validateHardSkill,
  validateSoftSkill,
  partitionSkills,
  REJECTION_DETAIL,
} = require('../dist/services/utils/skillValidation');
const { readHardSkillRecords } = require('../dist/database/skillsDatabase');

/**
 * The gate the skill blocks pass through, and why it carries a reason.
 *
 * The rejections already happened - a concept, a job title, a prose clause -
 * but each was a `continue` inside whichever function noticed, so the term
 * vanished. That is wrong twice: the keyword was in the posting, so a scanner
 * looks for it, and the operator had no way to see anything had been dropped.
 */

const library = new Set(
  readHardSkillRecords().map((r) => r.skill.trim().toLowerCase().replace(/\s+/g, ' '))
);
const hard = (term) => validateHardSkill(term, library);

test('real technologies pass', () => {
  for (const term of ['Kubernetes', 'PostgreSQL', 'Terraform', 'React', 'Snowflake', 'ArgoCD']) {
    const verdict = hard(term);
    assert.equal(verdict.ok, true, `${term} was refused: ${verdict.ok ? '' : verdict.detail}`);
  }
});

test('an idea is refused, and says so', () => {
  const verdict = hard('Distributed systems');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'concept');
  assert.match(verdict.detail, /idea rather than something you can use/);
});

test('a phrase that is not a name is refused', () => {
  for (const term of ['Full Stack Developer', 'SLA and SLO definition', 'experience']) {
    const verdict = hard(term);
    assert.equal(verdict.ok, false, `${term} was accepted as a skill`);
  }
});

test('a term the library already covers under another name is refused', () => {
  const verdict = hard('SQL query writing');
  assert.equal(verdict.ok, false);
  assert.ok(
    ['covered-by-library-term', 'concept', 'not-a-name'].includes(verdict.reason),
    `unexpected reason ${verdict.reason}`
  );
});

test('a sentence is refused on length before anything else looks at it', () => {
  const verdict = hard('Deep hands-on experience building and operating distributed data platforms at scale');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'too-long');
});

test('a soft skill is a quality, not the posting sentence it came from', () => {
  for (const term of ['Collaboration', 'Mentorship', 'Written communication', 'Ownership']) {
    assert.equal(validateSoftSkill(term).ok, true, `${term} was refused`);
  }

  for (const term of [
    'Ability to work in a fast-paced environment',
    'Able to communicate with stakeholders',
    'Experience with cross-functional teams',
    'Proven track record of delivery',
    'Comfortable with ambiguity',
  ]) {
    const verdict = validateSoftSkill(term);
    assert.equal(verdict.ok, false, `"${term}" was accepted as a soft skill`);
  }
});

test('partitioning keeps both halves, because the rejected half is the caller\'s obligation', () => {
  const { accepted, rejected } = partitionSkills(
    ['Kubernetes', 'Distributed systems', 'PostgreSQL', 'Full Stack Developer'],
    hard
  );

  assert.deepEqual(accepted, ['Kubernetes', 'PostgreSQL']);
  assert.equal(rejected.length, 2);
  assert.deepEqual(rejected.map((r) => r.term).sort(), ['Distributed systems', 'Full Stack Developer']);
  // Every rejection carries something an operator can read.
  for (const verdict of rejected) assert.ok(verdict.detail.length > 10, 'a rejection with no explanation');
});

test('one skill written twice is kept once, and the repeat is reported not dropped silently', () => {
  const { accepted, rejected } = partitionSkills(['Kubernetes', 'kubernetes', 'KUBERNETES'], hard);
  assert.deepEqual(accepted, ['Kubernetes']);
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every((r) => r.reason === 'duplicate'));
});

test('every reason has a sentence attached to it', () => {
  for (const [reason, detail] of Object.entries(REJECTION_DETAIL)) {
    assert.ok(detail && detail.length > 5, `${reason} has no explanation`);
  }
});

test('a blank is refused rather than printed as an empty bullet', () => {
  for (const term of ['', '   ', null, undefined]) {
    assert.equal(hard(term).ok, false);
    assert.equal(validateSoftSkill(term).ok, false);
  }
});
