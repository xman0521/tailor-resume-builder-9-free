const assert = require('node:assert/strict');
const test = require('node:test');

const { naturalRoleTitle } = require('../dist/services/utils/roleTitle');
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
