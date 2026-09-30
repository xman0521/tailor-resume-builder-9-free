/**
 * A job title as a person would say it, out of whatever the posting called it.
 *
 * WHY. The posting's title is what the resume is headlined with and what names
 * the file, and postings do not write titles - they write adverts. Real ones
 * from one sheet: "Staff Data Engineer US Remote", "Sr DevOps Engineer -
 * Remote (US) - Req #12345", "Senior Software Engineer (Contract, W2)". A
 * headline reading "Staff Data Engineer US Remote" tells a reader the resume
 * was assembled by a script, and a file called
 * "Leo_Wu_Software_Engineer,_Java_J2EE_AML_Applications.pdf" is no better.
 *
 * WHAT IT KEEPS. The role and its specialisation, which is what a scanner
 * matches and what a reader reads: "Software Engineer, Java/J2EE AML
 * Applications" keeps all of it, because none of that is noise. What goes is
 * the advert around it - where the job is, how it is paid, what it is numbered,
 * and anything in brackets.
 *
 * WHAT IT DOES NOT DO. It does not shorten a long but genuine title, and it
 * does not remove the employer's name, which cannot be told from a role word
 * without knowing the employer. Both of those would need a judgement this
 * cannot make from a string.
 */

/** Segments that describe the advert rather than the job. */
const NOISE_SEGMENT = new RegExp(
  '^(?:'
  + 'remote|hybrid|on[- ]?site|in[- ]?office|wfh'
  + '|u\\.?s\\.?a?|united states|us remote|usa remote|emea|apac|latam|eu|uk|canada|india'
  + '|full[- ]?time|part[- ]?time|permanent|perm|contract(?:or)?|contract to hire|c2h|w2|c2c|1099'
  + '|temp(?:orary)?|freelance|seasonal|internship'
  + '|urgent|immediate(?:ly)? hiring|now hiring|hiring|new|open|opening|apply now'
  + '|req(?:uisition)?\\.?\\s*#?\\s*[a-z0-9-]*|job\\s*(?:id|code|no\\.?|number)\\s*#?\\s*[a-z0-9-]*'
  + '|#?\\d{3,}'
  + '|[a-z .]+,\\s*[a-z]{2}'
  + ')$',
  'i'
);

/** The same words, trailing the title without a separator in front of them. */
const NOISE_TAIL = new RegExp(
  '(?:\\s+(?:'
  + 'us|usa|u\\.s\\.|united states|remote|hybrid|on[- ]?site|wfh|emea|apac|latam'
  + '|full[- ]?time|part[- ]?time|contract|w2|c2c|1099|permanent|perm'
  + '))+$',
  'i'
);

/** How long a headline may get before it stops being one. */
const MAX_TITLE_LENGTH = 72;

/** Words that are a grade rather than an abbreviation, despite having no vowel. */
const GRADES = new Set(['SR', 'JR', 'SNR', 'DR', 'MR', 'MS', 'MRS', 'MGR']);

/** Words that stay lower case inside a title. */
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

/**
 * The names that are not words, spelled the way the industry spells them.
 *
 * A title arriving in one case carries no clue that "ai" is two letters rather
 * than a syllable, and "Senior Ai Software Engineer" is a headline that says
 * nobody read it. Only entries whose casing cannot be guessed from the letters
 * belong here: "AWS" and "SQL" have no vowels and are handled by the rule below.
 */
const KNOWN_CASING: Record<string, string> = {
  ai: 'AI', ml: 'ML', ui: 'UI', ux: 'UX', it: 'IT', api: 'API', apis: 'APIs',
  sre: 'SRE', qa: 'QA', etl: 'ETL', llm: 'LLM', llms: 'LLMs', nlp: 'NLP',
  devops: 'DevOps', devsecops: 'DevSecOps', mlops: 'MLOps', sdet: 'SDET',
  ios: 'iOS', saas: 'SaaS', paas: 'PaaS', iaas: 'IaaS', erp: 'ERP', crm: 'CRM',
  bi: 'BI', qe: 'QE', ci: 'CI', cd: 'CD', ux_ui: 'UX/UI',
};

/**
 * Case, fixed only when the whole string is one case.
 *
 * "AWS DevOps Engineer" and "Engineer II, Platform" were typed deliberately and
 * are left exactly as they are; "SR DEVOPS ENGINEER" and "senior data engineer"
 * were not.
 */
function naturalCase(title: string): string {
  const hasLower = /[a-z]/.test(title);
  const hasUpper = /[A-Z]/.test(title);
  if (hasLower && hasUpper) return title;

  return title
    .split(' ')
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index > 0 && SMALL_WORDS.has(lower)) return lower;
      const known = KNOWN_CASING[lower.replace(/[^a-z]/g, '')];
      if (known) return word.replace(/[a-z]+/i, known);
      // An abbreviation stays in caps - AWS, SRE, QA, ML, SQL - and the test for
      // one is that it carries no vowel. Grades have no vowels either and are
      // words: "SR DEVOPS ENGINEER" is a shouted "Sr", not an acronym.
      const bare = word.replace(/[0-9/&.+-]/g, '');
      if (!hasLower && /^[A-Z0-9/&.+-]{2,5}$/.test(word)
        && !/[AEIOU]/.test(bare) && !GRADES.has(word)) return word;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

export function naturalRoleTitle(raw: string | undefined): string {
  const original = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!original) return '';

  // Anything in brackets is an aside: a location, a stack, a requisition.
  let title = original
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Then the segments, split on the separators a posting uses to bolt the
  // advert onto the job. TWO PASSES, because a place is written with a comma in
  // the middle of it: splitting on commas first turns "New York, NY" into "New
  // York" and "NY", and neither half looks like a location on its own. So the
  // strong separators go first, where "New York, NY" is still one segment, and
  // the commas inside what survives are split afterwards - a comma is how a
  // genuine specialisation is attached, so those pieces stay unless they are
  // noise by name.
  const kept: string[] = [];
  for (const outer of title.split(/\s*[|]\s*|\s+[-–—]\s+/).filter(Boolean)) {
    if (NOISE_SEGMENT.test(outer.trim())) continue;
    for (const segment of outer.split(/\s*,\s*/)) {
      const clean = segment.trim();
      if (!clean || NOISE_SEGMENT.test(clean)) continue;
      kept.push(clean);
    }
  }
  if (kept.length > 0) {
    // The first segment is the role; the rest were attached with commas.
    title = kept.length === 1 ? kept[0] : `${kept[0]}, ${kept.slice(1).join(', ')}`;
  }

  // And the words a posting tacks on with no separator at all.
  let previous = '';
  while (previous !== title) {
    previous = title;
    title = title.replace(NOISE_TAIL, '').trim();
  }

  title = title.replace(/[\s,;:/\\|-]+$/, '').replace(/^[\s,;:/\\|-]+/, '').trim();
  if (!title) return naturalCase(original);

  if (title.length > MAX_TITLE_LENGTH) {
    const cut = title.slice(0, MAX_TITLE_LENGTH);
    const lastSpace = cut.lastIndexOf(' ');
    title = (lastSpace > MAX_TITLE_LENGTH - 24 ? cut.slice(0, lastSpace) : cut)
      .replace(/[\s,;:/\\|-]+$/, '')
      .trim();
  }

  return naturalCase(title);
}

/**
 * Just the role, without the stack it is advertised with.
 *
 * `naturalRoleTitle` keeps a posting's specialisation because a scanner matches
 * it and a file name benefits from it: "Data & AI Engineer, AWS, Java & Python".
 * A SENTENCE cannot carry that - "an AWS, Java & Python engineer" is not a thing
 * anyone says - so the summary is given the head of the title only, and told to
 * phrase it naturally: "Data & AI Engineer" becomes "AI data engineering".
 */
export function shortRoleTitle(raw: string | undefined): string {
  const natural = naturalRoleTitle(raw);
  if (!natural) return '';

  const head = natural.split(',')[0].trim();
  if (head.length <= 44) return head;

  const cut = head.slice(0, 44);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * The kind of engineer a posting is looking for, in two or three words.
 *
 * WHAT IT IS FOR. File names. A posting's own title makes a long and useless
 * one - "Weitian_Wu_DevOps_Engineer_III_AI_Business_Automation.pdf",
 * "Weitian_Wu_Senior_Cloud_Engineer_Observability.pdf" - where what the operator
 * wants to see in a folder listing is which KIND of role it was: DevOps, Cloud,
 * Backend, AI/ML. The full title still names the folder, so nothing is lost.
 *
 * HOW IT DECIDES. On the HEAD of the title, before any comma or dash, because
 * that is the role and what follows is the team or the stack: "DevOps Engineer
 * III - AI Business Automation" is a DevOps job on an AI team, and matching the
 * whole string would call it AI/ML. The first pattern that matches wins, so the
 * order below is the ranking: a title that says several things is filed under
 * the most specific one it says.
 *
 * It answers "Software Engineer" when it recognises nothing, which is true of
 * most postings that do not say otherwise.
 */
const ROLE_FAMILIES: Array<{ family: string; pattern: RegExp }> = [
  { family: 'AI/ML Engineer', pattern: /\b(?:machine learning|\bml\b|mlops|deep learning|\bnlp\b|computer vision|generative ai|gen ?ai|\bai\b|\bllms?\b|artificial intelligence)\b/i },
  { family: 'Data Engineer', pattern: /\b(?:data engineer|data engineering|analytics engineer|\betl\b|big data|data platform|data pipeline)\b/i },
  { family: 'Data Scientist', pattern: /\b(?:data scientist|data science)\b/i },
  { family: 'DevOps Engineer', pattern: /\b(?:devops|dev ?sec ?ops|ci\/cd|build and release|release engineer)\b/i },
  { family: 'Site Reliability Engineer', pattern: /\b(?:site reliability|\bsre\b|reliability engineer)\b/i },
  // Security before cloud and platform: "Senior Infrastructure Security
  // Engineer" is a security job that happens to name infrastructure, and the
  // more specific discipline is the one worth putting in the file name.
  { family: 'Security Engineer', pattern: /\b(?:security|appsec|infosec|cyber|cryptograph)\b/i },
  { family: 'Cloud Engineer', pattern: /\b(?:cloud|aws|azure|gcp|kubernetes)\b/i },
  { family: 'Platform Engineer', pattern: /\b(?:platform|infrastructure|systems engineer)\b/i },
  { family: 'QA Engineer', pattern: /\b(?:\bqa\b|quality assurance|quality engineer|test engineer|testing|\bsdet\b|automation engineer)\b/i },
  { family: 'Mobile Engineer', pattern: /\b(?:mobile|\bios\b|android|react native|flutter)\b/i },
  { family: 'Full-Stack Engineer', pattern: /\bfull[ -]?stack\b/i },
  { family: 'Frontend Engineer', pattern: /\b(?:front[ -]?end|\bui\b|\bux\b|react|angular|vue|javascript developer|web developer)\b/i },
  { family: 'Backend Engineer', pattern: /\b(?:back[ -]?end|server[ -]?side|\bapi\b|microservices|java developer|python developer|\.net developer|golang)\b/i },
  { family: 'Integration Engineer', pattern: /\b(?:integration|mulesoft|middleware|\besb\b|solutions? engineer)\b/i },
  { family: 'Embedded Engineer', pattern: /\b(?:embedded|firmware|\brtos\b)\b/i },
  { family: 'Database Engineer', pattern: /\b(?:database|\bdba\b|\bsql\b|oracle|postgres)\b/i },
  { family: 'Engineering Manager', pattern: /\b(?:engineering manager|development manager|head of engineering|director of engineering|\bvp\b)\b/i },
  { family: 'Software Architect', pattern: /\barchitect\b/i },
];

/** What a posting is called when nothing in it names a discipline. */
const DEFAULT_ROLE_FAMILY = 'Software Engineer';

export function roleFamily(raw: string | undefined): string {
  const head = shortRoleTitle(raw);
  if (!head) return '';

  for (const { family, pattern } of ROLE_FAMILIES) {
    if (pattern.test(head)) return family;
  }

  // Nothing in the head, so try the whole title before giving up: a posting
  // that says "Engineer II - Backend Services" keeps its discipline in the tail.
  const whole = naturalRoleTitle(raw);
  for (const { family, pattern } of ROLE_FAMILIES) {
    if (pattern.test(whole)) return family;
  }

  return DEFAULT_ROLE_FAMILY;
}

/**
 * The headline with the target role after it, in one of six shapes.
 *
 * WHY IT IS BACK, AND WHY IT VARIES. A scanner scores the headline against the
 * posting - measured over 495 delivered resumes, the posting's title appeared
 * verbatim in 2% of them - and the candidate's own title alone scores nothing
 * there. The line has been through every shape in between: rebuilt from the
 * posting (which renamed the person), the posting's title alone (which read as
 * somebody else's job), and the profile's title alone. This is the middle: the
 * candidate's own title, and after it the KIND of role this application is for.
 *
 * The separator is drawn per resume because a batch of 500 resumes all reading
 * "Title (Discipline)" is a pattern anyone holding two of them can see, and the
 * separator is the one part of the line that can vary without changing what it
 * says.
 *
 * NOTHING IS SAID TWICE. A data engineer applying for a data engineering job
 * keeps their own line: "Senior Data Engineer | Data Engineer" is the machine
 * showing its working.
 */
const HEADLINE_STYLES: Record<string, (own: string, role: string) => string> = {
  pipe: (own, role) => `${own} | ${role}`,
  dash: (own, role) => `${own} - ${role}`,
  parens: (own, role) => `${own} (${role})`,
  emdash: (own, role) => `${own} — ${role}`,
  bracket: (own, role) => `${own} [${role}]`,
  amp: (own, role) => `${own} & ${role}`,
};

export const HEADLINE_STYLE_NAMES = Object.keys(HEADLINE_STYLES);

/** The shape this resume's headline takes: the pinned one, or a random one. */
export function pickHeadlineStyle(env: NodeJS.ProcessEnv = process.env): string {
  const pinned = (env.RESUME_HEADLINE_STYLE ?? '').trim().toLowerCase();
  if (pinned && HEADLINE_STYLE_NAMES.includes(pinned)) return pinned;
  return HEADLINE_STYLE_NAMES[Math.floor(Math.random() * HEADLINE_STYLE_NAMES.length)];
}

export function headlineWithTargetRole(
  ownTitle: string,
  postingTitle: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string {
  const own = (ownTitle ?? '').trim().replace(/\s+/g, ' ');
  const role = roleFamily(postingTitle);
  if (!own || !role) return own;

  // Already said: every word of the role is in the candidate's own title.
  const spoken = own.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const words = role.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.every((word) => spoken.includes(word))) return own;

  const composed = HEADLINE_STYLES[pickHeadlineStyle(env)](own, role);
  return composed.length <= MAX_TITLE_LENGTH ? composed : own;
}
