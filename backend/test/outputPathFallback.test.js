const assert = require('node:assert/strict');
const test = require('node:test');

const { renderOutputPathTemplate } = require('../dist/utils/outputStorage');

/**
 * The failure this exists to catch: a folder segment whose tokens all resolve
 * to nothing used to become the literal `unknown`. Every job the analyser could
 * not name a title for therefore shared ONE folder, so the second such job
 * overwrote the first one's resume, and the folder name said nothing about
 * which field had come up empty.
 */

const TEMPLATE = '/{{date}}/{{profile name}}/{{company name}}/{{job title}}';

const vars = (overrides) => ({
  date: '2026-09-13',
  profileName: 'Jane Doe',
  companyName: 'Acme Inc.',
  rowNumber: '12',
  jobTitle: 'Senior Engineer',
  ...overrides,
});

test('an empty job title names itself instead of collapsing to "unknown"', () => {
  const segments = renderOutputPathTemplate(TEMPLATE, vars({ jobTitle: '' })).split('/');

  assert.equal(segments.pop(), 'unknown_job_title');
  // The rest of the path is untouched: one empty token must not cost the
  // company or profile folder.
  assert.deepEqual(segments, ['2026_09_13', 'jane_doe', 'acme_inc']);
});

test('a title that sanitizes away is treated the same as an empty one', () => {
  // sanitizePathSegment keeps [a-z0-9] only, so a punctuation-only or
  // non-Latin title reaches the fallback with nothing left.
  for (const jobTitle of ['---', '???', '소프트웨어 엔지니어', '   ']) {
    assert.equal(
      renderOutputPathTemplate('/{{job title}}', vars({ jobTitle })),
      'unknown_job_title',
      `title ${JSON.stringify(jobTitle)}`
    );
  }
});

test('each token falls back to its own name, so empty fields stay distinguishable', () => {
  const cases = [
    ['/{{company name}}', { companyName: '' }, 'unknown_company'],
    ['/{{profile name}}', { profileName: '' }, 'unnamed_profile'],
    ['/{{job title}}', { jobTitle: '' }, 'unknown_job_title'],
  ];

  for (const [template, overrides, expected] of cases) {
    assert.equal(renderOutputPathTemplate(template, vars(overrides)), expected, template);
  }

  // Two different empty fields must not produce the same folder.
  assert.notEqual(
    renderOutputPathTemplate('/{{company name}}', vars({ companyName: '' })),
    renderOutputPathTemplate('/{{job title}}', vars({ jobTitle: '' }))
  );
});

test('a segment that still has one live token is left alone', () => {
  // The fallback is a last resort, not a decoration: an absent row number in
  // "{{row number}}_{{company name}}" still yields just the company.
  assert.equal(
    renderOutputPathTemplate('/{{row number}}_{{company name}}', vars({ rowNumber: '' })),
    'acme_inc'
  );
  assert.equal(
    renderOutputPathTemplate('/{{row number}}_{{company name}}', vars({ rowNumber: undefined })),
    'acme_inc'
  );
});

test('a multi-token segment with nothing left names every token it used', () => {
  assert.equal(
    renderOutputPathTemplate(
      '/{{row number}}_{{company name}}',
      vars({ rowNumber: '', companyName: '' })
    ),
    'no_row_unknown_company'
  );
});

test('a fully populated template is unchanged by the fallback', () => {
  assert.equal(
    renderOutputPathTemplate(TEMPLATE, vars()),
    '2026_09_13/jane_doe/acme_inc/senior_engineer'
  );
});

test('a literal segment with no tokens still falls back to "unknown"', () => {
  // Nothing to name, so the generic label is the honest answer.
  assert.equal(renderOutputPathTemplate('/{{company name}}/---', vars()), 'acme_inc/unknown');
});
