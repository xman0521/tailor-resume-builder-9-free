const assert = require('node:assert/strict');
const test = require('node:test');

const { parseJobAnalysisContent, parseTailoredResumeContent } = require('../dist/services/resumeService');
const {
  isRedundantWithLibraryTerm,
  looksLikeUnlistedHardSkill,
  selectHardSkills,
  UNLISTED_SKILL_PRIORITY,
} = require('../dist/services/utils/hardSkillSelection');
const { readHardSkillRecords } = require('../dist/database/skillsDatabase');

const library = readHardSkillRecords();
const inLibrary = new Set(library.map((r) => r.skill.toLowerCase()));
const has = (list, name) => list.some((s) => s.toLowerCase() === name.toLowerCase());

// Real tools this build's library happens not to carry. If one is ever added,
// the test below that depends on it being absent would stop proving anything,
// so it asserts the premise first.
const UNLISTED = ['Temporal', 'Supabase', 'LaunchDarkly', 'Biome'];

test('the fixtures for these tests really are outside the library', () => {
  for (const name of UNLISTED) {
    assert.ok(!inLibrary.has(name.toLowerCase()), `${name} is in the library now; pick another fixture`);
  }
});

test('a technology name is admitted, prose and job titles are not', () => {
  for (const name of [...UNLISTED, 'dbt', 'k9s', 'Nx']) {
    assert.ok(looksLikeUnlistedHardSkill(name), `${name} should be admitted`);
  }
  for (const junk of [
    'excellent communication skills',
    'a strong sense of ownership and accountability',
    'Full Stack Developer',
    'Senior Backend Engineer',
    'You will be responsible for building scalable systems.',
    'Experience',
    'Tools',
    'Microservices',
    'Test Automation',
    'Distributed Tracing',
    '',
    '5+',
  ]) {
    assert.ok(!looksLikeUnlistedHardSkill(junk), `${JSON.stringify(junk)} should be refused`);
  }
});

test('a tool the job names reaches the resume even with no library entry', () => {
  const picked = selectHardSkills({
    jobSkills: ['Python'],
    experienceSkills: [],
    library,
    unlistedJobSkills: UNLISTED,
  });
  for (const name of UNLISTED) {
    assert.ok(has(picked, name), `${name} was named by the job and should be listed`);
  }
});

test('an unlisted tool keeps the spelling it was given', () => {
  const picked = selectHardSkills({
    jobSkills: [], experienceSkills: [], library,
    unlistedJobSkills: ['LaunchDarkly'],
    target: 1, max: 1,
  });
  assert.deepEqual(picked, ['LaunchDarkly'], 'not "Launchdarkly" or "launchdarkly"');
});

test('the same tool spelled two ways is one skill', () => {
  const picked = selectHardSkills({
    jobSkills: [], experienceSkills: [], library,
    unlistedJobSkills: ['Supabase', 'supabase', 'SUPABASE'],
    target: 3, max: 3,
  });
  // One Supabase. The block is filled out to the target around it, which is a
  // separate rule - what this pins is that three spellings are not three skills.
  const supabases = picked.filter((s) => s.toLowerCase() === 'supabase');
  assert.equal(supabases.length, 1, `got ${picked.join(', ')}`);
});

test('the job outranks the profile for unlisted tools too', () => {
  const picked = selectHardSkills({
    jobSkills: [], experienceSkills: [], library,
    unlistedJobSkills: ['Temporal'],
    unlistedExperienceSkills: ['Biome'],
    target: 2, max: 2,
  });
  assert.equal(picked[0], 'Temporal', 'what the posting asked for comes first');
});

test('an unlisted tool does not outrank the library fundamentals', () => {
  // It sorts at UNLISTED_SKILL_PRIORITY, which is ahead of most of the library
  // but behind the handful it treats as fundamental.
  assert.ok(UNLISTED_SKILL_PRIORITY > 1, 'priority 1 entries should still lead');
  const picked = selectHardSkills({
    jobSkills: ['Python'],
    experienceSkills: [],
    library,
    unlistedJobSkills: ['Temporal'],
    target: 2, max: 2,
  });
  assert.equal(picked[0], 'Python');
});

test('an unlisted tool is reported so it can be added to the library', () => {
  const analysis = parseJobAnalysisContent(
    JSON.stringify({
      jobMeta: { title: 'Platform Engineer', seniority: 'Senior', industry: 'Software', department: 'Engineering' },
      // In `tools`, where the analyser's own prompt says named software goes.
      // `skills.technical` is defined there as abilities NOT tied to a named
      // tool, and is no longer read for the skills block - a tool mis-filed
      // into it gets prose coverage instead of a line in Technical Skills.
      skills: { technical: [], tools: [...UNLISTED, 'Python'], soft: [] },
      responsibilities: [], domainKnowledge: [],
      keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
    }),
    `Platform Engineer working with ${UNLISTED.join(', ')} and Python.`
  );
  const profile = {
    id: 'p', name: 'T', title: 'Platform Engineer', totalYearsExperience: 6,
    contact: { phone: '1', email: 'a@b.c', location: 'X' },
    summary: 'Engineer.',
    experience: [{
      title: 'Platform Engineer', company: 'Acme', startDate: '01/2021', endDate: 'Present',
      location: 'Remote', description: 'Ran services.', achievements: [], skills: [],
    }],
    strengths: [], skills: [], education: [], certifications: [], createdAt: '', updatedAt: '',
  };

  const out = parseTailoredResumeContent(
    JSON.stringify({ title: 'Engineer', summary: 'S.', experience: profile.experience, strengths: [], coverLetter: 'x' }),
    profile,
    analysis
  );

  for (const name of UNLISTED) {
    assert.ok(has(out.hardSkills, name), `${name} should be on the resume`);
    assert.ok(has(out.unconfirmedHardSkills, name), `${name} should be offered to the library`);
  }
  // Only terms that actually made the resume are offered, and a term the
  // library already knows is never offered.
  for (const reported of out.unconfirmedHardSkills) {
    assert.ok(has(out.hardSkills, reported), `${reported} was reported but is not on the resume`);
    assert.ok(!inLibrary.has(reported.toLowerCase()), `${reported} is already in the library`);
  }
});

test('an activity phrase built on an acronym is not a skill', () => {
  // These are what the job analyser's "specificity ladder" produces, and every
  // one of them defeated the earlier gate: AI, SQL, SLA and API supplied the
  // capital letter that the rule treated as evidence of a product name.
  for (const phrase of [
    'AI-assisted development tools',
    'SLA and SLO definition',
    'versioned APIs',
    'AI coding assistants',
    'AI coding tool usage',
    'SQL performance reasoning',
    'SQL query writing',
    'AI coding workflows',
    'AI-assisted code review tools',
    'Python scripting ability',
  ]) {
    const admitted = looksLikeUnlistedHardSkill(phrase)
      && !isRedundantWithLibraryTerm(phrase, inLibrary);
    assert.ok(!admitted, `"${phrase}" should not reach the skills block`);
  }
});

test('a real product of three or more words still gets through', () => {
  // The rule is "capitalise all of it", not "no long names": a trade name does,
  // an activity phrase does not.
  for (const name of [
    'Amazon Web Services', 'Azure Container Apps', 'Google Cloud Run',
    'Grafana Loki', 'Temporal Cloud', 'Ruby on Rails', 'Weights & Biases',
    'GitHub Copilot', 'OpenAI API',
  ]) {
    const admitted = looksLikeUnlistedHardSkill(name)
      && !isRedundantWithLibraryTerm(name, inLibrary);
    assert.ok(admitted, `"${name}" is a product and should be listable`);
  }
});

test('a phrase that reduces to a skill already listed is dropped', () => {
  // "SQL query writing" says nothing SQL does not, and SQL is already there.
  assert.ok(isRedundantWithLibraryTerm('SQL query writing', inLibrary));
  assert.ok(isRedundantWithLibraryTerm('SQL performance reasoning', inLibrary));
  assert.ok(isRedundantWithLibraryTerm('versioned APIs', inLibrary));

  // ...but a second capitalised word means a different product, not a
  // description of work with the first one.
  assert.ok(!isRedundantWithLibraryTerm('Grafana Loki', inLibrary));
  assert.ok(!isRedundantWithLibraryTerm('Temporal Cloud', inLibrary));
  assert.ok(!isRedundantWithLibraryTerm('Docker', inLibrary), 'a single word is never redundant');
});

test('the fields of ideas are not read for the skills block', async () => {
  // skills.technical is defined by the analyser prompt as "technical abilities
  // NOT tied to a specific named tool", and architecturePatterns as design
  // patterns. Neither is a source of things to list under Technical Skills.
  const phrases = ['SQL query writing', 'AI coding tool usage', 'versioned APIs'];

  for (const field of ['technical', 'architecturePatterns', 'methodologies']) {
    const skills = { technical: [], tools: [], soft: [] };
    const body = {
      jobMeta: { title: 'Engineer', seniority: 'Senior', industry: 'Software', department: 'Engineering' },
      skills, technologies: [], protocols: [], methodologies: [], architecturePatterns: [],
      responsibilities: [], domainKnowledge: [],
      keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
    };
    if (field === 'technical') skills.technical = [...phrases];
    else body[field] = [...phrases];

    const analysis = parseJobAnalysisContent(JSON.stringify(body), 'Engineer role. Python.');
    const profile = {
      id: 'p', name: 'T', title: 'Engineer', totalYearsExperience: 6,
      contact: { phone: '1', email: 'a@b.c', location: 'X' },
      summary: 'Engineer.',
      experience: [{
        title: 'Engineer', company: 'Acme', startDate: '01/2021', endDate: 'Present',
        location: 'Remote', description: 'Built services.', achievements: [], skills: [],
      }],
      strengths: [], skills: [], education: [], certifications: [], createdAt: '', updatedAt: '',
    };
    const out = parseTailoredResumeContent(
      JSON.stringify({ title: 'Engineer', summary: 'S.', experience: profile.experience, strengths: [], coverLetter: 'x' }),
      profile,
      analysis
    );
    for (const phrase of phrases) {
      assert.ok(!has(out.hardSkills, phrase), `"${phrase}" leaked from ${field}`);
    }
  }
});
