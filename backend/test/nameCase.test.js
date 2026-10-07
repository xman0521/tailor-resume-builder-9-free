const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const pdfParse = require('pdf-parse');

const { launchBrowser, closeBrowser } = require('../dist/config/browser');
const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');

/**
 * The name at the top of a resume is spelled the way the profile spells it.
 *
 * Six of the installed templates set `text-transform:uppercase` on `.name`, so
 * "Jordan Bracken" printed as "JORDAN BRACKEN" on every resume those profiles
 * produced, and the operator does not want the name shouted.
 *
 * MEASURED FROM THE PDF, not from the markup, for the reason text-transform is
 * easy to get wrong: it changes nothing in the DOM. The element still reads
 * "Jordan Bracken" when asked, and Chrome applies the transform when it paints,
 * which is also when it writes the text stream. The capitals a parser and a
 * reader both see exist only in the printed file, so the printed file is what
 * this opens.
 */

const TEMPLATE_DIR = path.join(__dirname, '..', 'static', 'templates');
const TEMPLATES = fs.readdirSync(TEMPLATE_DIR).filter((file) => file.endsWith('.json')).sort();

// Mixed case on purpose, and two words, so capitals are unmistakable in the text.
const NAME = 'Jordan Bracken';

const profile = {
  id: 'p', name: NAME, title: 'Software Engineer',
  profileSettings: { technicalSkillsLayout: 'flat' },
  contact: {
    phone: '(555) 555-5555', email: 'jordan@example.com',
    linkedin: 'linkedin.com/in/jordan', location: 'Austin, TX',
  },
  summary: 'Engineer.',
  experience: [{
    title: 'Software Engineer', company: 'Company', startDate: '01/2019', endDate: 'Present',
    location: 'Austin, TX', description: '',
    achievements: ['Cut p99 latency from 180ms to 118ms on the settlement path.'],
    skills: [],
  }],
  strengths: [], skills: [],
  education: [{
    degree: 'BS, Computer Science', institution: 'University of Central Florida',
    startDate: '2011', endDate: '2015', location: 'Orlando, FL',
  }],
  certifications: [], createdAt: '', updatedAt: '',
};

const tailored = {
  title: 'Senior Platform Engineer',
  summary: 'Engineer of 9 years across payment platforms.',
  experience: profile.experience,
  strengths: [], softSkills: [], skills: [], hardSkills: [],
  unconfirmedHardSkills: [], unconfirmedSoftSkills: [],
  skillGroups: [{ category: 'Languages', skills: ['Java', 'Python', 'SQL'] }],
  coverLetter: 'x',
};

const textOf = async (page, template) => {
  await page.setContent(await generatePreviewHTML(profile, template, tailored), { waitUntil: 'load' });
  const data = await pdfParse(Buffer.from(await page.pdf({ format: 'A4', printBackground: true })));
  return data.text;
};

test('no installed template prints the name in capitals', async (t) => {
  t.diagnostic(`${TEMPLATES.length} templates`);
  const browser = await launchBrowser();
  const shouted = [];

  try {
    const page = await browser.newPage();
    for (const file of TEMPLATES) {
      const template = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8'));
      const text = await textOf(page, template);

      if (text.includes(NAME.toUpperCase())) shouted.push(`${file}: JORDAN BRACKEN`);
      else if (!text.includes(NAME)) shouted.push(`${file}: name missing from the text stream`);
    }
  } finally {
    await closeBrowser(browser);
  }

  assert.deepEqual(shouted, [], shouted.join('\n'));
});

test('a template that asks for capitals is overruled at render time', async () => {
  /*
   * The templates are editable in the admin page and importable from a file, so
   * the six that were fixed are only the ones installed today. This is the rule
   * that covers the rest, and it has one thing to prove: it is written BEFORE
   * the template's own stylesheet, so without `!important` it loses to a rule of
   * equal specificity and the name is capitals again.
   */
  const shouting = {
    id: 'shouting', name: 'shouting', description: 'a template that uppercases the name',
    htmlContent: '<!DOCTYPE html><html><head><style>'
      + '.name{font-size:26pt;text-transform:uppercase}'
      + '.job-title{text-transform:uppercase}'
      + '</style></head><body>'
      + '<div class="name">{{name}}</div>'
      + '<div class="job-title">{{title}}</div>'
      + '</body></html>',
    cssContent: '', sections: [], createdAt: '', updatedAt: '',
  };

  const browser = await launchBrowser();
  try {
    const text = await textOf(await browser.newPage(), shouting);
    assert.ok(text.includes(NAME), `the name should read "${NAME}": ${JSON.stringify(text)}`);
    assert.ok(!text.includes(NAME.toUpperCase()), 'the name was printed in capitals');
    // And only the name: a template that shouts its headings or its job titles
    // is making a design choice, and this is not a licence to undo it.
    assert.ok(
      text.includes(tailored.title.toUpperCase()),
      `an uppercase job title is the template's own business: ${JSON.stringify(text)}`
    );
  } finally {
    await closeBrowser(browser);
  }
});
