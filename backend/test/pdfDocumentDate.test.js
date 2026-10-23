const assert = require('node:assert/strict');
const test = require('node:test');

const { pdfDateString, resumeDocumentDate, withDocumentDate } = require('../dist/generators/pdfDocumentDate');

/**
 * ASKED FOR: "different date and time per profile, random date of a few months
 * ago", on resumes only. Chrome stamps the second the file was rendered.
 */

const NOW = new Date(2026, 9, 23, 15, 30, 0);
const DAY = 24 * 60 * 60 * 1000;
const PROFILES = ['adam-miller', 'jonathan-lai', 'christopher-taylor', 'p-1', 'p-2', 'p-3', 'p-4', 'p-5'];

test('each profile gets a weekday working-hours date a few months back', () => {
  for (const id of PROFILES) {
    const date = resumeDocumentDate(id, NOW);
    const daysAgo = (NOW - date) / DAY;
    assert.ok(daysAgo >= 59 && daysAgo <= 153, `${id}: ${daysAgo.toFixed(1)} days ago`);
    assert.ok(date.getDay() >= 1 && date.getDay() <= 5, `${id}: falls on a weekend`);
    assert.ok(date.getHours() >= 9 && date.getHours() <= 17, `${id}: ${date.getHours()}h is outside working hours`);
  }
});

test('one profile keeps one date, and profiles differ from each other', () => {
  assert.equal(resumeDocumentDate('adam-miller', NOW).getTime(), resumeDocumentDate('adam-miller', NOW).getTime());
  const distinct = new Set(PROFILES.map((id) => resumeDocumentDate(id, NOW).getTime()));
  assert.equal(distinct.size, PROFILES.length, 'two profiles share a date');
});

test('the date is written the way Word writes one, local time with its offset', () => {
  assert.match(pdfDateString(new Date(2026, 6, 21, 10, 7, 46)), /^D:20260721100746[+-]\d\d'\d\d'$/);
});

test('the dates are rewritten in place, and the rest of the file is untouched', () => {
  const head = "%PDF-1.4\n1 0 obj\n<</Title (R) /CreationDate (D:20261022162936+00'00') /ModDate (D:20261022162936+00'00')>>\nendobj\n";
  const tail = 'xref\n0 2\ntrailer\n<</Size 2>>\n%%EOF\n';
  const pdf = Buffer.from(head + tail, 'latin1');
  const date = new Date(2026, 6, 21, 10, 7, 46);

  const out = withDocumentDate(pdf, date);
  assert.equal(out.rewritten, 2);
  assert.equal(out.pdf.length, pdf.length, 'a byte offset moved');
  const text = out.pdf.toString('latin1');
  assert.equal(text.split(pdfDateString(date)).length - 1, 2);
  assert.ok(text.endsWith(tail), 'everything after the dates is as it was');
  assert.ok(!text.includes('D:20261022'), 'the render time is still there');
});

test('a date in a form of another length is left alone rather than risked', () => {
  const pdf = Buffer.from('%PDF-1.4\n<</CreationDate (D:20261022162936Z)>>\n%%EOF\n', 'latin1');
  const out = withDocumentDate(pdf, new Date(2026, 6, 21, 10, 7, 46));
  assert.equal(out.rewritten, 0);
  assert.equal(out.pdf, pdf);
});

test('the file on disk carries the same date', async () => {
  // ASKED FOR: "set custom date and time on the file on disk". Modified on every
  // platform; Created where the operating system lets it be set (Windows).
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { stampFileTimes } = require('../dist/generators/pdfDocumentDate');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
  const file = path.join(dir, 'resume.pdf');
  fs.writeFileSync(file, '%PDF-1.4\n%%EOF\n');
  const date = new Date(2026, 6, 21, 10, 7, 46);
  try {
    assert.equal(await stampFileTimes(file, date), true);
    const stat = fs.statSync(file);
    assert.equal(Math.round(stat.mtimeMs / 1000), Math.round(date.getTime() / 1000), 'modified time');
    if (process.platform === 'win32') {
      assert.equal(Math.round(stat.birthtimeMs / 1000), Math.round(date.getTime() / 1000), 'created time');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
