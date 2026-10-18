const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildTailorResumePromptValues,
  parseJobAnalysisContent,
} = require('../dist/services/resumeService');

/**
 * The two ways a tailoring request can contradict itself.
 *
 * WHAT THIS REPLACED. These tests were `softSkillHeading.test.js`, about a
 * heading drawn per resume for the soft-skill group at the end of the skills
 * block. That group is gone - the operator asked for no soft skills in the
 * block at all - and the heading, the draw and the prompt value went with it.
 * Two of the three tests were about the dead feature. The two properties below
 * are not, and the second is the one that was nearly lost:
 *
 *   1. A placeholder the prompt names has a value supplied for it, or the
 *      build fails with "missing runtime values" at the first request.
 *   2. The prompt body and FINAL SKILL OVERRIDE say the SAME thing. The
 *      override is appended to the user body, so it is the last thing the model
 *      reads and the most salient - and while the prompt was being changed to
 *      ban soft skills from the block, the override still said "the last group
 *      headed X and holding this posting's own soft-skill words spelled as it
 *      spells them". Being last, it would have won, and the prompt change would
 *      have done nothing at all.
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
  skills: { technical: ['Python'], required: ['AWS'], preferred: [], tools: [], soft: ['collaboration'], technologies: [] },
  technologies: [], protocols: [], methodologies: [], architecturePatterns: [],
  responsibilities: [], domainKnowledge: [], softSkills: [],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
}), 'Backend role using Python on AWS.');

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

  assert.ok(asked.length > 0, 'the prompt names no placeholders at all');
  for (const name of asked) {
    assert.ok(supplied.includes(name), `the prompt asks for [[${name}]] and nothing supplies it`);
  }

  // The reverse is not an error - an unreferenced value costs nothing, and a
  // custom prompt an admin wrote may name either of two spellings - but the
  // heading of the deleted soft-skill group must not come back by accident.
  assert.equal(supplied.includes('softSkillGroupHeading'), false, 'a value for a deleted feature');
});

test('the appended override says what the prompt says about the skills block', async () => {
  /*
   * Observed on the request itself, because that is the only place the two
   * halves meet. The coverage revision is off: a draft that leaves checklist
   * terms unplaced is sent back for a second pass, which would double the calls
   * counted here and has its own tests.
   */
  const pinnedRevision = process.env.RESUME_REVISION_OFF;
  process.env.RESUME_REVISION_OFF = '1';

  const execution = require('../dist/services/ai/promptExecution');
  const original = execution.createPromptCompletion;
  const calls = [];
  execution.createPromptCompletion = async (request) => {
    calls.push(request);
    // The bullets clear the five-figure floor deliberately: a draft under it is
    // sent back for a revision, which has its own tests.
    return JSON.stringify({
      title: 'Engineer', summary: 'Engineer of 10 years.',
      experience: [{
        ...profile().experience[0],
        achievements: [
          'Cut p99 latency from 180ms to 118ms on the checkout path.',
          'Took releases from 40 minutes to 6 minutes by caching the build layers.',
          'Reviewed 30 changes a month across 4 services.',
        ],
      }],
      skillGroups: [{ category: 'Languages', skills: ['Python'] }],
      coverLetter: 'x',
    });
  };

  try {
    const { tailorResume } = require('../dist/services/resumeService');
    await tailorResume(profile(), analysis(), { provider: 'claude-web', modelName: 'chat' });
  } finally {
    execution.createPromptCompletion = original;
    if (pinnedRevision === undefined) delete process.env.RESUME_REVISION_OFF;
    else process.env.RESUME_REVISION_OFF = pinnedRevision;
  }

  assert.equal(calls.length, 1);
  const override = calls[0].appendToUserBody;
  assert.match(override, /^FINAL SKILL OVERRIDE:/);

  // The group shape, said the same way in both.
  assert.match(override, /5-7 groups, 5-9 skills each and never fewer than five in a group/);
  assert.match(override, /AT LEAST 35 in total - thirty-five is a floor/);
  assert.match(override, /never more than 45/);
  // And the group the operator calls essential, which the prompt also requires
  // first. If these two ever disagree about it, the override wins and the
  // prompt's requirement silently does nothing.
  assert.match(override, /The FIRST group is "Languages & Frameworks" and it is required/);

  // No soft skills, which is the rule the override used to contradict.
  assert.match(override, /NO soft skills anywhere in the block/);
  assert.doesNotMatch(override, /soft-skill words spelled as it spells them/);
  assert.doesNotMatch(override, /the last group headed/);

  // And the removals the application performs, so a model writing one of these
  // is told it will be deleted rather than left to wonder where it went.
  assert.match(override, /no entry joining two things with "and"/);
  assert.match(override, /No past-tense verb as a skill/);
  assert.match(override, /anything past 45 is deleted from the end of the longest group/);
});
