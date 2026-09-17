const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseJobAnalysisContent,
  buildTailorResumePromptValues,
} = require('../dist/services/resumeService');
const { collectJobKeywords, findUncoveredKeywords } = require('../dist/services/utils/keywordCoverage');

/**
 * The guarantee this pins: every term the analyser pulled out of the posting
 * reaches the prompt in at least one list.
 *
 * The failure it was written for: each prompt list is assembled by its own
 * function reading its own subset of the analysis, and nothing compared the
 * union of them against the posting. `skills.required` and `skills.preferred`
 * were missing from the prose checklist, which was invisible because both
 * reach the Technical Skills SELECTION - so anything the library carried came
 * out fine, and only a preferred technology the library had never heard of was
 * extracted, carried through the analysis, and written nowhere at all.
 */

const analysisWith = (overrides = {}) =>
  parseJobAnalysisContent(
    JSON.stringify({
      jobMeta: { title: 'Senior Platform Engineer', seniority: 'Senior', industry: 'Fintech', department: 'Platform' },
      skills: {
        technical: ['Distributed systems', 'Incident response', 'Service ownership'],
        required: ['Kubernetes', 'Go', 'PostgreSQL'],
        preferred: ['ArgoCD', 'Kafka', 'Backstage'],
        tools: ['Datadog', 'PagerDuty'],
        soft: ['collaboration', 'mentorship'],
        technologies: ['Redis'],
      },
      technologies: ['Prometheus', 'Grafana'],
      protocols: ['gRPC', 'OpenTelemetry'],
      methodologies: ['agile', 'trunk-based development'],
      architecturePatterns: ['microservices', 'event-driven'],
      responsibilities: ['own the platform roadmap', 'run the on-call rotation'],
      domainKnowledge: ['payments', 'PCI DSS'],
      softSkills: ['pragmatism'],
      keywords: {
        actionVerbs: ['designed', 'operated'],
        buzzwords: ['cloud-native', 'developer experience'],
        mustInclude: ['SLO', 'multi-tenant'],
      },
      ...overrides,
    }),
    'A job description mentioning Kubernetes, Go, PostgreSQL, ArgoCD and SLOs.'
  );

const profile = () => ({
  id: 'p', name: 'T', title: 'Platform Engineer', totalYearsExperience: 9,
  contact: { phone: '1', email: 'a@b.c', location: 'X' },
  summary: 'Engineer.',
  experience: [{
    title: 'Platform Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
    location: 'Remote', description: 'Ran Kubernetes and Terraform on AWS.', achievements: [], skills: [],
  }],
  strengths: [], skills: [], education: [], certifications: [], createdAt: '', updatedAt: '',
});

function promptLists(analysis) {
  const values = buildTailorResumePromptValues(profile(), analysis);
  const read = (name) => {
    try { return JSON.parse(values[name]); } catch { return []; }
  };
  return [
    read('skillsJSON'),
    read('keywordsJson'),
    read('conceptKeywordsJson'),
    read('keyResponsibilitiesJson'),
    read('domainKnowledge'),
  ];
}

test('every term the posting named reaches the prompt', () => {
  const analysis = analysisWith();
  const uncovered = findUncoveredKeywords(collectJobKeywords(analysis), promptLists(analysis));
  assert.deepEqual(uncovered, [], `these were extracted and then written nowhere: ${uncovered.join(', ')}`);
});

test('a preferred technology the library has never heard of still reaches the prompt', () => {
  // The exact term that found this: preferred-only, not in the library, and so
  // present in no list at all.
  const analysis = analysisWith();
  const lists = promptLists(analysis).flat().map((t) => String(t).toLowerCase());
  assert.ok(lists.includes('argocd'), 'ArgoCD is in the posting and in none of the prompt lists');
});

test('coverage holds for a posting made only of fields that used to be dropped', () => {
  // Nothing in `technical`, `tools` or `keywords` - the fields the checklist
  // already read. If coverage depended on those, this is where it shows.
  const analysis = analysisWith({
    skills: {
      technical: [], required: ['Snowflake', 'dbt'], preferred: ['Looker', 'Fivetran'],
      tools: [], soft: [], technologies: [],
    },
    technologies: [], protocols: [], methodologies: [], architecturePatterns: [],
    responsibilities: [], domainKnowledge: [], softSkills: [],
    keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
  });

  const uncovered = findUncoveredKeywords(collectJobKeywords(analysis), promptLists(analysis));
  assert.deepEqual(uncovered, [], `uncovered: ${uncovered.join(', ')}`);
});

test('the two prose checklists stay disjoint, so nothing is asked for twice', () => {
  const values = buildTailorResumePromptValues(profile(), analysisWith());
  const keywords = new Set(JSON.parse(values.keywordsJson).map((t) => t.toLowerCase()));
  const concepts = JSON.parse(values.conceptKeywordsJson).map((t) => t.toLowerCase());
  const both = concepts.filter((t) => keywords.has(t));
  assert.deepEqual(both, [], `asked for twice: ${both.join(', ')}`);
});

test('collectJobKeywords reads every field, and deduplicates case-insensitively', () => {
  const analysis = analysisWith({
    skills: {
      technical: ['Kubernetes'], required: ['kubernetes'], preferred: ['KUBERNETES'],
      tools: [], soft: [], technologies: [],
    },
  });
  const kubernetes = collectJobKeywords(analysis).filter((t) => t.toLowerCase() === 'kubernetes');
  assert.equal(kubernetes.length, 1, 'one term written three ways is one keyword');
});

test('an empty or missing analysis is not a crash', () => {
  assert.deepEqual(collectJobKeywords(undefined), []);
  assert.deepEqual(findUncoveredKeywords([], [[]]), []);
});

test('a term inside a longer phrase does not count as covered', () => {
  // The flattering measurement this refuses: a scanner matches the term, not a
  // phrase that happens to contain it.
  const uncovered = findUncoveredKeywords(['Kubernetes'], [['Kubernetes operators']]);
  assert.deepEqual(uncovered, ['Kubernetes']);
});
