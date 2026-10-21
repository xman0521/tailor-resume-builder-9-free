const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseJobAnalysisContent,
  parseTailoredResumeContent,
  buildTailorResumePromptValues,
} = require('../dist/services/resumeService');
const { extractConceptKeywords, isConceptSkill } = require('../dist/services/utils/hardSkillSelection');

function analysisFor(jobDescription, { technical = ['Python'], soft = [] } = {}) {
  return parseJobAnalysisContent(
    JSON.stringify({
      jobMeta: { title: 'Engineer', seniority: 'Mid', industry: 'Software', department: 'Engineering' },
      skills: { technical, tools: [], soft },
      responsibilities: [],
      domainKnowledge: [],
      keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
    }),
    jobDescription
  );
}

function profileFor(description = 'Wrote Python services.') {
  return {
    id: 'p', name: 'Test Person', title: 'Engineer', totalYearsExperience: 5,
    contact: { phone: '1', email: 'a@b.c', location: 'X' },
    summary: 'Engineer.',
    experience: [{
      title: 'Engineer', company: 'Acme', startDate: '01/2021', endDate: 'Present',
      location: 'Remote', description, achievements: [], skills: [],
    }],
    strengths: [], skills: [], education: [], certifications: [], createdAt: '', updatedAt: '',
  };
}

function tailor(profile, analysis) {
  return parseTailoredResumeContent(
    JSON.stringify({
      title: 'Engineer', summary: 'S.', experience: profile.experience, strengths: [], coverLetter: 'x',
    }),
    profile,
    analysis
  );
}

/*
 * The four tests that stood here pinned the Soft Skills section's fill: at
 * least five entries, the job's own terms kept, the cap held. There is no such
 * section any more - it was a row of nouns nobody reads, and 44 of the
 * library's entries were the exact register the operator asked to be rid of.
 * The soft skills a posting names are now written into the prose, where they
 * are attached to something the candidate actually did, and the prose
 * checklist below is what pins that.
 */
test('the soft skills the posting names reach their own section', () => {
  /*
   * This asserted the opposite for several rounds - `softSkills` was forced to
   * [] on the way out, while everything that built the list still ran. The
   * operator asked for the section back, 8 to 10 entries, under the technical
   * block.
   */
  const rich = tailor(
    profileFor(),
    analysisFor('Python dev needing communication, ownership, mentoring and leadership.', {
      soft: ['communication', 'ownership', 'mentoring', 'leadership'],
    })
  );
  for (const term of ['Communication', 'Ownership', 'Mentoring', 'Leadership']) {
    assert.ok(
      rich.softSkills.some((s) => s.toLowerCase() === term.toLowerCase()),
      `${term} was named by the posting: ${rich.softSkills.join(', ')}`
    );
  }
  assert.ok(rich.softSkills.length <= 10, `${rich.softSkills.length} is over the ceiling`);

  // None of them in the TECHNICAL block: the section is separate, not a group.
  for (const soft of rich.softSkills) {
    assert.ok(
      !rich.hardSkills.some((hard) => hard.toLowerCase() === soft.toLowerCase()),
      `"${soft}" is in both the technical block and the soft skills section`
    );
  }
});

test('a posting that names no soft skills still gets what the library finds, or nothing', () => {
  // Never padded to reach the floor: the terms come from the posting and the
  // library, and inventing two more would put words on the page nothing asked
  // for. Under the floor is a warning, not a fabrication.
  const bare = tailor(profileFor(), analysisFor('We need a Python developer.'));
  assert.ok(Array.isArray(bare.softSkills));
  assert.ok(bare.softSkills.length <= 10);
});

test('the concepts kept out of the skills block are handed to the prompt', () => {
  // Keeping "Microservices" out of Technical Skills is a formatting decision,
  // not a decision to drop the keyword. It has to reach the model so it can be
  // written into the prose, or the ATS score pays for the formatting.
  const analysis = analysisFor(
    `Microservices on AWS with event-driven services, CI/CD pipelines, observability,
     Python, Kubernetes, PostgreSQL, caching strategies, test automation, API design,
     agile development.`,
    { technical: ['Python', 'Kubernetes', 'PostgreSQL'] }
  );
  const profile = profileFor('Built Django services on PostgreSQL with Docker.');

  const values = buildTailorResumePromptValues(profile, analysis);
  assert.ok('conceptKeywordsJson' in values, 'the prompt variable must be supplied');
  const concepts = JSON.parse(values.conceptKeywordsJson);
  assert.ok(concepts.length > 0, 'this posting is full of concepts');
  for (const concept of concepts) {
    assert.ok(isConceptSkill(concept), `"${concept}" is not a concept`);
  }
  assert.ok(
    concepts.some((c) => /microservice/i.test(c)),
    `microservices should be handed over: ${concepts.join(', ')}`
  );

  // And the same terms must NOT be in the rendered skills block.
  const out = tailor(profile, analysis);
  for (const concept of concepts) {
    assert.ok(
      !out.hardSkills.some((s) => s.toLowerCase() === concept.toLowerCase()),
      `"${concept}" is in both the prose list and the skills block`
    );
  }
});

test('extractConceptKeywords keeps the job order and drops the tools', () => {
  const concepts = extractConceptKeywords([
    'Python', 'Microservices', 'Docker', 'CI/CD', 'PostgreSQL', 'Agile Development', 'microservices',
  ]);
  assert.deepEqual(concepts, ['Microservices', 'CI/CD', 'Agile Development']);
});
