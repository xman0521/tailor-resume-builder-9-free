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

test('a job that names no soft skills still fills the section', () => {
  const out = tailor(profileFor(), analysisFor('We need a Python developer.'));
  assert.ok(out.softSkills.length >= 5, `only ${out.softSkills.length}: ${out.softSkills.join(', ')}`);
});

test('a job that names one soft skill keeps it and fills around it', () => {
  const out = tailor(
    profileFor(),
    analysisFor('Python developer. Must have strong communication.', { soft: ['communication'] })
  );
  assert.ok(out.softSkills.length >= 5, `only ${out.softSkills.length}`);
  assert.ok(
    out.softSkills.some((s) => /communicat/i.test(s)),
    'what the job actually asked for must survive the fill'
  );
});

test('the floor survives condensing, not just the fill', () => {
  // The fill counts RAW names and the finalizer then condenses and dedupes
  // them, so a job asking four ways for one trait could be filled to five and
  // collapse back to two.
  const out = tailor(
    profileFor(),
    analysisFor(
      `Python developer wanting excellent communication skills, communication and
       collaboration, someone who can communicate clearly, and outstanding written
       communication skills.`,
      {
        soft: [
          'excellent communication skills',
          'strong communication and collaboration across teams',
          'ability to communicate clearly with stakeholders',
          'outstanding written communication skills throughout the org',
        ],
      }
    )
  );
  assert.ok(out.softSkills.length >= 5, `condensing dropped it to ${out.softSkills.length}`);
  assert.equal(new Set(out.softSkills.map((s) => s.toLowerCase())).size, out.softSkills.length);
});

test('a job rich in soft skills is not padded', () => {
  const out = tailor(
    profileFor(),
    analysisFor(
      'Python dev needing communication, ownership, collaboration, mentoring, adaptability, leadership and problem solving.',
      { soft: ['communication', 'ownership', 'collaboration', 'mentoring', 'adaptability', 'leadership', 'problem solving'] }
    )
  );
  assert.ok(out.softSkills.length >= 5);
  assert.ok(out.softSkills.length <= 10, 'the cap still holds');
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
