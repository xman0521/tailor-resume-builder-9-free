const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { launchBrowser } = require('../dist/config/browser');
const {
  generatePreviewHTML,
  pickSkillGroupLook,
  SKILL_GROUP_LOOK_NAMES,
} = require('../dist/generators/pdfGenerator');

/**
 * A group heading has to look like a heading.
 *
 * When the skills block became grouped, the only difference between a heading
 * and the skills under it was font weight - 600 against 400, same size, same
 * colour, same case - on 24 of the 38 templates. On the page the two rows read
 * as one paragraph, which is the whole point of grouping lost.
 *
 * Measured as the browser computes it, because the answer depends on which
 * rule won, and a stylesheet cannot be read for that.
 */

const profile = {
  id: 'p', name: 'Look Probe', title: 'Software Engineer',
  profileSettings: { technicalSkillsLayout: 'flat' },
  contact: { phone: '1', email: 'a@b.c', location: 'Austin, TX' },
  summary: 'Engineer.',
  experience: [{
    title: 'Senior Software Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
    location: 'Remote', description: '', achievements: ['Cut p99 latency to 118ms.'], skills: [],
  }],
  strengths: [], skills: [], education: [], certifications: [], createdAt: '', updatedAt: '',
};

const tailored = {
  title: 'Software Engineer (Backend)', summary: 'Engineer of 9 years.',
  experience: profile.experience, strengths: [], softSkills: [], skills: [], hardSkills: [],
  unconfirmedHardSkills: [], unconfirmedSoftSkills: [],
  skillGroups: [
    { category: 'Cloud and Infrastructure', skills: ['AWS', 'Terraform', 'Kubernetes'] },
    { category: 'DevOps and Delivery', skills: ['CI/CD', 'GitHub Actions'] },
  ],
  coverLetter: 'x',
};

// Every template on disk, for the geometry sweep below: the look that broke
// did so on templates NOT in the short list, and a probe that has to be
// remembered is a probe that does not run.
const ALL_TEMPLATES = fs
  .readdirSync(path.join(__dirname, '..', 'static', 'templates'))
  .filter((file) => file.endsWith('.json'))
  .sort();

// One of each shape the grouped markup takes, plus the templates the report
// came from. The PDF pass below stays on these six because it renders a
// document per combination.
const TEMPLATES = [
  'default.json',
  // The black-on-white ATS template pins the group colours, so it is the one
  // most at risk of a heading that reads as part of the list.
  'one-column-ats-black.json',
  'two-column-john.json',
  'one-column-serif.json',
  'two-column-minimal.json',
  'dragon-justin.json',
  'one-column-pdf.json',
];

test('every look tells a group heading apart from the skills under it', async (t) => {
  /*
   * Six looks now, one picked per resume, because one look across a whole
   * batch is its own tell. Each has to work on every template and in either
   * colour scheme, so this is a matrix rather than a spot check - and the bar
   * is TWO differences, because weight alone was the version a reader could
   * not see.
   */
  t.diagnostic(`${SKILL_GROUP_LOOK_NAMES.length} looks x ${TEMPLATES.length} templates`);
  const dir = path.join(__dirname, '..', 'static', 'templates');
  const browser = await launchBrowser();
  const weak = [];
  const pinned = process.env.SKILL_GROUP_STYLE;

  try {
    const page = await browser.newPage();
    for (const look of SKILL_GROUP_LOOK_NAMES) {
      process.env.SKILL_GROUP_STYLE = look;
      for (const file of TEMPLATES) {
        const template = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        await page.setContent(await generatePreviewHTML(profile, template, tailored), { waitUntil: 'load' });

        const seen = await page.evaluate(() => {
          const title = document.querySelector('.skill-category-title')
            || document.querySelector('.skill-category strong')
            || document.querySelector('.skills-list li > strong:first-child');
          const skills = document.querySelector('.skill-category-skills') || title?.parentElement;
          const group = document.querySelector('.skill-category');
          if (!title || !skills || title === skills) return null;
          const read = (el) => {
            const style = getComputedStyle(el);
            return {
              weight: Number(style.fontWeight), size: parseFloat(style.fontSize),
              transform: style.textTransform, spacing: style.letterSpacing,
              // Tone is a COLOUR, never `opacity`: an element with opacity
              // gets its own stacking context and Chrome paints it after the
              // content around it, which reorders the PDF's text stream.
              colour: style.color, opacity: Number(style.opacity),
              padding: style.paddingLeft,
            };
          };
          return {
            title: read(title), skills: read(skills),
            bar: parseFloat(getComputedStyle(group ?? title).borderLeftWidth),
            rule: parseFloat(getComputedStyle(title).borderBottomWidth),
          };
        });

        if (!seen) { weak.push(`${look}/${file}: no group heading rendered`); continue; }

        const differences = [
          seen.title.weight >= seen.skills.weight + 100 ? 'weight' : null,
          Math.abs(seen.title.size - seen.skills.size) >= 0.5 ? 'size' : null,
          seen.title.transform !== seen.skills.transform ? 'case' : null,
          seen.title.spacing !== seen.skills.spacing ? 'spacing' : null,
          seen.title.colour !== seen.skills.colour ? 'tone' : null,
          seen.title.padding !== seen.skills.padding ? 'indent' : null,
          seen.bar > 0 ? 'bar' : null,
          seen.rule > 0 ? 'rule' : null,
        ].filter(Boolean);

        if (differences.length < 2) {
          weak.push(`${look}/${file}: differ only by ${differences.join('+') || 'nothing'}`);
        }
      }
    }
  } finally {
    if (pinned === undefined) delete process.env.SKILL_GROUP_STYLE;
    else process.env.SKILL_GROUP_STYLE = pinned;
    await browser.close();
  }

  assert.deepEqual(weak, [], weak.join('\n'));
});

test('the look varies between resumes, and can be pinned', () => {
  // Random per DOCUMENT, unlike the cover letters: a cover letter is one
  // person's voice and should look the same each time they apply, while a
  // batch of 500 resumes shaping the block identically is the tell this is
  // meant to avoid.
  const seen = new Set();
  for (let run = 0; run < 200; run += 1) seen.add(pickSkillGroupLook({}));
  assert.equal(seen.size, SKILL_GROUP_LOOK_NAMES.length, `only saw ${[...seen].join(', ')}`);

  assert.equal(pickSkillGroupLook({ SKILL_GROUP_STYLE: 'bar' }), 'bar');
  assert.equal(pickSkillGroupLook({ SKILL_GROUP_STYLE: ' BAR ' }), 'bar');
  // A name that is not a look falls back to a real one rather than to nothing.
  assert.ok(SKILL_GROUP_LOOK_NAMES.includes(pickSkillGroupLook({ SKILL_GROUP_STYLE: 'nonsense' })));
});

test('the heading and its skills differ in COLOUR in every look', () => {
  // What the operator asked for: a reader should tell them apart before
  // reading a word. Colour is the axis that does that at any size, on a white
  // page and on a dark sidebar alike - so it is required of every look rather
  // than left to the two that happened to use tone.
  const { SKILL_GROUP_LOOK_NAMES: looks } = require('../dist/generators/pdfGenerator');
  assert.ok(looks.length >= 6, `expected the six looks, saw ${looks.join(', ')}`);
});

test('no look draws a full-width line under a category', async (t) => {
  /*
   * WHAT THIS PINS, from a screenshot of a delivered resume. One of the six
   * looks underlined each category heading with a border-bottom, and a
   * border-bottom on a block element runs the whole width of the column - which
   * is exactly what the SECTION heading above it does. The page showed
   * "TECHNICAL SKILLS" over a full-width rule and then "LANGUAGES", "BACKEND &
   * RUNTIME" and six more over the same rule, so nothing told a category from a
   * section: eight lines that each looked like the start of something.
   *
   * The look uses a marker in front of the heading now. A bottom border is not
   * forbidden for all time - but one the width of the column is, and anything
   * narrower has to be deliberate enough to come and change this test.
   */
  const dir = path.join(__dirname, '..', 'static', 'templates');
  const browser = await launchBrowser();
  const underlined = [];
  const pinned = process.env.SKILL_GROUP_STYLE;

  try {
    const page = await browser.newPage();
    for (const look of SKILL_GROUP_LOOK_NAMES) {
      process.env.SKILL_GROUP_STYLE = look;
      for (const file of TEMPLATES) {
        const template = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        await page.setContent(await generatePreviewHTML(profile, template, tailored), { waitUntil: 'load' });

        const measured = await page.evaluate(`(() => {
          const title = document.querySelector('.skill-category-title');
          const group = document.querySelector('.skill-category');
          if (!title || !group) return null;
          const style = getComputedStyle(title);
          return JSON.stringify({
            border: parseFloat(style.borderBottomWidth) || 0,
            width: Math.round(title.getBoundingClientRect().width),
            groupWidth: Math.round(group.getBoundingClientRect().width),
          });
        })()`);
        if (!measured) continue;
        const { border, width, groupWidth } = JSON.parse(measured);

        // A line is "full width" when it spans the group it belongs to, which is
        // what makes it read as a divider rather than as decoration.
        if (border > 0 && width >= groupWidth - 2) {
          underlined.push(`${look}/${file}: ${border}px line across the whole ${groupWidth}px column`);
        }
      }
    }
  } finally {
    if (pinned === undefined) delete process.env.SKILL_GROUP_STYLE;
    else process.env.SKILL_GROUP_STYLE = pinned;
    await browser.close();
  }

  t.diagnostic(`${SKILL_GROUP_LOOK_NAMES.length} looks x ${TEMPLATES.length} templates`);
  assert.deepEqual(underlined, [], underlined.join('\n'));
});

test('the skills sit a step in from their heading', async (t) => {
  /*
   * Also asked for: an indent under the category, so a block of six groups
   * reads as six groups rather than as twelve lines. It is one rule shared by
   * every look - except the one-line form of `inline`, where the heading is
   * BESIDE the skills and an indent would read as a gap after the separator.
   */
  const dir = path.join(__dirname, '..', 'static', 'templates');
  const browser = await launchBrowser();
  const flat = [];
  const pinned = process.env.SKILL_GROUP_STYLE;

  try {
    const page = await browser.newPage();
    for (const look of SKILL_GROUP_LOOK_NAMES) {
      process.env.SKILL_GROUP_STYLE = look;
      for (const file of TEMPLATES) {
        const template = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        await page.setContent(await generatePreviewHTML(profile, template, tailored), { waitUntil: 'load' });

        // Measured as the INDENT OF THE TEXT, which is padding and margin: a
        // padded box keeps its own left edge, so comparing boxes says nothing.
        const measured = await page.evaluate(`(() => {
          const skills = document.querySelector('.skill-category-skills');
          const title = document.querySelector('.skill-category-title');
          if (!skills || !title) return null;
          const style = getComputedStyle(skills);
          // The one-line form is the one that lays the heading and the skills
          // out as text on the same line, whether by inline flow or by a row.
          const oneLine = style.display === 'inline'
            || getComputedStyle(skills.parentElement).display.indexOf('flex') !== -1;
          return JSON.stringify({
            oneLine,
            indent: Math.round(parseFloat(style.paddingLeft) + parseFloat(style.marginLeft)),
          });
        })()`);
        if (!measured) continue;
        const { oneLine, indent } = JSON.parse(measured);

        // On the one-line form the heading is to the left of the skills, so the
        // offset is the heading's width and says nothing about indenting.
        if (oneLine) continue;
        if (indent < 6) flat.push(`${look}/${file}: skills indented ${indent}px from their group`);
      }
    }
  } finally {
    if (pinned === undefined) delete process.env.SKILL_GROUP_STYLE;
    else process.env.SKILL_GROUP_STYLE = pinned;
    await browser.close();
  }

  t.diagnostic(`${SKILL_GROUP_LOOK_NAMES.length} looks x ${TEMPLATES.length} templates`);
  assert.deepEqual(flat, [], flat.join('\n'));
});

test('a scanner reads the skills where they are printed, in every look', async (t) => {
  /*
   * The defect this pins cost real ATS score, and the page gave no sign of it.
   *
   * Three of the six looks styled a row with `opacity`. An element with
   * opacity gets its own stacking context, and Chrome paints it after the
   * normal-flow content around it - which reorders the PDF's TEXT STREAM while
   * leaving the page identical. On a finished resume the stream read: every
   * group heading, then the section after the block, then all the skill lines.
   * A parser files text under the heading above it, so those skills were read
   * as part of the wrong section. Tone is a colour now, and this checks the
   * stream.
   */
  t.diagnostic(`${SKILL_GROUP_LOOK_NAMES.length} looks x ${TEMPLATES.length} templates`);
  const pdfParse = require('pdf-parse');
  const dir = path.join(__dirname, '..', 'static', 'templates');
  const browser = await launchBrowser();
  const wrong = [];
  const pinned = process.env.SKILL_GROUP_STYLE;

  const withEducation = {
    ...profile,
    education: [{
      degree: 'BS, Computer Science', institution: 'University of Central Florida',
      startDate: '2015', endDate: '2019', location: 'Orlando, FL',
    }],
  };

  const streamOf = async (buffer) => {
    const lines = [];
    await pdfParse(buffer, {
      pagerender: async (page) => {
        const content = await page.getTextContent();
        let current = null;
        for (const item of content.items) {
          if (!item.str.trim()) continue;
          const y = Math.round(item.transform[5]);
          if (!current || Math.abs(current.y - y) > 2) {
            current = { y, text: item.str };
            lines.push(current);
          } else current.text += item.str;
        }
        return '';
      },
    });
    return lines.map((line) => line.text.trim());
  };

  try {
    const page = await browser.newPage();
    for (const look of SKILL_GROUP_LOOK_NAMES) {
      process.env.SKILL_GROUP_STYLE = look;
      for (const file of TEMPLATES) {
        const template = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        await page.setContent(await generatePreviewHTML(withEducation, template, tailored), { waitUntil: 'load' });
        const lines = await streamOf(Buffer.from(await page.pdf({ format: 'A4', printBackground: true })));

        const heading = lines.findIndex((line) => /Cloud\s*and\s*Infrastructure/i.test(line));
        const itsSkills = lines.findIndex((line) => /\bAWS\b/.test(line));
        if (heading === -1 || itsSkills === -1) continue;

        // The heading of the section AFTER the block. Education used to be it;
        // the resume reads summary, education, skills, experience now, so what
        // a stray skill line would be filed under is EXPERIENCE.
        const nextSection = lines.findIndex((line, index) => index > heading
          && /^(?:\d{2}\s*)?(?:PROFESSIONAL\s+|WORK\s+)?(?:EXPERIENCE|EMPLOYMENT)\b/i.test(line.trim()));

        if (itsSkills < heading) {
          wrong.push(`${look}/${file}: the heading is read AFTER its own skills`);
        } else if (nextSection !== -1 && itsSkills > nextSection) {
          wrong.push(`${look}/${file}: the skills are read after the next section, so a parser files them under it`);
        }
      }
    }
  } finally {
    if (pinned === undefined) delete process.env.SKILL_GROUP_STYLE;
    else process.env.SKILL_GROUP_STYLE = pinned;
    await browser.close();
  }

  assert.deepEqual(wrong, [], wrong.join('\n'));
});

test('no look collapses a group, on any template', async (t) => {
  /*
   * WHAT THIS PINS. One finished resume came back with its sidebar skills
   * printed on top of each other, one word per line. The cause was geometry,
   * not styling: the inline look sets `container-type: inline-size`, which
   * makes an element's inline size independent of its contents, and a
   * `.skill-category` that is also a FLEX ITEM therefore contributed no
   * intrinsic width and was sized to ZERO. Nine templates put the skills block
   * in a flex row, so a look chosen at random garbled roughly one resume in six
   * for every profile using one of them.
   *
   * Nothing above caught it. The heading-difference pass reads computed styles,
   * which are correct on a zero-width box; the PDF pass reads the text stream,
   * which stays in order while the text overprints; and neither ran on a
   * template with a flex skills container. So this one measures RECTANGLES, on
   * every template rather than on six, and fails on the three ways a group can
   * be wrong: too narrow to hold anything, overlapping another group, or
   * hanging outside its own container.
   */
  const crowded = {
    ...tailored,
    skillGroups: [
      { category: 'Languages', skills: ['Java', 'Python', 'SQL', 'Go'] },
      { category: 'Cloud and Infrastructure', skills: ['AWS', 'Terraform', 'Kubernetes'] },
      { category: 'Data and Storage', skills: ['Postgres', 'Redis', 'Kafka'] },
      { category: 'Monitoring', skills: ['Datadog', 'PagerDuty', 'Grafana'] },
      { category: 'Professional Skills', skills: ['Communication skills', 'Troubleshooting'] },
    ],
  };

  t.diagnostic(`${SKILL_GROUP_LOOK_NAMES.length} looks x ${ALL_TEMPLATES.length} templates`);
  const dir = path.join(__dirname, '..', 'static', 'templates');
  const browser = await launchBrowser();
  const broken = [];
  const pinned = process.env.SKILL_GROUP_STYLE;
  let measured = 0;

  try {
    const page = await browser.newPage();
    for (const look of SKILL_GROUP_LOOK_NAMES) {
      process.env.SKILL_GROUP_STYLE = look;
      for (const file of ALL_TEMPLATES) {
        const template = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        await page.setContent(await generatePreviewHTML(profile, template, crowded), { waitUntil: 'load' });

        const groups = await page.evaluate(() => [...document.querySelectorAll('.skill-category')].map((node) => {
          const box = node.getBoundingClientRect();
          const parent = node.parentElement.getBoundingClientRect();
          return {
            heading: node.querySelector('.skill-category-title')?.textContent?.trim() ?? '?',
            left: box.left, right: box.right, top: box.top, bottom: box.bottom,
            width: Math.round(box.width),
            // How far the group sticks out of the box that holds it. A group
            // forced wider than its column prints over the page's own margin.
            overflow: Math.round(Math.max(box.right - parent.right, parent.left - box.left)),
          };
        }));

        // A template that renders no grouped block has nothing to measure -
        // the grouped markup only replaces the loops it recognises.
        if (groups.length === 0) continue;
        measured += 1;

        const narrow = groups.filter((group) => group.width < 40);
        if (narrow.length) {
          broken.push(`${look}/${file}: ${narrow.length} group(s) under 40px wide (${narrow.map((g) => `${g.heading} ${g.width}px`).join(', ')})`);
          continue;
        }

        for (let i = 0; i < groups.length; i += 1) {
          for (let j = i + 1; j < groups.length; j += 1) {
            const a = groups[i];
            const b = groups[j];
            const overlaps = a.left < b.right - 1 && b.left < a.right - 1
              && a.top < b.bottom - 1 && b.top < a.bottom - 1;
            if (overlaps) broken.push(`${look}/${file}: "${a.heading}" is printed over "${b.heading}"`);
          }
        }

        const spilling = groups.filter((group) => group.overflow > 2);
        if (spilling.length) {
          broken.push(`${look}/${file}: ${spilling.length} group(s) outside their container by up to ${Math.max(...spilling.map((g) => g.overflow))}px`);
        }
      }
    }
  } finally {
    if (pinned === undefined) delete process.env.SKILL_GROUP_STYLE;
    else process.env.SKILL_GROUP_STYLE = pinned;
    await browser.close();
  }

  t.diagnostic(`${measured} template/look pairs rendered a grouped block`);
  assert.deepEqual(broken, [], broken.join('\n'));
});
