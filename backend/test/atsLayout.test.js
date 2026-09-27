const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const pdfParse = require('pdf-parse');

const { launchBrowser } = require('../dist/config/browser');
const {
  generatePreviewHTML,
  separateGluedTextRuns,
} = require('../dist/generators/pdfGenerator');

/**
 * What a resume parser sees: the order of the sections, and whether two fields
 * printed side by side arrive as two fields or as one word.
 *
 * Both were measured on 495 delivered resumes before this existed. Title and
 * dates ran together - "Software Engineer04/2022 - Present" - in 99-100% of
 * three profiles' resumes, company and location in 68-100% of every profile's,
 * and two-column templates printed a role AFTER the education heading in 68%
 * of one profile's, which files those bullets under education.
 */

const TEMPLATE_DIR = path.join(__dirname, '..', 'static', 'templates');
const ALL_TEMPLATES = fs.readdirSync(TEMPLATE_DIR).filter((file) => file.endsWith('.json')).sort();

// The five a profile is actually rendered with, plus the default.
const IN_USE = [
  'two-column-john.json',
  'two-column-executive.json',
  'new_leo.json',
  'template_Tommy_Margolis_fixed.json',
  'one-column-professional.json',
  'default.json',
];

const profile = {
  id: 'p', name: 'Layout Probe', title: 'Software Engineer',
  profileSettings: { technicalSkillsLayout: 'flat' },
  contact: {
    phone: '(555) 555-5555', email: 'probe@example.com',
    linkedin: 'linkedin.com/in/probe', location: 'Austin, TX',
  },
  summary: 'Engineer.',
  experience: [1, 2].map((n) => ({
    title: `Software Engineer ${n}`, company: `Company ${n}`,
    startDate: '01/2019', endDate: n === 1 ? 'Present' : '12/2018',
    location: 'Austin, TX', description: '',
    achievements: ['Cut p99 latency from 180ms to 118ms on the settlement path.'],
    skills: [],
  })),
  strengths: [], skills: [],
  education: [{
    degree: 'BS, Computer Science', institution: 'University of Central Florida',
    startDate: '2011', endDate: '2015', location: 'Orlando, FL',
  }],
  certifications: [], createdAt: '', updatedAt: '',
};

const tailored = {
  title: 'Senior Platform Engineer',
  summary: 'Engineer of 9 years across payment platforms, with services clearing 40M transactions a day.',
  experience: profile.experience, strengths: [], softSkills: [], skills: [], hardSkills: [],
  unconfirmedHardSkills: [], unconfirmedSoftSkills: [],
  skillGroups: [
    { category: 'Languages', skills: ['Java', 'Python', 'SQL'] },
    { category: 'Cloud and Infrastructure', skills: ['AWS', 'Terraform', 'Kubernetes'] },
    { category: 'Ways of Working', skills: ['Communication skills', 'Troubleshooting'] },
  ],
  coverLetter: 'x',
};

const SECTION_MARKS = {
  summary: /^(?:\d{2}\s*)?(?:PROFESSIONAL\s+)?(?:SUMMARY|PROFILE|ABOUT|OBJECTIVE|OVERVIEW)\b/i,
  education: /^(?:\d{2}\s*)?EDUCATION\b/i,
  skills: /^(?:\d{2}\s*)?(?:TECHNICAL\s+|CORE\s+)?(?:SKILLS|EXPERTISE)\b/i,
  experience: /^(?:\d{2}\s*)?(?:PROFESSIONAL\s+|WORK\s+)?(?:EXPERIENCE|EMPLOYMENT)\b/i,
};
const ASKED_FOR = ['summary', 'education', 'skills', 'experience'];

const linesOf = async (buffer) => {
  const data = await pdfParse(buffer);
  return data.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
};

const renderLines = async (page, template) => {
  await page.setContent(await generatePreviewHTML(profile, template, tailored), { waitUntil: 'load' });
  await separateGluedTextRuns(page);
  return linesOf(Buffer.from(await page.pdf({ format: 'A4', printBackground: true })));
};

test('every template reads summary, education, skills, experience', async (t) => {
  /*
   * Measured from the PDF's own text stream, which is the only thing that
   * settles it. An earlier version of the reordering pass was written against
   * the DOM and looked correct in the markup while the stream was unchanged:
   * Chrome paints flex and grid items in `order` sequence and writes the text in
   * paint sequence, so a column pinned in place with `order` is still read in
   * its old position. In a two-column page, reading order IS left-to-right
   * order, and the pass has to move the columns for real.
   */
  t.diagnostic(`${ALL_TEMPLATES.length} templates`);
  const browser = await launchBrowser();
  const wrong = [];

  try {
    const page = await browser.newPage();
    for (const file of ALL_TEMPLATES) {
      const template = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8'));
      const lines = await renderLines(page, template);

      const seen = [];
      for (const line of lines) {
        for (const name of ASKED_FOR) {
          if (SECTION_MARKS[name].test(line) && !seen.includes(name)) seen.push(name);
        }
      }
      const expected = ASKED_FOR.filter((name) => seen.includes(name));
      if (seen.join(',') !== expected.join(',')) wrong.push(`${file}: ${seen.join(' -> ')}`);
    }
  } finally {
    await browser.close();
  }

  assert.deepEqual(wrong, [], wrong.join('\n'));
});

test('two fields printed side by side are read as two fields', async (t) => {
  /*
   * A layout gap is not a character. `justify-content:space-between` puts the
   * title on the left and the dates on the right with nothing between them in
   * the markup, so the PDF's text stream has nothing between them either.
   *
   * The separator pass measures the page and puts a non-breaking space inside
   * the left box of any such pair - inside, because a text node BETWEEN two flex
   * items becomes a third item and moves the row.
   */
  const GLUE = [
    ['title and dates', /[a-z)](?:0[1-9]|1[0-2])\/(?:19|20)\d{2}/],
    ['company and location', /[a-z)]([A-Z]{2,}(?:,|\s|$)|[A-Z][a-z]+,\s*[A-Z]{2}\b)/],
    ['section number and heading', /\b\d{2}(?:SUMMARY|SKILLS|EDUCATION|PROFESSIONAL|EXPERIENCE|PROFILE|CONTACT)/],
    ['degree and dates', /[a-z)](?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}/],
  ];

  const browser = await launchBrowser();
  const glued = [];
  let caught = 0;

  try {
    const page = await browser.newPage();
    for (const file of IN_USE) {
      const template = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8'));
      const html = await generatePreviewHTML(profile, template, tailored);

      for (const withPass of [false, true]) {
        await page.setContent(html, { waitUntil: 'load' });
        if (withPass) await separateGluedTextRuns(page);
        const lines = await linesOf(Buffer.from(await page.pdf({ format: 'A4', printBackground: true })));

        for (const [label, pattern] of GLUE) {
          const hits = lines.filter((line) => pattern.test(line));
          if (!withPass) caught += hits.length;
          else if (hits.length) glued.push(`${file}: ${label} still run together - ${JSON.stringify(hits[0].slice(0, 60))}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  assert.deepEqual(glued, [], glued.join('\n'));
  // And the pass is doing something: without it, these same documents glue.
  t.diagnostic(`${caught} glued lines across ${IN_USE.length} templates without the pass`);
  assert.ok(caught > 0, 'the templates no longer glue anything, so this test proves nothing');
});

test('reordering the sections does not move the page around', async (t) => {
  /*
   * The order is worth nothing if it costs the design. Measured per template
   * with the pass off and on: which side each section is printed on and how
   * wide it is.
   *
   * The summary is the one section allowed to move, and only on the templates
   * where it has to: a page whose summary shares a column with experience while
   * education and skills sit in the other one cannot read in the asked-for order
   * until the summary joins them.
   */
  const MEASURE = `(() => {
    const KINDS = [
      ['experience', /experience|employment|work history/i],
      ['education', /education|academic/i],
      ['skills', /skill|expertise|competenc/i],
      ['summary', /summary|profile|about|objective|overview/i],
    ];
    const out = {};
    for (const node of Array.from(document.querySelectorAll('div, section'))) {
      const classes = node.className && node.className.split ? node.className.split(/\\s+/) : [];
      if (!classes.some((c) => c === 'section' || c === 'side-section' || c === 'main-section')) continue;
      const heading = node.querySelector('[class*=title], [class*=heading]');
      const text = (heading ? heading.textContent : (node.textContent || '')).trim();
      const box = node.getBoundingClientRect();
      for (const [kind, mark] of KINDS) {
        if (mark.test(text) && !out[kind]) {
          out[kind] = { x: Math.round(box.left), w: Math.round(box.width) };
          break;
        }
      }
    }
    out.page = Math.round(document.documentElement.scrollWidth);
    return JSON.stringify(out);
  })()`;

  const browser = await launchBrowser();
  const disturbed = [];
  const pinned = process.env.RESUME_SECTION_ORDER_OFF;

  try {
    const page = await browser.newPage();
    for (const file of ALL_TEMPLATES) {
      const template = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8'));
      const seen = {};
      for (const off of [true, false]) {
        if (off) process.env.RESUME_SECTION_ORDER_OFF = '1';
        else delete process.env.RESUME_SECTION_ORDER_OFF;
        await page.setContent(await generatePreviewHTML(profile, template, tailored), { waitUntil: 'load' });
        seen[off ? 'before' : 'after'] = JSON.parse(await page.evaluate(MEASURE));
      }

      const side = (box, width) => (box.x + box.w / 2 > width / 2 ? 'right' : 'left');
      for (const kind of ['experience', 'education', 'skills']) {
        const before = seen.before[kind];
        const after = seen.after[kind];
        if (!before || !after) continue;
        // A section may change sides only as part of a column swap, which moves
        // education, skills AND experience together. A section that moves alone
        // is a section that has lost its column.
        if (Math.abs(after.w - before.w) > 12) {
          disturbed.push(`${file}: ${kind} width ${before.w} -> ${after.w}`);
        }
        const swapped = ['experience', 'education', 'skills']
          .filter((other) => seen.before[other] && seen.after[other])
          .every((other) => side(seen.before[other], seen.before.page) !== side(seen.after[other], seen.after.page));
        if (side(before, seen.before.page) !== side(after, seen.after.page) && !swapped) {
          disturbed.push(`${file}: ${kind} moved to the ${side(after, seen.after.page)} on its own`);
        }
      }
    }
  } finally {
    if (pinned === undefined) delete process.env.RESUME_SECTION_ORDER_OFF;
    else process.env.RESUME_SECTION_ORDER_OFF = pinned;
    await browser.close();
  }

  t.diagnostic(`${ALL_TEMPLATES.length} templates measured with the pass off and on`);
  assert.deepEqual(disturbed, [], disturbed.join('\n'));
});

test('every section can be read where it is printed', async (t) => {
  /*
   * WHAT THIS PINS, from a screenshot of a delivered resume: the summary was a
   * ghost - dark grey text on a dark navy sidebar, measured at 1.4:1 where 4.5:1
   * is the bar for body text - and its heading was navy on navy, which is not
   * faint, it is absent.
   *
   * The cause was a section CHANGING COLUMN. The summary has to join education
   * and skills on six templates or the page cannot read in the asked-for order,
   * and on that one the destination is a dark sidebar while the summary's colour
   * is written on the element for the white column it came from. Moving a block
   * moves its markup, not the rules aimed at where it used to be.
   *
   * The geometry test above did not catch it: position and width were exactly
   * right, and the text was invisible.
   */
  const CONTRAST = `(() => {
    const parse = (value) => {
      const parts = (value.match(/[\\d.]+/g) || []).map(Number);
      return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0, a: parts.length > 3 ? parts[3] : 1 };
    };
    const luminance = ({ r, g, b }) => {
      const channel = (value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const behind = (node) => {
      for (let parent = node; parent; parent = parent.parentElement) {
        const colour = parse(getComputedStyle(parent).backgroundColor);
        if (colour.a > 0) return colour;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const ratio = (a, b) => {
      const light = Math.max(luminance(a), luminance(b));
      const dark = Math.min(luminance(a), luminance(b));
      return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
    };

    // Every element holding its own run of text, which is where a colour is
    // actually seen - a wrapper inherits and tells us nothing.
    const found = {};
    for (const node of Array.from(document.querySelectorAll('body *'))) {
      const text = (node.textContent || '').trim();
      if (text.length < 12) continue;
      if (Array.from(node.children).some((child) => (child.textContent || '').trim().length >= 12)) continue;
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      found[text.slice(0, 60)] = {
        ratio: ratio(parse(getComputedStyle(node).color), behind(node)),
        relocated: !!node.closest('[data-resume-relocated]'),
      };
    }
    return JSON.stringify(found);
  })()`;

  const browser = await launchBrowser();
  const unreadable = [];
  const alreadyFaint = [];
  const pinned = process.env.RESUME_SECTION_ORDER_OFF;

  try {
    const page = await browser.newPage();
    for (const file of ALL_TEMPLATES) {
      const template = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8'));
      const seen = {};
      for (const off of [true, false]) {
        if (off) process.env.RESUME_SECTION_ORDER_OFF = '1';
        else delete process.env.RESUME_SECTION_ORDER_OFF;
        await page.setContent(await generatePreviewHTML(profile, template, tailored), { waitUntil: 'load' });
        seen[off ? 'before' : 'after'] = JSON.parse(await page.evaluate(CONTRAST));
      }

      for (const [text, entry] of Object.entries(seen.after)) {
        if (entry.ratio >= 4.5) continue;
        const was = seen.before[text];
        if (entry.relocated) {
          unreadable.push(`${file}: a RELOCATED block at ${entry.ratio}:1 - ${JSON.stringify(text.slice(0, 40))}`);
        } else if (was && was.ratio >= 4.5) {
          unreadable.push(`${file}: ${was.ratio}:1 -> ${entry.ratio}:1 after the reorder - ${JSON.stringify(text.slice(0, 40))}`);
        } else {
          // A colour the template itself chose, faint before this pass existed.
          // Worth knowing, not this test's business.
          alreadyFaint.push(`${file}: ${entry.ratio}:1 ${JSON.stringify(text.slice(0, 32))}`);
        }
      }
    }
  } finally {
    if (pinned === undefined) delete process.env.RESUME_SECTION_ORDER_OFF;
    else process.env.RESUME_SECTION_ORDER_OFF = pinned;
    await browser.close();
  }

  t.diagnostic(`${ALL_TEMPLATES.length} templates, every run of text measured against what is behind it`);
  if (alreadyFaint.length) {
    t.diagnostic(`${alreadyFaint.length} run(s) of text were already under 4.5:1 before this pass: `
      + `${alreadyFaint.slice(0, 3).join(' | ')}${alreadyFaint.length > 3 ? ' ...' : ''}`);
  }
  assert.deepEqual(unreadable, [], unreadable.join('\n'));
});

test('the reordering can be switched off', () => {
  const { reorderResumeSections } = require('../dist/generators/pdfGenerator');
  const markup = '<div class="page">'
    + '<div class="section"><div class="section-title">Professional Experience</div><p>x</p></div>'
    + '<div class="section"><div class="section-title">Education</div><p>x</p></div>'
    + '<div class="section"><div class="section-title">Summary</div><p>x</p></div>'
    + '</div>';

  const ordered = reorderResumeSections(markup, {});
  assert.ok(ordered.indexOf('Summary') < ordered.indexOf('Education'), ordered);
  assert.ok(ordered.indexOf('Education') < ordered.indexOf('Professional Experience'), ordered);
  // Nothing is lost on the way: same sections, same content.
  assert.equal(ordered.match(/class="section"/g).length, 3);

  assert.equal(reorderResumeSections(markup, { RESUME_SECTION_ORDER_OFF: '1' }), markup);
});
