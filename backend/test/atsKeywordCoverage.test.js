const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseJobAnalysisContent,
  parseTailoredResumeContent,
  buildTailorResumePromptValues,
} = require('../dist/services/resumeService');
const { isConceptSkill } = require('../dist/services/utils/hardSkillSelection');

/**
 * The keywords a scanner looks for and the resume has to carry.
 *
 * These are the shapes that were coming back missing from real scans:
 * abilities the analyser files under `skills.technical`, which is its LARGEST
 * field and was the one field no coverage rule could see.
 */
const ABILITIES = [
  'Full-stack engineering', 'Production environment', 'Distributed computing',
  'Product Engineering', 'Network operations', 'Agile environment',
  'Develop Software', 'Web development', 'Data processing systems',
];

function analysisWith(overrides = {}) {
  return parseJobAnalysisContent(
    JSON.stringify({
      jobMeta: { title: 'Senior Software Engineer', seniority: 'Senior', industry: 'Transportation', department: 'Engineering' },
      skills: { technical: ABILITIES, tools: ['Docker'], soft: ['collaboration'] },
      technologies: ['Python', 'PostgreSQL'],
      protocols: ['REST'], methodologies: ['agile'], architecturePatterns: ['microservices'],
      responsibilities: ['backend service architecture'], domainKnowledge: ['rail logistics'],
      keywords: { actionVerbs: ['develop'], buzzwords: [], mustInclude: ['Python'] },
      ...overrides,
    }),
    'A job description mentioning Python, PostgreSQL and Docker.'
  );
}

function profile() {
  return {
    id: 'p', name: 'T', title: 'Software Engineer', totalYearsExperience: 8,
    contact: { phone: '1', email: 'a@b.c', location: 'X' },
    summary: 'Engineer.',
    experience: [{
      title: 'Software Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
      location: 'Remote', description: 'Built Python services on PostgreSQL with Docker.',
      achievements: [], skills: [],
    }],
    strengths: [], skills: [], education: [], certifications: [], createdAt: '', updatedAt: '',
  };
}

function proseChecklist(values) {
  const read = (name) => { try { return JSON.parse(values[name]); } catch { return []; } };
  return new Set([...read('keywordsJson'), ...read('conceptKeywordsJson')].map((s) => s.toLowerCase()));
}

test('every ability the job named reaches a prose checklist', () => {
  // The failure this pins: `skills.technical` reached no checklist variable at
  // all, so the coverage floor was computed over a list these were absent from
  // and the model was never asked for them. 0 of 18 in a measured run.
  const values = buildTailorResumePromptValues(profile(), analysisWith());
  const prose = proseChecklist(values);
  for (const ability of ABILITIES) {
    assert.ok(prose.has(ability.toLowerCase()), `"${ability}" is in no checklist the model is given`);
  }
});

test('the two prose checklists do not ask for the same term twice', () => {
  const values = buildTailorResumePromptValues(profile(), analysisWith());
  const keywords = JSON.parse(values.keywordsJson).map((s) => s.toLowerCase());
  const concepts = JSON.parse(values.conceptKeywordsJson).map((s) => s.toLowerCase());
  const overlap = concepts.filter((c) => keywords.includes(c));
  assert.deepEqual(overlap, [], `asked for twice: ${overlap.join(', ')}`);
});

test('a concept the skill library has never heard of is still named to the prompt', () => {
  // It used to be built from library matches, so a concept outside the library
  // was dropped from the skills block for being a concept AND never named to
  // the prompt for not being in the library. It landed nowhere.
  const values = buildTailorResumePromptValues(profile(), analysisWith());
  const concepts = JSON.parse(values.conceptKeywordsJson);
  assert.ok(
    concepts.some((c) => /full-stack engineering/i.test(c)),
    `expected an uncatalogued concept to be listed: ${concepts.join(', ')}`
  );
  for (const concept of concepts) {
    assert.ok(isConceptSkill(concept), `"${concept}" is in CONCEPT_KEYWORDS but is not a concept`);
  }
});

test('none of them reaches the Technical Skills block', () => {
  // The whole point of routing these to prose. An ability is not a skill you
  // can list, and a scanner reads the document, not just the list.
  const out = parseTailoredResumeContent(
    JSON.stringify({
      title: 'Engineer', summary: 'S.', experience: profile().experience, strengths: [], coverLetter: 'x',
    }),
    profile(),
    analysisWith()
  );

  for (const ability of ABILITIES) {
    assert.ok(
      !out.hardSkills.some((s) => s.toLowerCase() === ability.toLowerCase()),
      `"${ability}" reached the skills block`
    );
  }
  assert.ok(out.hardSkills.every((s) => !isConceptSkill(s)), 'no concept may be listed as a skill');
});

test('the analyser folding technical into required does not re-admit them', () => {
  // `normalizeJobAnalysisResponse` merges skills.technical into skills.required
  // as it parses, so reading `required` - even raw, avoiding the getter - hands
  // back every ability. That is how "Network operations" and "Clinical care"
  // got into a skills block after the getter had already been avoided.
  const analysis = analysisWith();
  assert.deepEqual(
    analysis.skills.required,
    analysis.skills.technical,
    'the premise: these two fields are the same list after normalization'
  );

  const out = parseTailoredResumeContent(
    JSON.stringify({
      title: 'Engineer', summary: 'S.', experience: profile().experience, strengths: [], coverLetter: 'x',
    }),
    profile(),
    analysis
  );
  for (const ability of ABILITIES) {
    assert.ok(
      !out.hardSkills.some((s) => s.toLowerCase() === ability.toLowerCase()),
      `"${ability}" came back through skills.required`
    );
  }
});

test('a named tool reaches the PROMPT, which is where the block is decided now', () => {
  /*
   * This used to assert that code put Python, PostgreSQL and Docker into the
   * Technical Skills block. Code no longer chooses that block - the tailor call
   * returns it, grouped, and it is printed unchanged - so the contract that
   * matters is upstream: everything the posting named has to reach the prompt,
   * or the model cannot put it anywhere.
   */
  const { buildTailorResumePromptValues } = require('../dist/services/resumeService');
  const values = buildTailorResumePromptValues(profile(), analysisWith());
  const sent = (values.skillsJSON + ' ' + values.jobAnalysisJson).toLowerCase();

  for (const tool of ['Python', 'PostgreSQL', 'Docker']) {
    assert.ok(sent.includes(tool.toLowerCase()), tool + ' was named by the job and must reach the prompt');
  }
});

test('every hard skill the job named reaches the prompt, from every field', () => {
  // The fields whose whole job is naming technologies - `tools`,
  // `technologies`, `protocols` - were once read for the block and then not
  // read at all, and Pulumi went missing from a posting that named it. The
  // block moved to the model; the fields still have to arrive.
  const tools = ['Docker', 'Kubernetes', 'Terraform', 'Datadog', 'Vault', 'Argo CD'];
  const technologies = ['Python', 'Go', 'FastAPI', 'PostgreSQL', 'Temporal', 'Pulumi'];
  const protocols = ['REST', 'gRPC', 'GraphQL', 'OAuth 2.0'];

  const analysis = parseJobAnalysisContent(
    JSON.stringify({
      jobMeta: { title: 'Senior Backend Engineer', seniority: 'Senior', industry: 'fintech', department: 'engineering' },
      skills: { technical: [], tools, soft: [] },
      technologies, protocols, methodologies: [], architecturePatterns: [],
      responsibilities: [], domainKnowledge: [],
      keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
    }),
    // Deliberately NOT naming every term in the raw text - that is the case
    // that used to lose them.
    'Senior Backend Engineer. Python and Go services on PostgreSQL.'
  );

  const { buildTailorResumePromptValues } = require('../dist/services/resumeService');
  const values = buildTailorResumePromptValues(profile(), analysis);
  const sent = (values.skillsJSON + ' ' + values.jobAnalysisJson).toLowerCase();

  for (const named of [...tools, ...technologies, ...protocols]) {
    assert.ok(sent.includes(named.toLowerCase()), named + ' was named by the job and never reached the prompt');
  }
});

test('REST is a protocol, not an idea', () => {
  // It sits in the analyser's `protocols` field beside gRPC and GraphQL, both of
  // which were listable. Calling one of the three a concept meant a posting
  // asking for REST by name got the other two and not it.
  assert.ok(!isConceptSkill('REST'), 'REST must be listable');
  assert.ok(!isConceptSkill('gRPC'));
  assert.ok(!isConceptSkill('GraphQL'));
  // The vague forms stay concepts - "API" alone names nothing a reader screens for.
  assert.ok(isConceptSkill('API'));
  assert.ok(isConceptSkill('APIs'));
  assert.ok(isConceptSkill('RESTful services'));
});
