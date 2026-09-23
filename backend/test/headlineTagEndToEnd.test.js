const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { useTempStorage } = require('./helpers');

/**
 * The headline tag, checked through the route the sheet import actually calls.
 *
 * This feature was "done" three times and absent from every resume each time,
 * because each check tested one piece and the piece was right:
 *
 *   1. the tag function was correct; the renderer read `profile.title` instead;
 *   2. the renderer was fixed; the headline was rebuilt from the posting, so
 *      the tag was correctly suppressed as a repeat;
 *   3. the headline was fixed; the tag read only the ANALYSER's title, and a
 *      real analysis can come back with that empty - while the request carried
 *      the right title from the sheet's job-title column the whole time.
 *
 * So this drives POST /generate-multi-job with the model stubbed and the
 * analyser's title deliberately blank, and asserts on the tailored title that
 * the route hands to the renderer.
 */

const analysisWithBlankTitle = () => ({
  jobMeta: { title: '', seniority: 'senior', industry: 'SaaS', department: 'engineering' },
  skills: { technical: [], required: ['Kubernetes'], preferred: [], tools: [], soft: [], technologies: [] },
  technologies: [], protocols: [], methodologies: [], architecturePatterns: [],
  responsibilities: [], domainKnowledge: [], softSkills: [],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
});

test('the sheet\'s job title reaches the headline when the analyser left its own blank', async (t) => {
  useTempStorage('headline-e2e');

  const execution = require('../dist/services/ai/promptExecution');
  const original = execution.createPromptCompletion;
  execution.createPromptCompletion = async () => JSON.stringify({
    title: 'Whatever The Model Said',
    summary: 'Engineer with 9 years of platform work.',
    experience: [], strengths: [], coverLetter: 'I build platforms.',
  });

  // Captured on the way to the renderer, so the assertion is about the value
  // that gets printed, not a value computed somewhere and discarded.
  const generator = require('../dist/generators/pdfGenerator');
  const originalRender = generator.generateResumePDF;
  const originalPreview = generator.generatePreviewHTML;
  const printed = [];
  generator.generateResumePDF = async (_profile, _template, tailored) => {
    printed.push(tailored?.title);
    return 'stub.pdf';
  };
  generator.generatePreviewHTML = async (_profile, _template, tailored) => `<p>${tailored?.title}</p>`;

  const coverLetters = require('../dist/generators/coverLetterGenerator');
  const originalCover = coverLetters.saveCoverLetter;
  coverLetters.saveCoverLetter = async () => 'stub-cover.pdf';

  // A temp store carries no installed templates, and rendering is stubbed, so
  // any template will do: the route only needs to find one before tailoring.
  const templates = require('../dist/extractors/templateExtractor');
  const originalTemplate = templates.getTemplateById;
  templates.getTemplateById = async (id) => ({
    id, name: 'stub', description: 'stub template', htmlContent: '<p>{{title}}</p>',
    cssContent: '', sections: [], createdAt: '', updatedAt: '',
  });

  const { saveProfile } = require('../dist/database/profileRepository');
  const { updateAppSettings } = require('../dist/config/aiModelConfig');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-headline-'));

  let server;
  try {
    await updateAppSettings({ outputBaseDir: outDir });
    const profile = saveProfile({
      id: 'headline-e2e-profile',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      name: 'Taylor Example',
      title: 'Software Engineer',
      contact: { phone: '555-555-5555', email: 't@example.com', location: 'Austin, TX' },
      summary: 'Engineer.',
      experience: [{
        title: 'Software Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
        location: 'Remote', description: 'Built things.', achievements: ['Did work.'], skills: [],
      }],
      skills: [], education: [], certifications: [], strengths: [],
    });

    const express = require('express');
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    delete require.cache[require.resolve('../dist/routes/resume')];
    app.use('/api/resume', require('../dist/routes/resume').default);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/resume/generate-multi-job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: 'pdf',
        profileIds: [profile.id],
        jobs: [
          { companyName: 'One', role: 'Mulesoft Integration Engineer', jobDescription: 'x'.repeat(80), jobAnalysis: analysisWithBlankTitle(), sourceRowNumber: 1 },
          { companyName: 'Two', role: 'AWS DevOps', jobDescription: 'x'.repeat(80), jobAnalysis: analysisWithBlankTitle(), sourceRowNumber: 2 },
        ],
      }),
    });

    const body = await response.json();
    if (response.status !== 200 || body.failed) {
      t.diagnostic(JSON.stringify(body).slice(0, 400));
    }
    assert.equal(response.status, 200);
    assert.equal(body.failed, 0);

    assert.deepEqual(printed.sort(), [
      'Software Engineer (DevOps)',
      'Software Engineer (Integration)',
    ]);

    // The on-screen preview has to agree with the file that gets saved.
    const preview = await fetch(`http://127.0.0.1:${server.address().port}/api/resume/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileId: profile.id,
        templateId: 'default',
        role: 'Senior Machine Learning Engineer',
        jobDescription: 'x'.repeat(80),
        jobAnalysis: analysisWithBlankTitle(),
      }),
    });
    const shown = await preview.json();
    assert.equal(preview.status, 200, JSON.stringify(shown).slice(0, 300));
    assert.equal(shown.html, '<p>Software Engineer (AI/ML)</p>');
  } finally {
    execution.createPromptCompletion = original;
    generator.generateResumePDF = originalRender;
    generator.generatePreviewHTML = originalPreview;
    coverLetters.saveCoverLetter = originalCover;
    templates.getTemplateById = originalTemplate;
    server?.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
