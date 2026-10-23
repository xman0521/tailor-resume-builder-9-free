const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { launchBrowser } = require('../dist/config/browser');
const { generatePreviewHTML, STANDARD_RESUME_FONT } = require('../dist/generators/pdfGenerator');

/**
 * ASKED FOR: "use standard font for all resumes" - Arial, chosen by the operator.
 *
 * The templates name fifteen different families between them - Georgia,
 * Calibri, Segoe UI, Trebuchet MS, Palatino Linotype and the rest - in their
 * own stylesheets and, in places, inline on an element. The render puts one
 * rule over all of them, so this checks what the browser actually draws rather
 * than what a template asked for.
 */

const TEMPLATES_DIR = path.join(__dirname, '..', 'static', 'templates');

const profile = {
  id: 'p', name: 'Font Probe', title: 'Software Engineer', profileSettings: {},
  contact: { email: 'a@b.c', phone: '555 0100', location: 'Austin, TX' },
  summary: 'Engineer of 9 years on payment platforms. Runs the settlement path end to end.',
  skills: [], strengths: [], certifications: [],
  education: [{ degree: 'B.S. in Computer Science', institution: 'State University' }],
  experience: [{
    title: 'Senior Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present', location: 'Remote',
    description: '', achievements: ['Built the settlement service in Go, cutting failed runs from 6 a week to 1.'], skills: [],
  }],
  createdAt: '', updatedAt: '',
};

const tailored = {
  title: 'Senior Engineer', summary: profile.summary, experience: profile.experience,
  strengths: [], softSkills: [], skills: [], hardSkills: [],
  skillGroups: [{ category: 'Languages & Frameworks', skills: ['Python', 'Go', 'FastAPI'] }],
  coverLetter: 'x',
};

test('the standard font is Arial, with its metric twins behind it', () => {
  assert.match(STANDARD_RESUME_FONT, /^Arial,/);
  assert.match(STANDARD_RESUME_FONT, /sans-serif$/);
});

test('every template draws every piece of text in Arial', async (t) => {
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage();

  const files = fs.readdirSync(TEMPLATES_DIR).filter((file) => file.endsWith('.json')).sort();
  assert.ok(files.length >= 10, 'this must cover the whole set, not a sample');

  const wrong = [];
  for (const file of files) {
    const template = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8'));
    await page.setContent(await generatePreviewHTML(profile, template, tailored), { waitUntil: 'load' });
    const families = await page.evaluate(() => {
      const seen = new Set();
      for (const element of document.body.querySelectorAll('*')) {
        const hasText = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
        if (hasText) seen.add(getComputedStyle(element).fontFamily.split(',')[0].trim().replace(/['"]/g, ''));
      }
      return [...seen];
    });
    const other = families.filter((family) => family !== 'Arial');
    if (other.length > 0) wrong.push(`${file}: ${other.join(', ')}`);
  }

  assert.deepEqual(wrong, [], `templates drawing text in another font:\n${wrong.join('\n')}`);
});
