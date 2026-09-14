const assert = require('node:assert/strict');
const test = require('node:test');

const {
  generatePreviewHTML,
  generateTemplatePreviewHTML,
  prepareResumeRenderData,
  RESUME_PAGE_GEOMETRY,
  resolveTemplatePageBox,
} = require('../dist/generators/pdfGenerator');
const { getAllTemplates, getTemplateById } = require('../dist/extractors/templateExtractor');

test('prepareResumeRenderData normalizes LinkedIn href and display text', () => {
  const renderData = prepareResumeRenderData({
    id: 'profile-1',
    name: 'Jane Doe',
    title: 'Software Engineer',
    contact: {
      phone: '555-555-5555',
      email: 'jane@example.com',
      linkedin: 'linkedin.com/in/jane-doe',
      location: 'San Francisco, CA',
    },
    summary: 'Summary',
    experience: [],
    strengths: [],
    skills: [],
    education: [],
    createdAt: '',
    updatedAt: '',
  });

  assert.equal(renderData.contact.linkedin, 'https://linkedin.com/in/jane-doe');
  assert.equal(renderData.contact.linkedinHref, 'https://linkedin.com/in/jane-doe');
  assert.equal(renderData.contact.linkedinDisplay, 'linkedin.com/in/jane-doe');
});

test('generatePreviewHTML shows linkedin.com text while keeping the full LinkedIn href', async () => {
  const html = await generatePreviewHTML(
    {
      id: 'profile-2',
      name: 'Jane Doe',
      title: 'Software Engineer',
      contact: {
        phone: '555-555-5555',
        email: 'jane@example.com',
        linkedin: 'https://www.linkedin.com/in/jane-doe',
        location: 'San Francisco, CA',
      },
      summary: 'Summary',
      experience: [],
      strengths: [],
      skills: [],
      education: [],
      createdAt: '',
      updatedAt: '',
    },
    {
      id: 'template-1',
      name: 'Template',
      htmlContent: '<a href="{{contact.linkedin}}">{{contact.linkedin}}</a>',
      cssContent: '',
      createdAt: '',
      updatedAt: '',
    }
  );

  assert.match(html, /href="https:\/\/www\.linkedin\.com\/in\/jane-doe"/);
  assert.match(html, />linkedin\.com\/in\/jane-doe<\/a>/);
  assert.doesNotMatch(html, />https:\/\/www\.linkedin\.com\/in\/jane-doe<\/a>/);
});

test('prepareResumeRenderData carries soft skills through to the render', () => {
  const tailoredContent = {
    title: 'Senior Software Engineer',
    summary: 'Summary',
    experience: [],
    skills: ['TypeScript'],
    hardSkills: ['TypeScript'],
    softSkills: ['Communication'],
    unconfirmedSoftSkills: [],
    unconfirmedHardSkills: [],
    strengths: [],
  };

  const firstRenderData = prepareResumeRenderData(
    {
      id: 'profile-1',
      name: 'Sam Chen',
      title: 'Senior Software Engineer',
      contact: {
        phone: '555-555-5555',
        email: 'sam@example.com',
        linkedin: 'linkedin.com/in/sam-chen',
        location: 'San Jose, CA',
      },
      summary: 'Summary',
      experience: [],
      strengths: [],
      skills: [],
      education: [],
      createdAt: '',
      updatedAt: '',
    },
    tailoredContent
  );

  const otherRenderData = prepareResumeRenderData(
    {
      id: 'profile-4',
      name: 'Jane Doe',
      title: 'Software Engineer',
      contact: {
        phone: '555-555-5555',
        email: 'jane@example.com',
        linkedin: 'linkedin.com/in/jane-doe',
        location: 'San Francisco, CA',
      },
      summary: 'Summary',
      experience: [],
      strengths: [],
      skills: [],
      education: [],
      createdAt: '',
      updatedAt: '',
    },
    tailoredContent
  );

  // The templates that draw a Soft Skills section read this list. It used to be
  // blanked here, so those sections rendered a heading over nothing.
  assert.deepEqual(firstRenderData.softSkills, ['Communication']);
  assert.deepEqual(otherRenderData.softSkills, ['Communication']);
});

test('prepareResumeRenderData enforces prompt-compliant skill category counts', () => {
  const renderData = prepareResumeRenderData(
    {
      id: 'profile-4',
      // Categories are opt-in now; this test is about the categorized layout,
      // so it asks for it rather than relying on the app default.
      profileSettings: { technicalSkillsLayout: 'categorized' },
      name: 'Jane Doe',
      title: 'Software Engineer',
      contact: {
        phone: '555-555-5555',
        email: 'jane@example.com',
        linkedin: 'linkedin.com/in/jane-doe',
        location: 'San Francisco, CA',
      },
      summary: 'Summary',
      experience: [],
      strengths: [],
      skills: [],
      education: [],
      createdAt: '',
      updatedAt: '',
    },
    {
      title: 'Software Engineer',
      summary: 'Summary',
      experience: [],
      skills: ['TypeScript', 'React', 'AWS', 'PostgreSQL', 'Git', 'CI/CD'],
      hardSkills: ['TypeScript', 'React', 'AWS', 'PostgreSQL', 'Git', 'CI/CD'],
      softSkills: [],
      unconfirmedSoftSkills: [],
      unconfirmedHardSkills: [],
      strengths: [],
    }
  );

  const groups = Object.fromEntries(
    renderData.skillCategories.map((group) => [group.category, group.skills])
  );

  assert.deepEqual(Object.keys(groups), [
    'Languages',
    'Frameworks and Libraries',
    'Cloud and Infrastructure',
    'Databases and Storage',
    'Version Control & Collaboration',
  ]);
  assert.equal(groups.Languages.length, 3);
  assert.equal(groups['Frameworks and Libraries'].length, 5);
  assert.equal(groups['Cloud and Infrastructure'].length, 5);
  assert.equal(groups['Databases and Storage'].length, 5);
  assert.equal(groups['Version Control & Collaboration'].length, 5);
  assert.ok(groups.Languages.includes('TypeScript'));
  assert.ok(groups.Languages.includes('Python'));
  assert.ok(groups.Languages.includes('Java'));
  assert.equal(groups.Languages.some((skill) => ['Bash', 'C#', 'HTML', 'CSS'].includes(skill)), false);
  assert.ok(groups['Frameworks and Libraries'].includes('React'));
  assert.ok(groups['Cloud and Infrastructure'].includes('AWS'));
  assert.ok(groups['Databases and Storage'].includes('PostgreSQL'));
  assert.ok(groups['Version Control & Collaboration'].includes('Git'));
});

test('prepareResumeRenderData rejects non-library hard skill strings', () => {
  const renderData = prepareResumeRenderData(
    {
      id: 'profile-non-library',
      // Categories are opt-in now; this test is about the categorized layout,
      // so it asks for it rather than relying on the app default.
      profileSettings: { technicalSkillsLayout: 'categorized' },
      name: 'Jane Doe',
      title: 'Software Engineer',
      contact: {
        phone: '555-555-5555',
        email: 'jane@example.com',
        linkedin: 'linkedin.com/in/jane-doe',
        location: 'San Francisco, CA',
      },
      summary: 'Summary',
      experience: [],
      strengths: [],
      skills: ['AI coding tools', 'Accuracy', 'SaaS', 'Code Review'],
      education: [],
      createdAt: '',
      updatedAt: '',
    },
    {
      title: 'Software Engineer',
      summary: 'Summary',
      experience: [],
      skills: [
        'Bash',
        'C#',
        'C++',
        'JavaScript',
        'TypeScript',
        'Next.js',
        'React',
        'AI coding tools',
        'AI coding workflows',
        'AI-assisted code review tools',
        'access-control workflow development',
        'End-to-End Testing',
        'Integration Testing',
        'Regression Testing',
        'Testing',
        'Unit Testing',
      ],
      hardSkills: [
        'Bash',
        'C#',
        'C++',
        'JavaScript',
        'TypeScript',
        'Next.js',
        'React',
        'AI coding tools',
        'AI coding workflows',
        'AI-assisted code review tools',
        'access-control workflow development',
        'End-to-End Testing',
        'Integration Testing',
        'Regression Testing',
        'Testing',
        'Unit Testing',
      ],
      softSkills: [],
      unconfirmedSoftSkills: [],
      unconfirmedHardSkills: [],
      strengths: [],
    }
  );

  const groups = renderData.skillCategories;
  const flattened = groups.flatMap((group) => group.skills.map((skill) => skill.toLowerCase()));

  assert.equal(groups.length >= 5, true);
  assert.equal(
    groups.every((group) =>
      group.category === 'Languages'
        ? group.skills.length >= 3 && group.skills.length <= 5
        : group.skills.length >= 5 && group.skills.length <= 10
    ),
    true
  );
  for (const rejectedSkill of [
    'ai coding tools',
    'ai coding workflows',
    'ai-assisted code review tools',
    'access-control workflow development',
    'accuracy',
    'saas',
    'code review',
  ]) {
    assert.equal(flattened.includes(rejectedSkill), false);
  }
});

test('prepareResumeRenderData applies strict skill category rules', () => {
  const renderData = prepareResumeRenderData(
    {
      id: 'profile-2',
      // Categories are opt-in now; this test is about the categorized layout,
      // so it asks for it rather than relying on the app default.
      profileSettings: { technicalSkillsLayout: 'categorized' },
      name: 'Alex Rivera',
      title: 'Senior Software Engineer',
      contact: {
        phone: '555-555-5555',
        email: 'alex@example.com',
        linkedin: 'linkedin.com/in/alex-rivera',
        location: 'Kirkland, WA',
      },
      summary: 'Summary',
      experience: [],
      strengths: [],
      skills: [],
      education: [],
      createdAt: '',
      updatedAt: '',
    },
    {
      title: 'Senior Software Engineer',
      summary: 'Summary',
      experience: [],
      skills: ['Go', 'Python'],
      hardSkills: ['Go', 'Python'],
      softSkills: [],
      unconfirmedSoftSkills: [],
      unconfirmedHardSkills: [],
      strengths: [],
    }
  );

  const groups = Object.fromEntries(
    renderData.skillCategories.map((group) => [group.category, group.skills])
  );

  assert.deepEqual(Object.keys(groups), [
    'Languages',
    'Frameworks and Libraries',
    'Software Architecture & Design',
    'Security',
    'Cloud and Infrastructure',
  ]);
  assert.equal(groups.Languages.length >= 3 && groups.Languages.length <= 5, true);
  for (const [category, skills] of Object.entries(groups)) {
    if (category === 'Languages') continue;
    assert.ok(skills.length >= 5);
    assert.ok(skills.length <= 10);
  }
  assert.deepEqual(new Set(groups.Languages), new Set(['Go', 'Python', 'Java']));
  assert.ok(groups['Frameworks and Libraries'].includes('Gin'));
  assert.ok(groups['Frameworks and Libraries'].includes('Echo'));
  assert.ok(groups['Frameworks and Libraries'].includes('Django'));
  assert.ok(groups['Frameworks and Libraries'].includes('FastAPI'));
});

test('prepareResumeRenderData caps language skills at the prompt maximum', () => {
  const renderData = prepareResumeRenderData(
    {
      id: 'profile-2',
      // Categories are opt-in now; this test is about the categorized layout,
      // so it asks for it rather than relying on the app default.
      profileSettings: { technicalSkillsLayout: 'categorized' },
      name: 'Alex Rivera',
      title: 'Senior Software Engineer',
      contact: {
        phone: '555-555-5555',
        email: 'alex@example.com',
        linkedin: 'linkedin.com/in/alex-rivera',
        location: 'Kirkland, WA',
      },
      summary: 'Summary',
      experience: [],
      strengths: [],
      skills: [],
      education: [],
      createdAt: '',
      updatedAt: '',
    },
    {
      title: 'Senior Software Engineer',
      summary: 'Summary',
      experience: [],
      skills: ['Go', 'Python', 'JavaScript', 'PHP', 'Java', 'TypeScript'],
      hardSkills: ['Go', 'Python', 'JavaScript', 'PHP', 'Java', 'TypeScript'],
      softSkills: [],
      unconfirmedSoftSkills: [],
      unconfirmedHardSkills: [],
      strengths: [],
    }
  );

  const languages = renderData.skillCategories.find((group) => group.category === 'Languages').skills;
  assert.equal(languages.length, 5);
  assert.deepEqual(new Set(languages), new Set(['Go', 'Python', 'JavaScript', 'PHP', 'Java']));
});

// -- Template preview == printed page ---------------------------------------- //
// The preview exists to show what the PDF will look like, and it only does that
// if it renders the same document at the same width. It used to do neither: the
// template document was nested inside a second wrapper document, and laid out at
// whatever width the iframe happened to be. Column counts, line wraps and page
// breaks all move with width, so the two were only loosely related.

test('the fallback page geometry is A4 with the margins page.pdf is called with', () => {
  assert.equal(RESUME_PAGE_GEOMETRY.format, 'A4');
  assert.deepEqual(RESUME_PAGE_GEOMETRY.margin, {
    top: '0.4in',
    right: '0.5in',
    bottom: '0.3in',
    left: '0.5in',
  });
  // A4 at 96 DPI, minus 0.5in of margin either side.
  assert.equal(RESUME_PAGE_GEOMETRY.pageWidthPx, 794);
  assert.equal(RESUME_PAGE_GEOMETRY.contentWidthPx, 698);
});

// Chrome honours a template's own `@page` rule and ignores the margin handed to
// `page.pdf()`. Print the same markup with and without an `@page { margin:
// 0.35in }` rule and the ink starts 34px in rather than 48px in. Every built-in
// template declares one, so a preview built from the fallback geometry above was
// 30-96px narrower than the page it was previewing, and wrapped its lines and
// filled its pages differently. The page box has to be read per template.
/**
 * A template built here rather than read off disk.
 *
 * These assertions are about how the page box is READ, not about which files
 * happen to be installed. Pinning them to shipped ids meant the suite broke the
 * moment somebody swapped their own template set into static/templates - which
 * is a supported thing to do, and not a regression in this code.
 */
function templateDeclaring(css, body = '<div class="resume">{{name}}</div>') {
  return {
    id: 'fixture',
    name: 'Fixture',
    description: 'A template constructed by the test to declare a known page box.',
    htmlContent: `<!DOCTYPE html><html><head><style>${css}</style></head><body>${body}</body></html>`,
  };
}

test('the page box is read from the template, not assumed', () => {
  const cases = [
    // margin shorthand it declares, content width that leaves on A4
    ['0.35in', 794 - 2 * 33.6],
    ['0.2in', 794 - 2 * 19.2],
    ['0.3in', 794 - 2 * 28.8],
  ];

  for (const [margin, contentWidthPx] of cases) {
    const box = resolveTemplatePageBox(templateDeclaring(`@page { size: A4; margin: ${margin}; }`));
    assert.equal(box.margin.top, margin, `${margin} margin`);
    assert.equal(Math.round(box.contentWidthPx), Math.round(contentWidthPx), `${margin} content width`);
    assert.equal(box.mediaScale, 1, `${margin} is already A4`);
  }

  // Letter with no margins is laid out at letter and scaled down to fit the A4
  // media box, which is what printing does to it.
  const letterBox = resolveTemplatePageBox(
    templateDeclaring('@page { size: letter; margin: 0; } .resume { height: 100vh; }')
  );
  assert.equal(letterBox.pageWidthPx, 816);
  assert.equal(letterBox.pageHeightPx, 1056);
  assert.equal(letterBox.contentWidthPx, 816, 'no margins means the content is the whole page');
  assert.ok(letterBox.mediaScale < 1 && letterBox.mediaScale > 0.9, 'letter is scaled to fit A4');
  assert.ok(letterBox.usesViewportUnits, 'a template sizing itself in vh is detected');
});

test('a template preview carries the printed page box, not an arbitrary width', () => {
  const template = templateDeclaring('@page { size: A4; margin: 0.35in; }');
  const preview = generateTemplatePreviewHTML(template);
  const { margin, contentWidthPx, contentHeightPx } = resolveTemplatePageBox(template);

  // The width every width-dependent CSS decision resolves against.
  assert.match(preview, new RegExp(`width:\\s*${contentWidthPx.toFixed(2)}px`));
  assert.match(preview, new RegExp(`min-height:\\s*${contentHeightPx.toFixed(2)}px`));
  // All four page margins, in PDF order. They are set on `html`, never on the
  // body: a border or padding on the body stops the first child's top margin
  // collapsing through it, and a template that pulls its header up with a
  // negative margin needs that collapse. Measured, doing it on the body put
  // every element below such a header 10px out against the PDF.
  assert.match(
    preview,
    new RegExp(`padding:\\s*${margin.top}\\s+${margin.right}\\s+${margin.bottom}\\s+${margin.left}`)
  );
  // Print cuts anything that bleeds past the margins off at the margin edge.
  assert.match(
    preview,
    new RegExp(`clip-path:\\s*inset\\(${margin.top}\\s+${margin.right}\\s+${margin.bottom}\\s+${margin.left}\\)`)
  );
  const bodyRule = /body\s*\{[^}]*\}/.exec(preview.slice(preview.indexOf('resume-preview-page')));
  assert.ok(bodyRule, 'the chrome should style the body');
  for (const forbidden of ['border', 'padding', 'margin-top', 'margin-bottom']) {
    assert.equal(
      bodyRule[0].includes(forbidden),
      false,
      `the preview must not set ${forbidden} on the body - it changes margin collapsing`
    );
  }
  // page.pdf runs with printBackground: true, so the preview must not let the
  // browser drop backgrounds the way a screen render would.
  assert.match(preview, /print-color-adjust:\s*exact/);
});

test('the preview is the PDF document plus chrome, never a different document', async () => {
  const [template] = await getAllTemplates();
  assert.ok(template, 'there should be at least one template installed');
  const preview = generateTemplatePreviewHTML(template);

  // Strip the one appended block and what is left must be a standalone
  // document - the same string the PDF renderer is handed.
  const chrome = /<style id="resume-preview-page">[\s\S]*?<\/style>$/;
  assert.match(preview, chrome, 'the chrome must be appended last so it wins ties');

  const document = preview.replace(chrome, '');
  assert.match(document, /^<!DOCTYPE html>/i);
  assert.equal(document.includes('resume-preview-page'), false);
  // And it must be a rendered resume, not an unfilled template.
  assert.equal(document.includes('{{'), false, 'no unrendered Handlebars should survive');
  assert.ok(document.includes('Jordan Avery Chen'));
});

test('every installed template loads and is described', async () => {
  // Asserted on shape, not on a list of ids. static/templates is the set the
  // operator installed; this suite has no business dictating which files are
  // in it, only that each one is usable.
  const templates = await getAllTemplates();
  assert.ok(templates.length > 0, 'there should be at least one template installed');

  for (const template of templates) {
    assert.ok(template.id, 'a template needs an id');
    assert.ok(template.name && template.name.trim(), `${template.id} needs a name`);
    assert.ok(
      template.description && template.description.length > 20,
      `${template.id} needs a description someone can choose from`
    );
    assert.ok(
      typeof template.htmlContent === 'string' && template.htmlContent.includes('<'),
      `${template.id} needs markup`
    );
  }

  const ids = templates.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'template ids must be unique');
});

test('every installed template renders the sample resume end to end', async () => {
  // Whatever is installed, rendered. The sample profile is deliberately a full
  // resume, so a template that silently drops a section shows up here rather
  // than in someone's PDF.
  const templates = await getAllTemplates();
  assert.ok(templates.length > 0, 'there should be at least one template installed');

  for (const template of templates) {
    const preview = generateTemplatePreviewHTML(template);
    assert.ok(preview.includes('Jordan Avery Chen'), `${template.id}: name missing`);
    assert.ok(preview.includes('Northwind Payments'), `${template.id}: experience missing`);
    assert.ok(preview.includes('University of Washington'), `${template.id}: education missing`);
    assert.ok(preview.includes('TypeScript'), `${template.id}: skills missing`);
    assert.equal(preview.includes('{{'), false, `${template.id}: unrendered Handlebars`);
  }
});

/*
 * There was a test here asserting that no template name matched a set of
 * authoring prefixes, written when static/templates held a curated set that
 * shipped with the app and those names were leftovers to clean up.
 *
 * That is a house rule about one particular set of files, not a property of
 * this code, and static/templates is the operator's to fill: an install may
 * carry any number of templates, named however its operator finds useful, and
 * those names are the operator's data rather than this project's. A suite that
 * fails because somebody named their own file after themselves is reporting a
 * preference as a defect.
 *
 * What was worth keeping from it - that every template is loadable, named and
 * described - is asserted in "every installed template loads and is described"
 * above, which holds whatever the set is.
 */

