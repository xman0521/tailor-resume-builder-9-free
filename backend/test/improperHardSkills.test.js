const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isConceptSkill,
  mapConceptToConcreteSkills,
  repairGluedSkillName,
  collapseVendorPrefix,
  genericSuffixStem,
  buildSpellingVocabulary,
  selectHardSkills,
  UNLISTED_SKILL_PRIORITY,
} = require('../dist/services/utils/hardSkillSelection');
const { readHardSkillRecords } = require('../dist/database/skillsDatabase');

/**
 * The failures this exists to catch, all reported off finished resumes:
 *
 *   - activities printed as tools: "Rate Limiting", "Reverse Proxy",
 *     "Normalization", "Transactions", "Data Visualization";
 *   - plural category slots printed as tools: "CRM platforms", "AI frameworks";
 *   - a spelling variant walking past an exact-match set: "LLM Ops" vs "MLOps";
 *   - a space the PDF extractor dropped, printed alongside the correct
 *     spelling: "CodeQuality Gates" beside "Code Quality Gates";
 *   - a vendor prefix printed as a second skill: "Chrome Lighthouse" beside
 *     "Lighthouse";
 *   - terms the library has never heard of outranking AWS and Docker.
 */

const library = readHardSkillRecords();
const norm = (skill) => skill.trim().toLowerCase().replace(/\s+/g, ' ');
const librarySkills = new Set(library.map((record) => norm(record.skill)));
const canonicalOf = new Map(library.map((record) => [norm(record.skill), record.skill]));

test('activities are no longer classed as tools', () => {
  const activities = [
    'Rate Limiting', 'Reverse Proxy', 'Normalization', 'Transactions',
    'Data Visualization', 'Disaster Recovery', 'Code Quality Gates',
    'API integrations', 'Application Security', 'API Security',
    'Indexing', 'Sharding', 'Partitioning', 'Serialization', 'Deserialization',
    'Input Sanitization', 'Data Encryption', 'Server-Side Rendering',
    'Multi-region', 'Front-end', 'OWASP Top 10', 'Artificial Intelligence',
  ];

  for (const skill of activities) {
    assert.equal(isConceptSkill(skill), true, `${skill} should be a concept`);
  }
});

test('the products those rules pass over are still tools', () => {
  // Every one of these would be lost to a last-word rule applied carelessly.
  const products = [
    'Spring Security', 'Spring Integration', 'Azure Synapse Analytics',
    'Google Workflows', 'Azure Pipelines', 'Azure DevOps', 'Amazon Web Services',
    'Ant Design', 'SolidJS', 'Solidity', 'Azure API Management', 'Power BI',
  ];

  for (const skill of products) {
    assert.equal(isConceptSkill(skill), false, `${skill} should stay a tool`);
  }
});

test('plural category slots are concepts, and map to products where the library has them', () => {
  for (const slot of ['CRM platforms', 'ERP platforms', 'SIEM platforms', 'ML platforms',
                      'AI frameworks', 'AI copilots', 'AI models', 'SIEM integrations']) {
    assert.equal(isConceptSkill(slot), true, `${slot} should be a concept`);
  }

  // Where a target exists it is used; where it does not, the term maps to
  // nothing and reaches the resume through the prose instead. Both are correct.
  assert.deepEqual(mapConceptToConcreteSkills('SIEM platforms', librarySkills),
    ['Splunk', 'Azure Sentinel', 'Elasticsearch']);
  assert.deepEqual(mapConceptToConcreteSkills('AI frameworks', librarySkills),
    ['PyTorch', 'TensorFlow', 'LangChain']);
  assert.deepEqual(mapConceptToConcreteSkills('CRM platforms', librarySkills), []);
});

test('spelling variants are caught like the spelling that was written down', () => {
  for (const [written, variant] of [['MLOps', 'ML Ops'], ['DevOps', 'Dev Ops'],
                                    ['GitOps', 'Git Ops'], ['LLMOps', 'LLM Ops']]) {
    assert.equal(isConceptSkill(written), true, written);
    assert.equal(isConceptSkill(variant), true, `${variant} (variant of ${written})`);
  }
});

test('a space the PDF extractor dropped is put back, using the library spelling', () => {
  const vocabulary = buildSpellingVocabulary([]);
  const repair = (term) => repairGluedSkillName(term, librarySkills, canonicalOf, vocabulary);

  assert.equal(repair('CodeQuality Gates'), 'Code Quality Gates');
  assert.equal(repair('APISecurity'), 'API Security');
  assert.equal(repair('ApplicationSecurity'), 'Application Security');
  assert.equal(repair('Azure DataFactory'), 'Azure Data Factory');
});

test('a name that is camel-cased on purpose is left alone', () => {
  // The regression this caught: "JavaScript" split at Java|Script, because
  // "Java" is a library entry and vouched for the left half.
  const vocabulary = buildSpellingVocabulary(['UiPath Integration Service']);
  const repair = (term) => repairGluedSkillName(term, librarySkills, canonicalOf, vocabulary);

  for (const name of ['JavaScript', 'TypeScript', 'PostgreSQL', 'BigQuery',
                      'Cribl LogStream', 'Fortinet FortiProxy', 'Citrix NetScaler ADC',
                      'UiPath Integration Service']) {
    assert.equal(repair(name), null, `${name} should not be split`);
  }

  // ...while a term the same batch vouches for is still repaired.
  assert.equal(repair('UiPathAction Center'), 'UiPath Action Center');
});

test('a vendor prefix folds into the library entry it duplicates', () => {
  assert.equal(collapseVendorPrefix('Chrome Lighthouse', librarySkills, canonicalOf), 'Lighthouse');
  // Nothing to fold into: the remainder is not a library entry.
  assert.equal(collapseVendorPrefix('Microsoft Teams', librarySkills, canonicalOf), null);
  assert.equal(collapseVendorPrefix('Lighthouse', librarySkills, canonicalOf), null);
});

test('a generic noun on the end of an admitted name does not make a second skill', () => {
  const admitted = new Set(['open storefront', 'visual studio']);

  assert.equal(genericSuffixStem('Open Storefront Framework', admitted), 'open storefront');
  // "Code" is not a generic noun, so these stay two products.
  assert.equal(genericSuffixStem('Visual Studio Code', admitted), null);
  assert.equal(genericSuffixStem('Open Storefront', admitted), null);
});

test('a term the library has never heard of sorts below every library entry', () => {
  assert.ok(
    UNLISTED_SKILL_PRIORITY > 5,
    'library priorities run 1-5; an unverified term must sort after all of them'
  );
});

test('end to end: the reported terms stop reaching the skills block', () => {
  const reported = [
    'Multi-region', 'Code Quality Gates', 'CodeQuality Gates', 'API integrations',
    'Data Visualization', 'Azure DataFactory', 'Front-end', 'APISecurity',
    'Application Security', 'ApplicationSecurity', 'Rate Limiting', 'Transactions',
    'ERP platforms', 'CRM platforms', 'ML platforms', 'AI frameworks', 'LLM Ops',
    'MLOps', 'Artificial Intelligence', 'AI copilots', 'AI models', 'SIEM platforms',
    'SIEM integrations', 'Normalization', 'Reverse Proxy', 'Disaster Recovery',
    'OWASP Top 10', 'Chrome Lighthouse', 'Open Storefront', 'UiPathAction Center',
  ];

  const picked = selectHardSkills({
    jobSkills: ['React', 'TypeScript', 'Node.js', 'AWS',
      ...reported.filter((term) => librarySkills.has(norm(term)))],
    experienceSkills: ['React', 'TypeScript', 'PostgreSQL', 'Docker'],
    library,
    unlistedJobSkills: [...reported.filter((term) => !librarySkills.has(norm(term))),
      'Open Storefront Framework', 'UiPath Integration Service'],
  });

  const printed = new Set(picked.map(norm));
  const survivors = reported.filter((term) => printed.has(norm(term)));
  assert.deepEqual(survivors, [], `still printed: ${survivors.join(', ')}`);

  // The repaired spellings are printed once, not twice alongside the damage.
  for (const [kept, dropped] of [['UiPath Action Center', 'UiPathAction Center'],
                                 ['Open Storefront Framework', 'Open Storefront']]) {
    assert.equal(printed.has(norm(kept)), true, `${kept} should be printed`);
    assert.equal(printed.has(norm(dropped)), false, `${dropped} should not be`);
  }

  // The fill still reaches the target with real tools.
  assert.ok(picked.length >= 20, `only ${picked.length} skills selected`);
});

test('JD-named unknowns no longer displace the tools the candidate has used', () => {
  const picked = selectHardSkills({
    jobSkills: ['React', 'TypeScript', 'Node.js', 'AWS'],
    experienceSkills: ['React', 'TypeScript', 'PostgreSQL', 'Docker'],
    library,
    unlistedJobSkills: ['Claude Code', 'Model Context Protocol', 'Visual Studio',
      'Microsoft Teams', 'Cribl LogStream'],
  });

  const positionOf = (skill) => picked.findIndex((entry) => norm(entry) === norm(skill));
  for (const tool of ['AWS', 'Node.js']) {
    for (const unlisted of ['Claude Code', 'Microsoft Teams']) {
      assert.ok(
        positionOf(tool) < positionOf(unlisted),
        `${tool} (${positionOf(tool)}) should print before ${unlisted} (${positionOf(unlisted)})`
      );
    }
  }
});
