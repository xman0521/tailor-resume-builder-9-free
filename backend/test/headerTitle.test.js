const assert = require('node:assert/strict');
const test = require('node:test');

// These stubs answer AI calls in order; the skills check has its own tests.
process.env.RESUME_SKILL_CHECK_OFF = '1';

const { useTempStorage } = require('./helpers');

useTempStorage('header-title');

const { normalizeProfileSettings, MAX_HEADER_TITLE_LENGTH } = require('../dist/services/profileService');
const { tailorResume } = require('../dist/services/resumeService');
const execution = require('../dist/services/ai/promptExecution');

/**
 * The per-profile header title: the line printed under the name.
 *
 * WHY IT IS NOT THE PROFILE'S TITLE FIELD. That field is doing four jobs at
 * once - it is printed, sent to the tailoring model as who this person is,
 * scanned as a source of the skills they already claim, and used to build the
 * fallback summary. Editing it so the printed line reads better moved the other
 * three as well. These two settings move only the printed line.
 *
 * The behaviour every existing profile already had is the default, and the
 * first test here is the one that keeps it that way.
 */

const analysis = (title) => ({
  jobMeta: { title, seniority: 'senior', industry: 'SaaS', department: 'engineering' },
  skills: { technical: [], required: [], preferred: [], tools: [], soft: [], technologies: [] },
  technologies: [], protocols: [], methodologies: [], architecturePatterns: [],
  responsibilities: [], domainKnowledge: [], softSkills: [],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
});

const profileWith = (settings, title = 'Software Engineer') => ({
  id: 'p', name: 'Jordan Bracken', title,
  profileSettings: settings,
  contact: { phone: '555', email: 'j@example.com', location: 'Austin, TX' },
  summary: 'Engineer.',
  experience: [{
    title: 'Staff Software Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
    location: 'Austin, TX', description: '', achievements: ['Did work.'], skills: [],
  }],
  skills: [], education: [], certifications: [], strengths: [],
  createdAt: '', updatedAt: '',
});

/** Drives the real tailoring path with the model stubbed, and returns the printed line. */
async function headlineFor(profile, postingTitle = 'DevOps Engineer III, AI Business Automation') {
  const original = execution.createPromptCompletion;
  execution.createPromptCompletion = async () => JSON.stringify({
    title: 'Whatever The Model Said',
    summary: 'Engineer with 9 years of platform work.',
    experience: [], strengths: [], coverLetter: 'x',
  });
  const pinned = process.env.RESUME_HEADLINE_STYLE;
  const revision = process.env.RESUME_REVISION_OFF;
  // The separator is drawn per resume from six shapes; pinned here so the
  // assertions are about the WORDS, which is what these settings change.
  process.env.RESUME_HEADLINE_STYLE = 'pipe';
  process.env.RESUME_REVISION_OFF = '1';
  try {
    const content = await tailorResume(profile, analysis(postingTitle), 'stub-model');
    return content.title;
  } finally {
    execution.createPromptCompletion = original;
    if (pinned === undefined) delete process.env.RESUME_HEADLINE_STYLE;
    else process.env.RESUME_HEADLINE_STYLE = pinned;
    if (revision === undefined) delete process.env.RESUME_REVISION_OFF;
    else process.env.RESUME_REVISION_OFF = revision;
  }
}

test('a profile that has never set one prints exactly what it printed before', async () => {
  // The Title field, then the kind of role the posting is for. Both an absent
  // settings object and one saved by a client that predates these fields.
  assert.equal(await headlineFor(profileWith(undefined)), 'Software Engineer | DevOps Engineer');
  assert.equal(
    await headlineFor(profileWith({ technicalSkillsLayout: 'flat' })),
    'Software Engineer | DevOps Engineer'
  );
});

test('a header title is printed instead of the Title field', async () => {
  const printed = await headlineFor(profileWith({ headerTitle: 'Platform & Reliability Engineer' }));
  assert.equal(printed, 'Platform & Reliability Engineer | DevOps Engineer');
});

test('turning the target role off prints the header title alone', async () => {
  assert.equal(
    await headlineFor(profileWith({ headerTitle: 'Platform & Reliability Engineer', appendTargetRole: false })),
    'Platform & Reliability Engineer'
  );
  // ...and it is obeyed whatever the line came from, not only a custom one.
  assert.equal(
    await headlineFor(profileWith({ appendTargetRole: false })),
    'Software Engineer'
  );
});

test('a blank header title falls back to the Title field', async () => {
  // Blank is how the field is cleared, so it has to mean "use the Title" rather
  // than "print nothing" - a resume with no line under the name.
  for (const value of ['', '   ']) {
    assert.equal(
      await headlineFor(profileWith({ headerTitle: value })),
      'Software Engineer | DevOps Engineer',
      `headerTitle ${JSON.stringify(value)} should fall back`
    );
  }
});

test('the rules the composed line already had still apply to a custom one', async () => {
  /*
   * Two of them, both older than this setting and both still wanted:
   * a role already named in the headline is not said twice, and a line past the
   * length the head section can hold drops the appended part rather than
   * wrapping under the name.
   */
  const alreadySaid = await headlineFor(profileWith({ headerTitle: 'Senior DevOps Engineer' }));
  assert.equal(alreadySaid, 'Senior DevOps Engineer', 'the role is already in the headline');

  const long = 'Principal Platform Reliability and Developer Experience Engineer';
  const capped = await headlineFor(profileWith({ headerTitle: long }));
  assert.equal(capped, long, 'the composed line would pass the ceiling, so the role is dropped');
});

test('what is stored is trimmed, collapsed and capped', () => {
  const saved = normalizeProfileSettings({ headerTitle: '  Platform   &  Reliability Engineer \n' });
  assert.equal(saved.headerTitle, 'Platform & Reliability Engineer');

  const long = normalizeProfileSettings({ headerTitle: 'E'.repeat(200) });
  assert.equal(long.headerTitle.length, MAX_HEADER_TITLE_LENGTH);

  // Not a string at all - a client sending the wrong shape clears it rather
  // than storing something the renderer would print as "[object Object]".
  assert.equal(normalizeProfileSettings({ headerTitle: { nope: true } }).headerTitle, '');
});

test('an omitted field keeps what was stored; an empty one clears it', () => {
  const existing = { headerTitle: 'Platform & Reliability Engineer', appendTargetRole: false };

  // A client that predates these fields saves a profile without them, and must
  // not blank a choice somebody made.
  const untouched = normalizeProfileSettings({ technicalSkillsLayout: 'flat' }, existing);
  assert.equal(untouched.headerTitle, 'Platform & Reliability Engineer');
  assert.equal(untouched.appendTargetRole, false);

  // ...while the form sending an empty string IS the clear.
  const cleared = normalizeProfileSettings({ headerTitle: '', appendTargetRole: true }, existing);
  assert.equal(cleared.headerTitle, '');
  assert.equal(cleared.appendTargetRole, true);
});

test('a profile stored before this existed appends the role', () => {
  // Absent means yes, because that is what every resume already did.
  assert.equal(normalizeProfileSettings(undefined).appendTargetRole, true);
  assert.equal(normalizeProfileSettings({}).appendTargetRole, true);
  assert.equal(normalizeProfileSettings({}, { technicalSkillsLayout: 'flat' }).appendTargetRole, true);
});
