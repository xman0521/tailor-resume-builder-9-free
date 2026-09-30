import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import os from 'os';

export const DEFAULT_GENERATED_RESUMES_DIR = path.join(__dirname, '..', '..', '..', 'generated');
export const DEFAULT_OUTPUT_PATH_TEMPLATE = '/{{profile name}}/{{date}}/{{company name}}/{{job title}}';
export const DEFAULT_RESUME_FILE_NAME_TEMPLATE = '{{profile name}}_{{role family}}';
export const DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE = '{{profile name}}_{{role family}}_cover_letter';
export const DEFAULT_COMPANY_FOLDER_NAME_TEMPLATE = '{{row number}}_{{company name}}';

/**
 * The shapes a pair of file names can take, one drawn per application.
 *
 * WHY. Five hundred files named to one pattern is the same tell as five hundred
 * resumes laid out to one pattern, and this app already varies the skills
 * block's look and the headline's separator for exactly that reason.
 *
 * WHAT VARIES: the order of the parts, the label ("Resume", "CL", nothing), and
 * the joining and case. What does NOT vary: every name starts with the
 * candidate, so a listing still sorts by person and a recruiter reads the name
 * first; and both files of one application take the SAME shape, because a
 * folder holding "Weitian_Wu_DevOps_Engineer.pdf" beside
 * "devops_engineer_weitian_wu_cl.pdf" reads as two different people's work.
 *
 * `transform` is for the shapes a template cannot express: camel joins the
 * words of each value, lower folds the finished name.
 */
export type FileNameStyle = {
  name: string;
  resume: string;
  coverLetter: string;
  transform?: 'camel' | 'lower';
};

export const FILE_NAME_STYLES: FileNameStyle[] = [
  {
    name: 'plain',
    resume: '{{profile name}}_{{role family}}',
    coverLetter: '{{profile name}}_{{role family}}_cover_letter',
  },
  {
    name: 'labelled',
    resume: '{{profile name}}_Resume_{{role family}}',
    coverLetter: '{{profile name}}_Cover_Letter_{{role family}}',
  },
  {
    name: 'suffixed',
    resume: '{{profile name}}_{{role family}}_Resume',
    coverLetter: '{{profile name}}_{{role family}}_Cover_Letter',
  },
  {
    name: 'camel',
    resume: '{{profile name}}_{{role family}}',
    coverLetter: '{{profile name}}_{{role family}}_CoverLetter',
    transform: 'camel',
  },
  {
    name: 'company',
    resume: '{{profile name}}_{{company name}}_{{role family}}',
    coverLetter: '{{profile name}}_{{company name}}_{{role family}}_CL',
  },
  {
    name: 'lower',
    resume: '{{profile name}}_{{role family}}',
    coverLetter: '{{profile name}}_{{role family}}_cover_letter',
    transform: 'lower',
  },
];

export const FILE_NAME_STYLE_NAMES = FILE_NAME_STYLES.map((style) => style.name);

/** The shape this application's files take: the pinned one, or a random one. */
export function pickFileNameStyle(env: NodeJS.ProcessEnv = process.env): FileNameStyle {
  const pinned = (env.RESUME_FILE_NAME_STYLE ?? '').trim().toLowerCase();
  const match = FILE_NAME_STYLES.find((style) => style.name === pinned);
  if (match) return match;
  return FILE_NAME_STYLES[Math.floor(Math.random() * FILE_NAME_STYLES.length)];
}

/** "Weitian Wu" as "WeitianWu", "AI/ML Engineer" as "AIMLEngineer". */
function camelJoin(value: string): string {
  return value
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => (/^[A-Z0-9]+$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join('');
}

/** Both names for one application, in one shape. */
export function renderStyledFileNames(
  style: FileNameStyle,
  variables: OutputTemplateVariables
): { resume: string; coverLetter: string } {
  const values: OutputTemplateVariables = style.transform === 'camel'
    ? {
      ...variables,
      profileName: camelJoin(variables.profileName),
      companyName: camelJoin(variables.companyName),
      jobTitle: camelJoin(variables.jobTitle),
      roleFamily: variables.roleFamily ? camelJoin(variables.roleFamily) : variables.roleFamily,
    }
    : variables;

  const render = (template: string, fallback: string) => {
    const name = renderOutputFileNameTemplate(template, values, fallback);
    return style.transform === 'lower' ? name.toLowerCase() : name;
  };

  return {
    resume: render(style.resume, DEFAULT_RESUME_FILE_NAME_TEMPLATE),
    coverLetter: render(style.coverLetter, DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE),
  };
}

export const OUTPUT_PATH_TOKENS = [
  { token: '{{date}}', description: 'Current date as YYYY-MM-DD' },
  { token: '{{profile name}}', description: 'Selected profile name' },
  { token: '{{company name}}', description: 'Company name' },
  { token: '{{row number}}', description: 'Source Google Sheet row number' },
  { token: '{{job title}}', description: 'Role / job title' },
  { token: '{{target role title}}', description: 'Role / job title (same value, named as the posting)' },
  {
    token: '{{role family}}',
    description: 'The kind of role in two or three words: DevOps Engineer, Cloud Engineer, AI/ML Engineer',
  },
] as const;

export type OutputTemplateVariables = {
  date: string;
  profileName: string;
  companyName: string;
  rowNumber?: string;
  jobTitle: string;
  /**
   * The discipline the posting is for, rather than what it called itself.
   *
   * A file name wants "DevOps Engineer", not "DevOps Engineer III - AI Business
   * Automation": the folder already carries the full title, and what an operator
   * reads in a listing is which KIND of role each resume was written for.
   */
  roleFamily?: string;
};

const OUTPUT_TOKEN_ALIASES: Record<string, keyof OutputTemplateVariables> = {
  date: 'date',
  profile: 'profileName',
  'profile name': 'profileName',
  company: 'companyName',
  'company name': 'companyName',
  row: 'rowNumber',
  'row number': 'rowNumber',
  'sheet row': 'rowNumber',
  'source row': 'rowNumber',
  role: 'jobTitle',
  'job title': 'jobTitle',
  // The same value under the name the operator uses for it. A token a template
  // names but this table does not know renders as the literal text, so every
  // spelling anybody writes has to resolve.
  'target role title': 'jobTitle',
  'target role': 'jobTitle',
  'role title': 'jobTitle',
  'target title': 'jobTitle',
  // The discipline rather than the posting's own words, for file names.
  'role family': 'roleFamily',
  'role type': 'roleFamily',
  'simple role': 'roleFamily',
  'simple role title': 'roleFamily',
  discipline: 'roleFamily',
};

/**
 * What a path segment is called when every token in it resolves to nothing.
 *
 * The segment used to become the literal `unknown`, which is both unreadable
 * and unsafe: every job whose title the analyser could not name landed in the
 * SAME `unknown` folder and overwrote the previous one's resume. Naming the
 * token that came up empty keeps distinct failures in distinct folders and says
 * which field to go fix.
 */
const TOKEN_FALLBACKS: Record<keyof OutputTemplateVariables, string> = {
  date: 'undated',
  profileName: 'unnamed_profile',
  companyName: 'unknown_company',
  rowNumber: 'no_row',
  jobTitle: 'unknown_job_title',
  roleFamily: 'unknown_role',
};

/**
 * The MS-DOS device names Windows still reserves, at every directory level and
 * with any extension: `CON`, `nul.pdf` and `foo/AUX/bar` are all rejected by
 * the filesystem with EINVAL rather than created.
 *
 * A profile called "Aux" or a company called "Con" is rare but entirely legal,
 * and without this the failure surfaces as an unexplained write error deep in
 * generation. Applied on every platform, not just Windows, so a tree generated
 * on Linux stays portable when it is synced to a Windows machine and so both
 * platforms produce the same paths for the same inputs.
 */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

function escapeReservedName(value: string): string {
  if (!value) {
    return value;
  }
  // Windows matches the name before the FIRST dot, so "nul.tar.gz" is reserved.
  const stem = value.split('.')[0];
  return WINDOWS_RESERVED_NAME.test(stem) ? `_${value}` : value;
}

export function sanitizePathSegment(value: string): string {
  return escapeReservedName(
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  );
}

/**
 * A file name of letters, digits and underscores, and nothing else.
 *
 * It used to remove only what Windows forbids, so a posting's own punctuation
 * came through: "Leo_Wu_Software_Engineer,_Java_J2EE_AML_Applications.pdf" - a
 * comma in a file name, which is legal, ugly, and awkward in every shell and
 * spreadsheet it gets pasted into. The operator asked for underscores only.
 *
 * Letters are matched as LETTERS rather than as A-Z, so a name written in any
 * alphabet survives; only punctuation and spaces become underscores.
 */
export function sanitizeFileNameStem(value: string): string {
  return escapeReservedName(
    value
      .trim()
      .replace(/[^\p{L}\p{N}_]+/gu, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
  );
}

function expandUserPath(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function normalizeOutputBaseDir(value: unknown): string {
  const candidate = typeof value === 'string' && value.trim()
    ? expandUserPath(value.trim())
    : DEFAULT_GENERATED_RESUMES_DIR;
  return path.resolve(candidate);
}

export function validateOutputBaseDir(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Output base directory is required');
  }

  const normalized = normalizeOutputBaseDir(value);
  if (!path.isAbsolute(normalized)) {
    throw new Error('Output base directory must be an absolute path');
  }

  return normalized;
}

export async function ensureWritableOutputDir(value: string): Promise<string> {
  const normalized = validateOutputBaseDir(value);
  await fs.mkdir(normalized, { recursive: true });
  await fs.access(normalized, fsConstants.W_OK);
  return normalized;
}

export function normalizeOutputPathTemplate(value: unknown): string {
  const trimmed = typeof value === 'string' && value.trim()
    ? value.trim()
    : DEFAULT_OUTPUT_PATH_TEMPLATE;
  const withForwardSlashes = trimmed.replace(/\\/g, '/');
  const withLeadingSlash = withForwardSlashes.startsWith('/')
    ? withForwardSlashes
    : `/${withForwardSlashes}`;
  const compact = withLeadingSlash.replace(/\/{2,}/g, '/');
  if (compact.length > 1 && compact.endsWith('/')) {
    return compact.slice(0, -1);
  }
  return compact;
}

export function validateOutputPathTemplate(value: unknown): string {
  const normalized = normalizeOutputPathTemplate(value);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error('Output path template must contain at least one folder segment');
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new Error('Output path template cannot contain "." or ".." segments');
    }

    for (const match of segment.matchAll(/\{\{\s*([^}]+)\s*\}\}/g)) {
      const tokenKey = match[1]?.trim().toLowerCase() || '';
      if (!OUTPUT_TOKEN_ALIASES[tokenKey]) {
        throw new Error(`Unsupported output path token "{{${match[1]}}}"`);
      }
    }
  }

  return normalized;
}

function assertSupportedOutputTokens(
  template: string,
  allowedAliases: Record<string, keyof OutputTemplateVariables> = OUTPUT_TOKEN_ALIASES
): void {
  for (const match of template.matchAll(/\{\{\s*([^}]+)\s*\}\}/g)) {
    const tokenKey = match[1]?.trim().toLowerCase() || '';
    if (!allowedAliases[tokenKey]) {
      throw new Error(`Unsupported output token "{{${match[1]}}}"`);
    }
  }
}

function resolveTokenName(
  rawToken: string,
  allowedAliases: Record<string, keyof OutputTemplateVariables> = OUTPUT_TOKEN_ALIASES
): keyof OutputTemplateVariables {
  const variableName = allowedAliases[rawToken.trim().toLowerCase()];
  if (!variableName) {
    throw new Error(`Unsupported output token "{{${rawToken}}}"`);
  }
  return variableName;
}

function resolveTemplateToken(
  rawToken: string,
  variables: OutputTemplateVariables,
  allowedAliases: Record<string, keyof OutputTemplateVariables> = OUTPUT_TOKEN_ALIASES
): string {
  return variables[resolveTokenName(rawToken, allowedAliases)] ?? '';
}

export function renderOutputPathTemplate(
  template: string,
  variables: OutputTemplateVariables
): string {
  const normalizedTemplate = validateOutputPathTemplate(template);
  const renderedSegments = normalizedTemplate
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const usedTokens: Array<keyof OutputTemplateVariables> = [];
      const withTokenValues = segment.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, rawToken) => {
        const tokenName = resolveTokenName(rawToken);
        usedTokens.push(tokenName);
        return variables[tokenName] ?? '';
      });

      const sanitized = sanitizePathSegment(withTokenValues);
      if (sanitized) {
        return sanitized;
      }

      // Only reached when the segment kept nothing at all - every token empty
      // and no literal text to carry it. A segment that still has one live
      // token keeps that token's value and never gets here, so an absent row
      // number in "{{row number}}_{{company name}}" still yields just "acme".
      const named = sanitizePathSegment(
        usedTokens.map((tokenName) => TOKEN_FALLBACKS[tokenName]).join('_')
      );
      return named || 'unknown';
    });

  if (renderedSegments.length === 0) {
    throw new Error('Output path template did not produce a valid folder path');
  }

  return renderedSegments.join('/');
}

export function normalizeOutputFileNameTemplate(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/[/\\]+/g, ' ')
    : fallback;
}

export function normalizeOutputFolderNameTemplate(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/[/\\]+/g, ' ')
    : fallback;
}

export function validateOutputFileNameTemplate(value: unknown, fallback: string): string {
  const normalized = normalizeOutputFileNameTemplate(value, fallback);
  assertSupportedOutputTokens(normalized);

  const sample = renderOutputFileNameTemplate(normalized, {
    date: '2026-04-10',
    profileName: 'Jane Doe',
    companyName: 'Acme Inc',
    rowNumber: '12',
    jobTitle: 'Senior Engineer',
  }, fallback);

  if (!sample) {
    throw new Error('Output file name template must produce a valid file name');
  }

  return normalized;
}

const COMPANY_FOLDER_TOKEN_ALIASES: Record<string, keyof OutputTemplateVariables> = {
  company: 'companyName',
  'company name': 'companyName',
  row: 'rowNumber',
  'row number': 'rowNumber',
  'sheet row': 'rowNumber',
  'source row': 'rowNumber',
};

export function validateOutputFolderNameTemplate(value: unknown, fallback: string): string {
  const normalized = normalizeOutputFolderNameTemplate(value, fallback);
  assertSupportedOutputTokens(normalized, COMPANY_FOLDER_TOKEN_ALIASES);

  const sample = renderOutputFolderNameTemplate(normalized, {
    date: '2026-04-10',
    profileName: 'Jane Doe',
    companyName: 'Acme Inc',
    rowNumber: '12',
    jobTitle: 'Senior Engineer',
  }, fallback);

  if (!sample) {
    throw new Error('Output folder name template must produce a valid folder name');
  }

  return normalized;
}

export function renderOutputFileNameTemplate(
  template: string,
  variables: OutputTemplateVariables,
  fallback: string
): string {
  const normalizedTemplate = normalizeOutputFileNameTemplate(template, fallback);
  assertSupportedOutputTokens(normalizedTemplate);

  const rendered = normalizedTemplate
    .replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, rawToken) =>
      resolveTemplateToken(rawToken, variables)
    )
    .replace(/[/\\]+/g, ' ')
    .replace(/\.(pdf|docx)$/i, '');

  const sanitized = sanitizeFileNameStem(rendered);
  if (sanitized) {
    return sanitized;
  }

  if (normalizedTemplate === fallback) {
    return 'document';
  }

  return renderOutputFileNameTemplate(fallback, variables, fallback);
}

export function renderOutputFolderNameTemplate(
  template: string,
  variables: OutputTemplateVariables,
  fallback: string
): string {
  const normalizedTemplate = normalizeOutputFolderNameTemplate(template, fallback);
  assertSupportedOutputTokens(normalizedTemplate, COMPANY_FOLDER_TOKEN_ALIASES);

  const rendered = normalizedTemplate.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, rawToken) =>
    resolveTemplateToken(rawToken, variables, COMPANY_FOLDER_TOKEN_ALIASES)
  );

  const sanitized = sanitizePathSegment(rendered);
  if (sanitized) {
    return sanitized;
  }

  if (normalizedTemplate === fallback) {
    return 'unknown';
  }

  return renderOutputFolderNameTemplate(fallback, variables, fallback);
}

export function buildOutputPathPreview(template: string): string {
  return `/${renderOutputPathTemplate(template, {
    date: '2026-04-10',
    profileName: 'Jane Doe',
    companyName: 'Acme Inc',
    rowNumber: '12',
    jobTitle: 'Senior Engineer',
  })}`;
}

export function outputPathTemplateUsesJobTitle(template: string): boolean {
  return /\{\{\s*(job title|role)\s*\}\}/i.test(normalizeOutputPathTemplate(template));
}

export function resolveStoredFilePath(baseDir: string, relativePathValue: string): string | null {
  const normalizedBaseDir = path.resolve(baseDir);
  const normalizedRelativePath = relativePathValue
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);

  if (normalizedRelativePath.length === 0) {
    return null;
  }

  const resolvedPath = path.resolve(normalizedBaseDir, ...normalizedRelativePath);
  if (resolvedPath !== normalizedBaseDir && !resolvedPath.startsWith(`${normalizedBaseDir}${path.sep}`)) {
    return null;
  }

  return resolvedPath;
}
