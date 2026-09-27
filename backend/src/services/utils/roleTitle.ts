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
