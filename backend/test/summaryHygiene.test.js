const assert = require('node:assert/strict');
const test = require('node:test');

const { parseJobAnalysisContent, parseTailoredResumeContent } = require('../dist/services/resumeService');

const analysis = parseJobAnalysisContent(
  JSON.stringify({
    jobMeta: { title: 'Senior Engineer', seniority: 'Senior', industry: 'Financial Services', department: 'Engineering' },
    skills: { technical: ['Java'], tools: [], soft: [] },
    responsibilities: [], domainKnowledge: [],
    keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
  }),
  'Senior engineer for financial services platforms. Java.'
);

function profile() {
  return {
    id: 'p', name: 'A Person', title: 'Senior Engineer', totalYearsExperience: 7,
    contact: { phone: '1', email: 'a@b.c', location: 'X' },
    summary: 'Engineer.',
    experience: [
      {
        title: 'Senior Engineer', company: 'Capital One', startDate: '01/2018', endDate: 'Present',
        location: 'VA', description: 'Worked on platforms.', achievements: [], skills: [],
      },
      {
        title: 'Engineer', company: 'Northwind Payments', startDate: '01/2016', endDate: '12/2017',
        location: 'VA', description: 'Worked on payments.', achievements: [], skills: [],
      },
    ],
    strengths: [], skills: [], education: [], certifications: [], createdAt: '', updatedAt: '',
  };
}

function summaryFrom(text) {
  const p = profile();
  return parseTailoredResumeContent(
    JSON.stringify({ title: 'Senior Engineer', summary: text, experience: p.experience, strengths: [], coverLetter: 'x' }),
    p,
    analysis
  ).summary;
}

test('a span of experience is written as a numeral', () => {
  assert.match(summaryFrom('Seven years of engineering work shaped a practice.'), /\b7 years\b/);
  assert.match(summaryFrom('A seven-year career spanning payments.'), /\b7-year\b/);
  assert.match(summaryFrom('Twelve years of platform work.'), /\b12 years\b/);
});

test('a word-number that is not a span of time is left alone', () => {
  // "three greenfield systems" is prose, not a figure a recruiter scans for.
  const out = summaryFrom('Engineer who took three greenfield systems to production.');
  assert.match(out, /three greenfield systems/);
});

test('the summary does not name an employer', () => {
  const out = summaryFrom(
    'Seven years of engineering work at Capital One shaped a practice built around distributed systems.'
  );
  assert.doesNotMatch(out, /capital one/i);
  // ...and the sentence it was in survives, because that sentence was the good one.
  assert.match(out, /shaped a practice built around distributed systems/);
  assert.match(out, /^7 years of engineering work shaped/);
});

test('an aside that existed only to name the employer goes whole', () => {
  const out = summaryFrom('Twelve years of platform work, most recently for Capital One, across payments.');
  assert.doesNotMatch(out, /capital one/i);
  assert.doesNotMatch(out, /most recently/i, 'a dangling "most recently," reads worse than the aside did');
  assert.match(out, /12 years of platform work/);
});

test('removing an employer does not leave a lower-case sentence', () => {
  const out = summaryFrom('Engineer with seven years of experience. Capital One systems handled heavy load.');
  assert.doesNotMatch(out, /capital one/i);
  assert.match(out, /\.\s+[A-Z]/, `sentence start was left lower-case: ${out}`);
});

test('every employer is removed, not just the current one', () => {
  const out = summaryFrom('A seven-year career with Northwind Payments spanning distributed systems.');
  assert.doesNotMatch(out, /northwind/i);
  assert.match(out, /spanning distributed systems/);
});

test('a real metric survives alongside the years', () => {
  // The old numeric cap deleted every figure after the first, so converting the
  // span to a numeral would have claimed the one slot and stripped the metric,
  // leaving "cut latency by." behind.
  const out = summaryFrom('Engineer of 9 years who took systems to production and cut latency by 30%.');
  assert.match(out, /cut latency by 30%/, `metric was mangled: ${out}`);
});

test('a summary with nothing to fix is returned untouched', () => {
  const text = 'Payments engineer of 8 years who has owned settlement services end to end.';
  assert.equal(summaryFrom(text), text);
});
