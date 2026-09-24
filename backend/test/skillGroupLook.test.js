const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { launchBrowser } = require('../dist/config/browser');
const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');

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

test('a group heading is told apart from the skills under it', async () => {
  const dir = path.join(__dirname, '..', 'static', 'templates');
  const browser = await launchBrowser();
  const weak = [];

  try {
    const page = await browser.newPage();
    for (const file of TEMPLATES) {
      const template = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      await page.setContent(await generatePreviewHTML(profile, template, tailored), { waitUntil: 'load' });

      const look = await page.evaluate(() => {
        const title = document.querySelector('.skill-category-title')
          || document.querySelector('.skill-category strong')
          || document.querySelector('.skills-list li > strong:first-child');
        const skills = document.querySelector('.skill-category-skills') || title?.parentElement;
        if (!title || !skills || title === skills) return null;
        const read = (el) => {
          const style = getComputedStyle(el);
          return {
            weight: Number(style.fontWeight),
            size: parseFloat(style.fontSize),
            transform: style.textTransform,
            spacing: style.letterSpacing,
            color: style.color,
          };
        };
        return { title: read(title), skills: read(skills) };
      });

      if (!look) { weak.push(`${file}: no group heading rendered at all`); continue; }

      const differences = [
        look.title.weight >= look.skills.weight + 100 ? 'weight' : null,
        Math.abs(look.title.size - look.skills.size) >= 0.5 ? 'size' : null,
        look.title.transform !== look.skills.transform ? 'case' : null,
        look.title.spacing !== look.skills.spacing ? 'spacing' : null,
        look.title.color !== look.skills.color ? 'colour' : null,
      ].filter(Boolean);

      // Two, not one: weight alone is what the reader could not see.
      if (differences.length < 2) {
        weak.push(`${file}: heading and skills differ only by ${differences.join('+') || 'nothing'}`);
      }
    }
  } finally {
    await browser.close();
  }

  assert.deepEqual(weak, [], weak.join('\n'));
});
