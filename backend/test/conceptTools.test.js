const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseJobAnalysisContent,
  buildTailorResumePromptValues,
} = require('../dist/services/resumeService');
const { conceptToolOptions } = require('../dist/services/utils/hardSkillSelection');

/**
 * Concepts reaching the skills block as the tools they are built with.
 *
 * A posting asks for "CI/CD", "containerization", "infrastructure as code".
 * None of those is a skill anybody installs, and the block may not carry them -
 * but dropping them loses the match a scanner is looking for. So the tools each
 * concept is built with are sent WITH the request, and the model picks the one
 * that fits the candidate. Code cannot pick: it does not have the profile in
 * front of it, and it may not touch the block that comes back.
 */

const profile = () => ({
  id: 'p', name: 'Probe', title: 'Engineer',
  contact: { phone: '1', email: 'a@b.c', location: 'X' },
  summary: 'Engineer.',
  experience: [{
    title: 'Engineer', company: 'Acme', startDate: '01/2021', endDate: 'Present',
    location: 'Remote', description: 'Ran services.', achievements: [], skills: [],
  }],
  strengths: [], skills: [], education: [], certifications: [], createdAt: '', updatedAt: '',
});

const analysisFor = (required = []) => parseJobAnalysisContent(JSON.stringify({
  jobMeta: { title: 'Platform Engineer', seniority: 'Senior', industry: 'SaaS', department: 'Engineering' },
  skills: { technical: ['Python'], required, preferred: [], tools: [], soft: [], technologies: [] },
  technologies: [], protocols: [], methodologies: ['CI/CD', 'infrastructure as code'],
  architecturePatterns: ['event-driven architecture'],
  responsibilities: ['containerization and orchestration'], domainKnowledge: ['observability'], softSkills: [],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
}), 'Platform role: CI/CD, infrastructure as code, containerization, observability.');

const rowsFor = (analysis) => JSON.parse(buildTailorResumePromptValues(profile(), analysis).conceptToolsJson);
const find = (rows, concept) => rows.find((row) => row.concept.toLowerCase().includes(concept));

test('the table answers with tools, and is not gated by the skill library', () => {
  // The old lookup filtered these against the 1,492-row library, which was
  // right while the library decided the block. It would now only hide options
  // nobody has catalogued.
  assert.deepEqual(conceptToolOptions('infrastructure as code'), ['Terraform', 'Ansible', 'CloudFormation']);
  assert.deepEqual(conceptToolOptions('containerization'), ['Docker', 'Kubernetes']);
  assert.deepEqual(conceptToolOptions('a concept nobody has a tool for'), []);
});

test('every concept the posting named arrives with its tools', () => {
  const rows = rowsFor(analysisFor());

  for (const concept of ['ci/cd', 'containeriz', 'observability']) {
    const row = find(rows, concept);
    assert.ok(row, `"${concept}" reached the prompt with no tools: ${JSON.stringify(rows)}`);
    assert.ok(row.tools.length > 0);
  }
  // Nothing without a mapping is sent as an empty row.
  assert.ok(rows.every((row) => row.tools.length > 0));
});

test('a tool the posting named for itself comes first', () => {
  // It is not a choice between options, it is the answer: a posting that says
  // "CI/CD (GitHub Actions)" gets GitHub Actions on the resume.
  for (let run = 0; run < 8; run += 1) {
    const rows = rowsFor(analysisFor(['GitHub Actions']));
    assert.equal(find(rows, 'ci/cd').tools[0], 'GitHub Actions');
  }
});

test('the options are shuffled, so fifty resumes do not all name Jenkins', () => {
  /*
   * Handed the same list in the same order, a model reaches for the same first
   * entry every time. The order changes per request, so the pick varies
   * between candidates while staying a tool the concept is actually built with.
   */
  const seen = new Set();
  for (let run = 0; run < 24; run += 1) {
    seen.add(find(rowsFor(analysisFor()), 'ci/cd').tools.join('|'));
  }
  assert.ok(seen.size > 1, `the order never changed across 24 requests: ${[...seen]}`);

  // Every ordering is the same set of tools - shuffling must not invent or drop.
  for (const order of seen) {
    assert.deepEqual(order.split('|').sort(), ['GitHub Actions', 'GitLab CI', 'Jenkins']);
  }
});

test('the prompt asks for the mapping it is sent', () => {
  // The rule and the data have to arrive together: a prompt that never mentions
  // CONCEPT_TOOLS leaves the model to invent a tool, which is how "Visual
  // Studio 2026" reached a resume.
  const prompt = require('../static/prompts/tailor-resume.json').content;
  assert.match(prompt, /\[\[conceptToolsJson\]\]/);
  assert.match(prompt, /A CONCEPT BECOMES THE TOOL IT IS BUILT WITH/);
  assert.match(prompt, /spelled as the posting spells it/);
});
