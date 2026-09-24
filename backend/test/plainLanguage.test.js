const assert = require('node:assert/strict');
const test = require('node:test');

const { plainLanguage, bannedTermsIn } = require('../dist/services/utils/plainLanguage');
const { parseTailoredResumeContent } = require('../dist/services/resumeService');

/**
 * The resume's vocabulary.
 *
 * The prompt asks for plain words, and over 120 finished resumes the previous
 * prompt's tone rules held in 61% of them. So the banned words are taken out
 * here as well, after the model has answered, where the rule cannot be ignored.
 */

test('the banned verbs become plain ones, in the same tense', () => {
  assert.equal(plainLanguage('Leveraged Redis to cut lookups'), 'Used Redis to cut lookups');
  assert.equal(plainLanguage('Utilizing Kafka for ingest'), 'Using Kafka for ingest');
  assert.equal(plainLanguage('Spearheaded the migration'), 'Ran the migration');
  assert.equal(plainLanguage('Orchestrated deployments with Kubernetes'), 'Ran deployments with Kubernetes');
  assert.equal(plainLanguage('Architected the ingest path'), 'Built the ingest path');
  assert.equal(plainLanguage('Designed and implemented the API'), 'Built and implemented the API');
  assert.equal(plainLanguage('Delivered the checkout rewrite'), 'Shipped the checkout rewrite');
  assert.equal(plainLanguage('Managed a team of six'), 'Ran a team of six');
  assert.equal(plainLanguage('Supported production systems'), 'Maintained production systems');
  assert.equal(plainLanguage('Integrated the billing service'), 'Connected the billing service');
  assert.equal(plainLanguage('Streamlined the deploy'), 'Simplified the deploy');
  assert.equal(plainLanguage('Maximized cache hits'), 'Raised cache hits');
});

test('a phrase that needs its object rewired is replaced whole', () => {
  assert.equal(plainLanguage('Partnered with the data team'), 'Worked with the data team');
  assert.equal(plainLanguage('Contributed to the scheduler rewrite'), 'Helped with the scheduler rewrite');
  assert.equal(plainLanguage('Collaborated with SRE on the rollout'), 'Worked with SRE on the rollout');
});

test('"led to" is not the banned verb', () => {
  // "Ran to a 40% reduction" is nonsense; the guard is what keeps it out.
  assert.equal(
    plainLanguage('The rewrite led to a 40% drop in timeouts'),
    'The rewrite led to a 40% drop in timeouts'
  );
  assert.equal(plainLanguage('Led the payments rewrite'), 'Ran the payments rewrite');
});

test('hype adjectives are deleted, and take their punctuation with them', () => {
  assert.equal(
    plainLanguage('Built scalable backend services in Node.js'),
    'Built backend services in Node.js'
  );
  assert.equal(
    plainLanguage('Shipped a robust, seamless integration'),
    'Shipped an integration'
  );
  assert.equal(
    plainLanguage('Ran cross-functional reviews with end-to-end coverage'),
    'Ran reviews with coverage'
  );

  // The comma the sentence needs is not the comma the adjective was holding up.
  assert.equal(
    plainLanguage('Used Kubernetes to orchestrate deployments end-to-end, streamlining the release process.'),
    'Used Kubernetes to run deployments, simplifying the release process.'
  );
});

test('the words around them are left alone', () => {
  // Technical nouns survive: "orchestration" is what Kubernetes does, and
  // "integration" and "design" are things, not the banned verbs.
  const kept = 'Kubernetes orchestration, integration tests, and the design document';
  assert.equal(plainLanguage(kept), kept);
  assert.equal(plainLanguage(''), '');
  assert.equal(plainLanguage('Cut p99 latency from 180ms to 118ms'), 'Cut p99 latency from 180ms to 118ms');
});

test('what cannot be swapped is reported instead of quietly kept', () => {
  // A metaphor needs the sentence rewritten, and only the model knows what it
  // meant - so it is logged for the operator rather than mangled here.
  assert.deepEqual(bannedTermsIn('This moved the needle on latency'), ['moving the needle', 'move the needle']
    .filter((term) => 'this moved the needle on latency'.includes(term)));
  assert.deepEqual(bannedTermsIn('Cut p99 latency from 180ms to 118ms'), []);
  assert.ok(bannedTermsIn('Built it from the ground up').includes('from the ground up'));
});

// --------------------------------------------------- through the real build

const profile = () => ({
  id: 'p', name: 'Leo Example', title: 'Software Engineer',
  contact: { phone: '555-555-5555', email: 'l@example.com', location: 'Austin, TX' },
  summary: 'Engineer.',
  experience: [{
    title: 'Software Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
    location: 'Remote', description: 'Built things.', achievements: ['Did work.'], skills: [],
  }],
  skills: [], education: [], certifications: [], strengths: [],
});

const built = (overrides) => parseTailoredResumeContent(
  JSON.stringify({
    title: 'Engineer',
    summary: 'Designed scalable services and spearheaded the migration.',
    experience: [{
      ...profile().experience[0],
      description: 'Acme is a leading provider of logistics software.',
      achievements: ['Leveraged Kafka to build a robust, end-to-end ingest path.'],
    }],
    strengths: [],
    coverLetter: 'I architected the ingest path and managed the rollout.',
    ...overrides,
  }),
  profile(),
  undefined
);

test('a finished resume carries none of the banned words', () => {
  const out = built();
  const prose = [out.summary, ...out.experience[0].achievements, out.coverLetter].join(' ');

  for (const term of ['Designed', 'scalable', 'spearheaded', 'Leveraged', 'robust', 'end-to-end', 'architected', 'managed']) {
    assert.ok(!new RegExp(`\\b${term}\\b`, 'i').test(prose), `"${term}" reached the page: ${prose}`);
  }
  assert.match(out.summary, /^Built services and ran the migration\.$/);
  assert.equal(out.experience[0].achievements[0], 'Used Kafka to build an ingest path.');
  assert.equal(out.coverLetter, 'I built the ingest path and ran the rollout.');
});

test('a role opens straight into its bullets', () => {
  // The paragraph under the company name was the most generated-looking part
  // of the page: the bullets said what the person did, and it said it again
  // with adjectives.
  assert.equal(built().experience[0].description, '');
});

test('there is no soft-skills block', () => {
  // 44 of the library's soft skills are the exact register being removed -
  // "Innovation", "Creative solutions", "Proactiveness", "Visionary Leadership".
  assert.deepEqual(built().softSkills, []);
});

// ------------------------------------------- the words the posting asked for

test('a banned word the posting asked for is kept', () => {
  /*
   * The collision this pins. The analyser extracts 15-25 past-tense action
   * verbs per posting as required keywords, and its own examples were
   * "architected" and "orchestrated" - so the app asked for a word and then
   * deleted it. Measured on an answer that placed every term perfectly,
   * coverage fell from 34/34 to 17/34, eleven of them lost right here.
   */
  const askedFor = ['architected', 'orchestrated', 'scalable systems', 'cross-functional collaboration'];
  const sentence = 'Architected the ingest path and orchestrated scalable systems with cross-functional collaboration.';
  assert.equal(plainLanguage(sentence, askedFor), sentence);

  // The same words, when the posting did NOT ask for them, still go.
  assert.equal(
    plainLanguage('Architected the ingest path and orchestrated scalable systems.'),
    'Built the ingest path and ran systems.'
  );

  // A phrase is protected whole; a bare adjective the model chose is not.
  assert.equal(
    plainLanguage('Built robust, scalable services on Kubernetes', ['Kubernetes', 'scalable systems']),
    'Built services on Kubernetes'
  );

  // And a protected word is not reported as a style problem either.
  assert.deepEqual(bannedTermsIn('Architected it', askedFor), []);
  assert.deepEqual(bannedTermsIn('Architected it'), ['architected']);
});

test('a resume that places every checklist term keeps every checklist term', () => {
  /*
   * The end-to-end version of the same measurement, and the one that would
   * have caught both bugs: the vocabulary swaps deleting keywords, and the
   * prompt routing keywords into the role description this now discards.
   */
  const { buildTailorResumePromptValues, parseJobAnalysisContent } = require('../dist/services/resumeService');
  const { measurePlacement, renderedProse } = require('../dist/services/utils/placementCoverage');

  const analysis = parseJobAnalysisContent(JSON.stringify({
    jobMeta: { title: 'Senior Software Engineer, Platform', seniority: 'Senior', industry: 'SaaS', department: 'Engineering' },
    skills: {
      technical: ['Kubernetes', 'Kafka', 'Terraform'], required: ['Go'], preferred: ['Datadog'],
      tools: [], technologies: [], soft: ['communication', 'ownership'],
    },
    technologies: [], protocols: [], methodologies: ['CI/CD'], architecturePatterns: ['event-driven architecture'],
    responsibilities: ['deployment pipeline management'], domainKnowledge: ['observability'],
    softSkills: ['communication', 'ownership'],
    keywords: {
      // The words that used to be deleted: banned verbs and banned phrases.
      actionVerbs: ['architected', 'orchestrated', 'designed', 'led', 'delivered', 'integrated', 'managed', 'supported', 'migrated'],
      buzzwords: ['scalable systems', 'cross-functional collaboration', 'end-to-end delivery'],
      mustInclude: ['Kubernetes', 'Kafka'],
    },
  }), 'Platform team needing Kubernetes, Kafka, Terraform and Go, with cross-functional, end-to-end delivery of scalable systems.');

  const person = {
    ...profile(),
    experience: [{ ...profile().experience[0], achievements: [] }],
  };

  const checklist = [
    ...JSON.parse(buildTailorResumePromptValues(person, analysis).keywordsJson),
    ...JSON.parse(buildTailorResumePromptValues(person, analysis).conceptKeywordsJson),
  ];
  assert.ok(checklist.length >= 20, `a thin checklist proves nothing: ${checklist.length}`);

  // A model that obeys the prompt: every term in the summary or a bullet, and
  // nothing in the role description, which the prompt no longer offers.
  const half = Math.ceil(checklist.length / 2);
  const answer = JSON.stringify({
    title: 'Engineer',
    summary: `Engineer of 9 years. ${checklist.slice(0, half).join('. ')}.`,
    experience: [{
      ...person.experience[0],
      description: '',
      achievements: checklist.slice(half).map((term) => `Work involving ${term} on the platform.`),
    }],
    strengths: [],
    coverLetter: 'x',
  });

  const built = parseTailoredResumeContent(answer, person, analysis);
  const report = measurePlacement(renderedProse(built), checklist);
  assert.equal(
    report.ratio,
    1,
    `${report.total - report.placed} checklist term(s) were removed after the model wrote them: ${report.missing.join(', ')}`
  );
});
