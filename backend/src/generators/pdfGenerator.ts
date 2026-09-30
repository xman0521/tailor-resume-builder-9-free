import type { Browser } from 'puppeteer';
import { browserProfileDir, launchBrowser } from '../config/browser';
import Handlebars from 'handlebars';
import fs from 'fs/promises';
import path from 'path';
import {
  Profile,
  type SkillCategoryGroup as ProfileSkillCategoryGroup,
  type TechnicalSkillsLayout,
} from '../types/profile';
import { getProfileTechnicalSkillsLayout } from '../services/profileService';
import { isConceptSkill } from '../services/utils/hardSkillSelection';
import { TailoredContent, Template } from '../types/template';
import type { GeneratedPathInfo } from '../utils/generatedPath';
import { getGeneratedFilePath, getResumeOutputFilename } from '../utils/generatedPath';
import { withRenderPermit } from './renderConcurrency';
import {
  HARD_SKILL_CATEGORIES,
  HardSkillCategory,
  readHardSkillPriorityMap,
  readHardSkillRecords,
  readSkills,
} from '../database/skillsDatabase';
const MAX_ROLE_BRIEF_LENGTH = 1200;
/** CSS absolute length units expressed in px at 96 DPI. */
const CSS_LENGTH_PX: Record<string, number> = {
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  pt: 96 / 72,
  pc: 16,
};

/** Named `@page size` keywords, in px at 96 DPI. */
const PAGE_SIZE_PX: Record<string, { width: number; height: number }> = {
  a3: { width: 1123, height: 1587 },
  a4: { width: 794, height: 1123 },
  a5: { width: 559, height: 794 },
  letter: { width: 816, height: 1056 },
  legal: { width: 816, height: 1344 },
  tabloid: { width: 1056, height: 1632 },
  ledger: { width: 1632, height: 1056 },
};

const A4_PAGE_WIDTH_PX = PAGE_SIZE_PX.a4.width;
const A4_PAGE_HEIGHT_PX = PAGE_SIZE_PX.a4.height;

/**
 * The page box used when a template does not say otherwise.
 *
 * `format` and `margin` are what `page.pdf()` is called with. Note that the
 * margin here is a FALLBACK, not a guarantee: Chrome honours a template's own
 * `@page { margin }` and ignores the value passed to `page.pdf()`. That is
 * measurable - print the same markup with and without an `@page` rule and the
 * ink starts 34px in rather than 48px in - and every built-in template declares
 * one, so this margin only ever applies to a template that has no `@page` rule
 * at all. Use `resolveTemplatePageBox` to learn the box a given template will
 * actually be printed into; the preview is built from that, which is the whole
 * reason a preview resembles the PDF it is previewing.
 */
export const RESUME_PAGE_GEOMETRY = {
  format: 'A4',
  margin: { top: '0.4in', right: '0.5in', bottom: '0.3in', left: '0.5in' },
  pageWidthPx: A4_PAGE_WIDTH_PX,
  pageHeightPx: A4_PAGE_HEIGHT_PX,
  contentWidthPx: A4_PAGE_WIDTH_PX - 96, // 0.5in either side
  contentHeightPx: A4_PAGE_HEIGHT_PX - 38.4 - 28.8, // 0.4in top, 0.3in bottom
} as const;

export interface ResumePageBox {
  /** The page Chrome lays the document out on, per its `@page size`. */
  pageWidthPx: number;
  pageHeightPx: number;
  /** Page margins, as CSS lengths, per its `@page margin`. */
  margin: { top: string; right: string; bottom: string; left: string };
  /** The area content is laid out into: page minus margins. */
  contentWidthPx: number;
  contentHeightPx: number;
  /**
   * `page.pdf()` is always asked for A4, so a document that declares a
   * different `@page size` is laid out at that size and then scaled to fit the
   * A4 media box, centred. 1 and 0 when the sizes already agree.
   */
  mediaScale: number;
  mediaOffsetYPx: number;
  /** True when the CSS uses viewport units, whose basis differs off-page. */
  usesViewportUnits: boolean;
}

function parseCssLengthPx(value: string): number | null {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z]*)$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const factor = CSS_LENGTH_PX[(match[2] || 'px').toLowerCase()];
  return factor === undefined ? null : amount * factor;
}

/**
 * The declarations of every `@page` rule in `css`, concatenated in source
 * order so that later rules win, with nested at-rules (`@top-center` and
 * friends) dropped.
 */
function collectAtPageDeclarations(css: string): string[] {
  const declarations: string[] = [];
  const ruleStart = /@page\b[^{]*\{/gi;
  let match: RegExpExecArray | null;

  while ((match = ruleStart.exec(css)) !== null) {
    let cursor = ruleStart.lastIndex;
    let depth = 1;
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === '{') depth += 1;
      else if (css[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    const body = css.slice(ruleStart.lastIndex, Math.max(cursor - 1, ruleStart.lastIndex));
    declarations.push(body.replace(/[^;{}]*\{[^{}]*\}/g, ''));
    ruleStart.lastIndex = cursor;
  }

  return declarations
    .join(';')
    .split(';')
    .map((declaration) => declaration.trim())
    .filter(Boolean);
}

function expandMarginShorthand(value: string): string[] | null {
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 4) return null;
  const [top, right = top, bottom = top, left = right] = parts;
  return [top, right, bottom, left];
}

function applyPageSize(
  value: string,
  fallback: { width: number; height: number }
): { width: number; height: number } {
  const tokens = value.toLowerCase().split(/\s+/).filter(Boolean);
  let size = fallback;
  let orientation: 'portrait' | 'landscape' | null = null;
  const lengths: number[] = [];

  for (const token of tokens) {
    if (token === 'auto') continue;
    if (token === 'portrait' || token === 'landscape') {
      orientation = token;
      continue;
    }
    if (PAGE_SIZE_PX[token]) {
      size = PAGE_SIZE_PX[token];
      continue;
    }
    const length = parseCssLengthPx(token);
    if (length !== null && length > 0) lengths.push(length);
  }

  if (lengths.length === 1) size = { width: lengths[0], height: lengths[0] };
  else if (lengths.length >= 2) size = { width: lengths[0], height: lengths[1] };

  if (orientation === 'landscape' && size.height > size.width) {
    size = { width: size.height, height: size.width };
  } else if (orientation === 'portrait' && size.width > size.height) {
    size = { width: size.height, height: size.width };
  }

  return size;
}

/**
 * The page box `page.pdf()` will actually print `template` into.
 *
 * Read from the template's own `@page` rule, because that is what Chrome
 * obeys - the margin handed to `page.pdf()` applies only in its absence.
 */
export function resolveTemplatePageBox(template: Template): ResumePageBox {
  const css = `${template.cssContent ?? ''}\n${template.htmlContent ?? ''}`;
  const fallback = RESUME_PAGE_GEOMETRY.margin;
  const margin: ResumePageBox['margin'] = { ...fallback };
  let size = { width: RESUME_PAGE_GEOMETRY.pageWidthPx, height: RESUME_PAGE_GEOMETRY.pageHeightPx };

  for (const declaration of collectAtPageDeclarations(css)) {
    const separator = declaration.indexOf(':');
    if (separator === -1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (!value) continue;

    if (property === 'size') {
      size = applyPageSize(value, size);
    } else if (property === 'margin') {
      const sides = expandMarginShorthand(value);
      if (sides) [margin.top, margin.right, margin.bottom, margin.left] = sides;
    } else if (property === 'margin-top') margin.top = value;
    else if (property === 'margin-right') margin.right = value;
    else if (property === 'margin-bottom') margin.bottom = value;
    else if (property === 'margin-left') margin.left = value;
  }

  const px = (value: string, fallbackValue: string) =>
    parseCssLengthPx(value) ?? parseCssLengthPx(fallbackValue) ?? 0;
  const marginPx = {
    top: px(margin.top, fallback.top),
    right: px(margin.right, fallback.right),
    bottom: px(margin.bottom, fallback.bottom),
    left: px(margin.left, fallback.left),
  };

  const mediaScale = Math.min(
    1,
    A4_PAGE_WIDTH_PX / size.width,
    A4_PAGE_HEIGHT_PX / size.height
  );

  return {
    pageWidthPx: size.width,
    pageHeightPx: size.height,
    margin,
    contentWidthPx: Math.max(1, size.width - marginPx.left - marginPx.right),
    contentHeightPx: Math.max(1, size.height - marginPx.top - marginPx.bottom),
    mediaScale,
    mediaOffsetYPx: (A4_PAGE_HEIGHT_PX - size.height * mediaScale) / 2,
    usesViewportUnits: /\b\d*\.?\d+(vh|vw|vmin|vmax)\b/i.test(css),
  };
}
const LANGUAGE_SKILLS = new Set([
  'python',
  'javascript',
  'typescript',
  'java',
  'go',
  'golang',
  'rust',
  'ruby',
  'php',
  'c++',
  'c#',
  'kotlin',
  'swift',
  'scala',
  'sql',
  'html',
  'css',
  'elixir',
  'bash',
]);
const FRAMEWORK_SKILLS = new Set([
  'react',
  'react.js',
  'reactjs',
  'next',
  'next.js',
  'nextjs',
  'node',
  'node.js',
  'nodejs',
  'vue',
  'vue.js',
  'vuejs',
  'express',
  'express.js',
  'expressjs',
  'angular',
  'angular.js',
  'angularjs',
  'nest',
  'nestjs',
  'nest.js',
  'nuxt',
  'nuxt.js',
  'nuxtjs',
  'django',
  'flask',
  'fastapi',
  'fastify',
  'laravel',
  'rails',
  'spring',
  'spring boot',
  'springboot',
  'tensorflow',
  'pytorch',
  'torch',
  'keras',
  'scikit-learn',
  'sklearn',
  'pandas',
  'numpy',
  'redux',
  'react router',
  'tailwind',
  'tailwindcss',
  'mui',
  'material ui',
  'sass',
  'scss',
  'svelte',
  'svelte.js',
  'sveltejs',
  'ember',
  'ember.js',
  'emberjs',
  'jquery',
  'jquery.js',
  'jqueryjs',
  'bootstrap',
  'graphql',
  'swr',
  'flutter',
  'react native',
  'reactnative',
  '.net',
  'dotnet',
  'asp.net',
  'aspnet',
]);
const OTHER_TECH_SKILLS = new Set([
  'docker',
  'kubernetes',
  'k8s',
  'kube',
  'aws',
  'gcp',
  'azure',
  'git',
  'nginx',
  'redis',
  'celery',
  'postgres',
  'postgresql',
  'psql',
  'mongo',
  'mongodb',
  'mysql',
  'nosql',
  'openapi',
  'restful api',
  'rest api',
  'rest',
  'jwt',
  'oauth',
  'jest',
  'mocha',
  'chai',
  'ci/cd',
  'github actions',
  'gitlab ci',
  'vercel',
  'netlify',
  'figma',
  'sketch',
  'unix/linux',
  'linux',
  'rdbms/sql',
  'rdbms',
  'webpack',
  'vite',
  'gatsby',
  'eslint',
  'openai api',
  'llm',
  'terraform',
  'ansible',
  'jenkins',
  'kafka',
  'rabbitmq',
  'airflow',
  'dbt',
  'snowflake',
  'dynamodb',
]);

type SkillCategory = HardSkillCategory;

/**
 * One rendered heading and the skills under it.
 *
 * `category` is a plain string, not the library's closed set: a profile may
 * carry headings its author invented, and the flat layout carries the empty
 * string - which is not a missing heading but the statement that there is none.
 */
type SkillCategoryGroup = {
  category: string;
  skills: string[];
};

const SKILL_CATEGORY_ORDER: SkillCategory[] = [...HARD_SKILL_CATEGORIES];
const SKILL_CATEGORY_LANGUAGE_CATEGORY: SkillCategory = 'Languages';
const SKILL_CATEGORY_MIN_LANGUAGE_SKILLS = 3;
const SKILL_CATEGORY_MAX_LANGUAGE_SKILLS = 5;
const SKILL_CATEGORY_MIN_SKILLS_PER_CATEGORY = 5;
const SKILL_CATEGORY_MAX_SKILLS_PER_CATEGORY = 10;
const SKILL_CATEGORY_MIN_CATEGORY_COUNT = 5;
const SKILL_CATEGORY_LANGUAGE_FILL_EXCLUDED_SKILLS = new Set(['bash', 'c#', 'html', 'css']);

function formatDuration(start: bigint, end: bigint): string {
  return `${(Number(end - start) / 1_000_000_000).toFixed(2)}s`;
}

async function timePdfStage<T>(label: string, action: () => Promise<T>): Promise<T> {
  const startedAt = process.hrtime.bigint();
  try {
    return await action();
  } finally {
    console.log(`[Resume timing] PDF ${label} finished in ${formatDuration(startedAt, process.hrtime.bigint())}`);
  }
}

function timePdfStageSync<T>(label: string, action: () => T): T {
  const startedAt = process.hrtime.bigint();
  try {
    return action();
  } finally {
    console.log(`[Resume timing] PDF ${label} finished in ${formatDuration(startedAt, process.hrtime.bigint())}`);
  }
}

let sharedPdfBrowser: Browser | null = null;
let sharedPdfBrowserLaunch: Promise<Browser> | null = null;
const PDF_BROWSER_USER_DATA_DIR = browserProfileDir('pdf-chrome');

async function getSharedPdfBrowser(): Promise<Browser> {
  if (sharedPdfBrowser?.connected) {
    return sharedPdfBrowser;
  }
  if (sharedPdfBrowserLaunch) {
    return sharedPdfBrowserLaunch;
  }

  sharedPdfBrowserLaunch = launchBrowser({
    userDataDir: PDF_BROWSER_USER_DATA_DIR,
    args: ['--disable-features=FirstPartySets'],
  }).then((browser) => {
    sharedPdfBrowser = browser;
    sharedPdfBrowserLaunch = null;
    browser.once('disconnected', () => {
      if (sharedPdfBrowser === browser) {
        sharedPdfBrowser = null;
      }
    });
    return browser;
  }).catch((error) => {
    sharedPdfBrowserLaunch = null;
    throw error;
  });

  return sharedPdfBrowserLaunch;
}

const SKILL_CATEGORY_LANGUAGE_SKILLS = new Set([
  ...LANGUAGE_SKILLS,
  'dart',
  'perl',
  'r',
  'r language',
  'matlab',
  'lua',
  'groovy',
  'shell',
  'powershell',
  'objective-c',
  'html5',
  'css3',
]);

const SKILL_CATEGORY_FRAMEWORK_SKILLS = new Set([
  ...FRAMEWORK_SKILLS,
  'babel',
  'chakra ui',
  'cypress',
  'emotion',
  'gatsby',
  'junit',
  'langchain',
  'llamaindex',
  'playwright',
  'prettier',
  'pytest',
  'selenium',
  'styled-components',
  'testng',
  'css modules',
  'asp.net',
  'asp.net core',
  'codeigniter',
  'django rest framework',
  'echo',
  'fastify',
  'gin',
  'grpc',
  'koa',
  'ktor',
  'spring framework',
  'spring mvc',
  'spring security',
  'swiftui',
]);

const SKILL_CATEGORY_INFRASTRUCTURE_SKILLS = new Set([
  'amazon web services',
  'ansible',
  'api gateway',
  'argocd',
  'autoscaling',
  'auto scaling',
  'aws',
  'azure',
  'chef',
  'cloud',
  'cloudfront',
  'cloudwatch',
  'datadog',
  'deployment',
  'docker',
  'ec2',
  'ecs',
  'eks',
  'elk',
  'fargate',
  'flux',
  'gcp',
  'google cloud',
  'grafana',
  'helm',
  'iac',
  'iam',
  'infrastructure',
  'istio',
  'jenkins',
  'k8s',
  'kube',
  'kubernetes',
  'lambda',
  'linkerd',
  'linux',
  'load balanc',
  'netlify',
  'network',
  'new relic',
  'nginx',
  'openshift',
  'prometheus',
  'puppet',
  'route 53',
  's3',
  'terraform',
  'unix/linux',
  'vpc',
  'vercel',
]);

const SKILL_CATEGORY_DATABASE_SKILLS = new Set([
  'activerecord',
  'cassandra',
  'couchdb',
  'database',
  'databases',
  'data lake',
  'dynamodb',
  'elasticsearch',
  'etl',
  'firestore',
  'influxdb',
  'memcached',
  'mongo',
  'mongodb',
  'mongoose',
  'mysql',
  'neo4j',
  'nosql',
  'oracle',
  'orm',
  'postgres',
  'postgresql',
  'prisma',
  'psql',
  'query',
  'rdbms',
  'rdbms/sql',
  'redis',
  'replication',
  'schema',
  'sequelize',
  'shard',
  'snowflake',
  'solr',
  'sql server',
  'sqlalchemy',
  'timescaledb',
  'typeorm',
  'warehouse',
]);

const SKILL_CATEGORY_TOOL_PRACTICE_SKILLS = new Set([
  ...OTHER_TECH_SKILLS,
  'airflow',
  'api',
  'ci',
  'dbt',
  'eslint',
  'figma',
  'git',
  'github',
  'github actions',
  'gitlab',
  'gitlab ci',
  'jira',
  'jwt',
  'oauth',
  'openai api',
  'openapi',
  'rabbitmq',
  'kafka',
  'rest',
  'rest api',
  'restful api',
  'sketch',
  'tdd',
]);

const SKILL_CATEGORY_CATEGORY_FALLBACK_SKILLS: Record<SkillCategory, string[]> = {
  Languages: ['Python', 'Java', 'JavaScript', 'TypeScript', 'Go', 'Ruby', 'PHP', 'SQL', 'Swift', 'Kotlin', 'Rust'],
  'Frameworks and Libraries': [
    'React',
    'Vue',
    'Django',
    'Flask',
    'Spring Boot',
    'Node.js',
    'Next.js',
    'Express',
    'Redux',
    'GraphQL',
  ],
  'Software Architecture & Design': ['Microservices', 'System Design', 'Distributed Systems', 'Caching', 'Design Patterns'],
  Security: ['OAuth', 'JWT', 'SAML', 'AWS IAM', 'API Security'],
  'Cloud and Infrastructure': [
    'AWS',
    'Docker',
    'Kubernetes',
    'Terraform',
    'Azure',
    'GCP',
    'Linux',
    'GitHub Actions',
    'Jenkins',
  ],
  'Databases and Storage': ['PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'DynamoDB', 'Elasticsearch', 'Snowflake'],
  'DevOps and CI/CD': ['GitHub Actions', 'Jenkins', 'CI/CD', 'Docker', 'Kubernetes', 'Terraform', 'ArgoCD'],
  'Observability and Monitoring': ['Grafana', 'Prometheus', 'Datadog', 'CloudWatch', 'New Relic', 'ELK Stack'],
  'Testing and Quality': ['Jest', 'Pytest', 'Cypress', 'Playwright', 'Selenium', 'JUnit', 'TestNG'],
  'APIs and Integration': ['REST API', 'GraphQL', 'OpenAPI', 'OAuth', 'JWT', 'Kafka', 'RabbitMQ'],
  'Engineering Practices & Methodology': ['Agile', 'Scrum', 'Kanban', 'Technical Documentation', 'Pair Programming'],
  'Data Engineering & Streaming': ['Kafka', 'RabbitMQ', 'Amazon Kinesis', 'Apache Kafka', 'ETL Pipelines'],
  'AI/ML & Data Science': ['PyTorch', 'TensorFlow', 'scikit-learn', 'Pandas', 'NumPy'],
  'Version Control & Collaboration': ['Git', 'GitHub', 'GitLab', 'Bitbucket', 'Code Review'],
  'Operating Systems & Platforms': ['Linux', 'Unix/Linux', 'Nginx', 'Windows', 'Network Security'],
  'Frontend & UI/UX Development': ['Tailwind CSS', 'CSS Grid', 'CSS Modules', 'Figma', 'Responsive Design'],
  'Mobile Development': ['React Native', 'Flutter', 'iOS', 'Android', 'SwiftUI'],
};

const SKILL_CATEGORY_LANGUAGE_FRAMEWORK_SKILLS: Array<{ languages: string[]; frameworks: string[] }> = [
  {
    languages: ['javascript', 'typescript'],
    frameworks: ['React', 'Node.js', 'Next.js', 'Express', 'Vue.js', 'Angular', 'NestJS', 'Fastify'],
  },
  {
    languages: ['php'],
    frameworks: ['Laravel', 'Symfony', 'CodeIgniter'],
  },
  {
    languages: ['python'],
    frameworks: ['Django', 'FastAPI', 'Flask', 'Django REST Framework', 'Pandas', 'NumPy'],
  },
  {
    languages: ['java'],
    frameworks: ['Spring Boot', 'Spring MVC', 'Spring Security', 'JUnit', 'TestNG'],
  },
  {
    languages: ['go', 'golang'],
    frameworks: ['Gin', 'Echo', 'gRPC'],
  },
  {
    languages: ['ruby'],
    frameworks: ['Ruby on Rails', 'Rails'],
  },
  {
    languages: ['c#'],
    frameworks: ['ASP.NET Core', 'ASP.NET'],
  },
  {
    languages: ['kotlin'],
    frameworks: ['Ktor', 'Spring Boot'],
  },
  {
    languages: ['swift'],
    frameworks: ['SwiftUI'],
  },
  {
    languages: ['dart'],
    frameworks: ['Flutter'],
  },
];

// Register Handlebars helpers
Handlebars.registerHelper('join', function(array: string[], separator: string) {
  if (!Array.isArray(array)) return '';
  return array.join(separator || ', ');
});

Handlebars.registerHelper('formatDate', function(date: string) {
  return date; // Keep as is for now
});

function normalizeSkills(skills: unknown): string[] {
  if (!Array.isArray(skills)) return [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of skills) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

function trimIncompleteEnd(s: string): string {
  return s.trim().replace(/,+\s*$/, '').replace(/\s+(and|or)\s*$/i, '').trim();
}

function clampRoleBrief(description: string): string {
  const clean = description.trim().replace(/\s+/g, ' ');
  if (clean.length <= MAX_ROLE_BRIEF_LENGTH) return trimIncompleteEnd(clean);
  const truncated = clean.slice(0, MAX_ROLE_BRIEF_LENGTH);
  let result: string;
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('? ')
  );
  if (lastSentenceEnd >= MAX_ROLE_BRIEF_LENGTH - 80) {
    result = truncated.slice(0, lastSentenceEnd + 1).trim();
  } else {
    const lastComma = truncated.lastIndexOf(', ');
    if (lastComma >= MAX_ROLE_BRIEF_LENGTH - 50) {
      result = truncated.slice(0, lastComma).trim();
    } else {
      const lastSpace = truncated.trimEnd().lastIndexOf(' ');
      result = lastSpace > 0 && lastSpace >= MAX_ROLE_BRIEF_LENGTH - 40
        ? truncated.slice(0, lastSpace).trim()
        : truncated.trimEnd();
    }
  }
  return trimIncompleteEnd(result);
}

function normalizeExperienceDescriptions<T extends { experience?: Array<{ description?: string }> }>(data: T): T {
  const experience = Array.isArray(data.experience)
    ? data.experience.map((entry) => ({
      ...entry,
      description: clampRoleBrief(entry.description ?? ''),
    }))
    : data.experience;

  return {
    ...data,
    experience,
  };
}

function normalizeHardSkillAlias(skill: string): string {
  return skill.trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchesSkillTerm(normalizedSkill: string, rawTerm: string): boolean {
  const term = normalizeHardSkillAlias(rawTerm);
  if (!term) return false;
  return normalizedSkill === term
    || normalizedSkill.startsWith(`${term} `)
    || normalizedSkill.startsWith(`${term}-`)
    || normalizedSkill.startsWith(`${term}/`)
    || normalizedSkill.endsWith(` ${term}`)
    || normalizedSkill.includes(` ${term} `);
}

function matchesAnySkillTerm(normalizedSkill: string, terms: Iterable<string>): boolean {
  for (const term of terms) {
    if (matchesSkillTerm(normalizedSkill, term)) return true;
  }
  return false;
}

function getSkillCategory(skill: string): SkillCategory {
  const normalized = normalizeHardSkillAlias(skill);
  if (!normalized) return 'Frameworks and Libraries';

  const libraryRecord = readHardSkillRecords().find((record) => normalizeHardSkillAlias(record.skill) === normalized);
  if (libraryRecord) return libraryRecord.category;

  if (matchesAnySkillTerm(normalized, SKILL_CATEGORY_DATABASE_SKILLS)) {
    return 'Databases and Storage';
  }
  if (matchesAnySkillTerm(normalized, SKILL_CATEGORY_INFRASTRUCTURE_SKILLS)) {
    return 'Cloud and Infrastructure';
  }
  if (matchesAnySkillTerm(normalized, SKILL_CATEGORY_FRAMEWORK_SKILLS)) {
    return 'Frameworks and Libraries';
  }
  if (matchesAnySkillTerm(normalized, SKILL_CATEGORY_LANGUAGE_SKILLS)) {
    return SKILL_CATEGORY_LANGUAGE_CATEGORY;
  }
  if (matchesAnySkillTerm(normalized, SKILL_CATEGORY_TOOL_PRACTICE_SKILLS)) {
    return 'APIs and Integration';
  }

  return 'Frameworks and Libraries';
}

function getLibraryHardSkillRecord(skill: string): ReturnType<typeof readHardSkillRecords>[number] | undefined {
  const normalized = normalizeHardSkillAlias(skill);
  if (!normalized) return undefined;
  return readHardSkillRecords().find((record) => normalizeHardSkillAlias(record.skill) === normalized);
}

function normalizeLibraryHardSkills(skills: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const skill of normalizeSkills(skills)) {
    const record = getLibraryHardSkillRecord(skill);
    if (!record) continue;
    const key = normalizeHardSkillAlias(record.skill);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(record.skill);
  }

  return result;
}

function getRelatedFrameworkSkillsForLanguages(languageSkills: string[]): string[] {
  const related: string[] = [];
  const seen = new Set<string>();
  const normalizedLanguages = languageSkills.map(normalizeHardSkillAlias);

  for (const language of normalizedLanguages) {
    const rule = SKILL_CATEGORY_LANGUAGE_FRAMEWORK_SKILLS.find((candidateRule) =>
      candidateRule.languages.some((candidate) => matchesSkillTerm(language, candidate))
    );
    if (!rule) continue;

    for (const framework of rule.frameworks) {
      const key = normalizeHardSkillAlias(framework);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      related.push(framework);
    }
  }

  return related;
}

function prioritizeRelatedFrameworkCandidates(
  languageSkills: string[],
  frameworkCandidates: string[],
  used: Set<string>
): string[] {
  const existingByKey = new Map(
    frameworkCandidates.map((skill) => [normalizeHardSkillAlias(skill), skill] as const)
  );
  const prioritized: string[] = [];
  const prioritizedKeys = new Set<string>();

  for (const skill of getRelatedFrameworkSkillsForLanguages(languageSkills)) {
    const key = normalizeHardSkillAlias(skill);
    if (!key || used.has(key) || prioritizedKeys.has(key)) continue;
    prioritizedKeys.add(key);
    prioritized.push(existingByKey.get(key) ?? skill);
  }

  return [
    ...prioritized,
    ...frameworkCandidates.filter((skill) => !prioritizedKeys.has(normalizeHardSkillAlias(skill))),
  ];
}

type SkillCategoryBuildOptions = {
  forceAllCategories?: boolean;
  relateFrameworksToLanguages?: boolean;
};

function buildSkillCategories(
  skills: string[],
  supplementalSkills: string[] = [],
  options: SkillCategoryBuildOptions = {}
): SkillCategoryGroup[] {
  const grouped = new Map<SkillCategory, string[]>(
    SKILL_CATEGORY_ORDER.map((category) => [category, []])
  );
  const used = new Set<string>();

  for (const skill of normalizeLibraryHardSkills(skills)) {
    const key = normalizeHardSkillAlias(skill);
    if (used.has(key)) continue;
    used.add(key);
    grouped.get(getSkillCategory(skill))?.push(skill);
  }

  const candidateByCategory = new Map<SkillCategory, string[]>(
    SKILL_CATEGORY_ORDER.map((category) => [category, []])
  );
  const candidateSeen = new Set<string>();

  const addFillCandidate = (skill: string) => {
    const record = getLibraryHardSkillRecord(skill);
    if (!record) return;
    const key = normalizeHardSkillAlias(record.skill);
    if (!key || used.has(key) || candidateSeen.has(key)) return;
    candidateSeen.add(key);
    candidateByCategory.get(record.category)?.push(record.skill);
  };

  for (const skill of sortHardSkillsByPriority(supplementalSkills)) {
    addFillCandidate(skill);
  }

  for (const category of SKILL_CATEGORY_ORDER) {
    for (const skill of SKILL_CATEGORY_CATEGORY_FALLBACK_SKILLS[category]) {
      if (getSkillCategory(skill) === category) {
        addFillCandidate(skill);
      }
    }
  }

  for (const skill of sortHardSkillsByPriority(readSkills('hard'))) {
    addFillCandidate(skill);
  }

  const includedCategories = new Set<SkillCategory>([SKILL_CATEGORY_LANGUAGE_CATEGORY]);
  for (const category of SKILL_CATEGORY_ORDER) {
    if (category !== SKILL_CATEGORY_LANGUAGE_CATEGORY && (grouped.get(category)?.length ?? 0) > 0) {
      includedCategories.add(category);
    }
  }

  if (includedCategories.size === 1 && options.forceAllCategories) {
    includedCategories.add('Frameworks and Libraries');
    includedCategories.add('Cloud and Infrastructure');
  }

  if (options.forceAllCategories) {
    for (const category of SKILL_CATEGORY_ORDER) {
      if (includedCategories.size >= SKILL_CATEGORY_MIN_CATEGORY_COUNT) break;
      if (category !== SKILL_CATEGORY_LANGUAGE_CATEGORY) {
        includedCategories.add(category);
      }
    }
  }

  for (const category of SKILL_CATEGORY_ORDER) {
    if (!includedCategories.has(category)) continue;
    const categorySkills = grouped.get(category) ?? [];
    if (category === SKILL_CATEGORY_LANGUAGE_CATEGORY) {
      for (const skill of candidateByCategory.get(category) ?? []) {
        const targetCount = options.forceAllCategories
          ? SKILL_CATEGORY_MIN_LANGUAGE_SKILLS
          : SKILL_CATEGORY_MAX_LANGUAGE_SKILLS;
        if (categorySkills.length >= targetCount) break;
        const key = normalizeHardSkillAlias(skill);
        if (SKILL_CATEGORY_LANGUAGE_FILL_EXCLUDED_SKILLS.has(key)) continue;
        if (used.has(key)) continue;
        used.add(key);
        categorySkills.push(skill);
      }

      if (!options.forceAllCategories) {
        categorySkills.splice(SKILL_CATEGORY_MAX_LANGUAGE_SKILLS);
      }
      if (options.relateFrameworksToLanguages) {
        candidateByCategory.set(
          'Frameworks and Libraries',
          prioritizeRelatedFrameworkCandidates(
            categorySkills,
            candidateByCategory.get('Frameworks and Libraries') ?? [],
            used
          )
        );
      }
      continue;
    }

    if (
      categorySkills.length >= SKILL_CATEGORY_MIN_SKILLS_PER_CATEGORY ||
      (!options.forceAllCategories && categorySkills.length === 0)
    ) {
      continue;
    }

    for (const skill of candidateByCategory.get(category) ?? []) {
      if (categorySkills.length >= SKILL_CATEGORY_MIN_SKILLS_PER_CATEGORY) break;
      const key = normalizeHardSkillAlias(skill);
      if (used.has(key)) continue;
      used.add(key);
      categorySkills.push(skill);
    }
  }

  return SKILL_CATEGORY_ORDER
    .filter((category) => includedCategories.has(category))
    .map((category) => ({
      category,
      skills: grouped.get(category) ?? [],
    }))
    .filter((group) => group.skills.length > 0);
}

function passesPromptHardSkillGate(skill: string): boolean {
  const normalized = normalizeHardSkillAlias(skill);
  if (!normalized) return false;

  // Delegated to the shared test rather than kept as a list here. This used to
  // be fifteen hand-written names, which let everything else the library files
  // as an idea - "Distributed Systems", "Event-driven architecture", "Test
  // Automation" - onto the resume as though it were a tool.
  return !isConceptSkill(normalized);
}

function enforcePromptSkillCategoryCounts(
  skills: string[],
  supplementalSkills: string[] = []
): SkillCategoryGroup[] {
  const promptHardSkills = normalizeSkills(skills).filter(passesPromptHardSkillGate);
  const promptSupplementalSkills = normalizeSkills(supplementalSkills).filter(passesPromptHardSkillGate);
  const groups = buildSkillCategories(promptHardSkills, promptSupplementalSkills, {
    forceAllCategories: true,
    relateFrameworksToLanguages: true,
  });

  return groups.map((group) => ({
    ...group,
    skills: group.skills.slice(
      0,
      group.category === SKILL_CATEGORY_LANGUAGE_CATEGORY ? SKILL_CATEGORY_MAX_LANGUAGE_SKILLS : SKILL_CATEGORY_MAX_SKILLS_PER_CATEGORY
    ),
  }));
}

const ALLOWED_TECH_SKILLS = new Set<string>();
let hardSkillPriorityMap = readHardSkillPriorityMap();

function loadAllowedTechSkills() {
  ALLOWED_TECH_SKILLS.clear();
  for (const skill of readSkills('hard')) {
    ALLOWED_TECH_SKILLS.add(normalizeHardSkillAlias(skill));
  }
  hardSkillPriorityMap = readHardSkillPriorityMap();
}

loadAllowedTechSkills();

export function refreshAllowedTechSkills() {
  loadAllowedTechSkills();
}


function sortHardSkillsByPriority(skills: string[]): string[] {
  return [...normalizeSkills(skills)].sort((a, b) => {
    const aPriority = hardSkillPriorityMap.get(normalizeHardSkillAlias(a)) ?? Number.MAX_SAFE_INTEGER;
    const bPriority = hardSkillPriorityMap.get(normalizeHardSkillAlias(b)) ?? Number.MAX_SAFE_INTEGER;

    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }

    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });
}

type SkillsData = {
  /** The model's own grouping, printed as given. See `TailoredContent`. */
  aiSkillGroups?: SkillCategoryGroup[];
  hardSkills?: string[];
  softSkills?: string[];
  skills?: string[];
  skillInventory?: string[];
  /** The author's own grouping, when the profile carries one. */
  skillCategories?: ProfileSkillCategoryGroup[];
  profileSettings?: Profile['profileSettings'];
};

/**
 * The flat layout, as one group with no heading.
 *
 * One group rather than none, so every renderer keeps the single loop it
 * already has. A template written against `skillCategories` renders the flat
 * layout correctly without knowing the option exists, provided it guards its
 * heading with `{{#if category}}` - which `normalizeTemplateSkillsSections`
 * arranges for every template, uploaded ones included.
 */
function flattenSkillCategories(skills: string[]): SkillCategoryGroup[] {
  return skills.length > 0 ? [{ category: '', skills }] : [];
}

/**
 * Groups the SELECTED skills using the author's own categories.
 *
 * The author's grouping covers their whole profile; what reaches here is the
 * subset this job called for. So the profile is read as a MAP from skill to
 * heading rather than as the finished block - grouping the whole profile would
 * put back every skill the tailoring step deliberately left out.
 *
 * A selected skill the author never placed still has to appear, so it falls
 * back to the library's inference for its heading. That heading joins the
 * author's order at the end if it is new, and merges into theirs if they
 * already have one by that name.
 */
function buildAuthoredSkillCategories(
  selected: string[],
  authored: ProfileSkillCategoryGroup[]
): SkillCategoryGroup[] {
  const headingBySkill = new Map<string, string>();
  for (const group of authored) {
    const category = group.category?.trim();
    if (!category) continue;
    for (const skill of group.skills ?? []) {
      const key = normalizeHardSkillAlias(skill);
      if (key && !headingBySkill.has(key)) headingBySkill.set(key, category);
    }
  }

  const order: string[] = [];
  const grouped = new Map<string, string[]>();
  const place = (heading: string, skill: string) => {
    const key = heading.toLowerCase();
    if (!grouped.has(key)) {
      grouped.set(key, []);
      order.push(heading);
    }
    grouped.get(key)!.push(skill);
  };

  // The author's headings lead, in their order, whether or not this job's
  // selection reached them - an empty one is dropped below.
  for (const group of authored) {
    const category = group.category?.trim();
    if (category && !grouped.has(category.toLowerCase())) {
      grouped.set(category.toLowerCase(), []);
      order.push(category);
    }
  }

  const seen = new Set<string>();
  for (const skill of selected) {
    const key = normalizeHardSkillAlias(skill);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    place(headingBySkill.get(key) ?? getSkillCategory(skill), skill);
  }

  return order
    .map((category) => ({ category, skills: grouped.get(category.toLowerCase()) ?? [] }))
    .filter((group) => group.skills.length > 0);
}

/**
 * The Technical Skills block's lines, for templates that render a flat list.
 *
 * Categorized, each line is "Heading: a, b, c" - which is how every template
 * that predates `skillCategories` has always shown them. Flat, each line is one
 * skill, so a template rendering a chip per entry produces a chip per skill
 * rather than one enormous chip holding the whole list behind a stray colon.
 */
function renderSkillLines(groups: SkillCategoryGroup[]): string[] {
  if (groups.length === 1 && !groups[0].category) return [...groups[0].skills];
  return groups.map((group) => `${group.category}: ${group.skills.join(', ')}`);
}

type SkillsLimitedData<T> = T & {
  hardSkills: string[];
  softSkills: string[];
  skills: string[];
  skillCategories: SkillCategoryGroup[];
};

function applySkillsLimit<T extends SkillsData>(data: T): SkillsLimitedData<T> {
  const layout: TechnicalSkillsLayout = getProfileTechnicalSkillsLayout({
    profileSettings: data.profileSettings,
  });
  const authored = (data.skillCategories ?? []).filter(
    (group) => group?.category?.trim() && Array.isArray(group.skills) && group.skills.length > 0
  );

  /*
   * The model's grouping wins outright, and nothing below runs.
   *
   * Every other branch here shapes the block: the flat one filters concepts,
   * the authored one re-groups, the last two pad each heading to a minimum and
   * truncate it to a maximum from the library. That was the right behaviour
   * while code chose the skills. It no longer does - the tailor call returns
   * the finished block - and reshaping it here would be this file overruling
   * the answer it asked for.
   */
  const fromModel = (data.aiSkillGroups ?? []).filter(
    (group) => group?.category?.trim() && Array.isArray(group.skills) && group.skills.length > 0
  );

  const finish = (skillCategories: SkillCategoryGroup[]): SkillsLimitedData<T> => {
    const lines = renderSkillLines(skillCategories);
    return {
      ...data,
      hardSkills: lines,
      // Passed through rather than emptied. This function decides the TECHNICAL
      // Skills block; soft skills are a separate section with a separate list,
      // and blanking them here is what used to leave every Soft Skills heading
      // with nothing under it.
      softSkills: normalizeSkills(data.softSkills ?? []),
      // The same lines under both names, because templates disagree about
      // which one they read and neither is more correct than the other.
      skills: lines,
      strengths: [],
      skillCategories,
    } as SkillsLimitedData<T>;
  };

  if (fromModel.length > 0) return finish(fromModel);

  const hasTailoredHardSkills = Array.isArray(data.hardSkills) && data.hardSkills.length > 0;
  const selected = hasTailoredHardSkills
    ? normalizeSkills(data.hardSkills ?? [])
    : sortHardSkillsByPriority(data.skills ?? []);

  // Flat is decided before any of the category machinery runs, and that is the
  // point of it: the padding rules below exist to make a CATEGORIZED block look
  // right - five per heading, at least five headings - and a list with no
  // headings has no such shape to fill. Running them anyway would pad the list
  // with skills the profile never claimed, to satisfy a layout it is not using.
  if (layout === 'flat') {
    return finish(
      flattenSkillCategories(
        (hasTailoredHardSkills ? selected : normalizeLibraryHardSkills(selected))
          // Applied to both branches. A profile rendered without tailoring gets
          // the same treatment as a tailored one: a concept is not a skill on
          // either of them.
          .filter(passesPromptHardSkillGate)
      )
    );
  }

  // The author's grouping replaces the inference, not the selection. It has no
  // counts to enforce either: the headings are theirs, and padding them to five
  // apiece would put skills under headings they did not choose for them.
  if (authored.length > 0) {
    return finish(
      buildAuthoredSkillCategories(
        hasTailoredHardSkills ? selected.filter(passesPromptHardSkillGate) : selected,
        authored
      )
    );
  }

  if (hasTailoredHardSkills) {
    return finish(enforcePromptSkillCategoryCounts(selected, data.skillInventory));
  }

  return finish(
    buildSkillCategories(selected, data.skillInventory, {
      forceAllCategories: true,
      relateFrameworksToLanguages: true,
    })
  );
}

/**
 * The headline the resume is printed under.
 *
 * The TAILORED title first, which is the whole point of computing one. It
 * carries the discipline the posting is about - "Senior Software Engineer
 * (Integration)" - and this function used to ignore it completely and read
 * ${TICK}profile.title${TICK} instead, so every bit of that work was thrown away between
 * being decided and being printed. Nothing failed; the tag simply never
 * appeared, which is exactly the kind of bug a unit test on the title function
 * cannot see.
 */
function getResumeTitle(profile: Profile, tailoredContent?: TailoredContent): string {
  const tailoredTitle = tailoredContent?.title?.trim();
  if (tailoredTitle) return tailoredTitle;
  const profileTitle = profile.title?.trim();
  if (profileTitle) return profileTitle;
  const lastRole = profile.experience?.[0]?.title?.trim();
  return lastRole || 'Professional';
}

/**
 * Strips the characters a scanner trips over, and keeps the ones a headline
 * legitimately uses.
 *
 * It used to remove parentheses, commas, slashes and hyphens along with
 * everything else, which quietly undid the discipline tag: "Senior Software
 * Engineer (Backend, AI/ML, Cloud)" came out as "Senior Software Engineer
 * Backend AI ML Cloud" - and "Full-Stack" as "Full Stack". Those four are the
 * punctuation an ordinary job title is written with, so they stay.
 *
 * AND SO DO THE PIPE, THE BRACKETS AND THE AMPERSAND, which this used to strip
 * as symbol soup. That was written when the MODEL wrote the headline and the
 * risk was punctuation copied out of a posting. The headline is composed here
 * now - the candidate's own title, a separator, the kind of role - in one of six
 * shapes, and three of them used exactly those characters: a delivered resume
 * read "Senior Software Engineer Full-Stack Engineer" with nothing between the
 * two, because the separator was removed after the line was built. "Data & AI
 * Engineer" as somebody's own profile title lost its ampersand the same way.
 *
 * What still goes: quotes, braces, angle brackets, and the arithmetic and
 * currency symbols nobody writes a job title with.
 */
function sanitizeTitleForATS(title: string): string {
  return title
    .replace(/[;:'"\\@#$%*+=<>{}~^]/g, ' ')
    .replace(/\s+/g, ' ')
    // A space before a closing bracket or a comma is the mark of something
    // having been removed from inside it.
    .replace(/\s+([)\],])/g, '$1')
    .replace(/([([])\s+/g, '$1')
    // An empty pair is what is left when everything inside it was stripped.
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    // A separator with nothing after it, for the same reason.
    .replace(/\s*[|&]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeExternalUrl(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/+/, '')}`;
}

function getExternalUrlDisplay(value: string | undefined): string {
  const normalized = normalizeExternalUrl(value);
  if (!normalized) return '';

  try {
    const url = new URL(normalized);
    const host = url.hostname.replace(/^www\./i, '');
    const path = `${url.pathname}${url.search}${url.hash}`;
    return `${host}${path}`.replace(/\/$/, '');
  } catch {
    return normalized
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/$/, '');
  }
}

function rewriteLinkedInAnchorDisplay(html: string): string {
  return html.replace(
    /<a\b([^>]*)href=(["'])(https?:\/\/(?:www\.)?linkedin\.com\/[^"']+)\2([^>]*)>([^<]*)<\/a>/gi,
    (match, beforeHref, quote, href, afterHref, text) => {
      const trimmedText = String(text ?? '').trim();
      const displayText = getExternalUrlDisplay(href);
      const acceptableCurrentTexts = new Set([
        href,
        href.replace(/^https?:\/\//i, ''),
        href.replace(/^https?:\/\/www\./i, ''),
        displayText,
      ]);

      if (!acceptableCurrentTexts.has(trimmedText)) {
        return match;
      }

      return `<a${beforeHref}href=${quote}${href}${quote}${afterHref}>${displayText}</a>`;
    }
  );
}

function enforceSkillCategoryLineBreaks(html: string): string {
  const categoryPattern = '(Programming &(?:amp;)? Scripting Languages|Languages|Frameworks (?:and|&(?:amp;)?) Libraries|Software Architecture &(?:amp;)? Design|Security|Cloud (?:and|&(?:amp;)?) Infrastructure|Infrastructure &(?:amp;)? Cloud|Databases (?:and|&(?:amp;)?) Storage|DevOps (?:and|&(?:amp;)?) CI/CD|Observability (?:and|&(?:amp;)?) Monitoring|Testing (?:and|&(?:amp;)?) Quality|APIs (?:and|&(?:amp;)?) Integration|Engineering Practices &(?:amp;)? Methodology|Data Engineering &(?:amp;)? Streaming|AI/ML &(?:amp;)? Data Science|Version Control &(?:amp;)? Collaboration|Operating Systems &(?:amp;)? Platforms|Frontend &(?:amp;)? UI/UX Development|Mobile Development|Cloud &(?:amp;)? DevOps|Databases|Tools &(?:amp;)? Practices|Tools|Methods)';
  const categoryTextPattern = new RegExp(
    `<(span|div)\\b([^>]*)>\\s*${categoryPattern}:\\s*([^<]*?)\\s*(?:[•·]|â€¢)?\\s*<\\/\\1>`,
    'gi'
  );

  return html.replace(categoryTextPattern, (_match, _tagName, attributes, category, skills) => {
    const normalizedSkills = String(skills ?? '').trim();
    const rawAttributes = String(attributes ?? '');
    const hasSkillChip = rawAttributes.includes('skill-chip');
    const cleanedAttributes = rawAttributes.replace(/\sclass=(["']).*?\1/i, '');
    const className = hasSkillChip ? 'skill-category skill-chip' : 'skill-category';
    return `<div${cleanedAttributes} class="${className}"><div class="skill-category-title">${category}</div><div class="skill-category-skills">${normalizedSkills}</div></div>`;
  });
}

function stripTemplateSectionByClass(html: string, className: string): string {
  let output = html;
  let searchFrom = 0;

  while (searchFrom < output.length) {
    const classIndex = output.indexOf(className, searchFrom);
    if (classIndex === -1) break;

    const tagStart = output.lastIndexOf('<div', classIndex);
    if (tagStart === -1) {
      searchFrom = classIndex + className.length;
      continue;
    }

    let cursor = tagStart;
    let depth = 0;
    let sectionEnd = -1;
    const tagPattern = /<\/?div\b[^>]*>/gi;
    tagPattern.lastIndex = tagStart;

    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(output)) !== null) {
      const tag = match[0];
      if (tag.startsWith('</')) {
        depth -= 1;
        if (depth === 0) {
          sectionEnd = tagPattern.lastIndex;
          break;
        }
      } else {
        depth += 1;
      }
      cursor = tagPattern.lastIndex;
    }

    if (sectionEnd === -1 || cursor <= tagStart) {
      searchFrom = classIndex + className.length;
      continue;
    }

    const beforeSection = output.slice(0, tagStart);
    const blockPrefixMatch = beforeSection.match(/\s*\{\{#if\s+(?:strengths|softSkills)\.length\}\}\s*$/);
    const blockStart = blockPrefixMatch ? tagStart - blockPrefixMatch[0].length : tagStart;
    const blockSuffixMatch = output.slice(sectionEnd).match(/^\s*\{\{\/if\}\}/);
    const blockEnd = blockSuffixMatch ? sectionEnd + blockSuffixMatch[0].length : sectionEnd;

    output = `${output.slice(0, blockStart)}${output.slice(blockEnd)}`;
    searchFrom = blockStart;
  }

  return output;
}

/**
 * Makes a Soft Skills block disappear when there are no soft skills.
 *
 * Rendering the block means an untailored preview - which has no soft skills,
 * because they are decided per job - would otherwise show a heading with
 * nothing under it. Some templates guard the block themselves; most do not, and
 * a template somebody uploads cannot be asked to.
 *
 * Matched on the class ATTRIBUTE rather than on the text, so the CSS rules that
 * name the same class inside `<style>` are left alone. Idempotent: a block
 * already wrapped in its own `{{#if softSkills.length}}` is skipped rather than
 * wrapped a second time.
 */
function guardSoftSkillsSection(html: string): string {
  const openingTag = /<div\b[^>]*\bclass=(["'])[^"']*\bsection-soft-skills\b[^"']*\1[^>]*>/gi;
  let output = html;
  let searchFrom = 0;

  while (searchFrom < output.length) {
    openingTag.lastIndex = searchFrom;
    const opening = openingTag.exec(output);
    if (!opening) break;

    const tagStart = opening.index;
    let depth = 0;
    let sectionEnd = -1;
    const tagPattern = /<\/?div\b[^>]*>/gi;
    tagPattern.lastIndex = tagStart;

    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(output)) !== null) {
      if (match[0].startsWith('</')) {
        depth -= 1;
        if (depth === 0) {
          sectionEnd = tagPattern.lastIndex;
          break;
        }
      } else {
        depth += 1;
      }
    }

    if (sectionEnd === -1) {
      searchFrom = tagStart + opening[0].length;
      continue;
    }

    if (/\{\{#if\s+softSkills\.length\}\}\s*$/.test(output.slice(0, tagStart))) {
      searchFrom = sectionEnd;
      continue;
    }

    const guarded = `{{#if softSkills.length}}${output.slice(tagStart, sectionEnd)}{{/if}}`;
    output = `${output.slice(0, tagStart)}${guarded}${output.slice(sectionEnd)}`;
    searchFrom = tagStart + guarded.length;
  }

  return output;
}

/**
 * One markup for headings, the template's own for a plain list.
 *
 * The rewrites below turn a loop over SKILLS into a loop over CATEGORIES, which
 * is right when there are categories: five headings, five items, each listing
 * what sits under it. The flat layout is delivered as ONE group with an empty
 * heading - deliberately, so a template keeps its single loop instead of
 * growing a second branch - and the two assumptions collide. The rewritten loop
 * runs once, and every skill lands in a single bullet, box or chip.
 *
 * Measured across the installed templates before this: in the flat layout, NOT
 * ONE of them produced an element per skill. Thirteen produced one bullet
 * holding all twenty, and thirteen more collapsed the same way into a box or a
 * chip - a chip component rendering one chip that reads "Go, Java, JavaScript,
 * Python, ...".
 *
 * So the choice is deferred to render time, where the data is. The template's
 * ORIGINAL markup becomes the flat branch verbatim: in that layout `hardSkills`
 * already holds the individual names, so the loop the author wrote does exactly
 * what they meant it to.
 */
/** The `{{#if}}` that `layoutBranch` opens, so a scan can recognise its own work. */
const LAYOUT_BRANCH_OPENER = '{{#if skillCategories.[0].category}}';

function layoutBranch(originalMarkup: string, groupedMarkup: string): string {
  // `skillCategories.[0].category` is non-empty only in the categorized layout;
  // the flat group's heading is the empty string, which Handlebars reads as
  // false. Nothing has to be passed in for this - the shape already says it.
  return `{{#if skillCategories.[0].category}}${groupedMarkup}{{else}}${originalMarkup}{{/if}}`;
}

/** The grouped block: a heading, then that heading's skills on one line. */
const GROUPED_SKILLS_MARKUP =
  '{{#each skillCategories}}<div class="skill-category">'
  + '<div class="skill-category-title">{{category}}</div>'
  + '<div class="skill-category-skills">{{join skills ", "}}</div>'
  + '</div>{{/each}}';

/**
 * Swaps a template's skills loop for the grouped one, whatever shape it is in.
 *
 * WHY THIS IS A SCANNER AND NOT MORE REGEXES. The rules below it match the
 * exact markup of the shapes that had been seen: a skill-box per entry, a
 * chip per entry, a span with a dot between. Measured across the installed
 * templates after the skills block moved to the model, ELEVEN still rendered
 * flat - all of them the same unseen shape, `{{#each hardSkills}}{{this}}
 * {{#unless @last}}, {{/unless}}{{/each}}`, which turns the grouped lines into
 * one run-on sentence: "Languages: TypeScript, JavaScript, Backend & APIs:
 * Node.js, ...". Adding a twelfth regex would leave a thirteenth shape.
 *
 * So this finds the BLOCK rather than the markup: the `{{#if hardSkills.length}}`
 * that opens it, or a bare `{{#each hardSkills}}`, matched to its own close by
 * counting Handlebars blocks. What it replaces the block with is the same
 * grouped markup the specific rules use, behind the same layout branch, so a
 * profile using the flat layout still renders exactly what its author wrote.
 */
function groupRemainingSkillLoops(html: string): string {
  const OPENERS = ['{{#if hardSkills.length}}', '{{#each hardSkills}}'];
  let output = html;

  for (const opener of OPENERS) {
    // Scanning forward from a cursor, never from the start of the string. The
    // replacement CONTAINS the block it replaced - that is what the flat
    // branch is - so searching from zero finds the same opener again and
    // rewrites it forever. It did: the first run of this never returned.
    let from = 0;
    for (;;) {
      const start = output.indexOf(opener, from);
      if (start === -1) break;

      // Walk forward counting opens and closes, so a nested {{#unless}} or
      // {{#each skills}} inside the block does not end it early.
      let depth = 0;
      let end = -1;
      const tag = /\{\{([#/])[^}]*\}\}/g;
      tag.lastIndex = start;
      let match: RegExpExecArray | null;
      while ((match = tag.exec(output)) !== null) {
        depth += match[1] === '#' ? 1 : -1;
        if (depth === 0) {
          end = match.index + match[0].length;
          break;
        }
      }
      if (end === -1) break;

      const original = output.slice(start, end);
      const branchOpen = output.lastIndexOf(LAYOUT_BRANCH_OPENER, start);
      const insideBranch = branchOpen !== -1 && branchOpen > output.lastIndexOf('{{/if}}', start);

      // Left alone when one of the specific rules already claimed it, and when
      // it is sitting in the flat half of a branch one of them built.
      if (original.includes('skillCategories') || insideBranch) {
        from = start + opener.length;
        continue;
      }

      const replacement = layoutBranch(original, GROUPED_SKILLS_MARKUP);
      output = output.slice(0, start) + replacement + output.slice(end);
      from = start + replacement.length;
    }
  }

  return output;
}

/**
 * Sane defaults for the grouped block, for templates that never had one.
 *
 * Only the two classes the grouped markup introduces, and only properties a
 * template would override if it cared: a template that styles them already
 * wins, because its own stylesheet comes after this one.
 */
/**
 * Six ways to tell a group heading from the skills under it, one per resume.
 *
 * WHY SIX. The first attempt set the heading bold and left everything else
 * alone, and on 24 of the 38 templates that was the ONLY difference - same
 * size, same colour, same case - so the two rows read as one paragraph. The
 * second attempt added caps and letter-spacing, which works, but one look
 * across every resume in a batch is its own tell.
 *
 * WHY THESE SIX. Each separates the rows on a different axis - case, a rule,
 * a bar, tone, indent, or putting them on one line - and each is safe on any
 * template and in either colour scheme: nothing here names a colour, because
 * these templates run from white to dark navy. A mix of `currentColor` with
 * transparent is the strongest thing any of them says - and it is a COLOUR,
 * never `opacity`.
 *
 * WHY NEVER `opacity`. An element with opacity gets its own stacking context,
 * and Chrome paints it after the normal-flow content around it - which
 * reorders the PDF's TEXT STREAM without moving anything on the page.
 * Measured on a finished resume: every group heading printed, then the
 * education section, then all the skill lines, so a parser filing text under
 * the heading above it read the skills as education. Three of the six looks
 * did this. `color-mix` reads the same and paints in place.
 *
 * EVERY look separates the heading from its skills BY COLOUR as well as by
 * whatever else it does: the heading at full strength, the skills a step
 * softer. That is the difference a reader sees first, before they read a
 * word, and it is what the operator asked for.
 *
 * The inline look is the one that needs room, so it asks for it: the block
 * becomes a container, and the one-line form applies only above 320px. In a
 * narrow sidebar it stays stacked rather than wrapping badly.
 */
const SKILL_GROUP_LOOKS: Record<string, string> = {
  // Uppercase, letter-spaced, a size smaller.
  caps:
    '.skill-category-title{font-weight:700;font-size:0.86em;text-transform:uppercase;'
    + 'letter-spacing:0.06em;line-height:1.3;margin:0 0 1px 0}'
    + '.skill-category-skills{font-weight:400;line-height:1.35;margin:0}',

  /*
   * A small square in front of the heading.
   *
   * WHAT THIS REPLACED. It used to be a hairline UNDER the heading, and a
   * border-bottom on a block element runs the whole width of the column - which
   * is exactly what the section heading above it does. On the page "TECHNICAL
   * SKILLS" sat over a full-width rule and so did "LANGUAGES", "BACKEND &
   * RUNTIME" and every other category, so a reader could not tell a category
   * from a section: eight lines that all looked like the start of something.
   *
   * A marker is the same job done at the width of one character. The space
   * after it is a REAL non-breaking space rather than a margin, so the PDF's
   * text stream reads "- LANGUAGES" instead of running the two together.
   */
  marker:
    '.skill-category-title{font-weight:700;font-size:0.9em;text-transform:uppercase;'
    + 'letter-spacing:0.04em;line-height:1.3;margin:0 0 1px 0}'
    + '.skill-category-title::before{content:"\\25aa\\00a0";'
    + 'color:color-mix(in srgb, currentColor 65%, transparent)}'
    + '.skill-category-skills{font-weight:400;line-height:1.35;margin:0}',

  // A bar down the left of the group, with everything indented past it.
  bar:
    '.skill-category{padding-left:7px;border-left:2px solid currentColor}'
    + '.skill-category-title{font-weight:700;font-size:0.92em;letter-spacing:0.02em;margin:0 0 1px 0}'
    + '.skill-category-skills{font-weight:400;line-height:1.35;margin:0;'
    + 'color:color-mix(in srgb, currentColor 80%, transparent)}',

  // Tone rather than weight: the heading at full strength, the skills stepped back.
  muted:
    '.skill-category-title{font-weight:700;font-size:0.95em;margin:0 0 1px 0}'
    + '.skill-category-skills{font-weight:400;font-size:0.92em;line-height:1.35;margin:0;'
    + 'color:color-mix(in srgb, currentColor 72%, transparent)}',

  // The skills hang under the heading, indented.
  hanging:
    '.skill-category-title{font-weight:700;font-size:0.9em;text-transform:uppercase;'
    + 'letter-spacing:0.05em;margin:0}'
    + '.skill-category-skills{font-weight:400;line-height:1.35;margin:0;padding-left:10px}',

  /*
   * The heading on the same line as its skills, with a dot between them.
   *
   * TWO THINGS WENT WRONG HERE, and both are why this is now three plain rules.
   *
   * The first: it asked for `container-type: inline-size` on the group, which
   * makes an element's inline size independent of its contents - so a group
   * that was also a FLEX ITEM contributed no intrinsic width and was sized to
   * ZERO. Nine templates put the skills block in a flex row, and on those the
   * groups printed on top of each other, one word per line.
   *
   * The second was invisible under the first: the one-line form never applied
   * at all. `@container` styles the container's DESCENDANTS, and the rule that
   * turned the group into a row targeted the group itself - which is the
   * container, not a descendant of it. So the query's other rules landed and
   * that one never did, leaving a look that was simply the stacked form with
   * its indent removed.
   *
   * `display:inline` needs neither: the heading and the skills flow as text,
   * they sit on one line when there is room, and they wrap like any other
   * sentence when there is not.
   */
  inline:
    '.skill-category-title{font-weight:700;font-size:0.88em;text-transform:uppercase;'
    + 'letter-spacing:0.05em;display:inline;margin:0}'
    // The spaces are CHARACTERS, not margins: a margin is invisible to the PDF's
    // text stream, so a dot spaced with one reads as "LANGUAGES·Go" and the
    // group's first skill is lost to whatever parses it.
    + '.skill-category-title::after{content:"\\00a0\\00b7\\00a0";'
    + 'color:color-mix(in srgb, currentColor 60%, transparent)}'
    // No indent on this one: the heading is beside the skills rather than above
    // them, and the shared indent would read as a gap after the dot.
    + '.skill-category-skills{font-weight:400;line-height:1.35;display:inline;'
    + 'margin:0;padding-left:0}',
};

export const SKILL_GROUP_LOOK_NAMES = Object.keys(SKILL_GROUP_LOOKS);

/**
 * The look this resume gets: the pinned one, or a random one.
 *
 * Random per DOCUMENT rather than per profile, unlike the cover letters. A
 * cover letter is one person's voice and should look the same each time they
 * apply; a skills block is a table, and a batch of 500 that all shape it the
 * same way is the tell this is meant to avoid.
 */
export function pickSkillGroupLook(env: NodeJS.ProcessEnv = process.env): string {
  const pinned = (env.SKILL_GROUP_STYLE ?? '').trim().toLowerCase();
  if (pinned && SKILL_GROUP_LOOKS[pinned]) return pinned;
  return SKILL_GROUP_LOOK_NAMES[Math.floor(Math.random() * SKILL_GROUP_LOOK_NAMES.length)];
}

function skillGroupCss(look: string): string {
  const rules = SKILL_GROUP_LOOKS[look] ?? SKILL_GROUP_LOOKS.caps;
  return (
    '<style id="resume-skill-groups" data-look="' + look + '">'
    + '.skill-category{margin:0 0 6px 0;break-inside:avoid}'
    /*
     * The colour difference every look shares, written BEFORE the look's own
     * rules so a look that wants a different tone (muted, bar) overrides it.
     * The heading keeps the template's text colour; the skills sit a step
     * softer, which is what separates them at a glance on a white page and on
     * a dark sidebar alike. A colour, never `opacity` - see above.
     */
    + '.skill-category-title{color:currentColor}'
    /*
     * And the indent every look shares: the skills sit a step in from their
     * heading, so a block of six groups reads as six groups rather than as
     * twelve lines. Written here rather than in each look, and before them, so
     * a look that wants its own indent - `hanging` - still decides.
     */
    + '.skill-category-skills{color:color-mix(in srgb, currentColor 82%, transparent);padding-left:10px}'
    + rules
    // The other shape the grouped markup takes, where the heading is a <strong>
    // and the skills are the text after a <br> in the same list item. Nothing
    // can style that text on its own, so the heading carries the difference.
    + '.skills-list li>strong:first-child,.skill-category>strong:first-child{'
    + 'font-weight:700;font-size:0.86em;text-transform:uppercase;letter-spacing:0.06em}'
    + '</style>'
  );
}

/**
 * The order the sections are read in: summary, education, skills, experience.
 *
 * WHY IT IS DONE HERE. The operator asked for that order on every resume, and
 * there are 38 templates - each one a hand-written HTML document with its
 * sections in whatever order its author chose, several of them in two columns.
 * Editing 38 files leaves the 39th wrong, so the order is imposed at render
 * time, on the template's own markup, by the pass every resume already goes
 * through. The preview and the PDF both come through here, so they agree.
 *
 * WHAT A SECTION IS. A block whose class list contains "section",
 * "side-section" or "main-section" - the three wrappers these templates use -
 * and which is not nested inside another one. Its kind is read from its own
 * class ("section-education") where the author named it, and otherwise from the
 * heading text inside it, because half the templates only say
 * <div class="section"><div class="section-title">Education</div>.
 *
 * WHAT MOVES, AND WHAT DOES NOT. Sections are reordered among their OWN
 * siblings; nothing is moved between containers, so a sidebar keeps its own
 * contents and its own styling. A contact block stays at the top of whatever
 * holds it, and a section this does not recognise - certifications, projects,
 * awards - keeps its place relative to the others, after experience. A section
 * wrapped in a handlebars conditional travels with its wrapper or stays put.
 *
 * TWO COLUMNS. Ordering siblings is not enough when experience is in one column
 * and the summary in the other: the PDF's text stream reads the first column
 * first, so a template with experience on the left reads experience first
 * whatever its sidebar says. Where the two columns are flex or grid items they
 * are swapped in the markup and given an explicit order, which leaves the page
 * looking exactly as its author drew it while the stream reads in the asked-for
 * order. Where the layout is not flex or grid - a float, an absolute position -
 * nothing is swapped, because order would not hold the design together.
 */
type ResumeSectionKind = 'contact' | 'summary' | 'education' | 'skills' | 'experience' | 'other';

const RESUME_SECTION_ORDER: Record<ResumeSectionKind, number> = {
  contact: 0,
  summary: 1,
  education: 2,
  skills: 3,
  experience: 4,
  other: 5,
};

/** The class tokens these templates wrap a section in. */
const SECTION_WRAPPER_TOKENS = new Set(['section', 'side-section', 'main-section']);

type TemplateSectionBlock = {
  start: number;
  end: number;
  kind: ResumeSectionKind;
  html: string;
};

/**
 * Where an element ends, counting its own kind of tag.
 *
 * Returns the index just past the closing tag, or -1 when the markup does not
 * close - in which case the caller leaves that block alone rather than guessing.
 */
function elementExtent(html: string, tagStart: number, tagName: string): number {
  const openerEnd = html.indexOf('>', tagStart);
  if (openerEnd === -1) return -1;
  if (html.slice(tagStart, openerEnd + 1).endsWith('/>')) return openerEnd + 1;

  const tagPattern = new RegExp('</?' + tagName + '\\b[^>]*>', 'gi');
  tagPattern.lastIndex = tagStart;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html)) !== null) {
    if (match[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) return tagPattern.lastIndex;
    } else if (!match[0].endsWith('/>')) {
      depth += 1;
    }
  }
  return -1;
}

/** The kind of section this markup is: by its class first, its heading second. */
function classifyResumeSection(classAttribute: string, inner: string): ResumeSectionKind {
  const byClass = classAttribute.toLowerCase();
  if (/\bsection-experience\b/.test(byClass)) return 'experience';
  if (/\bsection-education\b/.test(byClass)) return 'education';
  if (/\bsection-(?:soft-)?skills\b/.test(byClass)) return 'skills';
  if (/\bsection-summary\b/.test(byClass)) return 'summary';
  if (/\bsection-contact\b/.test(byClass)) return 'contact';
  if (/\bsection-strengths\b/.test(byClass)) return 'other';

  // The heading, which is all most templates give us: the first title-ish
  // element, or failing that the first run of text in the block.
  const heading = /<[a-z0-9]+\b[^>]*class="[^"]*(?:title|heading)[^"]*"[^>]*>\s*([^<]{2,80})/i.exec(inner)
    || />\s*([A-Za-z][A-Za-z &/']{2,60}?)\s*</.exec(inner);
  const text = (heading ? heading[1] : '').toLowerCase();
  if (/experience|employment|work history|career/.test(text)) return 'experience';
  if (/education|academic|degree/.test(text)) return 'education';
  if (/skill|expertise|competenc|technolog|tech stack/.test(text)) return 'skills';
  if (/summary|profile|about|objective|overview/.test(text)) return 'summary';
  if (/contact|details/.test(text)) return 'contact';
  return 'other';
}

/**
 * The elements directly inside this markup, each with its opening tag.
 *
 * Empty when the markup holds anything else - text, a handlebars block - so a
 * caller asking "is this only a wrapper" gets a straight no.
 */
function findDirectChildren(inner: string): Array<{ opener: string; html: string }> {
  const children: Array<{ opener: string; html: string }> = [];
  const openers = /<([a-z0-9]+)\b[^>]*>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;

  // A handlebars block around a child is not content: the soft-skills guard
  // puts one there, and it must not stop this counting as a wrapper.
  const HANDLEBARS_BLOCK = /\{\{[#/][^}]*\}\}/g;
  const isEmptyGap = (gap: string) => !gap.replace(HANDLEBARS_BLOCK, '').trim();

  while ((match = openers.exec(inner)) !== null) {
    if (match.index < cursor) continue;
    if (!isEmptyGap(inner.slice(cursor, match.index))) return [];
    const end = elementExtent(inner, match.index, match[1]);
    if (end === -1) return [];
    children.push({ opener: match[0], html: inner.slice(match.index, end) });
    cursor = end;
    openers.lastIndex = end;
  }

  return isEmptyGap(inner.slice(cursor)) ? children : [];
}

/**
 * A wrapper that holds nothing but sections counts as one of them.
 *
 * `.skills-row` is a two-column grid holding the technical and the soft skills
 * blocks. Its sections are siblings of each other and of nothing else, so
 * ordering siblings could never move them past the summary or education, which
 * live outside it. The wrapper is ranked by the strongest thing inside it,
 * which puts it in the same run as everything else.
 */
function sectionOnlyWrapper(inner: string): ResumeSectionKind | null {
  const children = findDirectChildren(inner);
  if (children.length === 0) return null;

  // ONE KIND ONLY. A column is a wrapper of sections too - that is what a column
  // is - and ranking one would reorder the COLUMNS here, without the `order`
  // rule below that keeps the page looking the same, so the sidebar would change
  // sides. True of a skills row, false of a column.
  let only: ResumeSectionKind | null = null;
  for (const child of children) {
    const classMatch = /class="([^"]*)"/i.exec(child.opener);
    const classAttribute = classMatch ? classMatch[1] : '';
    const tokens = classAttribute.split(/\s+/).filter(Boolean);
    if (!tokens.some((token) => SECTION_WRAPPER_TOKENS.has(token.toLowerCase()))) return null;
    const kind = classifyResumeSection(classAttribute, child.html);
    if (only && kind !== only) return null;
    only = kind;
  }
  return only;
}

/**
 * The start of the innermost element still open at this point in the markup.
 *
 * Counted rather than guessed. Reading back one tag lands on whichever element
 * happens to end just there, and reading back two lands on the grandparent -
 * which is what the column swap did, so it never fired on any template.
 */
function ancestorChain(html: string, index: number): number[] {
  const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'col', 'area', 'base']);
  const tags = /<(\/?)([a-z0-9]+)\b[^>]*?(\/?)>/gi;
  const stack: Array<{ name: string; start: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = tags.exec(html)) !== null) {
    if (match.index >= index) break;
    const name = match[2].toLowerCase();
    if (VOID_TAGS.has(name) || match[3]) continue;
    if (match[1]) {
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        if (stack[depth].name === name) { stack.length = depth; break; }
      }
    } else {
      stack.push({ name, start: match.index });
    }
  }

  return stack.map((entry) => entry.start);
}

function openParentAt(html: string, index: number): number {
  const chain = ancestorChain(html, index);
  return chain.length ? chain[chain.length - 1] : -1;
}
/** Every section in the document, in order, never one inside another. */
function findResumeSections(html: string): TemplateSectionBlock[] {
  const blocks: TemplateSectionBlock[] = [];
  const openers = /<(div|section)\b[^>]*class="([^"]*)"[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = openers.exec(html)) !== null) {
    const tokens = match[2].split(/\s+/).filter(Boolean);
    if (!tokens.some((token) => SECTION_WRAPPER_TOKENS.has(token.toLowerCase()))) {
      const wrapperEnd = elementExtent(html, match.index, match[1]);
      if (wrapperEnd === -1) continue;
      const innerStart = match.index + match[0].length;
      const innerEnd = html.lastIndexOf('</', wrapperEnd);
      if (innerEnd <= innerStart) continue;
      const wrapperKind = sectionOnlyWrapper(html.slice(innerStart, innerEnd));
      if (!wrapperKind) continue;
      blocks.push({
        start: match.index,
        end: wrapperEnd,
        kind: wrapperKind,
        html: html.slice(match.index, wrapperEnd),
      });
      openers.lastIndex = wrapperEnd;
      continue;
    }

    const end = elementExtent(html, match.index, match[1]);
    if (end === -1) continue;

    let start = match.index;
    let blockEnd = end;
    // A section inside a conditional moves with the conditional, or not at all.
    const before = /\{\{#if\s+[^}]+\}\}\s*$/.exec(html.slice(0, start));
    const after = /^\s*\{\{\/if\}\}/.exec(html.slice(end));
    if (before && after) {
      start -= before[0].length;
      blockEnd += after[0].length;
    } else if (before || after) {
      openers.lastIndex = end;
      continue;
    }

    blocks.push({
      start,
      end: blockEnd,
      kind: classifyResumeSection(match[2], html.slice(match.index, end)),
      html: html.slice(start, blockEnd),
    });
    openers.lastIndex = end;
  }

  return blocks;
}

/** Sections that sit next to each other with nothing but whitespace between. */
function runsOfSiblingSections(html: string, blocks: TemplateSectionBlock[]): TemplateSectionBlock[][] {
  const runs: TemplateSectionBlock[][] = [];
  for (const block of blocks) {
    const current = runs[runs.length - 1];
    const previous = current ? current[current.length - 1] : undefined;
    if (current && previous && !html.slice(previous.end, block.start).trim()) current.push(block);
    else runs.push([block]);
  }
  return runs;
}

/** Every declaration this template writes for any class on this element. */
function declarationsFor(template: string, openingTag: string): string {
  const inline = /style="([^"]*)"/i.exec(openingTag);
  let text = inline ? inline[1] : '';
  const classMatch = /class="([^"]*)"/i.exec(openingTag);
  const tokens = (classMatch ? classMatch[1] : '').split(/\s+/).filter(Boolean);

  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, (character) => '\\' + character);
    const rule = new RegExp('\\.' + escaped + '\\b[^{}]*\\{([^}]*)\\}', 'gi');
    let match: RegExpExecArray | null;
    while ((match = rule.exec(template)) !== null) text += ';' + match[1];
  }
  return text;
}

/**
 * Whether giving this element an `order` would actually move it.
 *
 * `order` only means something to a flex or grid ITEM, and an item is made one
 * by its PARENT. Asking the column itself was the bug: `.main-container` carries
 * `display:flex` and `.left-column` carries `flex:1`, so the question has to be
 * put to both - the parent's display, or the child's own flex or grid property.
 */
function respectsOrder(template: string, openingTag: string, parentTag: string): boolean {
  if (/display\s*:\s*(?:flex|inline-flex|grid|inline-grid)/i.test(declarationsFor(template, parentTag))) return true;
  return /(?:^|;)\s*(?:flex|flex-grow|flex-basis|grid-area|grid-column|grid-row)\s*:/i
    .test(declarationsFor(template, openingTag));
}

/** Adds, or extends, this element's inline style with one more declaration. */
function withInlineDeclaration(openingTag: string, declaration: string): string {
  if (/\bstyle="/i.test(openingTag)) {
    return openingTag.replace(/\bstyle="([^"]*)"/i, (_match, existing: string) =>
      'style="' + existing.replace(/;\s*$/, '') + ';' + declaration + '"');
  }
  return openingTag.replace(/^<([a-z0-9]+)/i, '<$1 style="' + declaration + '"');
}

/**
 * The parent's track list, reversed, when it is a grid of two named columns.
 *
 * A flex item carries its own width - `flex:1` moves with the sidebar - but a
 * grid's widths belong to the parent, so swapping the children without swapping
 * the tracks drops a narrow sidebar into a wide cell. Returns an empty string
 * when there is nothing to reverse, which includes every flex layout.
 */
function reversedGridTracks(template: string, parentTag: string): string {
  const parent = declarationsFor(template, parentTag);
  if (!/display\s*:\s*(?:grid|inline-grid)/i.test(parent)) return '';

  const tracks = /grid-template-columns\s*:\s*([^;}]+)/i.exec(parent);
  if (!tracks) return '';
  const parts = tracks[1].trim().split(/\s+(?![^(]*\))/).filter(Boolean);
  if (parts.length !== 2) return '';
  return 'grid-template-columns:' + parts[1] + ' ' + parts[0];
}

/**
 * Moves the summary to the column that holds education and skills.
 *
 * Only for the shape described above - a summary sharing its column with
 * experience while education or skills live in another one - and only ever to
 * the head of that other column. Everything else is left alone.
 */
/**
 * A section that changes column dresses for the column it arrives in.
 *
 * WHAT WENT WRONG. The summary has to join education and skills on six
 * templates, or the page cannot read in the asked-for order. On
 * `two-column-executive` that column is a dark navy sidebar, and the summary's
 * colours are written for the white column it came from:
 *
 *   .sidebar      { background:#1c2b3a; color:#cbd5e1 }
 *   .summary-text { color:#374151 }
 *   .main-heading { color:#1c2b3a }
 *
 * `.summary-text` sets its colour on the element, so it beat the colour it now
 * inherits from `.sidebar`: measured at 1.4:1 against its background, where
 * 4.5:1 is the bar for body text and it had been 10.31:1 in the main column.
 * The heading was navy on navy, which is 1:1 - not faint, absent.
 *
 * TWO CHANGES, BECAUSE THE PROBLEM HAS TWO HALVES. The wrapper and the heading
 * take the destination's own classes, so the block is styled by the same rules
 * as everything around it - a moved summary gets `.side-section` and
 * `.side-heading`, and the sidebar's gold heading colour comes with them. The
 * body text cannot be fixed that way, because its colour is on itself, so the
 * block is marked and a render-time rule makes everything inside it inherit -
 * everything except the heading, which has just been dressed deliberately.
 */
const RELOCATED_MARKER = 'data-resume-relocated';

/** The class attribute of the first element in this markup. */
function firstElementClass(html: string): string | null {
  const opener = /<(?:div|section)\b[^>]*class="([^"]*)"[^>]*>/i.exec(html);
  return opener ? opener[1] : null;
}

/** The class of the heading inside this section, if it names itself one. */
function headingClass(html: string): string | null {
  const heading = /<[a-z0-9]+\b[^>]*class="([^"]*(?:title|heading)[^"]*)"[^>]*>/i.exec(html);
  return heading ? heading[1] : null;
}

/**
 * Rewrites a moved section to wear the destination's classes, and marks it.
 */
function dressForDestination(sectionHtml: string, destinationHtml: string): string {
  const destinationSection = firstElementClass(destinationHtml);
  const destinationHeading = headingClass(destinationHtml);
  const ownHeading = headingClass(sectionHtml);
  let output = sectionHtml;

  // The wrapper: the destination's section class, plus the marker.
  output = output.replace(/<(div|section)\b([^>]*)class="([^"]*)"([^>]*)>/i,
    (match, tag: string, before: string, own: string, after: string) => {
      const wrapper = destinationSection && destinationSection !== own ? destinationSection : own;
      return `<${tag}${before}class="${wrapper}" ${RELOCATED_MARKER}="1"${after}>`;
    });

  // The heading: the destination's heading class, where both name one.
  if (destinationHeading && ownHeading && destinationHeading !== ownHeading) {
    output = output.replace(`class="${ownHeading}"`, `class="${destinationHeading}"`);
  }

  return output;
}

function moveSummaryBesideEducation(html: string): string {
  const runs = runsOfSiblingSections(html, findResumeSections(html));
  const summaryRun = runs.find((run) => run.some((block) => block.kind === 'summary'));
  if (!summaryRun || !summaryRun.some((block) => block.kind === 'experience')) return html;

  const target = runs.find((run) => run !== summaryRun
    && run.some((block) => block.kind === 'education' || block.kind === 'skills'));
  if (!target) return html;

  const summary = summaryRun.find((block) => block.kind === 'summary');
  if (!summary) return html;

  // Cut it out, then put it in front of the target run - which may sit below a
  // contact block, and belongs after that rather than at the top of the column.
  const cut = html.slice(0, summary.start) + html.slice(summary.end);
  const shift = summary.end - summary.start;
  const insertAt = target[0].start > summary.start ? target[0].start - shift : target[0].start;
  const dressed = dressForDestination(summary.html, target[0].html);
  return cut.slice(0, insertAt) + dressed + '\n' + cut.slice(insertAt);
}

/** Orders each set of sibling sections by the order the resume is read in. */
function orderSiblingSections(html: string): string {
  let output = html;

  // Backwards, so that rewriting a run cannot move the offsets of a run not yet
  // done.
  const runs = runsOfSiblingSections(output, findResumeSections(output));
  for (const run of [...runs].reverse()) {
    if (run.length < 2) continue;
    const ordered = [...run].sort((a, b) => RESUME_SECTION_ORDER[a.kind] - RESUME_SECTION_ORDER[b.kind]);
    if (ordered.every((block, index) => block === run[index])) continue;

    const separator = output.slice(run[0].end, run[1].start) || '\n';
    output = output.slice(0, run[0].start)
      + ordered.map((block) => block.html).join(separator)
      + output.slice(run[run.length - 1].end);
  }

  return output;
}

export function reorderResumeSections(html: string, env: NodeJS.ProcessEnv = process.env): string {
  // An operator who wants a template's own order back, and the measurement that
  // says what this pass changed, both need a way to switch it off.
  if (env.RESUME_SECTION_ORDER_OFF) return html;

  let output = orderSiblingSections(html);

  const moved = moveSummaryBesideEducation(output);
  if (moved !== output) output = orderSiblingSections(moved);

  // Last, the columns, for a template that prints experience first.
  const columnRuns = runsOfSiblingSections(output, findResumeSections(output));
  for (let index = 0; index < columnRuns.length - 1; index += 1) {
    const first = new Set(columnRuns[index].map((block) => block.kind));
    const second = new Set(columnRuns[index + 1].map((block) => block.kind));
    const experienceLeads = first.has('experience')
      && !first.has('summary')
      && (second.has('summary') || second.has('education') || second.has('skills'));
    if (!experienceLeads) continue;

    // The two columns: the elements directly below the deepest ancestor the two
    // runs share. Not "the parent of the first section" - that is the column for
    // one run and the whole row for the other, because a column holding one
    // section is itself ranked as a section by the wrapper rule above.
    const leftChain = ancestorChain(output, columnRuns[index][0].start);
    const rightChain = ancestorChain(output, columnRuns[index + 1][0].start);
    let shared = 0;
    while (shared < leftChain.length && shared < rightChain.length
      && leftChain[shared] === rightChain[shared]) shared += 1;
    const leftStart = shared < leftChain.length ? leftChain[shared] : columnRuns[index][0].start;
    const rightStart = shared < rightChain.length ? rightChain[shared] : columnRuns[index + 1][0].start;
    if (leftStart < 0 || rightStart < 0 || rightStart <= leftStart) continue;

    const leftTag = output.slice(leftStart, output.indexOf('>', leftStart) + 1);
    const rightTag = output.slice(rightStart, output.indexOf('>', rightStart) + 1);
    const leftName = /^<([a-z0-9]+)/i.exec(leftTag);
    const rightName = /^<([a-z0-9]+)/i.exec(rightTag);
    if (!leftName || !rightName) continue;

    const leftEnd = elementExtent(output, leftStart, leftName[1]);
    const rightEnd = elementExtent(output, rightStart, rightName[1]);
    if (leftEnd === -1 || rightEnd === -1 || leftEnd > rightStart) continue;
    const parentStart = openParentAt(output, leftStart);
    const parentTag = parentStart >= 0
      ? output.slice(parentStart, output.indexOf('>', parentStart) + 1)
      : '';
    if (!respectsOrder(html, leftTag, parentTag) && !respectsOrder(html, rightTag, parentTag)) continue;

    const left = output.slice(leftStart, leftEnd);
    const right = output.slice(rightStart, rightEnd);
    const between = output.slice(leftEnd, rightStart);
    // The columns change sides, because that is what changes the reading order.
    // Each keeps its own width; a grid's widths are the parent's, so its track
    // list is reversed to match.
    const tracks = reversedGridTracks(html, parentTag);
    const swappedColumns = right + between + left;
    output = output.slice(0, leftStart) + swappedColumns + output.slice(rightEnd);
    if (tracks && parentStart >= 0) {
      const newParentTag = withInlineDeclaration(parentTag, tracks);
      output = output.slice(0, parentStart)
        + newParentTag
        + output.slice(parentStart + parentTag.length);
    }
    break;
  }

  return output;
}

function normalizeTemplateSkillsSections(html: string): string {
  // Soft skills are rendered, not stripped. The pipeline has always produced
  // them - matched against the skill library, merged with the job analysis and
  // capped - and the renderer used to delete the block anyway, so a template
  // that wrote a Soft Skills heading silently never showed one.
  //
  // Templates that have no such block are unaffected: there is nothing to
  // guard, and `softSkills` simply goes unread.
  let output = reorderResumeSections(guardSoftSkillsSection(html));
  output = stripTemplateSectionByClass(output, 'section-strengths');
  // The specific rules below run first, because each preserves the author's
  // own item markup for the flat layout. `groupRemainingSkillLoops` then
  // catches whatever shape they had never seen.
  output = output
    .replace(/Hard Skills/g, 'Technical Skills')
    .replace(
      /\{\{#if hardSkills\.length\}\}\s*\{\{#each hardSkills\}\}\s*<div class="skill-box">\{\{this\}\}<\/div>\s*\{\{\/each\}\}\s*\{\{else\}\}\s*\{\{#each skills\}\}\s*<div class="skill-box">\{\{this\}\}<\/div>\s*\{\{\/each\}\}\s*\{\{\/if\}\}/g,
      (match) => layoutBranch(match,
        '{{#each skillCategories}}<div class="skill-category"><div class="skill-category-title">{{category}}</div><div class="skill-category-skills">{{join skills ", "}}</div></div>{{/each}}')
    )
    .replace(
      /\{\{#if hardSkills\.length\}\}\s*\{\{#each hardSkills\}\}<span>\{\{this\}\}\{\{#unless @last\}\} . \{\{\/unless\}\}<\/span>\{\{\/each\}\}\s*\{\{else\}\}\s*\{\{#each skills\}\}<span>\{\{this\}\}\{\{#unless @last\}\} . \{\{\/unless\}\}<\/span>\{\{\/each\}\}\s*\{\{\/if\}\}/g,
      (match) => layoutBranch(match,
        '{{#each skillCategories}}<div class="skill-category"><div class="skill-category-title">{{category}}</div><div class="skill-category-skills">{{join skills ", "}}</div></div>{{/each}}')
    )
    .replace(
      /\{\{#if hardSkills\.length\}\}\s*\{\{#each hardSkills\}\}\s*<span class="skill-chip">\{\{this\}\}<\/span>\s*\{\{\/each\}\}\s*\{\{else\}\}\s*\{\{#each skills\}\}\s*<span class="skill-chip">\{\{this\}\}<\/span>\s*\{\{\/each\}\}\s*\{\{\/if\}\}/g,
      (match) => layoutBranch(match,
        '{{#each skillCategories}}<div class="skill-category skill-chip"><div class="skill-category-title">{{category}}</div><div class="skill-category-skills">{{join skills ", "}}</div></div>{{/each}}')
    )
    .replace(
      /\{\{#if hardSkills\.length\}\}\s*\{\{#each hardSkills\}\}<span>\{\{this\}\}\{\{#unless @last\}\}[^{}]*\{\{\/unless\}\}<\/span>\{\{\/each\}\}\s*\{\{else\}\}\s*\{\{#each skills\}\}<span>\{\{this\}\}\{\{#unless @last\}\}[^{}]*\{\{\/unless\}\}<\/span>\{\{\/each\}\}\s*\{\{\/if\}\}/g,
      (match) => layoutBranch(match,
        '{{#each skillCategories}}<div class="skill-category"><div class="skill-category-title">{{category}}</div><div class="skill-category-skills">{{join skills ", "}}</div></div>{{/each}}')
    )
    .replace(
      /\{\{#each hardSkills\}\}\s*<li[^>]*>\{\{this\}\}<\/li>\s*\{\{\/each\}\}/g,
      (match) => layoutBranch(match,
        '{{#each skillCategories}}<li><strong>{{category}}</strong><br>{{join skills ", "}}</li>{{/each}}')
    );

  return guardEmptyCategoryHeadings(groupRemainingSkillLoops(output));
}

/**
 * Makes a category heading disappear when there is no category.
 *
 * The flat layout is delivered as ONE group whose heading is the empty string,
 * so that every template keeps the single `{{#each skillCategories}}` loop it
 * already has instead of growing a second branch. The cost of that choice is
 * this: an unguarded heading element renders as an empty box, which in the
 * built-in templates is a visible blank line and a border above the skills.
 *
 * Applied to the markup rather than asked of template authors, and applied
 * after the rewrites above so it also covers the markup this file generates.
 * A template somebody uploads has never heard of the flat layout, and the
 * option would otherwise be one a profile can only safely use on the handful of
 * templates that happened to be written for it.
 *
 * Idempotent: the negative lookbehind leaves a heading somebody already guarded
 * alone, rather than nesting a second identical `{{#if}}` around it.
 */
function guardEmptyCategoryHeadings(html: string): string {
  return (
    html
      // First, because its <br> belongs to the heading rather than to the
      // skills. Let the general rule below claim the <strong> and the break is
      // left outside the guard, so the flat layout opens its list with a blank
      // line - which is exactly what it did until this ordering was measured.
      .replace(
        /(?<!\{\{#if category\}\})<strong>\s*\{\{category\}\}\s*<\/strong>\s*<br\s*\/?>/g,
        '{{#if category}}<strong>{{category}}</strong><br>{{/if}}'
      )
      .replace(
        /(?<!\{\{#if category\}\})(<(\w+)\b[^>]*>)\s*\{\{category\}\}\s*(<\/\2>)/g,
        '{{#if category}}$1{{category}}$3{{/if}}'
      )
  );
}

export function prepareResumeRenderData(
  profile: Profile,
  tailoredContent?: TailoredContent,
  companyName?: string,
  role?: string
) {
  const linkedinHref = normalizeExternalUrl(profile.contact?.linkedin);
  const linkedinDisplay = getExternalUrlDisplay(profile.contact?.linkedin);
  const tailoredHardSkills = tailoredContent?.hardSkills ?? [];
  const tailoredSkills = tailoredContent?.skills ?? [];
  const data = {
    ...profile,
    contact: {
      ...profile.contact,
      linkedin: linkedinHref,
      linkedinHref,
      linkedinDisplay,
    },
    companyName: companyName || '',
    role: role || '',
    title: sanitizeTitleForATS(getResumeTitle(profile, tailoredContent)),
    skillInventory: normalizeSkills([
      ...(profile.skills ?? []),
      ...tailoredHardSkills,
      ...tailoredSkills,
    ]),
    ...(tailoredContent && {
      summary: tailoredContent.summary,
      experience: tailoredContent.experience,
      skills: tailoredSkills,
      hardSkills: tailoredHardSkills,
      softSkills: tailoredContent.softSkills ?? [],
      aiSkillGroups: tailoredContent.skillGroups ?? [],
      strengths: []
    })
  };
  return normalizeExperienceDescriptions(applySkillsLimit(data));
}

function compileTemplate(template: Template) {
  if (typeof template.htmlContent !== 'string' || !template.htmlContent.trim()) {
    throw new Error(`Template "${template.name || template.id}" is missing htmlContent`);
  }

  return Handlebars.compile(normalizeTemplateSkillsSections(template.htmlContent));
}

/**
 * Two words a reader sees apart and a parser reads as one.
 *
 * WHAT WAS WRONG. A role header puts the title on the left and the dates on the
 * right with `justify-content:space-between`, and the two sit in adjacent
 * elements with nothing between them in the source. A gap produced by layout is
 * not a character, so the PDF's text stream has none: "Software Engineer04/2022
 * - Present", "GoogleREMOTE", "PwCREMOTE", "Bachelor's degree, Computer
 * Engineering2012 - 2016", "02SKILLS". Measured over 495 delivered resumes,
 * title-and-date ran together in 99-100% of three profiles' resumes and
 * company-and-location in 68-100% of every profile's. A scanner reading
 * "GoogleREMOTE" has no employer and no location, and its job-title and
 * work-date checks fail on a page where both are plainly printed.
 *
 * WHY IT IS MEASURED HERE RATHER THAN SELECTED IN CSS. The same defect was
 * fixed once for the contact line, by naming the classes that line uses. There
 * are 38 templates and they call this row `company-line`, `job-header`,
 * `job-meta`, `entry-subline`, `exp-title-company`, `edu-header` and a dozen
 * other things, so a list of names is a list that will be out of date. Geometry
 * is the actual question - are these two boxes on the same line with a gap
 * between them and no whitespace in between - and the browser can answer it for
 * every template at once, including the ones nobody has written yet.
 *
 * WHY A NON-BREAKING SPACE, AND WHY INSIDE THE LEFT ELEMENT. Appended INSIDE,
 * because a text node BETWEEN two flex items becomes a third flex item and
 * would move the row; inside, it widens the left box by a few points, which
 * `space-between` absorbs. Non-breaking, so it cannot collapse away or become a
 * line break, and every parser reads it as a space.
 */
const SEPARATE_GLUED_RUNS_SCRIPT = `(() => {
  const SEPARATOR = '\\u00a0\\u00a0';
  let added = 0;

  for (const parent of Array.from(document.querySelectorAll('body *'))) {
    const children = Array.from(parent.children);
    if (children.length < 2) continue;

    for (let index = 0; index < children.length - 1; index += 1) {
      const left = children[index];
      const right = children[index + 1];
      const leftText = left.textContent || '';
      const rightText = right.textContent || '';
      if (!leftText.trim() || !rightText.trim()) continue;

      // Already separated in the source, or by content the author wrote.
      const between = left.nextSibling;
      if (between && between !== right && between.nodeType === 3
        && /[\\s\\u00a0]/.test(between.textContent || '')) continue;
      if (/[\\s\\u00a0]$/.test(leftText)) continue;
      if (/^[\\s\\u00a0]/.test(rightText)) continue;

      // A flex or grid box would turn the separator into a child item of its
      // own and move what is inside it, so those are left alone.
      const display = getComputedStyle(left).display;
      if (display.indexOf('flex') !== -1 || display.indexOf('grid') !== -1) continue;

      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      if (!a.width || !b.width || !a.height || !b.height) continue;

      // Same visual line, and the right box really is to the right: two boxes
      // stacked in a column already read as separate lines.
      const shared = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (shared < Math.min(a.height, b.height) * 0.5) continue;
      if (b.left < a.right - 1) continue;

      left.appendChild(document.createTextNode(SEPARATOR));
      added += 1;
    }
  }

  // Generated content, which has no node to sit beside. A stylesheet that
  // numbers the headings - content: counter(resume-section) - prints "02" hard
  // against "SKILLS", and the number is a box the document does not contain, so
  // the separator goes inside the heading's own first child instead: that keeps
  // it out of the flex row, where a text node would become an item of its own
  // and move the heading sideways by the row's gap.
  const printed = (element, which) => {
    const content = getComputedStyle(element, which).content;
    // A letter or a digit is text a reader reads. The contact separator this
    // file also injects is a non-breaking space and has neither, so it is not
    // mistaken for a word that needs separating.
    return !!content && content !== 'none' && content !== 'normal'
      && /[A-Za-z0-9]/.test(content);
  };

  for (const element of Array.from(document.querySelectorAll('body *'))) {
    const first = element.firstElementChild;
    const text = first ? (first.textContent || '') : '';
    if (!first || !text.trim()) continue;
    const opening = text.charCodeAt(0);
    if (opening === 32 || opening === 9 || opening === 10 || opening === 160) continue;
    if (!printed(element, '::before')) continue;
    const box = element.getBoundingClientRect();
    const inner = first.getBoundingClientRect();
    // Only when the generated text shares the heading line, which is what
    // makes the two read as one word.
    if (!box.height || !inner.height) continue;
    if (Math.min(box.bottom, inner.bottom) - Math.max(box.top, inner.top) < inner.height * 0.5) continue;
    first.insertBefore(document.createTextNode(SEPARATOR), first.firstChild);
    added += 1;
  }

  return added;
})()`;

export async function separateGluedTextRuns(
  page: { evaluate: (script: string) => Promise<unknown> }
): Promise<number> {
  const added = await page.evaluate(SEPARATE_GLUED_RUNS_SCRIPT);
  return typeof added === 'number' ? added : 0;
}

export async function generateResumePDF(
  profile: Profile,
  template: Template,
  tailoredContent: TailoredContent | undefined,
  pathInfo: GeneratedPathInfo,
  companyName?: string,
  role?: string
): Promise<string> {
  const renderData = timePdfStageSync('render data preparation', () =>
    prepareResumeRenderData(
      profile,
      tailoredContent,
      companyName,
      role
    )
  );

  // Compile and render template
  const html = timePdfStageSync('template render', () => renderTemplateBody(template, renderData));

  // Add CSS if separate
  const fullHtml = timePdfStageSync('HTML assembly', () => assembleResumeDocument(template, html));

  // Generate PDF with Puppeteer.
  //
  // Under a rendering permit, held across the whole render rather than just the
  // export call: the batch runs as wide as there are chat browsers registered,
  // and without this every one of those items would open a tab here at the same
  // moment. See renderConcurrency.
  const pageBox = resolveTemplatePageBox(template);
  return await withRenderPermit(async () => {
  const browser = await timePdfStage('browser ready', () => getSharedPdfBrowser());
  let page: Awaited<ReturnType<Browser['newPage']>> | null = null;

  try {
    const activePage = await timePdfStage('new page', () => browser.newPage());
    page = activePage;
    await timePdfStage('page setup', async () => {
      // The viewport is what viewport units and the pre-print layout resolve
      // against, so give it this template's own content box rather than a
      // fixed one that may be up to 96px narrower than the page it prints on.
      await activePage.setViewport({
        width: Math.round(pageBox.contentWidthPx),
        height: Math.round(pageBox.contentHeightPx),
        deviceScaleFactor: 1,
      });
      await activePage.emulateMediaType('print');
    });
    await timePdfStage('HTML load', () => activePage.setContent(fullHtml, { waitUntil: 'load' }));
    // After layout, because it asks the page where things ended up.
    await timePdfStage('separate glued runs', () => separateGluedTextRuns(activePage));

    const pdfFilename = getResumeOutputFilename(pathInfo, 'pdf');
    const relativePath = `${pathInfo.storagePathBase}/${pdfFilename}`;
    const filepath = path.join(pathInfo.absoluteDir, pdfFilename);
    const finalPdf = await timePdfStage('export', async () =>
      Buffer.from(await activePage.pdf({
        format: RESUME_PAGE_GEOMETRY.format,
        margin: { ...RESUME_PAGE_GEOMETRY.margin },
        printBackground: true
      }))
    );

    await timePdfStage('file write', async () => {
      await fs.mkdir(path.dirname(filepath), { recursive: true });
      await fs.writeFile(filepath, finalPdf);
    });

    return relativePath;
  } finally {
    if (page) {
      const pageToClose = page;
      await timePdfStage('page close', () => pageToClose.close());
    }
  }
  });
}

export async function generatePreviewHTML(
  profile: Profile,
  template: Template,
  tailoredContent?: TailoredContent
): Promise<string> {
  const renderData = prepareResumeRenderData(profile, tailoredContent);
  return assembleResumeDocument(template, renderTemplateBody(template, renderData));
}

/** Sample profile for template preview */
/**
 * The resume every template preview is rendered with.
 *
 * Deliberately a FULL one - four roles with real achievement bullets, a skill
 * list broad enough to fill every category the skills pipeline builds, two
 * degrees - because a preview's whole job is to show how a template handles a
 * real resume. The previous sample had two roles and five skills, which made
 * every template look roomy and told you nothing about how the one you picked
 * would cope with a second page, a long company line, or a four-column skills
 * block.
 *
 * The names and companies are invented. Nothing here is anyone's real resume.
 */
const SAMPLE_PROFILE: Profile = {
  id: 'preview',
  name: 'Jordan Avery Chen',
  title: 'Senior Software Engineer',
  totalYearsExperience: 9,
  contact: {
    phone: '+1 (555) 123-4567',
    email: 'jordan.chen@example.com',
    linkedin: 'linkedin.com/in/jordanchen',
    location: 'San Francisco, CA',
  },
  summary:
    'Senior engineer with nine years building and operating payment and data platforms at scale. ' +
    'Leads backend architecture for services handling 40M requests a day, and has taken three ' +
    'greenfield systems from design through to production ownership. Works closely with product ' +
    'and SRE, and has mentored eight engineers through promotion.',
  experience: [
    {
      title: 'Senior Software Engineer',
      company: 'Northwind Payments',
      startDate: '03/2022',
      endDate: 'Present',
      location: 'San Francisco, CA',
      description:
        'Own the ledger and settlement services behind a payments platform processing $2.4B annually. ' +
        'Lead a team of five across backend and infrastructure.',
      achievements: [
        'Rebuilt the settlement pipeline on an event-sourced ledger, cutting end-of-day reconciliation from 6 hours to 18 minutes',
        'Cut p99 authorisation latency from 840ms to 120ms by replacing synchronous fraud lookups with a cached risk service',
        'Introduced contract testing across 14 services, taking integration failures in staging from roughly 30 a week to under 3',
        'Mentored three engineers to senior; two now lead their own teams',
      ],
      skills: [],
    },
    {
      title: 'Software Engineer II',
      company: 'Cobalt Analytics',
      startDate: '07/2019',
      endDate: '02/2022',
      location: 'Seattle, WA',
      description:
        'Built the ingestion and query layer for a customer-facing analytics product used by 1,200 organisations.',
      achievements: [
        'Designed a columnar ingestion path handling 8TB a day, reducing storage cost per event by 62%',
        'Shipped an incremental materialised-view engine that brought dashboard loads under 2 seconds at the 95th percentile',
        'Led the migration from a single Postgres instance to a sharded cluster with no customer-visible downtime',
      ],
      skills: [],
    },
    {
      title: 'Software Engineer',
      company: 'Harbourline Systems',
      startDate: '08/2017',
      endDate: '06/2019',
      location: 'Remote',
      description:
        'Full-stack work on a logistics scheduling product, from the React planning board to the routing service behind it.',
      achievements: [
        'Replaced a nightly batch scheduler with an incremental solver, improving on-time dispatch from 81% to 96%',
        'Built the CI pipeline the whole engineering group still uses, taking a release from a half-day to 20 minutes',
      ],
      skills: [],
    },
    {
      title: 'Junior Software Engineer',
      company: 'Fairhaven Digital',
      startDate: '06/2016',
      endDate: '07/2017',
      location: 'Boston, MA',
      description: 'Maintained client web applications and internal tooling for a digital agency.',
      achievements: [
        'Automated the deployment process for 20 client sites, removing a recurring source of release errors',
      ],
      skills: [],
    },
  ],
  strengths: [
    { title: 'Systems Design', description: 'Designs for failure modes and operational cost, not just the happy path.' },
    { title: 'Mentorship', description: 'Eight engineers coached through promotion in four years.' },
    { title: 'Incident Ownership', description: 'Drives root-cause analysis through to the fix that prevents recurrence.' },
    { title: 'Communication', description: 'Writes the design document people actually read before the meeting.' },
  ],
  skills: [
    'TypeScript', 'JavaScript', 'Python', 'Go', 'SQL', 'Java',
    'React', 'Next.js', 'Node.js', 'Express', 'Django', 'GraphQL',
    'PostgreSQL', 'MySQL', 'Redis', 'MongoDB', 'DynamoDB', 'Kafka',
    'AWS', 'GCP', 'Docker', 'Kubernetes', 'Terraform', 'GitHub Actions',
    'Jenkins', 'Prometheus', 'Grafana', 'Datadog', 'Jest', 'Playwright',
  ],
  education: [
    {
      degree: 'M.S. Computer Science',
      institution: 'University of Washington',
      startDate: '2014',
      endDate: '2016',
      location: 'Seattle, WA',
    },
    {
      degree: 'B.S. Computer Engineering',
      institution: 'Boston University',
      startDate: '2010',
      endDate: '2014',
      location: 'Boston, MA',
    },
  ],
  createdAt: '',
  updatedAt: '',
};

/** Compiles a template against render data. Shared so preview and PDF agree. */
function renderTemplateBody(template: Template, renderData: unknown): string {
  const compiledTemplate = compileTemplate(template);
  return enforceSkillCategoryLineBreaks(
    rewriteLinkedInAnchorDisplay(compiledTemplate(renderData))
  );
}

/**
 * Turns off the typographic ligatures the renderer applies by default.
 *
 * Chrome substitutes ONE glyph for "fi", "fl", "ffi" and "ffl" when the font
 * offers them, and writes that glyph into the PDF with a ToUnicode entry
 * pointing at U+FB01-U+FB04 - the ligature codepoints, not the letters. So the
 * file does not contain "Artificial"; it contains "Arti", U+FB01, "cial", drawn
 * as three separate operations. Anything that reads the PDF back sees the
 * ligature character and a run boundary: pasting gives "Artifi cial", and an
 * ATS that does not normalise Unicode fails to match the keyword at all.
 *
 * Measured across the fourteen fonts the installed templates use, Calibri is
 * the only one that does this - and nine templates use Calibri. Applied to
 * every template rather than those nine, because the next Calibri template
 * would bring the bug back, and because a font that ships ligatures is a
 * property of the font, not of the template that picked it.
 *
 * The cost is nothing anyone will see: "fi" renders as two glyphs instead of
 * one joined glyph, at the same width.
 *
 * Early in the head, so a template that genuinely wants a ligature can still
 * ask for one: this selector has zero specificity and any real rule beats it.
 */
/**
 * Puts a real character between the contact fields.
 *
 * WHY. The header lays phone, email, LinkedIn and location out with
 * `display:flex; gap:14px`, and a flex gap is not a character - it is space
 * between boxes. The PDF therefore carries the four fields with NOTHING between
 * them, and the text layer of every resume this app has produced reads:
 *
 *   (214) 865-9131jonalai0897@gmail.comlinkedin.com/in/jonathan-...The Colony, TX
 *
 * A scanner pulling the email out of that gets "…@gmail.comlinkedin.com", a
 * domain that does not exist. Measured across 60 finished resumes: the email
 * was present in 60 and cleanly delimited in 0. Same family as the ligature
 * rule above - the page looks right and the text layer disagrees.
 *
 * A NON-BREAKING space, and generated content rather than markup. Measured
 * against the alternatives: a whitespace text node between flex items is
 * dropped by layout, a plain space in `content` is collapsed the same way, and
 * swapping the gap for a margin changes nothing because neither is a glyph.
 * U+00A0 survives all of it, is invisible next to an existing 14px gap, and
 * needs no template edited - which matters, because 33 of them have this.
 */
/**
 * Everything inside a relocated block inherits its new column's text colour.
 *
 * The heading is left out: `dressForDestination` has just given it the
 * destination's own heading class, so it is already wearing the right colour,
 * and this would flatten it back to body text.
 *
 * `!important` because the colour this overrides is on the element itself -
 * `.summary-text{color:#374151}` - which a rule of equal specificity written
 * before the template's own stylesheet cannot beat.
 */
const RELOCATED_SECTION_CSS =
  '<style id="resume-relocated-section">'
  + '[data-resume-relocated] *:not([class*="head"]):not([class*="title"])'
  + '{color:inherit !important}'
  + '</style>';

const CONTACT_SEPARATOR_CSS =
  '<style id="resume-contact-separator">' +
  '.contact>*::after,.contact-row>*::after,.contact-item::after,' +
  '.contact>*::before,.contact-row>*::before{content:"\\00a0"}' +
  '</style>';

/**
 * The column the Soft Skills block used to stand in.
 *
 * Several templates lay the two blocks side by side - `.skills-row` is a
 * two-column grid, 1.18fr for the technical skills and 0.82fr for the soft
 * ones. There is no soft-skills block any more, so the second column was being
 * reserved and left blank: two fifths of the page width, empty, beside a list
 * squeezed into the other three.
 *
 * Fixed at render time rather than in 38 template files, and asked as a
 * question about the page rather than about the data: if nothing in the row
 * has any skills under it besides the technical block, the row is one column.
 * `:has` is a Chrome selector and Chrome is what prints these.
 */
const SKILLS_ROW_CSS =
  '<style id="resume-skills-row">'
  + '.skills-row:not(:has(.section-soft-skills .skills-list li))'
  + '{grid-template-columns:minmax(0,1fr) !important}'
  + '</style>';

/**
 * Where a page is allowed to break.
 *
 * Two faults, both seen on finished resumes. A role's company and title sat at
 * the foot of a page with its bullets on the next one, which reads as a heading
 * for nothing. And the education section was cut in half by a boundary.
 *
 * Said as "keep this with what follows" rather than "never split this role": a
 * role with eight bullets SHOULD be allowed to break between bullet three and
 * four, and forbidding that would leave half a page empty every time. So the
 * header rows keep the first bullet with them, and the break falls after it.
 *
 * Class names, not structure, because the templates share names rather than
 * shapes - `job-title` appears in 36 of the 38, `achievements` in 36 - while
 * the wrapper around a role appears in 14. Listed rather than guessed at, and
 * a template that sets its own rule still wins: this stylesheet is written
 * before the template's own.
 */
const PAGE_BREAK_CSS =
  '<style id="resume-page-breaks">'
  // The header of a role, and anything printed with it.
  + '.job-title,.company-line,.job-header,.job-meta,.job-date,.company-name,'
  + '.entry-head,.entry-subline,.entry-location,.experience-meta,.experience-desc,'
  + '.job-description{break-inside:avoid;break-after:avoid;page-break-after:avoid}'
  // ...and the first bullet, so the header cannot be left behind alone.
  + '.achievements>li:first-child{break-before:avoid;page-break-before:avoid}'
  // Education is short and reads as one thing; it stays whole.
  + '.section-education,.education-item,.edu-item,.edu-header,.edu-degree,'
  + '.edu-institution{break-inside:avoid;page-break-inside:avoid}'
  + '</style>';

function renderTimeCss(): string {
  return (
    '<style id="resume-no-ligatures">*,*::before,*::after{font-variant-ligatures:none}</style>'
    + CONTACT_SEPARATOR_CSS
    + RELOCATED_SECTION_CSS
    + SKILLS_ROW_CSS
    // Chosen per document, which is why this is a function and not a constant.
    + skillGroupCss(pickSkillGroupLook())
    + PAGE_BREAK_CSS
  );
}

/**
 * Puts the rule inside the document rather than in front of it.
 *
 * The templates are whole HTML documents, and `<!DOCTYPE html>` has to be the
 * first thing in one - a stylesheet before it drops the browser into quirks
 * mode, where the box model changes and every template's layout shifts. So the
 * rule goes just after `<head>`, and only falls back to the front for a
 * template that is a bare fragment.
 */
function withDisabledLigatures(document: string): string {
  const css = renderTimeCss();
  for (const opening of [/<head\b[^>]*>/i, /<html\b[^>]*>/i]) {
    const match = document.match(opening);
    if (match?.index === undefined) continue;
    const at = match.index + match[0].length;
    return document.slice(0, at) + css + document.slice(at);
  }
  return css + document;
}

/** Prepends a template's separate stylesheet, if it has one. */
function assembleResumeDocument(template: Template, body: string): string {
  const styled = template.cssContent ? `<style>${template.cssContent}</style>${body}` : body;
  return withDisabledLigatures(styled);
}

/**
 * Turns the printed page into something a browser can show, WITHOUT changing
 * the document the PDF renderer sees.
 *
 * The body is given the exact content width `page.pdf()` prints into, so every
 * width-dependent decision a template makes - `column-count`, flex wrapping,
 * where a line breaks - resolves the same way it will in the PDF.
 *
 * WIDTH IS ALL IT SETS ON THE BODY, and that restraint is load-bearing. An
 * earlier version drew the page margins as a border on the body, which looked
 * right and was wrong: a border stops the first child's top margin collapsing
 * through the body, and `timeline-bars` pulls its header up with
 * `margin: -10px`. Measured, that put every element below it 10px out against
 * the PDF. Padding and vertical margins on the body break collapsing the same
 * way, so the page margins go on `html`, where they cannot reach the body's
 * own box.
 *
 * Appended last so it wins ties against the template's own `body` rules.
 */
function previewPageChrome(box: ResumePageBox): string {
  const { margin, pageWidthPx, pageHeightPx, contentWidthPx, contentHeightPx } = box;

  /* A document that asks for a page size other than the A4 `page.pdf()` is
     called with is laid out at its own size and then scaled to fit, centred.
     Mirror that instead of showing the user an unscaled page. */
  const fitToMediaBox =
    box.mediaScale === 1
      ? ''
      : `
      transform: translateY(${box.mediaOffsetYPx.toFixed(2)}px) scale(${box.mediaScale.toFixed(5)});
      transform-origin: top left;`;

  /* `vh` and friends resolve against the viewport, which off-page is the
     preview iframe rather than the printed page. Only templates that actually
     use viewport units need the correction, so only they get it: pinning
     `body > *` on every template would force a full-page box on wrappers that
     paint a background. */
  const viewportUnitFix = box.usesViewportUnits
    ? `
    body > * {
      min-height: ${contentHeightPx.toFixed(2)}px !important;
    }`
    : '';

  return `<style id="resume-preview-page">
    html {
      box-sizing: border-box;
      width: ${pageWidthPx}px;
      min-height: ${pageHeightPx}px;
      background: #ffffff;
      /* The page margins this template declares, taken from its own @page
         rule. On html, so the body's box is untouched: a border or padding on
         body would stop a first child's top margin collapsing through it and
         shift the whole document relative to the print. */
      padding: ${margin.top} ${margin.right} ${margin.bottom} ${margin.left};
      /* Print clips to the page area, so an element that bleeds outside the
         margins - a header with a negative margin, say - is cut off at the
         margin edge rather than painted into it. A clip-path reproduces that
         without the layout side effects overflow would bring: a clip on body
         would open a block formatting context and stop the first child's top
         margin collapsing, moving the whole document down instead. */
      clip-path: inset(${margin.top} ${margin.right} ${margin.bottom} ${margin.left});
      /* page.pdf runs with printBackground: true, so colours must not be
         dropped the way a screen render would drop them. */
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;${fitToMediaBox}
    }
    body {
      width: ${contentWidthPx.toFixed(2)}px !important;
      min-height: ${contentHeightPx.toFixed(2)}px !important;
      margin-left: auto !important;
      margin-right: auto !important;
    }${viewportUnitFix}
  </style>`;
}

export function generateTemplatePreviewHTML(template: Template): string {
  const renderData = prepareResumeRenderData(SAMPLE_PROFILE);
  const document = assembleResumeDocument(template, renderTemplateBody(template, renderData));
  return `${document}${previewPageChrome(resolveTemplatePageBox(template))}`;
}

export async function getGeneratedPDFPath(filename: string): Promise<string | null> {
  return getGeneratedFilePath(filename);
}
