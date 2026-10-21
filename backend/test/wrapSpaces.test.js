const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { useTempStorage } = require('./helpers');

useTempStorage('wrap-spaces');

const puppeteer = require('puppeteer');
const pdfParse = require('pdf-parse');
const { preserveWrapSpaces, separateGluedTextRuns } = require('../dist/generators/pdfGenerator');
const { closeBrowser } = require('../dist/config/browser');

/**
 * A space at the end of every wrapped line.
 *
 * REPORTED: copying a bullet out of a delivered PDF gave
 * "...through pricing APIs, applyingmodel-driven pricing..." and
 * "...while maintaining consistentprediction latency under load." Two keywords
 * destroyed per wrap, on every bullet of every resume.
 *
 * Chrome writes each rendered LINE as its own run of glyphs. Inside a line the
 * spaces are real glyphs; at a soft wrap there is nothing, because the space
 * the text wrapped on is trailing whitespace and CSS throws it away before it
 * is drawn. pdftotext and pdf.js compare Y coordinates and recover - which is
 * why this went unseen - but a viewer's copy, and any parser that concatenates
 * runs, reads the welded word.
 *
 * MEASURED THE WAY THE FAULT WAS SEEN: the text runs are concatenated with no
 * separator, which is exactly what the operator's copy did.
 */

const SENTENCE =
  'Built Python services for real-time pricing at scale that served model predictions through pricing APIs, '
  + 'applying model-driven pricing and real-time pricing methods to customer-facing guidance while maintaining '
  + 'consistent prediction latency under load.';

/* Indented and wrapped the way a template writes it, because that is what makes
 * `pre-wrap` dangerous on its own: the source newlines would be printed. */
const DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: letter; margin: 0.6in; }
  body { font-family: Georgia, serif; font-size: 10.5pt; }
  .dates { white-space: nowrap; }
</style></head><body>
  <ul>
    <li>
      ${SENTENCE}
    </li>
  </ul>
  <p class="dates">01/2019 - Present</p>
</body></html>`;

/** A browser closed with the test, for the single-page probes below. */
async function launchBrowserFor(t) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  t.after(async () => { await closeBrowser(browser); });
  return browser;
}

async function render(t, { fix }) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-wrap-'));
  t.after(async () => {
    await closeBrowser(browser);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const page = await browser.newPage();
  await page.setContent(DOCUMENT, { waitUntil: 'load' });
  await separateGluedTextRuns(page);
  const changed = fix ? await preserveWrapSpaces(page) : 0;

  const file = path.join(dir, 'out.pdf');
  await page.pdf({ path: file, format: 'letter', printBackground: true });

  const runs = [];
  await pdfParse(fs.readFileSync(file), {
    pagerender: (pageData) =>
      pageData
        .getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
        .then((content) => { runs.push(...content.items.map((item) => item.str)); return ''; }),
  });
  return { runs, changed, joined: runs.join('') };
}

test('without the pass, the words at a line break weld together', async (t) => {
  // The fault itself, so the test proves the fix rather than asserting that
  // something was called.
  const { joined } = await render(t, { fix: false });
  assert.ok(
    /[a-z],?[a-z]/.test(joined.replace(/ /g, '')) && !joined.includes('APIs, applying'),
    `expected a weld, got: ${JSON.stringify(joined.slice(90, 150))}`
  );
  assert.equal(
    joined.replace(/\s+/g, ' ').trim() === SENTENCE,
    false,
    'the sentence must NOT reconstruct, or there is nothing here to fix'
  );
});

test('with the pass, the sentence reconstructs exactly', async (t) => {
  const { joined, changed } = await render(t, { fix: true });
  assert.ok(changed > 0, 'nothing was changed, so nothing was fixed');

  const flat = joined.replace(/\s+/g, ' ').trim();
  assert.ok(flat.includes(SENTENCE), `the bullet did not survive the round trip: ${JSON.stringify(flat.slice(0, 200))}`);
  // The two welds the operator reported, by name.
  assert.equal(joined.includes('applyingmodel'), false);
  assert.equal(joined.includes('consistentprediction'), false);
});

test('the source indentation is not printed, and nowrap is left alone', async (t) => {
  /*
   * THE REASON THIS IS A DOM PASS AND NOT A STYLESHEET RULE. `pre-wrap` keeps
   * the newlines and indentation of the HTML source, and templates are written
   * with both - so the whitespace is collapsed first, exactly as `normal`
   * would have collapsed it, and only then is the property set.
   */
  const { joined } = await render(t, { fix: true });
  assert.equal(/\n\s{4,}Built Python/.test(joined), false, 'the markup indentation reached the page');
  assert.equal(joined.includes('  '), false, 'a run of spaces reached the page');
  assert.ok(joined.includes('01/2019'), 'the nowrap element still rendered');
});

test('an element the template pinned to nowrap keeps its own rule', async (t) => {
  // Date columns are `nowrap` on purpose: a split date range is the parse fault
  // this app fixed two rounds ago, and a pass that overrode it would undo that.
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  t.after(async () => { await closeBrowser(browser); });

  const page = await browser.newPage();
  await page.setContent(DOCUMENT, { waitUntil: 'load' });
  await preserveWrapSpaces(page);

  const probe = await page.evaluate(
    '(() => { const el = document.querySelector(".dates");'
    + ' return JSON.stringify({ whiteSpace: getComputedStyle(el).whiteSpace, text: el.textContent }); })()'
  );
  const { whiteSpace, text } = JSON.parse(probe);

  /*
   * "pre", not "nowrap", and the behaviour is what the rule was for: a date
   * range must not be split across two lines, and both values guarantee that.
   *
   * WHY IT CHANGED. The pass used to SKIP anything pinned to nowrap, out of
   * respect for the template - and skipping it meant the element got no
   * trailing separator either, so a delivered resume read "11/2021 -
   * PresentCut p99 latency" and the end date did not parse. "pre" is nowrap
   * that keeps its spaces, so the pinned behaviour survives and the separator
   * arrives.
   */
  assert.ok(['nowrap', 'pre'].includes(whiteSpace), `a date column must not wrap, got ${whiteSpace}`);
  assert.match(text, /^01\/2019 - Present /, 'the separator the weld needed');
});

test('every template in use carries the wrap space, with the same layout', async (t) => {
  /*
   * THE REAL TEMPLATES, because the fault was reported on delivered resumes and
   * a hand-written fixture proves nothing about the ones that ship.
   *
   * Two things are measured at once: that no run welds into the next, and that
   * the number of rendered lines is UNCHANGED. The second is the risk in this
   * fix - `pre-wrap` preserves runs of spaces, and a run of spaces at a line end
   * could push a word onto the next line and the last line onto a second page.
   * Collapsing the whitespace first is what prevents it, and this is what says
   * so.
   */
  const { launchBrowser } = require('../dist/config/browser');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');

  const TEMPLATE_DIR = path.join(__dirname, '..', 'static', 'templates');
  const IN_USE = [
    'two-column-john.json',
    'two-column-executive.json',
    'new_leo.json',
    'one-column-professional.json',
    'default.json',
  ];

  const profile = {
    id: 'p', name: 'Wrap Probe', title: 'Software Engineer',
    profileSettings: { technicalSkillsLayout: 'flat' },
    contact: { phone: '555-555-5555', email: 'w@example.com', location: 'Austin, TX' },
    summary: 'Engineer of 9 years on payment platforms.',
    experience: [{
      title: 'Senior Software Engineer', company: 'Acme', startDate: '04/2022', endDate: 'Present',
      location: 'Remote', description: '', achievements: [SENTENCE], skills: [],
    }],
    strengths: [], skills: ['Python'], education: [], certifications: [], createdAt: '', updatedAt: '',
  };
  const tailored = {
    title: 'Senior Software Engineer',
    summary: profile.summary,
    experience: profile.experience,
    hardSkills: ['Python', 'Airflow'],
    skillGroups: [{ category: 'Languages & Frameworks', skills: ['Python', 'Airflow'] }],
  };

  /*
   * The skill-group look is drawn at RANDOM per document - six of them - so two
   * renders of the same template differ in case and spacing for reasons that
   * have nothing to do with this pass. That is what made this test fail the
   * first time, with "LANGUAGES & FRAMEWORKS" in one render and "Languages &
   * Frameworks" in the other, a baseline apart.
   */
  const pinnedLook = process.env.SKILL_GROUP_STYLE;
  process.env.SKILL_GROUP_STYLE = 'caps';
  t.after(() => {
    if (pinnedLook === undefined) delete process.env.SKILL_GROUP_STYLE;
    else process.env.SKILL_GROUP_STYLE = pinnedLook;
  });

  const browser = await launchBrowser();
  t.after(async () => { await closeBrowser(browser); });

  const runsFor = async (template, fix) => {
    const page = await browser.newPage();
    try {
      await page.setContent(await generatePreviewHTML(profile, template, tailored), { waitUntil: 'load' });
      await separateGluedTextRuns(page);
      if (fix) await preserveWrapSpaces(page);
      const buffer = Buffer.from(await page.pdf({ format: 'A4', printBackground: true }));
      const runs = [];
      const lines = new Set();
      const parsed = await pdfParse(buffer, {
        pagerender: (pageData) =>
          pageData
            .getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
            .then((content) => {
              for (const item of content.items) {
                runs.push(item.str);
                // The baseline this run sits on, which is what "the layout" is.
                lines.add(`${pageData.pageNumber}:${Math.round(item.transform[5])}`);
              }
              return '';
            }),
      });
      return { runs, lines, pages: parsed.numpages };
    } finally {
      await page.close();
    }
  };

  for (const file of IN_USE) {
    const template = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8'));
    const fixed = await runsFor(template, true);
    const joined = fixed.runs.join('');

    assert.ok(
      joined.replace(/\s+/g, ' ').includes(SENTENCE),
      `${file}: the bullet did not survive the round trip`
    );
    assert.equal(joined.includes('applyingmodel'), false, `${file} still welds at the wrap`);

    /*
     * LAYOUT UNCHANGED, measured as the baselines the text sits on and the
     * number of pages. NOT as the number of runs: a trailing space changes how
     * pdf.js splits a line into items, so the run count moves while the page
     * looks identical - which is the measurement, not the fault.
     */
    const plain = await runsFor(template, false);
    assert.equal(fixed.pages, plain.pages, `${file}: the page count changed`);
    assert.deepEqual(
      [...fixed.lines].sort(),
      [...plain.lines].sort(),
      `${file}: the text moved to different baselines`
    );
  }
});

test('a date does not weld to what follows it', async (t) => {
  /*
   * REPORTED ON A DELIVERED RESUME: the dates "do not parse well". The range
   * itself was intact and on its own line - a parser that compares Y
   * coordinates read it correctly, which is why it survived every earlier
   * check - but concatenated, the way a viewer's copy and a coordinate-blind
   * parser read it, the page said:
   *
   *   "Senior Software Engineer IEverbridge  11/2021 - PresentCut p99 latency"
   *
   * Three welds in one line: the title into the employer, and the END DATE
   * into the first bullet. "PresentCut" matches no date pattern anywhere, so
   * the role had no end date at all.
   *
   * Both are block boundaries, where the text stream carries no separator and
   * the line break exists only in the geometry.
   */
  const page = await (await launchBrowserFor(t)).newPage();
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>
       @page { size: letter; margin: 0.6in; }
       body { font-family: Georgia, serif; font-size: 10.5pt; }
       .head { display: flex; justify-content: space-between; }
       .job-date { white-space: nowrap; }
     </style></head><body>
       <div class="entry">
         <div class="head">
           <div><div class="job-title">Senior Software Engineer I</div><div class="company">Everbridge</div></div>
           <div><div class="job-date">11/2021 - Present</div></div>
         </div>
         <ul><li>Cut p99 latency from 180ms to 118ms on the settlement path.</li></ul>
       </div>
     </body></html>`,
    { waitUntil: 'load' }
  );
  await separateGluedTextRuns(page);
  await preserveWrapSpaces(page);

  const buffer = Buffer.from(await page.pdf({ format: 'letter', printBackground: true }));
  const runs = [];
  await pdfParse(buffer, {
    pagerender: (pageData) =>
      pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
        .then((content) => { runs.push(...content.items.map((item) => item.str)); return ''; }),
  });
  const joined = runs.join('');

  assert.equal(joined.includes('PresentCut'), false, 'the end date welded into the bullet');
  assert.equal(joined.includes('IEverbridge'), false, 'the title welded into the employer');
  // And the range is still whole, which is the rule the nowrap was there for.
  assert.match(joined.replace(/\s+/g, ' '), /11\/2021 - Present /);
});
