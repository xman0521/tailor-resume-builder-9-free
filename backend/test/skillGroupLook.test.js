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

// One of each shape the grouped markup takes, plus the templates the report
// came from. A sweep of all 38 belongs in the probe, not in the suite.
const TEMPLATES = [
  'default.json',
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
              opacity: Number(style.opacity), padding: style.paddingLeft,
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
          Math.abs(seen.title.opacity - seen.skills.opacity) >= 0.05 ? 'tone' : null,
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
