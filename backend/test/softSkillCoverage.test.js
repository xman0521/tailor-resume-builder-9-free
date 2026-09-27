const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildTailorResumePromptValues,
  parseJobAnalysisContent,
} = require('../dist/services/resumeService');
const { shortRoleTitle } = require('../dist/services/utils/roleTitle');

/**
 * Soft skills are the weak band, so this pins the plumbing that feeds them.
 *
 * Fifteen scanned resumes averaged 85 and soft skills were the low score in
 * every one. The writing rules had been pushing on a list that was barely
 * populated: the analyser's whole instruction for them was one line, and
 * whatever it returned is what the tailor prompt is told to place and what the
 * report counts. A thin list cannot be recovered downstream - so what matters
 * is that every soft skill the analyser finds reaches the prompt, and that both
 * prompts ask for the work.
 */

const analysis = (soft, extra = []) => parseJobAnalysisContent(JSON.stringify({
  jobMeta: { title: 'Data & AI Engineer - AWS, Java & Python', seniority: 'Senior', industry: 'SaaS', department: 'Engineering' },
  skills: {
    technical: ['code review'], required: ['Python', 'AWS'], preferred: [],
    tools: ['Python', 'AWS'], soft, technologies: [],
  },
  technologies: [], protocols: [], methodologies: [], architecturePatterns: [],
  responsibilities: [], domainKnowledge: [], softSkills: extra,
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
}), 'A data and AI role using Python and AWS.');

const profile = () => ({
  id: 'p', name: 'Soft Probe', title: 'Software Engineer', profileSettings: {},
  contact: { phone: '1', email: 'a@b.c', location: 'Austin, TX' },
  summary: 'Engineer.',
  experience: [{
    title: 'Senior Software Engineer', company: 'Acme', startDate: '01/2019', endDate: 'Present',
    location: 'Remote', description: '', achievements: ['Did work.'], skills: [],
  }],
  strengths: [], skills: [], education: [], certifications: [], createdAt: '', updatedAt: '',
});

test('every soft skill the analyser finds reaches the prompt checklist', () => {
  const named = [
    'Communication skills', 'Collaboration', 'Ownership', 'Problem solving',
    'Mentoring', 'Adaptability', 'Attention to detail', 'Stakeholder management',
  ];
  const implied = ['Teamwork', 'Time management'];

  const checklist = JSON.parse(
    buildTailorResumePromptValues(profile(), analysis(named, implied)).keywordsJson
  );

  const missing = [...named, ...implied].filter((term) => !checklist.includes(term));
  assert.deepEqual(missing, [], `these never reached the prompt: ${missing.join(', ')}`);
});

test('the summary is given the role in words a sentence can carry', () => {
  // The posting's own string cannot go in a sentence - "an AWS, Java & Python
  // engineer" is not a thing anyone says - so the prompt gets the head of it and
  // is told to phrase it: "Data & AI Engineer" as "AI data engineering".
  const value = buildTailorResumePromptValues(profile(), analysis([])).targetRoleTitle;
  assert.equal(value, 'Data & AI Engineer');
  assert.equal(shortRoleTitle('Senior Site Reliability Engineer - Remote (US)'), 'Senior Site Reliability Engineer');
  assert.equal(shortRoleTitle(''), '');
});

test('both prompts ask for the work, in the copies that actually run', () => {
  /*
   * The static file and the saved record have drifted apart before - months of
   * prompt edits ran nowhere because the saved record is what resolves - so this
   * checks whichever copy each prompt actually uses.
   */
  const { getStoredPrompt } = require('../dist/database/promptRepository');
  const staticPrompt = (name) => JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'static', 'prompts', `${name}.json`), 'utf8')
  ).content;
  const running = (name) => (getStoredPrompt(name)?.content ?? staticPrompt(name));

  const analyser = running('analyze-job-description');
  assert.match(analyser, /EVERY behavioural requirement/, 'the analyser still asks for soft skills in one line');
  assert.match(analyser, /Aim for 8-15/);

  const tailor = running('tailor-resume');
  assert.match(tailor, /EVERY ONE OF THEM, AND COUNT THEM BEFORE YOU RETURN/);
  assert.match(tailor, /Three or four in the summary/);
  // The headline is the candidate's own again, and the role moved to the summary.
  assert.match(tailor, /TARGET ROLE\. This resume is aimed at: \[\[targetRoleTitle\]\]/);
  assert.match(tailor, /Never the target job title, and never role-targeted/);
  assert.doesNotMatch(tailor, /the headline on the page is this posting's\s*\n?own job title/);
});
