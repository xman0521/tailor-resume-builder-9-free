const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { saveCoverLetter, pickCoverLetterStyle } = require('../dist/generators/coverLetterGenerator');

/**
 * The catalogue, reached the only way it is exposed: by pinning each name.
 * Ten typefaces times five reading rhythms, which is how fifty distinct looks
 * are built without fifty hand-written blocks to keep in step.
 */
const FAMILIES = ['georgia', 'times', 'palatino', 'cambria', 'garamond',
  'helvetica', 'arial', 'segoe', 'verdana', 'trebuchet'];
const RHYTHMS = ['compact', 'plain', 'open', 'airy', 'formal'];
const CATALOGUE = FAMILIES.flatMap((family) => RHYTHMS.map((rhythm) => `${family}-${rhythm}`));
const allStyles = () => CATALOGUE.map((name) => pickCoverLetterStyle('x', { COVER_LETTER_STYLE: name }));

/**
 * Two failures, both visible on every letter the app produced.
 *
 * 1. Every cover letter was the same 11pt Arial block, so a batch sent for a
 *    dozen different people arrived looking like a dozen copies of one
 *    template - the one thing a cover letter is supposed to deny.
 *
 * 2. The PDF carried no document title. It is rendered with `setContent`, so
 *    there is no URL to fall back on either, and a viewer's tab read
 *    "about:blank".
 */

const NAMES = [
  'Maxcimiliano Miranda', 'Weitian Wu', 'Jonathan Lai', 'Tommy Margolis',
  'Ryan Pham', 'William Cheng', 'Shane Earl Mays', 'Krishnakumar Ramesan',
];

test('the catalogue holds fifty looks, and every one is really there', () => {
  assert.equal(CATALOGUE.length, 50);
  for (const name of CATALOGUE) {
    assert.equal(
      pickCoverLetterStyle('anyone', { COVER_LETTER_STYLE: name }).name,
      name,
      `${name} is not in the catalogue`
    );
  }
});

test('no two looks are the same once the label is ignored', () => {
  // Fifty NAMES would be worth nothing if they rendered as ten letters. The
  // label is dropped so this compares what a reader would actually see.
  const seen = new Map();
  for (const style of allStyles()) {
    const key = JSON.stringify([
      style.fontFamily, style.fontSize, style.lineHeight,
      style.color, style.paragraphGap, style.signOff, style.signature,
    ]);
    const clash = seen.get(key);
    assert.equal(clash, undefined, `${style.name} is identical to ${clash}`);
    seen.set(key, style.name);
  }
  assert.equal(seen.size, 50);
});

test('different people get different looks', () => {
  const looks = new Set(NAMES.map((name) => pickCoverLetterStyle(name, {}).name));
  assert.ok(looks.size >= 5, `eight people produced only ${looks.size} look(s): ${[...looks].join(', ')}`);
});

test('the whole catalogue gets used, not a favoured corner of it', () => {
  // A hash that mixes badly would pass every test above and still send eight
  // people out in three looks. This is the one that would notice.
  const people = [];
  for (const first of ['james', 'mary', 'wei', 'tirath', 'tyler', 'ana', 'joseph', 'linda', 'ryan', 'hui',
                       'david', 'jennifer', 'tommy', 'shane', 'jonathan', 'weitian', 'robert', 'maria',
                       'omar', 'yuki', 'sofia', 'liam', 'noor', 'diego', 'mei']) {
    for (const last of ['smith', 'garcia', 'lai', 'wu', 'miranda', 'pham', 'cheng', 'shah', 'nguyen', 'kim',
                        'patel', 'okafor', 'rossi', 'silva', 'dubois', 'jones', 'brown', 'davis', 'mays',
                        'jepson', 'margolis', 'ramesan', 'johnson', 'williams', 'miller']) {
      people.push(`${first} ${last}`);
    }
  }

  const used = new Set(people.map((person) => pickCoverLetterStyle(person, {}).name));
  assert.equal(used.size, 50, `only ${used.size} of 50 looks were ever chosen`);
});

test('one person keeps the same look, so their letters match each other', () => {
  // Chosen from the name rather than at random on purpose: a random pick per
  // call would give one applicant a different letter every time they applied.
  for (const name of NAMES) {
    const first = pickCoverLetterStyle(name, {});
    const second = pickCoverLetterStyle(name, {});
    assert.equal(first.name, second.name, `${name} drifted between renders`);
  }

  // Spelling and spacing are not a different person.
  assert.equal(
    pickCoverLetterStyle('Jonathan Lai', {}).name,
    pickCoverLetterStyle('  jonathan lai  ', {}).name
  );
});

test('the look can be pinned, and a bad value falls back rather than throwing', () => {
  assert.equal(
    pickCoverLetterStyle('Anyone', { COVER_LETTER_STYLE: 'garamond-formal' }).name,
    'garamond-formal'
  );
  assert.equal(
    pickCoverLetterStyle('Anyone', { COVER_LETTER_STYLE: 'GARAMOND-FORMAL' }).name,
    'garamond-formal'
  );

  // A rhythm on its own is not a style name any more - it used to be, when
  // there were five looks called classic/modern/formal/airy/compact - so it
  // falls back rather than half-matching something the operator did not ask
  // for. Pinned here because a silent fallback is exactly the failure an
  // operator would not notice.
  assert.equal(
    pickCoverLetterStyle('Anyone', { COVER_LETTER_STYLE: 'formal' }).name,
    pickCoverLetterStyle('Anyone', {}).name
  );
  assert.equal(
    pickCoverLetterStyle('Anyone', { COVER_LETTER_STYLE: 'neon' }).name,
    pickCoverLetterStyle('Anyone', {}).name,
    'an unknown style should fall back to the name-derived one'
  );
});

test('every look stays a plain single column, because a scanner reads this too', () => {
  // A cover letter is parsed by the same software the resume is. Varying the
  // typography is free; varying the LAYOUT would trade a real advantage for a
  // cosmetic one. Checked across all fifty, not just the ones eight names hit.
  for (const style of allStyles()) {
    assert.match(style.fontFamily, /(serif|sans-serif)$/, `${style.name} has no generic fallback family`);
    assert.match(style.fontSize, /^\d+(\.\d+)?pt$/, `${style.name} has an odd size`);

    const size = Number.parseFloat(style.fontSize);
    assert.ok(size >= 10 && size <= 13, `${style.name} is ${style.fontSize}, outside what a letter is set in`);
    assert.ok(Number(style.lineHeight) >= 1.4, `${style.name} is set too tight to read`);
    assert.match(style.color, /^#[0-9a-f]{6}$/i, `${style.name} has an odd ink`);

    // Nothing may introduce a column, a float or a page break.
    const css = [style.greeting, style.signOff, style.signature].join(' ');
    assert.equal(/column|float|position|transform|rotate/i.test(css), false, `${style.name} moves the text around`);
  }
});

test('the rendered PDF carries a title instead of about:blank', async (t) => {
  let pdfParse;
  try {
    pdfParse = require('pdf-parse');
  } catch {
    t.skip('pdf-parse unavailable');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-cover-'));
  try {
    const relative = await saveCoverLetter(
      { name: 'Jordan Avery Chen' },
      'First paragraph about the role.\n\nSecond paragraph about the work.',
      {
        absoluteDir: dir,
        storagePathBase: 'cl',
        resumeFileStem: 'Jordan_Avery_Chen',
        coverLetterFileStem: 'Jordan_Avery_Chen_cover_letter',
      }
    );

    const file = path.join(dir, path.basename(relative));
    const parsed = await pdfParse(fs.readFileSync(file));

    assert.equal(parsed.info?.Title, 'Jordan Avery Chen - Cover Letter');
    assert.ok(parsed.text.includes('Best regards'), 'the letter body should be in the PDF');

    // The ligature lesson from the resume renderer applies here too: this
    // generator builds its own document and never went through the page that
    // disables them.
    assert.equal(/[ﬀ-ﬄ]/.test(parsed.text), false, 'a ligature glyph reached the text');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
