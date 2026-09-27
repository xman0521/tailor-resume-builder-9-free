const assert = require('node:assert/strict');
const test = require('node:test');

const {
  countFigures,
  parseJobAnalysisContent,
  parseTailoredResumeContent,
} = require('../dist/services/resumeService');

/**
 * Eight bullets under a role, and the right eight.
 *
 * A delivered resume carried twenty-two under one company. The prompt has said
 * "maximum 8" the whole time, so the rule needed enforcing rather than
 * restating - and the interesting half is WHICH eight survive: the fourteen
 * that go are carrying keywords, and taking the first eight would drop whatever
 * the model happened to write late, including terms that appear nowhere else.
 */

const profile = () => ({
  id: 'p', name: 'Bullet Probe', title: 'Software Engineer',
  profileSettings: {},
  contact: { phone: '1', email: 'a@b.c', location: 'Austin, TX' },
  summary: 'Engineer.',
  experience: [{
    title: 'Senior Software Engineer', company: 'Samsara', startDate: '03/2019', endDate: 'Present',
    location: 'Remote', description: '', achievements: ['Did work.'], skills: [],
  }],
  strengths: [], skills: [], education: [], certifications: [], createdAt: '', updatedAt: '',
});

const analysis = () => parseJobAnalysisContent(JSON.stringify({
  jobMeta: { title: 'Senior ML Engineer', seniority: 'Senior', industry: 'SaaS', department: 'Engineering' },
  skills: {
    technical: [], required: ['Python', 'PyTorch', 'TensorFlow', 'LangChain', 'Kubernetes'],
    preferred: ['Airflow'], tools: ['Python', 'PyTorch', 'TensorFlow', 'LangChain', 'Kubernetes', 'Airflow'],
    soft: [], technologies: [],
  },
  technologies: [], protocols: [], methodologies: [], architecturePatterns: [],
  responsibilities: [], domainKnowledge: [], softSkills: [],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
}), 'An ML role using Python, PyTorch, TensorFlow, LangChain, Kubernetes and Airflow.');

const answer = (bullets) => JSON.stringify({
  title: 'Model Title',
  summary: 'Engineer of 9 years on machine learning platforms.',
  experience: [{
    title: 'Senior Software Engineer', company: 'Samsara', startDate: '03/2019', endDate: 'Present',
    location: 'Remote', description: '', achievements: bullets,
  }],
  skillGroups: [{ category: 'Languages', skills: ['Python'] }],
  coverLetter: 'x',
});

const printed = (bullets) => parseTailoredResumeContent(answer(bullets), profile(), analysis())
  .experience[0].achievements;

test('a role is capped at eight bullets', () => {
  const many = Array.from({ length: 22 }, (_value, index) => `Built telemetry workflow number ${index + 1} for the fleet.`);
  const kept = printed(many);
  assert.equal(kept.length, 8);
  // Every survivor is the model's own sentence, unedited.
  for (const bullet of kept) assert.ok(many.includes(bullet), bullet);
  // And they are printed in the order the model wrote them.
  const positions = kept.map((bullet) => many.indexOf(bullet));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test('the eight that survive are the ones carrying the keywords', () => {
  // Ten bullets: the last five carry the posting's technologies, the first five
  // carry nothing. Taking the first eight would drop three of the five.
  const empty = Array.from({ length: 5 }, (_value, index) => `Attended the weekly review meeting number ${index + 1}.`);
  const loaded = [
    'Built model training jobs in Python for vehicle telemetry.',
    'Compared PyTorch detections against production traffic before release.',
    'Moved TensorFlow inference behind a service boundary.',
    'Wired LangChain tool calls into the operational workflow.',
    'Ran the inference workers on Kubernetes across three clusters.',
  ];
  const kept = printed([...empty, ...loaded]);

  assert.equal(kept.length, 8);
  for (const bullet of loaded) {
    assert.ok(kept.includes(bullet), `dropped a bullet carrying a posting term: ${bullet}`);
  }
});

test('a figure breaks a tie, because the page needs five of them', () => {
  // Twelve bullets, none carrying a posting term, four carrying numbers.
  const plain = Array.from({ length: 8 }, (_value, index) => `Reviewed the operational workflow for area ${String.fromCharCode(65 + index)}.`);
  const measured = [
    'Cut nightly reconciliation from 40 minutes to 12.',
    'Reduced retained payload size by 18% across the fleet.',
    'Dropped manual deployment steps from 7 to 3.',
    'Held alert volume under 20 a week after the rollout.',
  ];
  const kept = printed([...plain, ...measured]);

  assert.equal(kept.length, 8);
  const keptFigures = countFigures({ experience: [{ achievements: kept }] });
  assert.ok(keptFigures >= 4, `the measured bullets were dropped: ${keptFigures} figures left`);
});

test('a role under the cap is untouched, and the cap can be moved', () => {
  const few = ['Built model training jobs in Python.', 'Ran inference on Kubernetes.'];
  assert.deepEqual(printed(few), few);

  const pinned = process.env.RESUME_MAX_BULLETS;
  process.env.RESUME_MAX_BULLETS = '4';
  try {
    const many = Array.from({ length: 9 }, (_value, index) => `Built workflow ${index + 1} for the fleet.`);
    assert.equal(printed(many).length, 4);
  } finally {
    if (pinned === undefined) delete process.env.RESUME_MAX_BULLETS;
    else process.env.RESUME_MAX_BULLETS = pinned;
  }
});
