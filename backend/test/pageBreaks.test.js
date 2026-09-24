const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const pdfParse = require('pdf-parse');
const { launchBrowser } = require('../dist/config/browser');
const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');

/**
 * Where a page is allowed to break.
 *
 * Two faults, both reported from finished resumes: a role's company and title
 * at the foot of a page with its bullets on the next one, and the education
 * section cut in half by a boundary.
 *
 * Checked on the PDF, because the page is the only place the answer exists -
 * and across a SWEEP of content lengths, because whether a header lands at the
 * foot of a page is a question of where the content happens to fall. One
 * fixture proves nothing: the fault this pins appears only when the summary is
 * ten sentences long, and not at nine or fourteen.
 */

const ROLES = 7;
const experience = Array.from({ length: ROLES }, (_, index) => ({
  title: `Senior Software Engineer ${index + 1}`,
  company: `Company Number ${index + 1}`,
  startDate: `01/20${10 + index}`,
  endDate: `12/20${11 + index}`,
  location: 'Remote',
  description: '',
  achievements: Array.from({ length: 4 + (index % 3) }, (_, bullet) =>
    `Bullet ${index + 1}.${bullet + 1}: cut p99 latency from 180ms to 118ms on the checkout path by batching the lookups.`),
  skills: [],
}));

const profile = {
  id: 'p', name: 'Page Break Probe', title: 'Software Engineer',
  profileSettings: { technicalSkillsLayout: 'flat' },
  contact: { phone: '1', email: 'a@b.c', location: 'Austin, TX' },
  summary: 'Engineer of 12 years on payments platforms.',
  experience,
  strengths: [], skills: [],
  education: [
    { degree: 'Bachelor of Science - BS, Computer Science', institution: 'University of Central Florida', startDate: '2015', endDate: '2019', location: 'Orlando, FL' },
    { degree: 'Associate of Arts, Computer Science', institution: 'Valencia College', startDate: '2013', endDate: '2015', location: 'Orlando, FL' },
  ],
  certifications: [], createdAt: '', updatedAt: '',
};

const tailored = {
  title: 'Software Engineer (Backend)',
  summary: profile.summary,
  experience,
  strengths: [], softSkills: [], skills: [], hardSkills: [],
  unconfirmedHardSkills: [], unconfirmedSoftSkills: [],
  skillGroups: [
    { category: 'Languages', skills: ['TypeScript', 'SQL'] },
    { category: 'Backend & APIs', skills: ['Node.js', 'REST APIs'] },
  ],
  coverLetter: 'x',
};

async function pagesOf(buffer) {
  const pages = [];
  await pdfParse(buffer, {
    pagerender: async (pageData) => {
      const content = await pageData.getTextContent();
      let text = '';
      let lastY;
      for (const item of content.items) {
        if (lastY !== undefined && Math.abs(lastY - item.transform[5]) > 1) text += '\n';
        text += item.str;
        lastY = item.transform[5];
      }
      pages.push(text);
      return text;
    },
  });
  return pages;
}

const lines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);

function faults(pages) {
  const found = [];
  for (let at = 0; at < pages.length - 1; at += 1) {
    const here = lines(pages[at]);
    const next = lines(pages[at + 1]);
    const last = here.at(-1) ?? '';
    const head = next[0] ?? '';

    if (/Senior Software Engineer \d|Company Number \d/.test(last) && /^Bullet \d/.test(head)) {
      found.push(`a role header was left at the foot of page ${at + 1}: "${last}"`);
    }

    const tail = here.slice(-3).join(' ');
    const eduHere = /EDUCATION|Education|Bachelor|Associate|University|College/.test(tail);
    const eduNext = /Bachelor|Associate|University|College|EDUCATION/.test(next.slice(0, 3).join(' '));
    if (eduHere && eduNext) found.push(`education was split across pages ${at + 1}-${at + 2}`);
  }
  return found;
}

// The template that produced the fault, plus two of other shapes. A full sweep
// of all 38 takes minutes; this one runs in about one.
const TEMPLATES = ['one-column-pdf.json', 'two-column-john.json', 'one-column-serif.json'];
const LENGTHS = 14;

test('a role header is never left at the foot of a page, and education stays whole', async (t) => {
  t.diagnostic(`${TEMPLATES.length} templates x ${LENGTHS} content lengths`);
  const dir = path.join(__dirname, '..', 'static', 'templates');
  const browser = await launchBrowser();
  const problems = [];

  try {
    const page = await browser.newPage();
    for (const file of TEMPLATES) {
      const template = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      for (let pad = 0; pad < LENGTHS; pad += 1) {
        const padded = { ...tailored, summary: tailored.summary + ' Ran the settlement path.'.repeat(pad) };
        await page.setContent(await generatePreviewHTML(profile, template, padded), { waitUntil: 'load' });
        const buffer = Buffer.from(await page.pdf({ format: 'A4', printBackground: true }));
        for (const fault of faults(await pagesOf(buffer))) problems.push(`${file} [pad ${pad}]: ${fault}`);
      }
    }
  } finally {
    await browser.close();
  }

  assert.deepEqual(problems, [], problems.join('\n'));
});
