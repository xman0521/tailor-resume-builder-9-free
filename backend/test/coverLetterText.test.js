const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { saveCoverLetter } = require('../dist/generators/coverLetterGenerator');

/**
 * The letter has to survive being copied somewhere else.
 *
 * WHAT WAS WRONG, and it was not the file. A letter pasted out of the PDF
 * arrived with a line break in the middle of every sentence - "...reliability
 * depends on careful / infrastructure, useful / service signals...". Measured on
 * a delivered letter, the PDF is correct: its text layer is uniform full-width
 * lines, and its structure tree carries one `/P` per paragraph, so a reader that
 * understands structure copies it properly. A plain text extractor - which is
 * what "select all, copy" usually is - cannot, because a PDF has no paragraphs,
 * only glyphs at coordinates.
 *
 * Nothing about the PDF fixes that, so the letter is written as text as well.
 */

const profile = {
  id: 'p', name: 'Weitian Wu', title: 'Software Engineer', profileSettings: {},
  contact: { phone: '1', email: 'a@b.c', location: 'Austin, TX' },
  summary: '', experience: [], strengths: [], skills: [], education: [],
  certifications: [], createdAt: '', updatedAt: '',
};

// A letter as the model returns one: paragraphs separated by a blank line, and
// hard-wrapped inside them, which is what makes the collapsing worth testing.
const LETTER = [
  'I am excited by production engineering work where reliability depends on careful',
  'infrastructure, useful service signals, and practical automation. I have spent 10 years',
  'building software across e-commerce and manufacturing environments.',
  '',
  'In one set of production workflows, I used Prometheus, Grafana, Loki and Kubernetes to',
  'investigate failures, and the habit of staying with a problem until it is closed is the',
  'part of the work I would bring with me.',
].join('\n');

test('the letter is written as text beside the PDF, one line per paragraph', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-letter-'));
  const pathInfo = {
    relativeBase: 'probe', absoluteDir: outDir, storagePathBase: 'probe',
    profileSlug: 'weitian_wu', resumeFileStem: 'Weitian_Wu_DevOps_Engineer',
    coverLetterFileStem: 'Weitian_Wu_DevOps_Engineer_cover_letter',
    companyFolderName: '1_acme', roleSlug: 'devops_engineer',
  };

  try {
    await saveCoverLetter(profile, LETTER, pathInfo);

    const written = fs.readdirSync(outDir).sort();
    assert.deepEqual(written, [
      'Weitian_Wu_DevOps_Engineer_cover_letter.pdf',
      'Weitian_Wu_DevOps_Engineer_cover_letter.txt',
    ]);

    const text = fs.readFileSync(path.join(outDir, 'Weitian_Wu_DevOps_Engineer_cover_letter.txt'), 'utf8');
    const lines = text.split(/\r?\n/);

    // A paragraph is ONE line, however the model wrapped it - that is the whole
    // point: whatever this is pasted into does its own wrapping.
    const paragraphs = lines.filter((line) => line.trim().length > 40);
    assert.equal(paragraphs.length, 2, text);
    assert.match(paragraphs[0], /^I am excited by production engineering work .* manufacturing environments\.$/);
    assert.match(paragraphs[1], /^In one set of production workflows, .* would bring with me\.$/);
    // No sentence is broken across lines.
    assert.doesNotMatch(text, /careful\r?\ninfrastructure/);

    // And it is a letter, not a fragment: greeting, body, sign-off, name.
    assert.ok(lines[0].trim().length > 0, 'no greeting');
    assert.equal(lines[lines.length - 3], 'Best regards,');
    assert.equal(lines[lines.length - 2], 'Weitian Wu');

    // Blank lines separate the parts, so it pastes into a form as a letter.
    assert.match(text, /\r\n\r\n/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
