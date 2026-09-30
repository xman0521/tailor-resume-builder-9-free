const assert = require('node:assert/strict');
const test = require('node:test');

const {
  HEADLINE_STYLE_NAMES,
  headlineWithTargetRole,
  naturalRoleTitle,
  pickHeadlineStyle,
  roleFamily,
} = require('../dist/services/utils/roleTitle');
const { echoingBullets } = require('../dist/services/resumeService');

/**
 * The posting's title, written the way a person would say it - and the writing
 * tic that made the last batch of bullets read like slots rather than
 * sentences. Both were reported from delivered documents.
 */

test('the advert goes and the job stays', () => {
  const cases = [
    // What a sheet's job-title column actually holds.
    ['Staff Data Engineer US Remote', 'Staff Data Engineer'],
    ['Sr DevOps Engineer - Remote (US) - Req #12345', 'Sr DevOps Engineer'],
    ['Senior Software Engineer (Contract, W2)', 'Senior Software Engineer'],
    ['Senior Software Engineer II | Payments | New York, NY', 'Senior Software Engineer II, Payments'],
    ['Lead/Staff Full Stack Engineer - AI Platform & Agents (US/Canada, Hybrid or Remote)',
      'Lead/Staff Full Stack Engineer, AI Platform & Agents'],

    // A specialisation is the job, not the advert, so it stays - all of it.
    ['Software Engineer, Java/J2EE AML Applications', 'Software Engineer, Java/J2EE AML Applications'],
    ['Engineer II, Platform', 'Engineer II, Platform'],
    ['Machine Learning Engineer Co-Op', 'Machine Learning Engineer Co-Op'],

    // Case is fixed only when the whole string is one case.
    ['SR DEVOPS ENGINEER', 'Sr DevOps Engineer'],
    ['senior data engineer', 'Senior Data Engineer'],
    ['AWS DevOps Engineer', 'AWS DevOps Engineer'],
    // A name that is not a word keeps its own spelling rather than becoming one.
    ['senior ai software engineer', 'Senior AI Software Engineer'],
    ['senior mlops engineer', 'Senior MLOps Engineer'],
    ['principal sre', 'Principal SRE'],
  ];

  for (const [raw, expected] of cases) {
    assert.equal(naturalRoleTitle(raw), expected, `"${raw}" came out wrong`);
  }
});

test('a title that is nothing but advert keeps its words', () => {
  // Better a clumsy headline than an empty one: if every segment looks like
  // noise, the original comes back rather than nothing.
  assert.equal(naturalRoleTitle('Remote'), 'Remote');
  assert.equal(naturalRoleTitle(''), '');
  assert.equal(naturalRoleTitle(undefined), '');
  assert.equal(naturalRoleTitle('   '), '');
});

test('a headline stays a headline', () => {
  const long = naturalRoleTitle(
    'Senior Staff Software Engineer, Distributed Systems and Platform Reliability for Payments Infrastructure'
  );
  assert.ok(long.length <= 72, `${long.length} characters: ${long}`);
  // Cut at a word, not mid-word.
  assert.ok(!/\s$/.test(long) && !/,$/.test(long), long);
  assert.ok(long.startsWith('Senior Staff Software Engineer'), long);
});

test('a posting is filed under the kind of role it is', () => {
  /*
   * For file names. The posting's own title makes a long and useless one -
   * "Weitian_Wu_DevOps_Engineer_III_AI_Business_Automation.pdf" - where what an
   * operator reads in a folder listing is which KIND of role it was.
   *
   * The interesting cases are the titles that say several things. A DevOps job
   * on an AI team is a DevOps job, and an infrastructure SECURITY engineer is a
   * security engineer: the head of the title decides, and among the words in it
   * the most specific discipline wins.
   */
  const cases = [
    // The two the operator sent.
    ['Senior Cloud Engineer, Observability', 'Cloud Engineer'],
    ['DevOps Engineer III - AI Business Automation', 'DevOps Engineer'],

    // Titles that name more than one thing.
    ['Senior Infrastructure Security Engineer', 'Security Engineer'],
    ['Senior AI Engineer & Full-Stack Architect', 'AI/ML Engineer'],
    ['Site Reliability Engineering Team Lead, Principal SRE', 'Site Reliability Engineer'],
    ['Engineering Manager, Platform', 'Engineering Manager'],

    // And the ordinary ones.
    ['Staff Data Engineer US Remote', 'Data Engineer'],
    ['Senior Full Stack Software Engineer', 'Full-Stack Engineer'],
    ['Front End Developer (React)', 'Frontend Engineer'],
    ['Sr. Backend Engineer - Payments', 'Backend Engineer'],
    ['Machine Learning Engineer Co-Op', 'AI/ML Engineer'],
    ['Mulesoft Integration Engineer', 'Integration Engineer'],
    ['Senior QA Automation Engineer', 'QA Engineer'],
    ['iOS Engineer', 'Mobile Engineer'],
    ['Principal Software Architect', 'Software Architect'],

    // A posting that names no discipline is what it says it is.
    ['Senior Software Engineer II', 'Software Engineer'],
    ['Product Engineer', 'Software Engineer'],
    ['Software Engineer, Java/J2EE AML Applications', 'Software Engineer'],
  ];

  for (const [posting, expected] of cases) {
    assert.equal(roleFamily(posting), expected, `"${posting}" was filed wrong`);
  }

  // The discipline can live in the tail when the head carries none.
  assert.equal(roleFamily('Engineer II - Backend Services'), 'Backend Engineer');
  // And nothing in means nothing out, rather than a guess.
  assert.equal(roleFamily(''), '');
  assert.equal(roleFamily(undefined), '');
});

test('the headline carries the target role, in six shapes', () => {
  /*
   * This line has been through every shape there is: rebuilt from the posting
   * (which renamed the candidate), their own title with a discipline in
   * parentheses, their own title alone, the posting's title alone, and their own
   * title again. It is now their own title plus the KIND of role - because a
   * scanner scores that line and their own title alone scores nothing on it -
   * and the SEPARATOR is drawn per resume, because 500 resumes all reading
   * "Title (Discipline)" is a pattern anyone holding two of them can see.
   */
  const own = 'Senior Software Engineer';
  const posting = 'DevOps Engineer III - AI Business Automation';

  assert.deepEqual(
    HEADLINE_STYLE_NAMES.map((style) => headlineWithTargetRole(own, posting, { RESUME_HEADLINE_STYLE: style })),
    [
      'Senior Software Engineer | DevOps Engineer',
      'Senior Software Engineer - DevOps Engineer',
      'Senior Software Engineer (DevOps Engineer)',
      'Senior Software Engineer — DevOps Engineer',
      'Senior Software Engineer [DevOps Engineer]',
      'Senior Software Engineer & DevOps Engineer',
    ]
  );

  // Drawn per resume, and pinnable for a test or for an operator who wants one.
  const seen = new Set();
  for (let run = 0; run < 300; run += 1) seen.add(pickHeadlineStyle({}));
  assert.equal(seen.size, HEADLINE_STYLE_NAMES.length, `only saw ${[...seen].join(', ')}`);
  assert.equal(pickHeadlineStyle({ RESUME_HEADLINE_STYLE: 'bracket' }), 'bracket');
  assert.equal(pickHeadlineStyle({ RESUME_HEADLINE_STYLE: ' BRACKET ' }), 'bracket');
  assert.ok(HEADLINE_STYLE_NAMES.includes(pickHeadlineStyle({ RESUME_HEADLINE_STYLE: 'nonsense' })));

  const pipe = (title, job) => headlineWithTargetRole(title, job, { RESUME_HEADLINE_STYLE: 'pipe' });

  // Nothing is said twice.
  assert.equal(pipe('Senior Data Engineer', 'Staff Data Engineer US Remote'), 'Senior Data Engineer');
  assert.equal(pipe('DevOps Engineer', 'Sr DevOps Engineer - Remote (US)'), 'DevOps Engineer');

  // Nothing to append, or nothing to append to.
  assert.equal(pipe('Senior Software Engineer', ''), 'Senior Software Engineer');
  assert.equal(pipe('Senior Software Engineer', undefined), 'Senior Software Engineer');
  assert.equal(pipe('', 'Staff Data Engineer'), '');

  // A headline stays a headline: too long to carry both, so it carries one.
  assert.equal(
    pipe('Senior Distributed Systems and Platform Reliability Engineer', 'Senior Machine Learning Engineer'),
    'Senior Distributed Systems and Platform Reliability Engineer'
  );
});

test('a bullet whose verb repeats its own noun is caught', () => {
  /*
   * All four are real bullets from one delivered resume. The prompt now bans
   * the shape and offers rewrites; this is what says whether that landed.
   */
  const echoing = [
    'Automated model training workflow automation for recurring telemetry experiments.',
    'Evaluated ML model evaluation results against operational telemetry cases.',
    'Experimented with ML technology experimentation around vehicle and camera telemetry.',
    'Optimized AI agent optimization experiments by narrowing tool calls.',
  ];
  assert.equal(echoingBullets(echoing).length, 4);

  const rewritten = [
    'Automated the retraining runs for recurring telemetry experiments, so a model refresh needed no manual setup.',
    'Compared ML model evaluation results against operational telemetry before production changes.',
    'Tested PyTorch models against camera telemetry before committing them to the deployment path.',
    'Narrowed tool calls and response paths in the AI agent experiments, cutting repeated inference.',
    'Built settlement services in Go and cut p99 latency from 180ms to 118ms.',
  ];
  assert.deepEqual(echoingBullets(rewritten), []);

  // A short verb cannot collide with a longer word by accident.
  assert.deepEqual(echoingBullets(['Ran the runbook drills for the settlement path.']), []);
  assert.deepEqual(echoingBullets([]), []);
});

test('every headline shape survives the trip to the page', () => {
  /*
   * WHAT THIS PINS, from a delivered resume: a headline that read "Senior
   * Software Engineer Full-Stack Engineer" with nothing between the two names.
   *
   * The composer was right and the renderer undid it. `sanitizeTitleForATS`
   * strips the punctuation a scanner trips over, and its list included the pipe,
   * the brackets and the ampersand - written when the MODEL wrote this line and
   * the risk was symbol soup copied out of a posting. Three of the six shapes
   * use exactly those characters, so three in six resumes printed the two names
   * run together, and the shape that survived looked fine.
   *
   * Composing and rendering are in different files, and each was right on its
   * own, which is why this test goes end to end rather than calling either.
   */
  const { parseTailoredResumeContent, parseJobAnalysisContent } = require('../dist/services/resumeService');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');

  const analysis = parseJobAnalysisContent(JSON.stringify({
    jobMeta: { title: 'Senior Full Stack Software Engineer', seniority: '', industry: '', department: '' },
    skills: { technical: [], required: [], preferred: [], tools: [], soft: [], technologies: [] },
    technologies: [], protocols: [], methodologies: [], architecturePatterns: [],
    responsibilities: [], domainKnowledge: [], softSkills: [],
    keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
  }), 'A full stack role.');

  const person = {
    id: 'p', name: 'Jonathan Lai', title: 'Senior Software Engineer', profileSettings: {},
    contact: { phone: '1', email: 'a@b.c', location: 'X' }, summary: '',
    experience: [{
      title: 'Senior Software Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
      location: 'Remote', description: '', achievements: ['Did work.'], skills: [],
    }],
    strengths: [], skills: [], education: [], certifications: [], createdAt: '', updatedAt: '',
  };
  const answer = JSON.stringify({
    title: 'Model Title', summary: 'S.', experience: person.experience,
    skillGroups: [{ category: 'Languages', skills: ['Go'] }], coverLetter: 'x',
  });

  const pinned = process.env.RESUME_HEADLINE_STYLE;
  try {
    const printed = {};
    for (const style of HEADLINE_STYLE_NAMES) {
      process.env.RESUME_HEADLINE_STYLE = style;
      printed[style] = prepareResumeRenderData(person, parseTailoredResumeContent(answer, person, analysis)).title;
    }

    assert.deepEqual(printed, {
      pipe: 'Senior Software Engineer | Full-Stack Engineer',
      dash: 'Senior Software Engineer - Full-Stack Engineer',
      parens: 'Senior Software Engineer (Full-Stack Engineer)',
      emdash: 'Senior Software Engineer — Full-Stack Engineer',
      bracket: 'Senior Software Engineer [Full-Stack Engineer]',
      amp: 'Senior Software Engineer & Full-Stack Engineer',
    });

    // Whatever the shape, the two names never run together.
    for (const [style, title] of Object.entries(printed)) {
      assert.doesNotMatch(title, /Engineer Full-Stack/, `${style} printed no separator: ${title}`);
    }
  } finally {
    if (pinned === undefined) delete process.env.RESUME_HEADLINE_STYLE;
    else process.env.RESUME_HEADLINE_STYLE = pinned;
  }
});

test('a headline still loses what a scanner trips over', () => {
  // The sanitizer keeps its job: the pipe, the brackets and the ampersand are
  // punctuation a job title is written with, and the rest is not.
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const person = (title) => ({
    id: 'p', name: 'Probe', title, profileSettings: {},
    contact: { phone: '1', email: 'a@b.c', location: 'X' }, summary: '',
    experience: [], strengths: [], skills: [], education: [], certifications: [],
    createdAt: '', updatedAt: '',
  });
  const printed = (title) => prepareResumeRenderData(person(title), undefined).title;

  // Kept: a genuine title's own punctuation.
  assert.equal(printed('Data & AI Engineer'), 'Data & AI Engineer');
  assert.equal(printed('Engineer II, Platform'), 'Engineer II, Platform');
  assert.equal(printed('Full-Stack Engineer (AI/ML)'), 'Full-Stack Engineer (AI/ML)');

  // Gone: quotes, braces, angle brackets, arithmetic.
  assert.equal(printed('Engineer {contractor} "remote"'), 'Engineer contractor remote');
  assert.equal(printed('Senior Engineer <script>alert(1)</script>'), 'Senior Engineer script alert(1) /script');
  // And a separator left dangling by a removal does not print alone.
  assert.equal(printed('Senior Engineer | '), 'Senior Engineer');
  assert.equal(printed('Senior Engineer []'), 'Senior Engineer');
});
