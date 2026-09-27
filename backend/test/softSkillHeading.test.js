const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildTailorResumePromptValues,
  parseJobAnalysisContent,
  pickSoftSkillGroupHeading,
  SOFT_SKILL_GROUP_HEADING_NAMES,
} = require('../dist/services/resumeService');

/**
 * The heading over the soft-skill group at the end of the skills block.
 *
 * WHY IT MOVED. Every resume this app produced ended its skills block with a
 * group headed "Professional Skills" - same words, every profile, every
 * posting - which is the kind of repetition a recruiter holding two of our
 * resumes notices before they read either. The group stays: those are the
 * posting's own soft-skill words, a scanner scores them as skills, and with no
 * Soft Skills section they appear nowhere else.
 *
 * So the heading is drawn per resume, and the two places that name it - the
 * stored prompt and the override appended to the same turn - have to agree, or
 * the model is told two different things in one request.
 */

const profile = () => ({
  id: 'p', name: 'Test Person', title: 'Software Engineer',
  profileSettings: { technicalSkillsLayout: 'flat' },
  contact: { phone: '1', email: 'a@b.c', location: 'X' },
  summary: 'Engineer.',
  experience: [{
    title: 'Software Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
    location: 'Remote', description: '', achievements: ['Cut p99 latency from 180ms to 118ms.'], skills: [],
  }],
  strengths: [], skills: ['Python'], education: [], certifications: [], createdAt: '', updatedAt: '',
});

const analysis = () => parseJobAnalysisContent(JSON.stringify({
  jobMeta: { title: 'Backend Engineer', seniority: 'Senior', industry: 'SaaS', department: 'Engineering' },
  skills: { technical: ['Python'], required: ['AWS'], preferred: [], tools: [], soft: ['Communication skills'], technologies: [] },
  technologies: [], protocols: [], methodologies: [], architecturePatterns: [],
  responsibilities: [], domainKnowledge: [], softSkills: ['Ownership'],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
}), 'Backend role using Python and AWS.');

test('the heading is drawn per resume, and can be pinned', () => {
  const pinned = process.env.SOFT_SKILL_HEADING;
  try {
    delete process.env.SOFT_SKILL_HEADING;
    const seen = new Set();
    for (let run = 0; run < 300; run += 1) {
      seen.add(buildTailorResumePromptValues(profile(), analysis()).softSkillGroupHeading);
    }
    assert.equal(
      seen.size,
      SOFT_SKILL_GROUP_HEADING_NAMES.length,
      `only saw ${[...seen].join(' / ')}`
    );
    for (const heading of seen) assert.ok(SOFT_SKILL_GROUP_HEADING_NAMES.includes(heading), heading);

    // Pinned for a test, and case is not the test's problem.
    assert.equal(pickSoftSkillGroupHeading({ SOFT_SKILL_HEADING: 'Ways of Working' }), 'Ways of Working');
    assert.equal(pickSoftSkillGroupHeading({ SOFT_SKILL_HEADING: ' ways of working ' }), 'Ways of Working');
    // A name that is not on the list falls back to a real one.
    assert.ok(SOFT_SKILL_GROUP_HEADING_NAMES.includes(pickSoftSkillGroupHeading({ SOFT_SKILL_HEADING: 'nonsense' })));
  } finally {
    if (pinned === undefined) delete process.env.SOFT_SKILL_HEADING;
    else process.env.SOFT_SKILL_HEADING = pinned;
  }
});

test('every value the tailor prompt asks for is supplied', () => {
  /*
   * The failure class this pins: a prompt naming `[[conceptKeywordsJson]]`
   * after the code that supplied it was removed, which failed the whole build
   * with "missing runtime values". A placeholder and its value are written in
   * two files, and only a run ever compared them.
   */
  const prompt = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'static', 'prompts', 'tailor-resume.json'), 'utf8'
  ));
  const asked = [...new Set(
    [...prompt.content.matchAll(/\[\[([a-zA-Z0-9_]+)\]\]/g)].map((match) => match[1])
  )];
  const supplied = Object.keys(buildTailorResumePromptValues(profile(), analysis()));

  assert.ok(asked.includes('softSkillGroupHeading'), 'the prompt no longer names the heading');
  assert.deepEqual(
    asked.filter((name) => !supplied.includes(name)),
    [],
    'the prompt names a value nothing supplies'
  );
});

test('the prompt body and the appended override name the SAME heading', async () => {
  /*
   * Two instructions, one turn: the prompt says what to head the group, and
   * `FINAL_SKILL_OVERRIDE` - appended to the user body because an admin editing
   * the stored prompt must not be able to drop it - says it again. If the
   * override drew its own heading, every request would carry a contradiction.
   */
  // The coverage revision is off here. A draft that leaves checklist terms
  // unplaced is sent back for a second pass, which would double every call this
  // test counts - and the revision has its own tests. This one is about what a
  // single request asks for.
  const pinnedRevision = process.env.RESUME_REVISION_OFF;
  process.env.RESUME_REVISION_OFF = '1';

  const execution = require('../dist/services/ai/promptExecution');
  const original = execution.createPromptCompletion;
  const calls = [];
  execution.createPromptCompletion = async (request) => {
    calls.push(request);
    // The bullets clear the five-figure floor deliberately: a draft under it is
    // sent back for a revision, which would double every call counted here and
    // has its own tests.
    return JSON.stringify({
      title: 'Engineer', summary: 'Engineer of 10 years.',
      experience: [{
        ...profile().experience[0],
        achievements: [
          'Cut p99 latency from 180ms to 118ms on the checkout path.',
          'Took releases from 40 minutes to 6 by caching the build layers.',
          'Reviewed 30 changes a month across 4 services.',
        ],
      }],
      skillGroups: [{ category: 'Languages', skills: ['Python'] }],
      coverLetter: 'x',
    });
  };

  try {
    const { tailorResume } = require('../dist/services/resumeService');
    for (let run = 0; run < 12; run += 1) {
      await tailorResume(profile(), analysis(), { provider: 'claude-web', modelName: 'chat' });
    }
  } finally {
    execution.createPromptCompletion = original;
    if (pinnedRevision === undefined) delete process.env.RESUME_REVISION_OFF;
    else process.env.RESUME_REVISION_OFF = pinnedRevision;
  }

  assert.equal(calls.length, 12);
  for (const call of calls) {
    const heading = call.promptValues.softSkillGroupHeading;
    assert.ok(SOFT_SKILL_GROUP_HEADING_NAMES.includes(heading), `unknown heading ${heading}`);
    assert.ok(
      call.appendToUserBody.includes(`headed "${heading}"`),
      `the override asked for a different heading than the prompt: ${call.appendToUserBody.slice(0, 200)}`
    );
  }

  // And across a batch, not every resume ends with the same words.
  const seen = new Set(calls.map((call) => call.promptValues.softSkillGroupHeading));
  assert.ok(seen.size > 1, `all 12 builds used "${[...seen][0]}"`);
});
