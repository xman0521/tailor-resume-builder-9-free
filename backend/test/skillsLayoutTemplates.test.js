const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');

const TEMPLATES_DIR = path.join(__dirname, '..', 'static', 'templates');

/**
 * Every installed template, rendered in both layouts.
 *
 * The failure this exists to catch: the renderer rewrites a template's loop over
 * SKILLS into a loop over CATEGORIES, which is right when there are categories
 * and wrong when there is one group with no heading - the flat layout's shape.
 * The rewritten loop then ran exactly once and every skill landed in a single
 * bullet, box or chip. Twenty-six of the installed templates did that, and
 * nothing in the suite noticed, because every test rendered one layout.
 */

const SKILLS = [
  'Go', 'Java', 'JavaScript', 'Python', 'SQL', 'TypeScript', 'Django', 'Express',
  'Jest', 'React', 'MongoDB', 'PostgreSQL', 'Redis', 'Terraform', 'AWS', 'Docker',
  'Grafana', 'Kubernetes', 'Prometheus', 'Kafka',
];

// The loops the renderer rewrites. A template that comma-joins its skills by its
// own design is not one of these and is not a bug.
const REWRITTEN_LOOPS = [
  { kind: 'li', tag: 'li', pattern: /\{\{#each hardSkills\}\}\s*<li[^>]*>\{\{this\}\}<\/li>\s*\{\{\/each\}\}/ },
  { kind: 'box', tag: 'div', pattern: /\{\{#each hardSkills\}\}\s*<div class="skill-box">/ },
  { kind: 'chip', tag: 'span', pattern: /\{\{#each hardSkills\}\}\s*<span class="skill-chip">/ },
];

function profileWith(layout) {
  return {
    id: 'p', name: 'Jordan Avery Chen', title: 'Senior Software Engineer',
    profileSettings: { technicalSkillsLayout: layout },
    contact: { phone: '555-555-5555', email: 'j@example.com', location: 'San Francisco, CA' },
    summary: 'Senior engineer.', experience: [], strengths: [],
    skills: SKILLS, education: [], certifications: [], createdAt: '', updatedAt: '',
  };
}

function templatesOnDisk() {
  return fs
    .readdirSync(TEMPLATES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({
      id: file.replace(/\.json$/, ''),
      template: JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8')),
    }));
}

function body(html) {
  return html.slice(html.indexOf('</style>'));
}

// Non-greedy and nesting-tolerant: the grouped <li> holds <strong> and <br>.
function elementsOf(markup, tag) {
  return markup.match(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi')) || [];
}

const skillsIn = (element) => SKILLS.filter((skill) => element.includes(skill)).length;

test('no template crams every skill into one element in the plain-list layout', async () => {
  const installed = templatesOnDisk();
  assert.ok(installed.length > 0, 'there should be templates installed');

  let checked = 0;
  for (const { id, template } of installed) {
    const loop = REWRITTEN_LOOPS.find((candidate) => candidate.pattern.test(template.htmlContent));
    if (!loop) continue;
    checked += 1;

    const rendered = body(await generatePreviewHTML(profileWith('flat'), template));
    const elements = elementsOf(rendered, loop.tag);
    const oneEach = elements.filter((element) => skillsIn(element) === 1).length;
    const crowded = elements.filter((element) => skillsIn(element) >= 3).length;

    assert.equal(crowded, 0, `${id} (${loop.kind}): ${crowded} element(s) hold three or more skills`);
    assert.ok(oneEach >= 5, `${id} (${loop.kind}): only ${oneEach} element(s) carry a single skill`);
  }

  assert.ok(checked > 0, 'no installed template uses a rewritten skills loop; this test proves nothing');
});

test('the same templates still group under headings in the categorized layout', async () => {
  // The flat fix must not cost the layout the rewrite was written for.
  for (const { id, template } of templatesOnDisk()) {
    const loop = REWRITTEN_LOOPS.find((candidate) => candidate.pattern.test(template.htmlContent));
    if (!loop) continue;

    const rendered = body(await generatePreviewHTML(profileWith('categorized'), template));
    // Any element holding two or more skills IS the grouping - that is what
    // "grouped under headings" means and what the flat layout must not produce.
    //
    // Asserted on the skill count rather than on a class name: the rewrite emits
    // a `skill-category` block for a box or a chip and a plain <li> for a list,
    // and the outer block nests, so matching the wrapper by name finds an
    // element whose own text holds no skills at all. The leaf that carries the
    // joined names is the honest thing to count.
    const grouped = [...elementsOf(rendered, 'div'), ...elementsOf(rendered, 'li')]
      .filter((element) => skillsIn(element) >= 2);

    assert.ok(
      grouped.length > 0,
      `${id} (${loop.kind}): categorized layout produced no grouped block`
    );
  }
});

test('every installed template renders both layouts without leaving Handlebars behind', async () => {
  for (const { id, template } of templatesOnDisk()) {
    for (const layout of ['flat', 'categorized']) {
      const html = await generatePreviewHTML(profileWith(layout), template);
      assert.equal(html.includes('{{'), false, `${id} (${layout}): unrendered Handlebars`);
      assert.ok(
        SKILLS.some((skill) => html.includes(skill)),
        `${id} (${layout}): no skills reached the page at all`
      );
    }
  }
});
