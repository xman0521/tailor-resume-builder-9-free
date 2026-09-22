const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeDashes } = require('../dist/services/utils/dashes');
const { parseTailoredResumeContent } = require('../dist/services/resumeService');

/**
 * The stand-in dash, taken from a finished cover letter.
 *
 * Both prompts say "Never use em-dashes", so a model that wants one writes
 * "--" instead and it reaches the page verbatim. Wording the prompt harder is
 * not the fix - the instruction is already there, twice - so the substitution
 * is undone in code.
 */

test('a dash standing between clauses becomes the comma it stands for', () => {
  assert.equal(
    normalizeDashes('What I enjoy about platform engineering -- and what makes someone good at it -- is the mix.'),
    'What I enjoy about platform engineering, and what makes someone good at it, is the mix.'
  );
  // The real dashes too, however the model spells them.
  assert.equal(normalizeDashes('scope here — multi-account AWS — is the work'), 'scope here, multi-account AWS, is the work');
  assert.equal(normalizeDashes('a–b'), 'a, b');
  assert.equal(normalizeDashes('three---hyphens here'), 'three, hyphens here');
});

test('an ordinary hyphen is left alone', () => {
  const kept = 'multi-account AWS, Full-Stack work and on-call ownership of CI/CD';
  assert.equal(normalizeDashes(kept), kept);
});

test('a span of numbers keeps a single hyphen', () => {
  assert.equal(normalizeDashes('2019 -- 2021'), '2019-2021');
  assert.equal(normalizeDashes('cut 10--20% of spend'), 'cut 10-20% of spend');
  assert.equal(normalizeDashes('handled 3 – 5 incidents'), 'handled 3-5 incidents');
});

test('a dash with nothing after it is dropped, not turned into a comma', () => {
  assert.equal(normalizeDashes('the platform team --'), 'the platform team');
  assert.equal(normalizeDashes('trusted by teams -- .'), 'trusted by teams.');
  assert.equal(normalizeDashes('-- and then it shipped'), 'and then it shipped');
  // A comma already there is not doubled.
  assert.equal(normalizeDashes('teams, -- and leadership'), 'teams, and leadership');
});

test('empty input comes back unchanged', () => {
  assert.equal(normalizeDashes(''), '');
  assert.equal(normalizeDashes(undefined), '');
});

test('the resume and the cover letter are cleaned on the way out', () => {
  const profile = {
    id: 'p', name: 'Leo Example', title: 'Software Engineer',
    contact: { phone: '555-555-5555', email: 'l@example.com', location: 'Austin, TX' },
    summary: 'Engineer.',
    experience: [{
      title: 'Software Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
      location: 'Remote', description: 'Built things.', achievements: ['Did work.'], skills: [],
    }],
    skills: [], education: [], certifications: [], strengths: [],
  };

  const out = parseTailoredResumeContent(
    JSON.stringify({
      title: 'Engineer',
      summary: 'Platform work -- the kind other engineers build on -- for 10 years.',
      experience: [{
        ...profile.experience[0],
        description: 'Owned the shared module registry -- the paved road for twelve teams.',
        achievements: ['Cut deployment time -- from days to hours -- across the platform.'],
      }],
      strengths: [],
      coverLetter: 'The scope here -- multi-account AWS -- is where I do my best work.',
    }),
    profile,
    undefined
  );

  const prose = [out.summary, out.experience[0].description, ...out.experience[0].achievements, out.coverLetter];
  for (const text of prose) {
    assert.ok(!text.includes('--'), `a stand-in dash reached the page: ${text}`);
  }
  assert.match(out.summary, /Platform work, the kind other engineers build on, for 10 years\./);
  assert.equal(out.coverLetter, 'The scope here, multi-account AWS, is where I do my best work.');
});
