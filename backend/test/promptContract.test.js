const assert = require('node:assert/strict');
const test = require('node:test');

// These stubs answer AI calls in order; the skills check has its own tests.
process.env.RESUME_SKILL_CHECK_OFF = '1';
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

  // Soft skills only in their own group, last, which the prompt also requires.
  assert.match(override, /NO soft skills in the technical groups/);
  assert.match(override, /ONE MORE GROUP, last, headed exactly "Soft Skills"/);
  assert.match(override, /The Soft Skills group is not counted in any of that/);
  assert.doesNotMatch(override, /soft-skill words spelled as it spells them/);

  // And the removals the application performs, so a model writing one of these
  // is told it will be deleted rather than left to wonder where it went.
  assert.match(override, /no entry joining two things with "and"/);
  assert.match(override, /No past-tense verb as a skill/);
  assert.match(override, /anything past 45 is deleted from the end of the longest group/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The prompt's account of what the application does, checked against it
 * ──────────────────────────────────────────────────────────────────────────── */

test('every removal the prompt promises is one the application performs', () => {
  /*
   * MEASURED, and it is why this test exists: eleven places in the prompt told
   * the model "the application deletes this", and SEVEN of them were no longer
   * true. The code behind them went when the `kind` schema replaced the rules
   * that guessed from the words, and the prompt kept promising it for several
   * rounds afterwards.
   *
   * A promise that does not fire is worse than no promise. The model is told
   * that writing padding "only makes the group shorter", so it writes the
   * padding - and the padding prints.
   *
   * Each case below is fed through the real tidy pass. A claim the prompt makes
   * has to survive contact with it.
   */
  const { tidySkillGroups } = require('../dist/services/utils/resumeQuality');
  const prompt = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'static', 'prompts', 'tailor-resume.json'), 'utf8')
  ).content;

  const printed = (groups) =>
    tidySkillGroups(groups).groups.flatMap((group) => group.skills);
  const one = (name, kind) => [{ category: 'Group', skills: [{ name, kind }] }];

  // What the application DOES do, each still claimed in the prompt.
  assert.deepEqual(printed(one('Observability', 'practice')), [], 'a labelled practice leaves');
  assert.deepEqual(
    tidySkillGroups(one('Ownership', 'soft')).groups,
    [{ category: 'Soft Skills', skills: ['Ownership'] }],
    'a labelled soft skill moves to the Soft Skills group'
  );
  assert.deepEqual(printed(one('Infrastructure', 'category')), [], 'a labelled category word leaves');
  assert.deepEqual(
    printed([{ category: 'ML & AI', skills: [{ name: 'RAG', kind: 'technology' }, { name: 'Retrieval-Augmented Generation', kind: 'technology' }] }]),
    ['RAG'],
    'an abbreviation beside its expansion collapses to the first written'
  );
  assert.deepEqual(
    printed([{ category: 'Cloud', skills: [{ name: 'Kinesis', kind: 'platform' }, { name: 'Amazon Kinesis', kind: 'platform' }] }]),
    ['Amazon Kinesis'],
    'one name under two spellings collapses'
  );
  assert.deepEqual(
    printed([
      { category: 'Cloud', skills: [{ name: 'Docker', kind: 'tool' }] },
      { category: 'DevOps', skills: [{ name: 'Docker', kind: 'tool' }] },
    ]),
    ['Docker'],
    'the same name in two groups collapses'
  );

  /*
   * And what it does NOT do any more. The prompt must not say it does - these
   * are the exact strings that were false, kept here by name so that restoring
   * one without restoring the code fails this test.
   */
  const RETIRED = [
    'the application deletes too',
    'exactly as the code applies it',
    'The application deletes a bare one',
    'THE TEST THE CODE APPLIES',
    'The application runs that same test',
    'knows the seven by name',
    'Nothing reorders it, merges it, spell-checks',
  ];
  for (const claim of RETIRED) {
    assert.equal(
      prompt.includes(claim), false,
      `the prompt claims "${claim}", and the application no longer does it`
    );
  }

  // A mislabel defeats every one of them, which is the thing the model has to
  // know now that nothing reads the words.
  assert.deepEqual(printed(one('Observability', 'tool')), ['Observability']);
  assert.match(prompt, /A wrong label is not caught, it is obeyed/);
});

test('the prompt describes the heading merge the application actually performs', () => {
  const { tidySkillGroups, MAX_SKILL_GROUPS } = require('../dist/services/utils/resumeQuality');
  const prompt = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'static', 'prompts', 'tailor-resume.json'), 'utf8')
  ).content;

  const groups = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((name, index) => ({
    category: name,
    skills: Array.from({ length: index === 0 ? 6 : 2 }, (_, n) => ({ name: `${name}${n}`, kind: 'tool' })),
  }));
  const { groups: out, report } = tidySkillGroups(groups);

  assert.ok(out.length <= MAX_SKILL_GROUPS);
  assert.ok(report.mergedGroups.length > 0, 'a merge should have happened');
  // Both names kept, which is what the prompt now promises.
  assert.ok(out.some((group) => /&/.test(group.category)), `no joined heading in ${JSON.stringify(out.map((g) => g.category))}`);
  assert.match(prompt, /joins the two SMALLEST headings/);
  assert.match(prompt, /keeps both names/);
});

test('the block floor is stated as one number throughout', () => {
  const prompt = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'static', 'prompts', 'tailor-resume.json'), 'utf8')
  ).content;

  // A superseded count left in the section the model reads while writing the
  // block: "A list padded towards thirty", "thirty is still the target".
  assert.doesNotMatch(prompt, /padded towards thirty\./);
  assert.doesNotMatch(prompt, /thirty is still the target/);
  assert.doesNotMatch(prompt, /does not reach thirty,/);
  assert.match(prompt, /THIRTY-FIVE IS A FLOOR/);
  assert.match(prompt, /At most 45/);
});

test('the duplicated paragraph and the duplicated heading are gone', () => {
  const prompt = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'static', 'prompts', 'tailor-resume.json'), 'utf8')
  ).content;

  assert.equal(
    prompt.split('YOU write the block, under TECHNICAL SKILLS').length - 1, 1,
    'this paragraph was printed twice, back to back'
  );
  assert.equal(
    (prompt.match(/^HARD RULES\.?$/gm) || []).length, 1,
    'two different sections were both headed HARD RULES'
  );
  assert.match(prompt, /^SECTION BY SECTION$/m);
  // The em-dash ban belongs in HARD RULES, once.
  assert.equal((prompt.match(/Never use em-dashes/g) || []).length, 1);
});
