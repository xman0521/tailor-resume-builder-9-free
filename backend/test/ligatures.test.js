const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { launchBrowser } = require('../dist/config/browser');
const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');

const TEMPLATES_DIR = path.join(__dirname, '..', 'static', 'templates');

/**
 * The failure this exists to catch.
 *
 * Chrome substitutes ONE glyph for "fi", "fl", "ffi" and "ffl" when the font
 * offers them - Calibri does, and nine installed templates use Calibri - and
 * writes that glyph into the PDF with a ToUnicode entry pointing at U+FB01 and
 * friends. The file then does not contain "Artificial"; it contains "Arti",
 * U+FB01, "cial", drawn as three separate operations. Copying gave
 * "Artifi cial", and an ATS that does not normalise Unicode never matched the
 * keyword at all.
 *
 * Asserted on the PDF's own ToUnicode table rather than on extracted text,
 * because every extractor normalises differently and the question here is what
 * the FILE says.
 */

const WORDS = [
  'Apache Airflow', 'Artificial Intelligence', 'Dockerfile', 'Snowflake',
  'Cloudflare Workers', 'Classification Models', 'MLflow', 'Traefik',
];

function inflatedStreams(buffer) {
  const out = [];
  const raw = buffer.toString('latin1');
  const marker = /stream\r?\n/g;
  let match;
  while ((match = marker.exec(raw))) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    try { out.push(zlib.inflateSync(buffer.subarray(start, end)).toString('latin1')); } catch { /* not Flate */ }
  }
  return out;
}

/** The ligature codepoints a reader would find in the PDF's ToUnicode table. */
function ligatureCodepoints(buffer) {
  const found = new Set();
  for (const stream of inflatedStreams(buffer)) {
    for (const block of stream.match(/beginbfchar[\s\S]*?endbfchar/g) || []) {
      for (const [, , destination] of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        const chars = (destination.match(/.{4}/g) || [])
          .map((unit) => String.fromCharCode(parseInt(unit, 16)))
          .join('');
        for (const char of chars) {
          const code = char.charCodeAt(0);
          if (code >= 0xfb00 && code <= 0xfb04) found.add(char);
        }
      }
    }
  }
  return found;
}

function profileWith(skills) {
  return {
    id: 'p', name: 'Jordan Avery Chen', title: 'Senior Data Engineer',
    profileSettings: { technicalSkillsLayout: 'flat' },
    contact: { phone: '555-555-5555', email: 'j@example.com', location: 'Austin, TX' },
    summary: 'Built Artificial Intelligence pipelines on Apache Airflow with careful configuration.',
    experience: [{
      title: 'Data Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
      location: 'Remote', description: 'Owned Dockerfile builds and Snowflake models.',
      achievements: ['Cut Classification Models training time through profiling.'], skills: [],
    }],
    strengths: [], skills, education: [], certifications: [], createdAt: '', updatedAt: '',
  };
}

/** Templates whose font stack leads with Calibri - the only font that ligates. */
function calibriTemplates() {
  return fs
    .readdirSync(TEMPLATES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8')))
    .filter((template) => /font-family\s*:\s*['"]?Calibri/i.test(template.htmlContent ?? ''));
}

test('the rule that disables ligatures reaches every rendered document', async () => {
  const templates = calibriTemplates();
  assert.ok(templates.length > 0, 'no Calibri template installed; this test proves nothing');

  for (const template of templates) {
    const html = await generatePreviewHTML(profileWith(WORDS), template);
    assert.ok(
      html.includes('resume-no-ligatures'),
      `${template.id}: the no-ligature rule is missing`
    );
    // It has to be INSIDE the document. A stylesheet before <!DOCTYPE html>
    // puts the browser in quirks mode and moves every template's layout.
    const doctype = html.search(/<!DOCTYPE html>/i);
    if (doctype >= 0) {
      assert.ok(
        doctype < html.indexOf('resume-no-ligatures'),
        `${template.id}: the rule was placed before the doctype`
      );
    }
  }
});

test('no ligature glyph survives into a generated PDF', async (t) => {
  const templates = calibriTemplates();
  assert.ok(templates.length > 0, 'no Calibri template installed; this test proves nothing');

  let browser;
  try {
    browser = await launchBrowser();
  } catch {
    t.skip('no browser available in this environment');
    return;
  }

  try {
    const page = await browser.newPage();
    for (const template of templates) {
      await page.setContent(await generatePreviewHTML(profileWith(WORDS), template), { waitUntil: 'load' });
      const pdf = Buffer.from(await page.pdf({ format: 'Letter', printBackground: true }));

      const ligatures = ligatureCodepoints(pdf);
      assert.deepEqual(
        [...ligatures],
        [],
        `${template.id}: PDF still encodes ${[...ligatures].join(' ')}`
      );
    }
  } finally {
    await browser.close();
  }
});
