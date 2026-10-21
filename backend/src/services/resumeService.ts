import type { AiChoice } from '../config/aiPreferences';
import { describeAiChoice } from '../config/aiPreferences';
import { Profile } from '../types/profile';
import type { AIProvider, JobAnalysis, RawNestedJobAnalysis, TailoredContent } from '../types/template';
import { createPromptCompletion, DEFAULT_PROVIDER } from './ai';
import { AIProviderError, isAIProviderError } from './ai/errors';
import {
  analysisCacheKey,
  readAnalysisCache,
  writeAnalysisCache,
} from './ai/analysisCache';
import { resolvePromptByExactId } from './promptService';
import {
  HARD_SKILL_CATEGORIES,
  HardSkillCategory as LibraryHardSkillCategory,
  readHardSkillPriorityMap,
  readHardSkillRecords,
  readSkills,
} from '../database/skillsDatabase';
import { moveCaseInsensitiveMatches, uniqueCaseInsensitive } from '../utils/array';
import { extractJSON } from '../utils/json';
import { removeDuplicateSubstrings, ensureMinTechSkills } from './utils/resumeBuilder';
import { collectJobKeywords, findUncoveredKeywords } from './utils/keywordCoverage';
import { conceptToolOptions } from './utils/hardSkillSelection';
import { normalizeDashes } from './utils/dashes';
import { headlineWithTargetRole, shortRoleTitle } from './utils/roleTitle';
import { bannedTermsIn, plainLanguage } from './utils/plainLanguage';
import {
  containsTerm,
  measurePlacement,
  placementFloor,
  renderedProse,
  renderedSkillBlock,
  type PlacementReport,
} from './utils/placementCoverage';
import {
  MAX_SKILL_BLOCK_SIZE,
  MAX_SKILL_GROUPS,
  bulletsNamingATool,
  findAnachronisms,
  findBrokenBullets,
  findGarbledMetrics,
  recentRolesWithoutScope,
  rolesWithoutScale,
  tidySkillGroups,
  withoutValuesPhrases,
  bulletsWithBoltedSoftSkills,
  bulletsWithoutAnOutcome,
  repeatedPhrases,
} from './utils/resumeQuality';
import {
  partitionSkills,
  validateHardSkill,
  validateSoftSkill,
  REJECTION_DETAIL,
  type SkillVerdict,
} from './utils/skillValidation';
import {
  extractConceptKeywords,
  isConceptSkill,
  isRedundantWithLibraryTerm,
  looksLikeUnlistedHardSkill,
  selectHardSkills,
} from './utils/hardSkillSelection';
import { supplimentSoftSkills } from './utils/config';
import {
  DEFAULT_ANALYZE_JOB_PROMPT_ID,
  DEFAULT_COVER_LETTER_PROMPT_ID,
  DEFAULT_RESUME_PROMPT_ID,
  getProfileHardSkillOrdering,
} from './profileService';

/**
 * Resume and cover-letter domain logic.
 *
 * Everything about HOW a model is reached now lives in `services/ai`; this
 * module only decides what to ask, and how to read the answer. The `.env` load
 * that used to sit here (with `override: true`, quietly beating the process
 * environment for every importer) belongs to the entry point and lives in
 * index.ts.
 */

const technicalSkills = readSkills('hard');
const softSkills = readSkills('soft');
let hardSkillPriorityMap = readHardSkillPriorityMap();
let hardSkillRecords = readHardSkillRecords();
const resumeBuildTiming = new WeakMap<JobAnalysis, { firstCallEndedAt: bigint }>();

function formatDuration(start: bigint, end: bigint): string {
  return `${(Number(end - start) / 1_000_000_000).toFixed(2)}s`;
}

export function refreshSkillCaches(): void {
  const nextTech = readSkills('hard');
  const nextSoft = readSkills('soft');
  const nextHardSkillPriorityMap = readHardSkillPriorityMap();
  const nextHardSkillRecords = readHardSkillRecords();

  technicalSkills.length = 0;
  technicalSkills.push(...nextTech);

  softSkills.length = 0;
  softSkills.push(...nextSoft);

  hardSkillPriorityMap = nextHardSkillPriorityMap;
  hardSkillRecords = nextHardSkillRecords;
}

// Lazy initialization to ensure env vars are loaded first

function extractTechSkills(text: string): string[] {
  return technicalSkills.filter((item: string) => {
    const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const regex =
      item === "Go"
        ? new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`) // case-sensitive
        : new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i"); // case-insensitive

    return regex.test(text);
  });
}

function extractSoftSkills(text: string): string[] {
  return softSkills.filter((item: string) => {
    const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i");
    return regex.test(text);
  });
}

type SkillReconciliationOptions = {
  extractedSkills: string[];
  modelSkills: string[];
  referenceSkills: string[];
  supplementSkills: string[];
  minimumCount: number;
  finalizeSkills?: (skills: string[]) => string[];
};

type SkillReconciliationResult = {
  confirmedSkills: string[];
  unconfirmedSkills: string[];
};

function getTailoringSourceText(jobAnalysis?: JobAnalysis): string {
  const directSource = jobAnalysis?.sourceJobDescription?.trim();
  if (directSource) {
    return directSource;
  }

  return [
    getJobAnalysisTitle(jobAnalysis),
    ...getTechnicalSkills(jobAnalysis),
    ...getRequiredSkills(jobAnalysis),
    ...getPreferredSkills(jobAnalysis),
    ...getSkillTools(jobAnalysis),
    ...getTechnologies(jobAnalysis),
    ...getProtocols(jobAnalysis),
    ...getMethodologies(jobAnalysis),
    ...getArchitecturePatterns(jobAnalysis),
    ...getKeywordChecklist(jobAnalysis),
    ...getResponsibilities(jobAnalysis),
    ...getDomainKnowledge(jobAnalysis),
    ...getSoftSkills(jobAnalysis),
  ]
    .filter((value) => value.trim().length > 0)
    .join('\n');
}

function reconcileSkillBuckets({
  extractedSkills,
  modelSkills,
  referenceSkills,
  supplementSkills,
  minimumCount,
  finalizeSkills,
}: SkillReconciliationOptions): SkillReconciliationResult {
  const confirmedSkills = [...extractedSkills];
  const unconfirmedSkills = [...modelSkills];

  moveCaseInsensitiveMatches(referenceSkills, unconfirmedSkills, confirmedSkills);

  const uniqueConfirmedSkills = uniqueCaseInsensitive(ensureMinTechSkills(
    removeDuplicateSubstrings(uniqueCaseInsensitive(confirmedSkills)),
    supplementSkills,
    minimumCount
  ));

  let finalized = finalizeSkills ? finalizeSkills(uniqueConfirmedSkills) : uniqueConfirmedSkills;

  /**
   * The fill above counts RAW names, and `finalizeSkills` then condenses and
   * deduplicates them - so a job that asked four different ways for the same
   * trait ("excellent communication skills", "communication and collaboration",
   * "communicate clearly with stakeholders") could be filled to the minimum and
   * then collapse back under it, leaving a section with two entries in it.
   *
   * Topping up against the finished list instead closes that: a supplement is
   * kept only if it survives finalization as a NEW entry, so one that condenses
   * onto something already there is skipped rather than silently lost.
   */
  if (finalizeSkills && finalized.length < minimumCount) {
    for (const candidate of supplementSkills) {
      if (finalized.length >= minimumCount) break;
      const next = finalizeSkills([...finalized, candidate]);
      if (next.length > finalized.length) finalized = next;
    }
  }

  return {
    confirmedSkills: finalized,
    unconfirmedSkills: uniqueCaseInsensitive(unconfirmedSkills),
  };
}

function capitalizeFirstCharacter(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

const MAX_ROLE_BRIEF_LENGTH = 900;
const MIN_EXPERIENCE_SKILLS = 10;
const MAX_SOFT_SKILLS = 10;

/**
 * And the floor, which is the half that was missing.
 *
 * ASKED FOR: "I need around 8 to 10 soft skills in soft skill section, at least
 * 8." The ceiling has been 10 throughout; nothing ever said how few was too
 * few, and for several rounds the answer was none at all - the list was built,
 * validated, capped, and then thrown away one line later.
 *
 * Reported rather than padded. The entries come from the posting and the
 * library, and inventing two more to reach eight would put words on the page
 * that nothing asked for.
 */
const MIN_SOFT_SKILLS = 8;
const SOFT_SKILL_SIGNALS = [
  'accountability',
  'communication',
  'collaboration',
  'mindset',
  'mentality',
  'ownership',
  'reliability',
  'resilient',
  'supportive',
  'eager to learn',
  'adaptability',
  'autonomy',
  'independent',
  'self-directed',
  'adapt',
  'ambiguity',
  'passion',
  'attention to detail',
  'team player',
  'cross-functional',
  'stakeholder',
  'leadership',
  'problem-solving',
  'product-minded',
  'driving clarity',
  'transparency',
];
const ATS_SOFT_SKILL_RULES: Array<{ canonical: string; patterns: string[] }> = [
  { canonical: 'Reliability', patterns: ['reliability', 'reliable'] },
  { canonical: 'Resilient', patterns: ['resilient', 'resilience'] },
  { canonical: 'Supportive', patterns: ['supportive', 'support'] },
  { canonical: 'Communication', patterns: ['communication', 'communicate'] },
  { canonical: 'Collaboration skills', patterns: ['collaboration', 'collaborative'] },
  { canonical: 'Cross-functional team', patterns: ['cross-functional', 'cross functional'] },
  { canonical: 'Strong problem-solving skills', patterns: ['problem-solving', 'problem solving'] },
  { canonical: 'Eager to learn', patterns: ['eager to learn', 'lifelong learning'] },
  { canonical: 'Accountability', patterns: ['accountability', 'accountable'] },
];
type HardSkillCategory =
  | 'backend'
  | 'frontend'
  | 'databases'
  | 'cloud-devops'
  | 'testing-automation'
  | 'ai-ml'
  | 'tools-methodologies'
  | 'other';
type HardSkillDefinition = {
  display: string;
  category: HardSkillCategory;
  aliases: string[];
  priority: number;
};

type HardSkillSeed = {
  display: string;
  aliases?: string[];
};

const HARD_SKILL_CATEGORY_SEEDS: Array<{
  category: Exclude<HardSkillCategory, 'other'>;
  skills: HardSkillSeed[];
}> = [
  {
    category: 'backend',
    skills: [
      { display: 'Python', aliases: ['python'] },
      { display: 'FastAPI', aliases: ['fastapi', 'fast api'] },
      { display: 'Django', aliases: ['django'] },
      { display: 'Django REST Framework', aliases: ['django rest framework', 'drf'] },
      { display: 'Flask', aliases: ['flask'] },
      { display: 'Pydantic', aliases: ['pydantic'] },
      { display: 'Node.js', aliases: ['node.js', 'nodejs', 'node'] },
      { display: 'Express.js', aliases: ['express.js', 'expressjs', 'express'] },
      { display: 'NestJS', aliases: ['nestjs', 'nest.js', 'nest'] },
      { display: 'Fastify', aliases: ['fastify'] },
      { display: 'Koa', aliases: ['koa'] },
      { display: 'Ruby on Rails', aliases: ['ruby on rails', 'rails'] },
      { display: 'Go', aliases: ['go', 'golang'] },
      { display: 'Gin', aliases: ['gin'] },
      { display: 'Echo', aliases: ['echo'] },
      { display: 'Java', aliases: ['java'] },
      { display: 'Spring Boot', aliases: ['spring boot', 'springboot'] },
      { display: 'Spring Framework', aliases: ['spring framework', 'spring'] },
      { display: 'C#', aliases: ['c#'] },
      { display: '.NET Core', aliases: ['.net core', 'dotnet core'] },
      { display: 'PHP', aliases: ['php'] },
      { display: 'Laravel', aliases: ['laravel'] },
      { display: 'Symfony', aliases: ['symfony'] },
      { display: 'Microservices Architecture', aliases: ['microservices architecture', 'microservices', 'microservice architecture'] },
      { display: 'Event-Driven Architecture', aliases: ['event-driven architecture', 'event driven architecture'] },
      { display: 'Domain-Driven Design (DDD)', aliases: ['domain-driven design', 'domain driven design', 'ddd'] },
      { display: 'gRPC', aliases: ['grpc'] },
      { display: 'WebSockets', aliases: ['websockets', 'websocket'] },
      { display: 'Server-Sent Events', aliases: ['server-sent events', 'server sent events', 'sse'] },
      { display: 'Celery', aliases: ['celery'] },
      { display: 'RabbitMQ', aliases: ['rabbitmq'] },
      { display: 'Apache Kafka', aliases: ['apache kafka', 'kafka'] },
      { display: 'RESTful APIs', aliases: ['restful apis', 'restful api', 'rest apis', 'rest api'] },
      { display: 'GraphQL', aliases: ['graphql'] },
      { display: 'Asynchronous Processing', aliases: ['asynchronous processing', 'async processing'] },
      { display: 'API Gateway Design', aliases: ['api gateway design', 'api gateway'] },
      { display: 'Serverless Functions', aliases: ['serverless functions', 'serverless function'] },
      { display: 'Background Jobs', aliases: ['background jobs', 'background job'] },
      { display: 'Message Queues', aliases: ['message queues', 'message queue'] },
    ],
  },
  {
    category: 'frontend',
    skills: [
      { display: 'React.js', aliases: ['react.js', 'reactjs', 'react'] },
      { display: 'React Hooks', aliases: ['react hooks', 'react hook'] },
      { display: 'Angular', aliases: ['angular'] },
      { display: 'Vue.js', aliases: ['vue.js', 'vuejs', 'vue'] },
      { display: 'Next.js', aliases: ['next.js', 'nextjs', 'next'] },
      { display: 'Nuxt.js', aliases: ['nuxt.js', 'nuxtjs', 'nuxt'] },
      { display: 'TypeScript', aliases: ['typescript', 'ts'] },
      { display: 'JavaScript', aliases: ['javascript', 'js', 'javascript (es6+)', 'es6+'] },
      { display: 'Redux', aliases: ['redux'] },
      { display: 'Redux Toolkit', aliases: ['redux toolkit'] },
      { display: 'Zustand', aliases: ['zustand'] },
      { display: 'MobX', aliases: ['mobx'] },
      { display: 'RxJS', aliases: ['rxjs'] },
      { display: 'HTML5', aliases: ['html5', 'html'] },
      { display: 'CSS3', aliases: ['css3', 'css'] },
      { display: 'SCSS', aliases: ['scss'] },
      { display: 'SASS', aliases: ['sass'] },
      { display: 'TailwindCSS', aliases: ['tailwindcss', 'tailwind css', 'tailwind'] },
      { display: 'Bootstrap', aliases: ['bootstrap'] },
      { display: 'Material UI (MUI)', aliases: ['material ui', 'material-ui', 'mui'] },
      { display: 'Ant Design', aliases: ['ant design', 'antd'] },
      { display: 'Chakra UI', aliases: ['chakra ui', 'chakra-ui'] },
      { display: 'Styled Components', aliases: ['styled components', 'styled-components'] },
      { display: 'Emotion', aliases: ['emotion'] },
      { display: 'Chart.js', aliases: ['chart.js', 'chartjs'] },
      { display: 'D3.js', aliases: ['d3.js', 'd3js', 'd3'] },
      { display: 'Three.js', aliases: ['three.js', 'threejs'] },
      { display: 'Responsive Design', aliases: ['responsive design'] },
      { display: 'Mobile-First Design', aliases: ['mobile-first design', 'mobile first design'] },
      { display: 'Progressive Web Apps (PWA)', aliases: ['progressive web apps', 'progressive web app', 'pwa'] },
      { display: 'Webpack', aliases: ['webpack'] },
      { display: 'Vite', aliases: ['vite'] },
      { display: 'Rollup', aliases: ['rollup'] },
      { display: 'Babel', aliases: ['babel'] },
      { display: 'ESLint', aliases: ['eslint', 'es lint'] },
      { display: 'Prettier', aliases: ['prettier'] },
    ],
  },
  {
    category: 'databases',
    skills: [
      { display: 'PostgreSQL', aliases: ['postgresql', 'postgres', 'psql'] },
      { display: 'MySQL', aliases: ['mysql'] },
      { display: 'SQL Server', aliases: ['sql server', 'mssql'] },
      { display: 'Oracle Database', aliases: ['oracle database', 'oracle'] },
      { display: 'MongoDB', aliases: ['mongodb', 'mongo'] },
      { display: 'DynamoDB', aliases: ['dynamodb'] },
      { display: 'Cassandra', aliases: ['cassandra'] },
      { display: 'CouchDB', aliases: ['couchdb'] },
      { display: 'Redis', aliases: ['redis'] },
      { display: 'Memcached', aliases: ['memcached'] },
      { display: 'Firebase Firestore', aliases: ['firebase firestore', 'firestore'] },
      { display: 'Elasticsearch', aliases: ['elasticsearch', 'elastic search'] },
      { display: 'Apache Solr', aliases: ['apache solr', 'solr'] },
      { display: 'InfluxDB', aliases: ['influxdb'] },
      { display: 'TimescaleDB', aliases: ['timescaledb'] },
      { display: 'Neo4j', aliases: ['neo4j'] },
      { display: 'ETL Pipelines', aliases: ['etl pipelines', 'etl pipeline', 'etl'] },
      { display: 'Data Warehousing', aliases: ['data warehousing', 'data warehouse'] },
      { display: 'Data Lakes', aliases: ['data lakes', 'data lake'] },
      { display: 'SQLAlchemy', aliases: ['sqlalchemy'] },
      { display: 'Prisma', aliases: ['prisma'] },
      { display: 'TypeORM', aliases: ['typeorm'] },
      { display: 'Sequelize', aliases: ['sequelize'] },
      { display: 'Mongoose', aliases: ['mongoose'] },
      { display: 'ActiveRecord', aliases: ['activerecord', 'active record'] },
      { display: 'Query Optimization', aliases: ['query optimization', 'query optimisation'] },
      { display: 'Database Indexing', aliases: ['database indexing', 'indexing'] },
      { display: 'Sharding', aliases: ['sharding'] },
      { display: 'Replication', aliases: ['replication'] },
      { display: 'Data Modeling', aliases: ['data modeling', 'data modelling'] },
      { display: 'Data Caching', aliases: ['data caching'] },
      { display: 'Database Migration', aliases: ['database migration', 'database migrations'] },
      { display: 'ACID Transactions', aliases: ['acid transactions', 'acid transaction', 'acid'] },
    ],
  },
  {
    category: 'cloud-devops',
    skills: [
      { display: 'AWS', aliases: ['aws', 'amazon web services'] },
      { display: 'AWS Lambda', aliases: ['aws lambda', 'lambda'] },
      { display: 'Amazon EKS', aliases: ['amazon eks', 'eks'] },
      { display: 'Amazon ECS', aliases: ['amazon ecs', 'ecs'] },
      { display: 'AWS Fargate', aliases: ['aws fargate', 'fargate'] },
      { display: 'Amazon EC2', aliases: ['amazon ec2', 'ec2'] },
      { display: 'Amazon S3', aliases: ['amazon s3', 's3'] },
      { display: 'Amazon CloudFront', aliases: ['amazon cloudfront', 'cloudfront'] },
      { display: 'Amazon RDS', aliases: ['amazon rds', 'rds'] },
      { display: 'Amazon API Gateway', aliases: ['amazon api gateway', 'api gateway'] },
      { display: 'CloudWatch', aliases: ['cloudwatch'] },
      { display: 'SageMaker', aliases: ['sagemaker'] },
      { display: 'Step Functions', aliases: ['step functions', 'aws step functions'] },
      { display: 'SNS', aliases: ['sns', 'amazon sns'] },
      { display: 'SQS', aliases: ['sqs', 'amazon sqs'] },
      { display: 'IAM', aliases: ['iam', 'aws iam'] },
      { display: 'VPC', aliases: ['vpc', 'amazon vpc'] },
      { display: 'Route 53', aliases: ['route 53', 'route53'] },
      { display: 'Google Cloud Platform (GCP)', aliases: ['google cloud platform', 'gcp', 'google cloud'] },
      { display: 'Microsoft Azure', aliases: ['microsoft azure', 'azure'] },
      { display: 'Docker', aliases: ['docker'] },
      { display: 'Docker Compose', aliases: ['docker compose'] },
      { display: 'Kubernetes', aliases: ['kubernetes', 'k8s', 'kube'] },
      { display: 'Helm', aliases: ['helm'] },
      { display: 'OpenShift', aliases: ['openshift'] },
      { display: 'Terraform', aliases: ['terraform'] },
      { display: 'CloudFormation', aliases: ['cloudformation', 'aws cloudformation'] },
      { display: 'Ansible', aliases: ['ansible'] },
      { display: 'Puppet', aliases: ['puppet'] },
      { display: 'Chef', aliases: ['chef'] },
      { display: 'GitHub Actions', aliases: ['github actions'] },
      { display: 'Jenkins', aliases: ['jenkins'] },
      { display: 'GitLab CI/CD', aliases: ['gitlab ci/cd', 'gitlab ci'] },
      { display: 'CircleCI', aliases: ['circleci', 'circle ci'] },
      { display: 'Travis CI', aliases: ['travis ci'] },
      { display: 'ArgoCD', aliases: ['argocd', 'argo cd'] },
      { display: 'Flux', aliases: ['flux'] },
      { display: 'CI/CD Pipelines', aliases: ['ci/cd pipelines', 'ci/cd pipeline', 'cicd pipelines'] },
      { display: 'Infrastructure as Code (IaC)', aliases: ['infrastructure as code', 'iac'] },
      { display: 'Grafana', aliases: ['grafana'] },
      { display: 'Prometheus', aliases: ['prometheus'] },
      { display: 'Datadog', aliases: ['datadog'] },
      { display: 'New Relic', aliases: ['new relic'] },
      { display: 'ELK Stack', aliases: ['elk stack', 'elk'] },
      { display: 'Istio', aliases: ['istio'] },
      { display: 'Linkerd', aliases: ['linkerd'] },
      { display: 'Load Balancing', aliases: ['load balancing', 'load balancer'] },
      { display: 'Auto Scaling', aliases: ['auto scaling', 'auto-scaling'] },
    ],
  },
  {
    category: 'testing-automation',
    skills: [
      { display: 'PyTest', aliases: ['pytest', 'py test'] },
      { display: 'Jest', aliases: ['jest'] },
      { display: 'JUnit', aliases: ['junit'] },
      { display: 'TestNG', aliases: ['testng'] },
      { display: 'Mocha', aliases: ['mocha'] },
      { display: 'Chai', aliases: ['chai'] },
      { display: 'Jasmine', aliases: ['jasmine'] },
      { display: 'Cypress', aliases: ['cypress'] },
      { display: 'Playwright', aliases: ['playwright'] },
      { display: 'Selenium', aliases: ['selenium'] },
      { display: 'Puppeteer', aliases: ['puppeteer'] },
      { display: 'WebDriverIO', aliases: ['webdriverio', 'webdriver io'] },
      { display: 'Postman', aliases: ['postman'] },
      { display: 'Insomnia', aliases: ['insomnia'] },
      { display: 'REST Assured', aliases: ['rest assured'] },
      { display: 'Locust', aliases: ['locust'] },
      { display: 'k6', aliases: ['k6'] },
      { display: 'JMeter', aliases: ['jmeter'] },
      { display: 'Artillery', aliases: ['artillery'] },
      { display: 'Unit Testing', aliases: ['unit testing'] },
      { display: 'Integration Testing', aliases: ['integration testing'] },
      { display: 'End-to-End Testing (E2E)', aliases: ['end-to-end testing', 'end to end testing', 'e2e'] },
      { display: 'API Testing', aliases: ['api testing'] },
      { display: 'Test-Driven Development (TDD)', aliases: ['test-driven development', 'test driven development', 'tdd'] },
      { display: 'Behavior-Driven Development (BDD)', aliases: ['behavior-driven development', 'behaviour-driven development', 'bdd'] },
      { display: 'Performance Testing', aliases: ['performance testing'] },
      { display: 'Security Testing', aliases: ['security testing'] },
      { display: 'Penetration Testing', aliases: ['penetration testing', 'pen testing', 'pentesting'] },
      { display: 'Code Coverage', aliases: ['code coverage'] },
      { display: 'SonarQube', aliases: ['sonarqube', 'sonar qube'] },
      { display: 'Quality Assurance', aliases: ['quality assurance', 'qa'] },
      { display: 'Test Automation Frameworks', aliases: ['test automation frameworks', 'test automation framework'] },
    ],
  },
  {
    category: 'ai-ml',
    skills: [
      { display: 'OpenAI GPT APIs', aliases: ['openai gpt apis', 'openai api', 'gpt api', 'gpt apis'] },
      { display: 'ChatGPT', aliases: ['chatgpt'] },
      { display: 'Claude API', aliases: ['claude api', 'anthropic api'] },
      { display: 'LangChain', aliases: ['langchain'] },
      { display: 'LlamaIndex', aliases: ['llamaindex', 'llama index'] },
      { display: 'Hugging Face Transformers', aliases: ['hugging face transformers', 'transformers', 'huggingface transformers'] },
      { display: 'TensorFlow', aliases: ['tensorflow', 'tensor flow'] },
      { display: 'PyTorch', aliases: ['pytorch', 'py torch'] },
      { display: 'Keras', aliases: ['keras'] },
      { display: 'Scikit-learn', aliases: ['scikit-learn', 'sklearn'] },
      { display: 'XGBoost', aliases: ['xgboost'] },
      { display: 'LightGBM', aliases: ['lightgbm'] },
      { display: 'SpaCy', aliases: ['spacy'] },
      { display: 'NLTK', aliases: ['nltk'] },
      { display: 'Pandas', aliases: ['pandas'] },
      { display: 'NumPy', aliases: ['numpy'] },
      { display: 'Matplotlib', aliases: ['matplotlib'] },
      { display: 'Seaborn', aliases: ['seaborn'] },
      { display: 'Jupyter Notebooks', aliases: ['jupyter notebooks', 'jupyter notebook', 'jupyter'] },
      { display: 'FastAPI AI Agents', aliases: ['fastapi ai agents', 'fastapi ai agent'] },
      { display: 'Prompt Engineering', aliases: ['prompt engineering'] },
      { display: 'Model Fine-tuning', aliases: ['model fine-tuning', 'model fine tuning', 'fine-tuning', 'fine tuning'] },
      { display: 'RAG (Retrieval-Augmented Generation)', aliases: ['rag', 'retrieval-augmented generation', 'retrieval augmented generation'] },
      { display: 'Pinecone', aliases: ['pinecone'] },
      { display: 'Chroma', aliases: ['chroma'] },
      { display: 'Weaviate', aliases: ['weaviate'] },
      { display: 'MLOps', aliases: ['mlops'] },
      { display: 'Model Deployment', aliases: ['model deployment'] },
      { display: 'Computer Vision', aliases: ['computer vision'] },
      { display: 'Natural Language Processing (NLP)', aliases: ['natural language processing', 'nlp'] },
      { display: 'Deep Learning', aliases: ['deep learning'] },
      { display: 'Machine Learning', aliases: ['machine learning', 'ml'] },
    ],
  },
  {
    category: 'tools-methodologies',
    skills: [
      { display: 'Git', aliases: ['git'] },
      { display: 'GitHub', aliases: ['github'] },
      { display: 'GitLab', aliases: ['gitlab'] },
      { display: 'Bitbucket', aliases: ['bitbucket'] },
      { display: 'Jira', aliases: ['jira'] },
      { display: 'Asana', aliases: ['asana'] },
      { display: 'Trello', aliases: ['trello'] },
      { display: 'Linear', aliases: ['linear'] },
      { display: 'Monday.com', aliases: ['monday.com', 'monday'] },
      { display: 'Confluence', aliases: ['confluence'] },
      { display: 'Notion', aliases: ['notion'] },
      { display: 'Swagger/OpenAPI', aliases: ['swagger/openapi', 'swagger', 'openapi'] },
      { display: 'Figma', aliases: ['figma'] },
      { display: 'Sketch', aliases: ['sketch'] },
      { display: 'Adobe XD', aliases: ['adobe xd', 'xd'] },
      { display: 'VSCode', aliases: ['vscode', 'vs code'] },
      { display: 'PyCharm', aliases: ['pycharm'] },
      { display: 'IntelliJ IDEA', aliases: ['intellij idea', 'intellij'] },
      { display: 'WebStorm', aliases: ['webstorm'] },
      { display: 'Sublime Text', aliases: ['sublime text', 'sublime'] },
      { display: 'Vim', aliases: ['vim'] },
      { display: 'Agile', aliases: ['agile'] },
      { display: 'Scrum', aliases: ['scrum'] },
      { display: 'Kanban', aliases: ['kanban'] },
      { display: 'DevOps', aliases: ['devops'] },
      { display: 'Microservices', aliases: ['microservices'] },
      { display: 'Clean Architecture', aliases: ['clean architecture'] },
      { display: 'SOLID Principles', aliases: ['solid principles', 'solid'] },
      { display: 'Design Patterns', aliases: ['design patterns', 'design pattern'] },
      { display: 'Code Review', aliases: ['code review', 'code reviews'] },
      { display: 'Pair Programming', aliases: ['pair programming'] },
      { display: 'npm', aliases: ['npm'] },
      { display: 'yarn', aliases: ['yarn'] },
      { display: 'pip', aliases: ['pip'] },
      { display: 'poetry', aliases: ['poetry'] },
      { display: 'Maven', aliases: ['maven'] },
      { display: 'Gradle', aliases: ['gradle'] },
    ],
  },
];

const HARD_SKILL_DEFINITIONS: HardSkillDefinition[] = HARD_SKILL_CATEGORY_SEEDS.flatMap(
  ({ category, skills }) =>
    skills.map((skill, index) => ({
      display: skill.display,
      category,
      aliases: uniqueCaseInsensitive([skill.display, ...(skill.aliases ?? [])]).map(normalizeHardSkillAlias),
      priority: index,
    }))
);

const HARD_SKILL_ALIAS_MAP = new Map<string, { display: string; category: HardSkillCategory; priority: number }>();
for (const definition of HARD_SKILL_DEFINITIONS) {
  for (const alias of definition.aliases) {
    HARD_SKILL_ALIAS_MAP.set(alias, {
      display: definition.display,
      category: definition.category,
      priority: definition.priority,
    });
  }
}

const HARD_SKILL_CATEGORY_WEIGHT: Record<HardSkillCategory, number> = {
  backend: 0,
  frontend: 1,
  databases: 2,
  'cloud-devops': 3,
  'testing-automation': 4,
  'ai-ml': 5,
  'tools-methodologies': 6,
  other: 7,
};
/**
 * Appended to the tailor-resume turn.
 *
 * It used to say the opposite: "do not decide, generate, or return skills",
 * because code decided every list from the skill library and overwrote
 * whatever came back. The library is no longer consulted for what a resume
 * prints, so the same slot now carries the instruction the pipeline actually
 * depends on - return the block, grouped - and says plainly that it is printed
 * unchanged. It lives here rather than in the stored prompt so an admin
 * editing the prompt cannot drop the field the renderer reads.
 */
/*
 * THE SOFT-SKILL GROUP HEADING USED TO BE DRAWN HERE, from a list of eight, so
 * that a batch of resumes did not all end their skills block with the words
 * "Professional Skills". The group it headed is gone: the operator asked for no
 * soft skills in the skills block at all - they are unprovable adjectives in a
 * list - so they are shown through the bullets instead, where SOFT SKILLS ARE
 * PROSE already required them. The heading, the draw, the `SOFT_SKILL_HEADING`
 * pin and the `[[softSkillGroupHeading]]` prompt value went with it.
 */

/**
 * What the draft is short of, and the revision that asks for it.
 *
 * WHY IT IS NOT JUST FIGURES ANY MORE. The second call was built for the
 * five-figure floor. A scan of a finished resume then came back at 69% with
 * twenty-two hard skills missing, and they were all the same KIND of term:
 * "Artificial intelligence", "Full-stack development", "Web applications",
 * "Mobile application development", "Personalized learning" - capabilities
 * rather than products. Traced through the pipeline, every one of them reached
 * the prompt, on the concept checklist or the keyword one. Nothing was missing
 * upstream; the model simply did not write them, and only the figure count was
 * enforced, so nothing asked twice.
 *
 * A term the scanner counts and the page does not carry is the cheapest point
 * lost in this whole pipeline: the words cost nothing and there is room.
 *
 * WHAT THE REVISION MAY NOT DO. Invent a domain. A term naming an industry the
 * candidate has not worked in - "clinical documentation" on a banking engineer -
 * stays missing, and the instruction says so, because rule 3 is the one part of
 * this that protects the person whose name is on the page.
 */
type CoverageGap = {
  missingTerms: string[];
  /** The missing terms that are worth a second model call on their own. */
  missingImportant: string[];
  /** Of those, the soft skills, which now have nowhere else to appear. */
  missingSoft: string[];
  /**
   * On the page, in the skills block, and in no sentence.
   *
   * Not missing - that is the point of counting them apart - but worth a line
   * in the log, because the size of this list is the size of the mistake the
   * prose-only measurement used to make.
   */
  inBlockOnly: string[];
  figures: number;
  short: boolean;
  reason: string;
};

/**
 * How many ordinary terms have to be missing before the call is worth making.
 *
 * MEASURED, not guessed. The first version revised whenever ANYTHING was
 * missing, and with the keyword floor at 100% of a 25-45 term checklist that is
 * nearly every resume: a batch of 500 went from 0.84 hours of working time to
 * 2.21. One stray term is worth a fraction of a point and cost a whole call.
 */
const REVISION_MISSING_FLOOR = 3;

/**
 * And how many missing SOFT skills are worth it, which is fewer.
 *
 * WHY THEY GET THEIR OWN FLOOR. They used to be pooled with everything else, so
 * a resume missing four soft skills and nothing else never bought the call -
 * and since the skills block stopped carrying a group of them, a soft skill
 * that is not in a bullet is not on the resume at all. Measured over the batch
 * that prompted this: soft-skill presence fell from 8.8 terms per resume to
 * 6.8 when the group went, and the bullets picked up less than a third of what
 * the block had been carrying.
 *
 * TWO, NOT ONE, because the call costs money and time - a batch of 500 went
 * from 0.84 hours to 2.21 when an earlier version revised on any single
 * missing term. Most of the resumes this now catches were already being
 * revised for something else, so it is one call either way; what changes is
 * that the call is TOLD about the soft skills.
 */
const SOFT_SKILL_MISSING_FLOOR = 2;

function measureCoverageGap(
  content: TailoredContent,
  jobAnalysis?: JobAnalysis
): CoverageGap {
  const prose = renderedProse(content);
  const wanted = normalizeSkillsList([
    ...getProseChecklist(jobAnalysis),
    ...getSoftSkills(jobAnalysis),
  ]);

  /*
   * MISSING MEANS MISSING FROM THE PAGE, not missing from the sentences.
   *
   * This used to ask `renderedProse` alone, and the checklist it asks is not a
   * prose checklist: `getKeywordChecklist` reads the posting's tools,
   * technologies and protocols along with its ideas, so most of what is on it
   * belongs in the skills block and is PUT there, correctly, by the model.
   *
   * MEASURED on a posting naming Azure, GCP, Bash, LLMs and MCP: a draft that
   * had done everything right - every technology in the block, bullets about
   * work - was scored as missing 30 of 30 terms, SIXTEEN of them sitting in its
   * own skills block. That list is what the revision call receives. It is told
   * a bullet may carry two or three of these and that a role may not exceed
   * eight bullets, so the terms genuinely absent - "artificial intelligence",
   * the soft skills, the concepts that have nowhere else to go - were
   * competing for bullet space against sixteen that were already printed.
   *
   * The prose-only number is still measured and still reported, by
   * `reportPlacement`, which answers the different question the prompt's own
   * 90% rule asks: how much of this was written into a sentence.
   */
  const block = renderedSkillBlock(content);
  const missingTerms = wanted.filter(
    (term) => !containsTerm(prose, term) && !containsTerm(block, term)
  );
  const inBlockOnly = wanted.filter(
    (term) => !containsTerm(prose, term) && containsTerm(block, term)
  );
  // Bullets only, matching the floor's own wording: "five measurable results in
  // bullet points". The summary is 50 words and contributes at most one.
  const figures = countFigures({ experience: content.experience });

  /*
   * The terms a missing one of which is worth the call by itself: the five this
   * posting leans on, and the concepts - which is the class a scan reported
   * twenty-two of missing at once. Everything else has to reach a count.
   */
  const important = new Set(
    normalizeSkillsList([...focusSkills(jobAnalysis), ...getConceptKeywords(jobAnalysis)])
      .map((term) => term.toLowerCase())
  );
  const missingImportant = missingTerms.filter((term) => important.has(term.toLowerCase()));

  // The soft skills among them, counted apart: with no group in the skills
  // block, a bullet is the only place they can appear.
  const softWanted = new Set(
    withoutValuesPhrases(normalizeSkillsList(getSoftSkills(jobAnalysis))).terms.map((term) => term.toLowerCase())
  );
  const missingSoft = missingTerms.filter((term) => softWanted.has(term.toLowerCase()));

  const reasons: string[] = [];
  if (missingImportant.length > 0) {
    reasons.push(`${missingImportant.length} of the posting's leading terms missing`);
  }
  if (missingSoft.length >= SOFT_SKILL_MISSING_FLOOR) {
    reasons.push(`${missingSoft.length} soft skill(s) missing, which now appear nowhere else`);
  }
  if (missingTerms.length >= REVISION_MISSING_FLOOR) {
    reasons.push(`${missingTerms.length} checklist terms missing`);
  }
  if (figures < FIGURE_FLOOR) {
    reasons.push(`${figures} figure(s) against a floor of ${FIGURE_FLOOR}`);
  }

  return {
    missingTerms,
    missingImportant,
    missingSoft,
    inBlockOnly,
    figures,
    short: reasons.length > 0,
    reason: reasons.join(', '),
  };
}

/** The prompt the revision call uses: its own, short one. */
const RESUME_REVISION_PROMPT_ID = 'revise-resume-coverage';

/**
 * What the revision is sent: the draft's own sentences, and nothing else.
 *
 * Every call here opens a FRESH conversation, so a follow-up has to carry its
 * own context - which is why the first version re-sent the whole tailoring
 * prompt, all 36,853 characters of rules, and asked for the whole resume back.
 * It does not need the rules. It needs the sentences it is rewriting.
 */
/**
 * The revision call's values, exported for the test that renders the prompt.
 *
 * A variable added to the prompt and not to this function fails the whole
 * revision at runtime with "missing runtime values", which is a thing to find
 * in a test rather than in the middle of a batch.
 */
export function buildRevisionPromptValuesForTests(
  content: TailoredContent,
  gap: CoverageGap
): Record<string, string> {
  return revisionPromptValues(content, gap);
}

function revisionPromptValues(content: TailoredContent, gap: CoverageGap): Record<string, string> {
  const draft = {
    summary: content.summary ?? '',
    experience: (content.experience ?? []).map((role) => ({
      company: role.company ?? '',
      title: role.title ?? '',
      achievements: role.achievements ?? [],
    })),
  };

  const figuresNote = gap.figures < FIGURE_FLOOR
    ? `THE DRAFT ALSO NEEDS MORE MEASURABLE RESULTS. Its bullets carry ${gap.figures} and this `
      + `resume needs at least ${FIGURE_FLOOR}: a page under that reads as a list of duties and `
      + `fails a scanner's measurable-results check. Add figures to enough bullets to reach `
      + `${FIGURE_FLOOR}, spread across roles, at most one per bullet. Use the number the work `
      + `itself implies - how many services a change covered, how many engineers a review `
      + `involved, how often a release went out, how long a job took before and after - small, `
      + `ordinary and defensible. Prefer a before-and-after to a lone percentage, and write the `
      + `unit on BOTH ends of one: "from 40 minutes to 6 minutes", never "by 40 minutes to 6". `
      + `The figures in this instruction are examples; every number you write comes from the work `
      + `in the bullet.`
    : 'The draft carries enough measurable results. Do not add more.';

  /*
   * Soft skills, named separately and told where to go.
   *
   * They are in `missingTermsJson` as well, pooled with everything else, and
   * that was not enough: the skills block no longer carries a group of them, so
   * a soft skill that is not in a bullet is not on the resume - and the one
   * instruction most likely to be obeyed is the one that says which words and
   * which sentences.
   */
  const softSkillsNote = gap.missingSoft.length > 0
    ? `SOFT SKILLS STILL MISSING: ${gap.missingSoft.join(', ')}. `
      + `Write each one INSIDE a sentence about work the draft already describes, so the skill is `
      + `visible in the action rather than named after it. NEVER append one after a clause that has `
      + `already finished - no ", applying X", no ", demonstrating X", no ", with attention to detail". `
      + `If a term has nothing in this draft to attach to naturally, leave it out rather than bolting `
      + `it on - a sentence whose last words are a keyword tells a reader exactly how the page was made.`
    : 'The draft carries the soft skills this posting asked for. Do not add more.';

  return {
    draftJson: promptJson(draft),
    missingTermsJson: promptJson(gap.missingTerms),
    figuresNote,
    softSkillsNote,
  };
}

/**
 * The draft with the revision's sentences in it, and nothing else touched.
 *
 * The revision returns only what it changed - the summary, and the roles whose
 * bullets it rewrote - and everything else is taken from the draft this
 * application already holds. That is what keeps the employers, dates, skills
 * block and cover letter safe by construction rather than by instruction: the
 * old shape asked for the whole object back and a model told "do not touch the
 * cover letter" would sometimes return it without one, which sent the route off
 * to write a new letter with a THIRD model call.
 */
function mergeRevision(draft: TailoredContent, patch: unknown): TailoredContent | null {
  if (!patch || typeof patch !== 'object') return null;
  const revision = patch as {
    summary?: unknown;
    experience?: Array<{ company?: unknown; title?: unknown; achievements?: unknown }>;
  };

  const rewritten = Array.isArray(revision.experience) ? revision.experience : [];
  const key = (company: unknown, title: unknown) =>
    `${String(company ?? '').trim().toLowerCase()}|${String(title ?? '').trim().toLowerCase()}`;
  const byRole = new Map<string, string[]>();
  for (const role of rewritten) {
    const bullets = Array.isArray(role.achievements)
      ? role.achievements.filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
      : [];
    if (bullets.length > 0) byRole.set(key(role.company, role.title), bullets);
  }

  const summary = typeof revision.summary === 'string' && revision.summary.trim()
    ? revision.summary.trim()
    : draft.summary;
  if (summary === draft.summary && byRole.size === 0) return null;

  return {
    ...draft,
    summary,
    experience: (draft.experience ?? []).map((role) => {
      const bullets = byRole.get(key(role.company, role.title));
      return bullets ? { ...role, achievements: bullets } : role;
    }),
  };
}

/** Off switch for the revision call, for an operator watching the bill. */
function coverageRevisionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // The old name still works: it was the figures-only switch before this was
  // generalised, and an operator may have it set.
  return !env.RESUME_REVISION_OFF && !env.RESUME_METRIC_RETRY_OFF;
}

/**
 * Does a revision call that FAILED take the build down with it?
 *
 * YES, AND THE REPORT THAT CHANGED IT: "even when the account browsers didn't
 * respond after receiving prompt, our program finished generating resumes
 * saying 5 out of 5 generated successfully." They had. The draft was complete,
 * a PDF was written, and the only trace of a browser that took the prompt and
 * never answered was a console warning nobody was reading.
 *
 * A failed call is now a failed build, which puts it through `withUnitRetry`
 * like any other transient browser fault - a retry re-enters the tab pool and
 * takes whichever browser is free, which is the whole reason a retry has a
 * chance of going differently. A revision correctly REJECTED for being no
 * better is untouched by this: the model answered, the answer was judged, and
 * the draft standing is the right outcome rather than a failure.
 *
 * THE WAY BACK, because this can turn a batch that was shipping into a batch
 * that fails: set RESUME_REVISION_SOFT_FAIL to keep the old behaviour, or
 * RESUME_REVISION_OFF to stop making the call at all.
 */
function coverageRevisionFailureIsFatal(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.RESUME_REVISION_SOFT_FAIL;
}

/**
 * The same failure, said in a way that names the stage it happened at.
 *
 * REBUILT RATHER THAN WRAPPED IN A PLAIN ERROR, because `isRetryableFailure`
 * reads `retryable` off an AIProviderError and that flag is derived from the
 * KIND. Carrying the kind across carries the decision: `auth`, `disabled`,
 * `locked` and `binaryMissing` still say "do not try again", and a timeout
 * still says "do".
 */
function asRevisionFailure(error: unknown): unknown {
  if (!isAIProviderError(error)) return error;
  return new AIProviderError({
    provider: error.provider,
    kind: error.kind,
    detail: `coverage revision: ${error.detail ?? error.message}`,
    adminAction: error.adminAction,
    retryAfterSeconds: error.retryAfterSeconds,
    cause: error,
  });
}

/**
 * The skills-block instruction an admin cannot edit away.
 *
 * Appended to the user body on every call, which makes it the LAST thing the
 * model reads and the most salient - so it has to agree with the prompt word
 * for word. It did not: while the prompt was being changed to ban soft skills
 * from the block, this still said "the last group headed X and holding this
 * posting's own soft-skill words spelled as it spells them", and being last it
 * would have won. A rule in two places is a rule that disagrees with itself
 * sooner or later; both are changed together or neither is.
 *
 * It no longer takes a heading, because there is no soft-skill group to head.
 */
const finalSkillOverride = () => `FINAL SKILL OVERRIDE:
Return "skillGroups": an array of { "category": string, "skills": [{ "name": string, "kind": string }] }, 5-7 groups, 5-9 skills each and never fewer than five in a group, ordered as you want them read. EVERY ENTRY CARRIES ITS KIND: language, framework, library, tool, platform, database, protocol, methodology or technology belong in the block; practice, concept, soft, domain and category are taken out of it before printing, so write those into a bullet first and label them honestly rather than mislabelling them to keep them. An entry whose kind you cannot name is not a thing and does not go in. The FIRST group is "Languages & Frameworks" and it is required on every resume - the languages this candidate writes and the frameworks they build with - because it is the first thing a technical reader looks for. Concrete tools, languages, frameworks and platforms ONLY. NO soft skills anywhere in the block - not "Ownership", "Communication", "Collaboration", "Mentoring", "Accountability", "Troubleshooting", nor any other - and no category words such as "Cloud", "Infrastructure", "Platforms", "Systems", "Data", "Tools" or "Technologies": both leave the block when you label them honestly - kind soft, kind category - and both are PRINTED when you label one a tool, because the label is the only thing read. No entry of three or more words unless it is a proper name with its capitals, and no entry joining two things with "and". NO CONCEPTS OR PRACTICES - write the TOOL instead: Datadog not "Observability", Terraform not "Infrastructure as Code", pytest not "unit testing", MLflow not "Experiment Tracking", Kong or Redis not "rate limiting". An entry goes if its last word names an activity (engineering, optimization, automation, orchestration, monitoring, planning, tracking, modeling, validation, testing, design, deployment, integration, implementation, operations) or if it is two or more words with no capital letter in it - UNLESS THIS POSTING NAMED IT, in which case it may stay, spelled as the posting spells it, because a phrase the employer wrote down is a keyword a scanner scores: "CI/CD", "APIs", "REST", "Large Language Models", "RAG" and whatever else this posting asked for - "Threat hunting", "Data Modeling", "Cloud infrastructure". The same shape you invented does not stay: "agent orchestration", "latency optimization", "fast iteration". Keep the named products the bulk of the block and let these ride in the slots left over, never more than a quarter; the application enforces that share and routes the rest to the prose. The concept itself goes in an experience bullet, spelled as the posting spells it - it is moved, not dropped, and the application checks that it arrived. No past-tense verb as a skill. One entry per real thing: where one entry's words are all inside another's, write the shorter. Count the skills before returning: AT LEAST 35 in total - thirty-five is a floor, and five groups need seven entries each, six need six, seven need five - never more than 45, and anything past 45 is deleted from the end of the longest group. Reach thirty-five by naming the stack one layer at a time rather than by writing one thing several ways: name the cloud PLATFORM - "AWS", "Azure", "GCP", whichever this posting names - and then its services, Lambda, S3, ECS, RDS, CloudWatch and IAM, because the platform's own name is what a scanner searches for and a block listing only services matches none of them. Infer what the described work could not have been done without, never a tool from an industry they have not worked in; a competitor beside the tool they used is allowed WHEN THIS POSTING NAMES IT, and left out when the posting is silent. If thirty-five would need a line nobody could be asked about, return what is true and stop short - fill up from the technologies this posting names and the ones the candidate's own roles imply, so the block answers the posting without reading as a copy of it. A tool is not gated by the profile; a DOMAIN is - nothing from an industry this candidate has not worked in. Beyond those removals it is printed as returned - nothing reorders it, renames a group or tops it up, and the only merge is that the two smallest headings are joined, both names kept, when you send more than seven groups - so no duplicates of one product, no concepts, no invented versions. Never invent a metric, an employer, a title or a date. Do NOT return "softSkills" - the field has been removed. Soft skills go into the bullets where they are shown by the work, not listed as traits. Never bolt a soft skill onto the end of a finished sentence - no ", applying X", no ", demonstrating X", no ", with attention to detail". Omit "skills", "hardSkills", "unconfirmedHardSkills" and "unconfirmedSoftSkills": those flat lists are derived from skillGroups.`;

function usesJobPriorityHardSkillOrdering(profile?: Profile): boolean {
  return getProfileHardSkillOrdering(profile) === 'job-priority';
}

function normalizeSkillsList(skills: string[] | undefined): string[] {
  if (!Array.isArray(skills)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const raw of skills) {
    if (typeof raw !== 'string') continue;
    const skill = raw.trim();
    if (!skill) continue;
    const key = skill.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(skill);
  }

  return normalized;
}

const JOB_POSTING_PERSPECTIVE_PATTERN =
  /\b(?:we|our|ours|ourselves|you|your|yours|yourself|yourselves)\b/i;
const JOB_POSTING_RECRUITING_PATTERN =
  /\b(?:join us|help us|you will|you'll|you are|you would|the ideal candidate|successful candidate|next generation|break ground|ground-breaking)\b/i;
const RESUME_META_TAILORING_PATTERN =
  /\b(?:this background maps to|background maps to|maps to|mapped to|aligns with|aligned with|target role|target job|job description|job posting|ats|keyword coverage|required skills|key responsibilities|for this specific role|for this role)\b/i;
const IMPERATIVE_RESPONSIBILITY_VERBS = new Set([
  'build',
  'create',
  'develop',
  'design',
  'implement',
  'lead',
  'own',
  'manage',
  'drive',
  'deliver',
  'enable',
  'collaborate',
  'partner',
  'support',
  'improve',
  'optimize',
  'architect',
]);

function normalizeJobAnalysisPhrase(value: string): string {
  return value
    .replace(/^[\s\-*]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[;:,\s]+$/, '')
    .trim();
}

function isUnsafeJobPostingPhrase(value: string): boolean {
  const normalized = normalizeJobAnalysisPhrase(value);
  if (!normalized) return true;
  return (
    JOB_POSTING_PERSPECTIVE_PATTERN.test(normalized) ||
    JOB_POSTING_RECRUITING_PATTERN.test(normalized) ||
    RESUME_META_TAILORING_PATTERN.test(normalized)
  );
}

function neutralizeResponsibilityPhrase(value: string): string {
  const normalized = normalizeJobAnalysisPhrase(value).replace(/\.$/, '');
  if (!normalized || isUnsafeJobPostingPhrase(normalized)) return '';

  const words = normalized.split(/\s+/);
  const first = words[0]?.toLowerCase();
  if (first && IMPERATIVE_RESPONSIBILITY_VERBS.has(first) && words.length > 1) {
    return `${words.slice(1).join(' ')} delivery`;
  }

  return normalized;
}

function normalizeSafeKeywordList(values: string[]): string[] {
  return normalizeSkillsList(values)
    .map(normalizeJobAnalysisPhrase)
    .filter((item) => item && !isUnsafeJobPostingPhrase(item));
}

function normalizeSafeResponsibilityList(values: string[]): string[] {
  return normalizeSkillsList(values)
    .map(neutralizeResponsibilityPhrase)
    .filter(Boolean);
}


function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function normalizeJobAnalysisResponse(
  parsed: RawNestedJobAnalysis,
  jobDescription: string
): JobAnalysis {
  // const inferredSoft = inferAtsSoftSkillsFromText(jobDescription);
  // const inferredHard = inferHardSkillsFromText(jobDescription);

  const technical = normalizeSafeKeywordList([
    ...toStringList(parsed.skills?.technical),
    ...toStringList(parsed.skills?.required),
  ]);
  const required = normalizeSkillsList([
    ...technical,
    // ...inferredHard,
  ]);
  const preferred = normalizeSkillsList([
    ...toStringList(parsed.skills?.preferred),
  ]);
  const tools = normalizeSkillsList(toStringList(parsed.skills?.tools));
  const soft = prioritizeSoftSkills(
    normalizeSkillsList([
      ...toStringList(parsed.skills?.soft),
      ...toStringList(parsed.softSkills),
    ])
  );
  const technologies = normalizeSafeKeywordList([
    ...toStringList(parsed.technologies),
    ...toStringList(parsed.skills?.technologies),
  ]);
  const protocols = normalizeSafeKeywordList(toStringList(parsed.protocols));
  const methodologies = normalizeSafeKeywordList(toStringList(parsed.methodologies));
  const architecturePatterns = normalizeSafeKeywordList(toStringList(parsed.architecturePatterns));
  const responsibilities = normalizeSafeResponsibilityList([
    ...toStringList(parsed.responsibilities),
  ]);
  const domainKnowledge = normalizeSafeKeywordList([
    ...toStringList(parsed.domainKnowledge),
  ]);
  const keywordGroups = parsed.keywords && typeof parsed.keywords === 'object' && !Array.isArray(parsed.keywords)
    ? parsed.keywords as Record<string, unknown>
    : {};

  return {
    jobMeta: {
      title: asString(parsed.jobMeta?.title) || asString(parsed.jobMeta?.title),
      seniority: asString(parsed.jobMeta?.seniority),
      industry: asString(parsed.jobMeta?.industry),
      department: asString(parsed.jobMeta?.department),
    },
    skills: {
      technical,
      required,
      preferred,
      tools,
      soft,
      technologies,
    },
    technologies,
    protocols,
    methodologies,
    architecturePatterns,
    responsibilities,
    domainKnowledge,
    softSkills: soft,
    keywords: {
      actionVerbs: normalizeSafeKeywordList(toStringList(keywordGroups.actionVerbs)),
      buzzwords: normalizeSafeKeywordList(toStringList(keywordGroups.buzzwords)),
      mustInclude: normalizeSafeKeywordList([
        ...toStringList(keywordGroups.mustInclude),
      ]),
    },
    sourceJobDescription: jobDescription.trim(),
  };
}

function getJobAnalysisTitle(jobAnalysis?: JobAnalysis): string {
  return jobAnalysis?.jobMeta?.title?.trim() ?? '';
}

function getTechnicalSkills(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.skills?.technical);
}

function getRequiredSkills(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    ...(jobAnalysis?.skills?.required ?? []),
    ...getTechnicalSkills(jobAnalysis),
  ]);
}

function getPreferredSkills(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.skills?.preferred);
}

function getSkillTools(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.skills?.tools);
}

function getTechnologies(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    ...(jobAnalysis?.technologies ?? []),
    ...(jobAnalysis?.skills?.technologies ?? []),
  ]);
}

function getProtocols(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.protocols);
}

function getMethodologies(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.methodologies);
}

function getArchitecturePatterns(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.architecturePatterns);
}

function getResponsibilities(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.responsibilities);
}

function getDomainKnowledge(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.domainKnowledge);
}

function getSoftSkills(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    ...(jobAnalysis?.softSkills ?? []),
    ...(jobAnalysis?.skills?.soft ?? []),
  ]);
}

function getIndustryTerms(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    jobAnalysis?.jobMeta?.industry ?? '',
    jobAnalysis?.jobMeta?.department ?? '',
    ...getDomainKnowledge(jobAnalysis),
  ]);
}

/**
 * Every term the job named that the resume is scored on.
 *
 * `skills.technical` belongs here and was the one field missing from it. The
 * analyser is asked for 15-25 entries there - it is the LARGEST field it
 * produces - and they are the abilities a scanner looks for by name:
 * "Full-stack engineering", "Network operations", "Web development",
 * "Data processing systems". Every other field reached this list in full;
 * technical reached it not at all, so those terms were invisible to the 80%
 * coverage floor and simply never written.
 *
 * This is a PROSE checklist. Nothing here is a candidate for the Technical
 * Skills block - that list is built separately, from the library and from the
 * analyser's named-tool fields - and an ability is not a skill you can list.
 */
function getKeywordChecklist(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    ...(jobAnalysis?.keywords?.actionVerbs ?? []),
    ...(jobAnalysis?.keywords?.buzzwords ?? []),
    ...(jobAnalysis?.keywords?.mustInclude ?? []),
    ...getTechnicalSkills(jobAnalysis),
    // Required and preferred were the two fields missing from this list, and
    // the omission was invisible: both reach the Technical Skills SELECTION, so
    // anything the library carries came out fine, and only a term the library
    // had never heard of - a preferred technology like ArgoCD - was extracted
    // from the posting and then written nowhere at all.
    ...getRequiredSkills(jobAnalysis),
    ...getPreferredSkills(jobAnalysis),
    ...getSoftSkills(jobAnalysis),
    ...getSkillTools(jobAnalysis),
    ...getTechnologies(jobAnalysis),
    ...getProtocols(jobAnalysis),
    ...getMethodologies(jobAnalysis),
    ...getArchitecturePatterns(jobAnalysis),
    ...getDomainKnowledge(jobAnalysis),
  ]);
}

/**
 * Technical terms the job or the profile named that the library does not carry.
 *
 * Read from the ANALYSIS's own technical fields rather than mined out of the
 * raw posting: the analysis pass has already decided which phrases in the text
 * are technologies, and re-deciding that here without a vocabulary is the part
 * that cannot be done well. `keywords` and `industryTerms` are deliberately not
 * read - those are prose keywords, and they belong in the prose.
 *
 * On the profile side only skills the candidate LISTED are taken. Their role
 * descriptions are prose, and prose needs a vocabulary to read; an explicit
 * claim does not.
 */
function keepUnlistedHardSkills(stated: string[]): string[] {
  const known = new Set(technicalSkills.map((skill) => normalizeHardSkillAlias(skill)));

  return normalizeSkillsList(stated).filter((skill) => {
    const key = normalizeHardSkillAlias(skill);
    if (!key || known.has(key)) return false;
    if (JOB_TITLE_EXCLUSIONS.has(key)) return false;
    if (SOFT_SKILL_SIGNALS.some((signal) => key.includes(signal))) return false;
    if (!looksLikeUnlistedHardSkill(skill)) return false;
    // "SQL query writing" is SQL with work described around it, and SQL is
    // already listed. Applied here as well as in the selection so that what is
    // offered to the skill library matches what reached the resume.
    return !isRedundantWithLibraryTerm(skill, known);
  });
}

/**
 * Only the analysis fields that are supposed to hold NAMED technologies.
 *
 * The analyser's own prompt draws the line and this follows it. `skills.tools`
 * is "named software, services, platforms, CLIs", `technologies` is "languages,
 * frameworks, libraries, infrastructure ecosystems", `protocols` is "REST,
 * GraphQL, gRPC, OAuth 2.0". Those are things with names.
 *
 * `skills.technical` is defined in that same prompt as "technical abilities NOT
 * tied to a specific named tool" - its own examples are "system design",
 * "capacity planning", "code review" - and `architecturePatterns` is "high-level
 * structural and system design patterns". Reading either for a skills BLOCK was
 * the mistake: it asked two fields of ideas for a list of tools. While the
 * library was the only way in this did not show, because the library filtered
 * them out; once unlisted terms were allowed through, "SQL query writing" and
 * "AI coding tool usage" went straight onto the resume.
 *
 * `skills.required` is not read either, and avoiding `getRequiredSkills` was not
 * enough to avoid it. The side door is one level deeper than the getter: the
 * analysis NORMALIZER folds `skills.technical` into `skills.required` as it is
 * parsed, so by the time anything reads the stored field the two are the same
 * list. Reading it raw re-admitted every ability - "Network operations",
 * "Clinical care", "Develop Software" went into the skills block through
 * exactly that route. `required` carries nothing `technical` does not, so
 * there is nothing lost by leaving it out.
 */
/**
 * The hard skills the JOB ITSELF named, taken from the analyser's own fields.
 *
 * The skills block was built by matching the library against the posting's raw
 * text, and that quietly threw the extraction away. `getTailoringSourceText`
 * returns the raw description whenever there is one, so the analyser's
 * `technologies`, `tools` and `protocols` - the fields whose whole job is to
 * name the technologies - were never read for the block at all. A term the
 * analyser extracted but that the posting spells differently, or lists in a
 * table the text extraction flattened, was simply lost: Pulumi went missing
 * from a posting that named it, because it was not in the raw text AND, being a
 * library term, the unlisted path refused it too. It fell through both.
 *
 * These are returned whether or not the library carries them. The library's job
 * here is spelling and grouping; deciding WHICH skills the job asked for is the
 * analyser's, and it has already done it.
 */
/**
 * The five skills this posting is actually about.
 *
 * WHY FIVE, AND WHY THESE. A posting names thirty things and means five of
 * them: the ones in the requirements, named first, repeated in the
 * responsibilities. A scanner weights those highest and a reader looks for
 * nothing else, so the prompt is told which five to build the bullets around
 * rather than being left to spread its attention evenly over a list of thirty.
 *
 * Required before preferred before merely mentioned, in the posting's own
 * order, because that order is the employer's own ranking. Anything that is not
 * a technology - an ability, a practice, a soft skill - is left out: those have
 * their own checklists, and a bullet cannot be built around "collaboration" the
 * way it can be built around Kubernetes.
 */
export function focusSkills(jobAnalysis?: JobAnalysis, limit = 5): string[] {
  const named = new Set(getJobNamedHardSkills(jobAnalysis).map((skill) => skill.toLowerCase()));
  const ordered = normalizeSkillsList([
    ...(jobAnalysis?.skills?.required ?? []),
    ...getJobNamedHardSkills(jobAnalysis),
    ...(jobAnalysis?.skills?.preferred ?? []),
  ]);

  const chosen: string[] = [];
  for (const skill of ordered) {
    // A technology, not an ability: the named list is the technologies this
    // posting spelled out, and a required entry counts when it is one of them.
    if (!named.has(skill.toLowerCase())) continue;
    if (isConceptSkill(skill)) continue;
    chosen.push(skill);
    if (chosen.length === limit) break;
  }
  return chosen;
}

function getJobNamedHardSkills(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    ...getSkillTools(jobAnalysis),
    ...getTechnologies(jobAnalysis),
    ...getProtocols(jobAnalysis),
  ]).filter((skill) => {
    const key = normalizeHardSkillAlias(skill);
    if (!key || JOB_TITLE_EXCLUSIONS.has(key)) return false;
    if (SOFT_SKILL_SIGNALS.some((signal) => key.includes(signal))) return false;
    return true;
  });
}

function getUnlistedJobSkills(jobAnalysis?: JobAnalysis): string[] {
  return keepUnlistedHardSkills([
    ...getPreferredSkills(jobAnalysis),
    ...getSkillTools(jobAnalysis),
    ...getTechnologies(jobAnalysis),
    ...getProtocols(jobAnalysis),
  ]);
}

function getUnlistedProfileSkills(profile?: Profile): string[] {
  return keepUnlistedHardSkills([
    ...(profile?.skills ?? []),
    ...(profile?.experience ?? []).flatMap((role) => role.skills ?? []),
  ]);
}

/**
 * The job's concept terms, wherever the analyser filed them.
 *
 * Everything is passed through `isConceptSkill`, which is what guarantees the
 * caller's rule: a term listed here is by definition one the Technical Skills
 * block refuses, so naming it to the prompt cannot put it in that block. Terms
 * from these fields that are NOT concepts - "Network operations", "Clinical
 * care" - fall through to the ordinary keyword checklist, which is also prose.
 *
 * The tool-shaped fields are read too, not just the three that hold ideas by
 * definition. The analyser files a posting's "experience with CRM platforms" or
 * "familiarity with SIEM platforms" under `tools`, because that is the sentence
 * it came from - and those phrases are slots, not products. Now that the skills
 * block refuses them, they have to be named here or they reach the resume
 * nowhere at all, and an ATS scoring the posting's own words would miss them.
 */
function getConceptKeywords(jobAnalysis?: JobAnalysis, librarySkills: string[] = []): string[] {
  return extractConceptKeywords(
    normalizeSkillsList([
      ...librarySkills,
      ...getTechnicalSkills(jobAnalysis),
      ...getMethodologies(jobAnalysis),
      ...getArchitecturePatterns(jobAnalysis),
      ...getPreferredSkills(jobAnalysis),
      ...getSkillTools(jobAnalysis),
      ...getTechnologies(jobAnalysis),
      ...getProtocols(jobAnalysis),
      /*
       * AND THE FIELD THE ANALYSER PUTS CONCEPTS IN, which this read for a
       * long time and did not.
       *
       * `domainKnowledge` is defined to the analyser as "business and technical
       * concepts the candidate understands deeply", 10-20 entries - so it is
       * where "Data Modeling", "Cloud infrastructure", "Threat hunting" and
       * "Business Systems" land. Leaving it out meant those never reached
       * `conceptKeywordsJson`, the one list the prompt says something specific
       * about, and arrived instead among two dozen undifferentiated keywords.
       *
       * MEASURED on two scans: eleven of fourteen reported misses were phrases
       * of exactly this shape, every one named by the posting and none of them
       * anywhere on the page.
       */
      ...getDomainKnowledge(jobAnalysis),
    ])
  );
}

/**
 * The prose targets, as the prompt received them.
 *
 * Built from the same two functions that fill `keywordsJson` and
 * `conceptKeywordsJson`, so the thing being measured is the thing that was
 * asked for. Anything else would produce a number that looks like coverage and
 * answers a different question.
 */
/** At most this many bullets under one role, whatever the model returns. */
/**
 * The longest a summary may be.
 *
 * WHY A CEILING AT ALL. The prompt asked for 80-120 words and got paragraphs
 * that filled a third of the first page before a reader reached a single thing
 * the candidate had done.
 *
 * WHY 80 AND NOT 65. The first version of this capped at 65, and measured over
 * 60 delivered resumes per run the result was a median of 52 words - the model
 * retreated from a ceiling it was only ever told not to exceed, and not one
 * summary in the sample was trimmed by this function. The share of the resume's
 * own skills terms that also appeared in the summary fell from 16% to 4%, and
 * the ATS scores fell about ten points with it. The prompt now asks for 65-80
 * and names a floor; this is the ceiling that floor sits under.
 */
const MAX_SUMMARY_WORDS = 50;

/** The cap, which an operator can move without editing the source. */
function summaryWordCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.RESUME_MAX_SUMMARY_WORDS || '', 10);
  if (!Number.isFinite(raw) || raw < 1) return MAX_SUMMARY_WORDS;
  return raw;
}

const wordsIn = (value: string): number => value.trim().split(/\s+/).filter(Boolean).length;

/**
 * Trims a long summary to the cap by dropping WHOLE SENTENCES from the end.
 *
 * Never mid-sentence. A paragraph cut at the 65th word ends in the middle of a
 * clause, which reads worse than a paragraph that is a few words long and is
 * the first thing anybody sees on the page. A single sentence that already
 * exceeds the cap is therefore kept as it is and reported instead - there is no
 * cut that improves it, and silently halving it would be the renderer rewriting
 * the candidate's prose.
 */
export function capSummaryWords(
  summary: string,
  cap: number = summaryWordCap()
): { summary: string; dropped: number; words: number } {
  const trimmed = summary.trim();
  const words = wordsIn(trimmed);
  if (!trimmed || words <= cap) return { summary: trimmed, dropped: 0, words };

  // Kept WITH their punctuation, so the rebuilt paragraph still ends in a stop.
  const sentences = trimmed.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [trimmed];
  const kept: string[] = [];
  for (const sentence of sentences) {
    const candidate = [...kept, sentence].join('').trim();
    if (kept.length > 0 && wordsIn(candidate) > cap) break;
    kept.push(sentence);
  }

  const result = kept.join('').trim() || trimmed;
  return { summary: result, dropped: sentences.length - kept.length, words: wordsIn(result) };
}

const MAX_BULLETS_PER_ROLE = 8;

/**
 * The cap, which an operator can move without editing the source.
 */
function bulletCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.RESUME_MAX_BULLETS || '', 10);
  if (!Number.isFinite(raw) || raw < 1) return MAX_BULLETS_PER_ROLE;
  return raw;
}

/**
 * Which bullets survive the cap.
 *
 * WHY NOT THE FIRST EIGHT. A role came back with twenty-two bullets - the
 * prompt has said "maximum 8" throughout, and the model wrote twenty-two - and
 * the fourteen that had to go were carrying keywords: taking the first eight
 * would have dropped whichever terms the model happened to put late, including
 * the ones that appear nowhere else on the page. The resume is a keyword
 * document and this is a keyword decision.
 *
 * So the eight are chosen for COVERAGE. Repeatedly take the bullet that adds
 * the most checklist terms nothing kept so far has; break ties towards a bullet
 * carrying a figure, because the page needs five of those, and then towards the
 * order the model wrote them in. When the terms run out, the earliest bullets
 * left fill the remaining slots, and the survivors are printed in the model's
 * own order rather than in the order they were picked.
 *
 * Nothing is rewritten: a kept bullet is the model's sentence, untouched.
 */
function chooseBullets(bullets: string[], cap: number, jobAnalysis?: JobAnalysis): string[] {
  if (bullets.length <= cap) return bullets;

  const terms = normalizeSkillsList([
    ...focusSkills(jobAnalysis, 8),
    ...getProseChecklist(jobAnalysis),
  ]);
  const covered = new Set<string>();
  const kept = new Set<number>();

  const termsIn = (bullet: string) => terms.filter((term) => containsTerm(bullet, term));
  const hasFigure = (bullet: string) => countFigures({ experience: [{ achievements: [bullet] }] }) > 0;

  while (kept.size < cap) {
    let best = -1;
    let bestScore = -1;
    for (let index = 0; index < bullets.length; index += 1) {
      if (kept.has(index)) continue;
      const adds = termsIn(bullets[index]).filter((term) => !covered.has(term.toLowerCase())).length;
      // A figure is worth less than a keyword and more than a tie.
      const score = adds * 2 + (hasFigure(bullets[index]) ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    }
    if (best === -1) break;
    kept.add(best);
    for (const term of termsIn(bullets[best])) covered.add(term.toLowerCase());
  }

  return bullets.filter((_bullet, index) => kept.has(index));
}

function getProseChecklist(jobAnalysis?: JobAnalysis): string[] {
  if (!jobAnalysis) return [];
  const promptSkills = buildLibraryAugmentedPromptLists(jobAnalysis).promptSkills;
  const concepts = getConceptKeywords(jobAnalysis, promptSkills);
  const conceptSet = new Set(concepts.map((term) => term.toLowerCase()));
  const keywords = buildLibraryAugmentedPromptLists(jobAnalysis).keywords
    .filter((term) => !conceptSet.has(term.toLowerCase()));
  // Without the posting's culture language, for the reason given where the
  // prompt's own lists are built: a measurement that counts a term the prompt
  // forbids reads as a shortfall, and a shortfall buys a revision that puts the
  // phrase back. The two have to agree about what belongs on the page.
  return withoutValuesPhrases(normalizeSkillsList([...keywords, ...concepts])).terms;
}

/**
 * Says how much of the checklist the finished resume carries.
 *
 * Logged rather than enforced. The model has already answered by the time this
 * runs, and throwing away a resume that placed 84% of the terms in exchange for
 * nothing is worse than shipping it with the number written down - the operator
 * can see the figure, and a run whose average sits below the floor is a prompt
 * problem rather than a per-resume one.
 */
/**
 * Bullets whose verb says the same word as their noun.
 *
 * "Automated model training workflow automation", "Evaluated ML model
 * evaluation results", "Experimented with ML technology experimentation",
 * "Optimized AI agent optimization experiments" - four bullets from one
 * delivered resume. It is the model wedging a checklist phrase into a sentence
 * whose verb already says it, and on the page it is the clearest possible tell
 * that nobody wrote this.
 *
 * The prompt now bans it and offers rewrites. This counts it, because a writing
 * rule nobody counts is a writing rule that quietly stops holding.
 *
 * The test is crude on purpose: take the opening verb, cut the inflection off
 * it, and see whether the same stem turns up again later in the same sentence.
 * Five letters of stem, so "built"/"build" and "ran"/"run" cannot collide with
 * anything by accident.
 */
export function echoingBullets(bullets: readonly string[]): string[] {
  const echoes: string[] = [];

  for (const bullet of bullets) {
    const opening = /^[\s\-•]*([A-Za-z]+)/.exec(bullet);
    if (!opening) continue;
    const stem = opening[1].toLowerCase().replace(/(?:ed|ing|s)$/, '');
    if (stem.length < 5) continue;
    const rest = bullet.slice(opening[0].length);
    if (new RegExp(`\\b${stem}`, 'i').test(rest)) echoes.push(bullet);
  }

  return echoes;
}

/** Roles where two bullets open with the same verb. */
function repeatedOpeners(bullets: readonly string[]): string[] {
  const seen = new Map<string, number>();
  for (const bullet of bullets) {
    const opening = /^[\s\-•]*([A-Za-z]+)/.exec(bullet);
    if (!opening) continue;
    const verb = opening[1].toLowerCase();
    seen.set(verb, (seen.get(verb) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([verb]) => verb);
}

/** Says whether the bullets read like sentences or like slots. */
function reportBulletVoice(
  profileName: string,
  content: { experience?: Array<{ company?: string; achievements?: string[] }> }
): void {
  const roles = content.experience ?? [];
  const echoes = roles.flatMap((role) => echoingBullets(role.achievements ?? []));
  const repeated = roles
    .map((role) => ({ role: role.company ?? 'a role', verbs: repeatedOpeners(role.achievements ?? []) }))
    .filter((entry) => entry.verbs.length > 0);

  if (echoes.length === 0 && repeated.length === 0) return;

  const parts: string[] = [];
  if (echoes.length > 0) {
    parts.push(`${echoes.length} bullet(s) whose verb repeats its own noun: ${JSON.stringify(echoes[0].slice(0, 70))}`);
  }
  if (repeated.length > 0) {
    parts.push(`${repeated.length} role(s) opening two bullets with the same verb (${repeated[0].verbs.join(', ')})`);
  }
  console.warn(`[Resume voice] ${profileName}: ${parts.join('; ')}.`);
}

/**
 * Claims that do not fit inside the years of the role they sit in.
 *
 * REPORTED BY THE OPERATOR: LLM-as-a-judge, RAG, prompt injection testing and
 * agent orchestration written into 2017-2019 roles. Every role is tailored
 * towards the same posting, so a posting that leans on AI pushes AI language
 * into the oldest role on the page - and that is the one fault on the list that
 * ends an interview rather than costing a point.
 *
 * Reported, not repaired: fixing it means describing the old work in the
 * vocabulary of its own era, which only the model can do. The prompt now asks
 * for exactly that, under fault 2, and this says whether it listened.
 */
function reportAnachronisms(
  profileName: string,
  content: { experience?: Array<{ company?: string; endDate?: string; achievements?: string[] }> }
): void {
  const found = findAnachronisms(content.experience ?? []);
  if (found.length === 0) return;

  const shown = found
    .slice(0, 5)
    .map((hit) => `"${hit.term}" in ${hit.company} (ended ${hit.endedIn}, term is ${hit.from} on)`)
    .join('; ');
  console.warn(
    `[Resume dates] ${profileName}: ${found.length} claim(s) newer than the role they sit in - `
      + `${shown}${found.length > 5 ? ', ...' : ''}.`
  );
}

/**
 * Figures whose two ends do not describe one measurement.
 *
 * REPORTED BY THE OPERATOR as garbled metrics: "reduced deploy time by about 40
 * minutes to 6". This prompt taught it - its own before-and-after example was
 * written "40 minutes to 6", with the unit on one end - so the example and the
 * rule were both fixed, and this counts what still arrives.
 */
function reportGarbledMetrics(
  profileName: string,
  content: { experience?: Array<{ achievements?: string[] }> }
): void {
  const found = findGarbledMetrics(content.experience ?? []);
  if (found.length === 0) return;

  console.warn(
    `[Resume metrics] ${profileName}: ${found.length} figure(s) a reader cannot parse - `
      + found
        .slice(0, 3)
        .map((hit) => `${hit.shape}: ${JSON.stringify(hit.bullet.slice(0, 90))}`)
        .join('; ')
      + `${found.length > 3 ? ', ...' : ''}.`
  );
}

/** The prompt's own floor: two of every three bullets name a technology. */
const TOOL_SHARE_FLOOR = 2 / 3;

/**
 * The bullets the prompt asks for, and the reason the floor is counted.
 *
 * MEASURED on a five-role profile after the per-role guidance was cut to 5-7
 * and 2-3: twelve bullets, below the prompt's own stated minimum of fourteen.
 * A short page is why the soft skills, the checklist terms and the five
 * measurable results all ran out of room at once - each needs a sentence to
 * live in. The page has no length limit, so there is nothing a short resume
 * buys.
 */
const BULLET_FLOOR = 14;

/**
 * The three faults left on the operator's list, counted rather than repaired.
 *
 * Broken or leftover text, bullets with no named tool and no figure of scale,
 * and roles that never widen into owning or mentoring anything. Each one needs
 * the sentence rewritten, so each is a rule in the prompt - and a writing rule
 * nobody counts is a writing rule that quietly stops holding, which is why
 * `echoingBullets` is counted beside its own ban.
 *
 * ONE LINE PER RESUME, and only when there is something to say: an operator
 * reads a batch of sixty of these.
 */
function reportBulletShape(
  profileName: string,
  roles: ReadonlyArray<{ company?: string; achievements?: string[] }>,
  vocabulary: readonly string[]
): void {
  const parts: string[] = [];

  const written = roles.reduce((count, role) => count + (role.achievements ?? []).length, 0);
  if (written > 0 && written < BULLET_FLOOR) {
    parts.push(
      `${written} bullets across ${roles.length} role(s), under the floor of ${BULLET_FLOOR} `
        + `- everything else on this page needs a sentence to live in`
    );
  }

  const broken = findBrokenBullets(roles);
  if (broken.length > 0) {
    parts.push(
      `${broken.length} bullet(s) that are not one finished sentence (`
        + `${broken.slice(0, 2).map((hit) => `${hit.shape}: ${JSON.stringify(hit.bullet.slice(0, 70))}`).join('; ')})`
    );
  }

  const tools = bulletsNamingATool(roles, vocabulary);
  if (tools.bullets > 0 && tools.share < TOOL_SHARE_FLOOR) {
    parts.push(
      `only ${tools.named}/${tools.bullets} bullets name a technology this resume claims `
        + `(${Math.round(tools.share * 100)}%, floor ${Math.round(TOOL_SHARE_FLOOR * 100)}%)`
    );
  }

  const noScale = rolesWithoutScale(roles);
  if (noScale.length > 0) {
    parts.push(`${noScale.length} role(s) with no figure of scale: ${noScale.slice(0, 3).join(', ')}`);
  }

  const noScope = recentRolesWithoutScope(roles);
  if (noScope.length > 0) {
    parts.push(`no ownership or mentoring bullet in ${noScope.slice(0, 2).join(', ')}`);
  }

  // Issue 2 — soft skill bolted onto a technical bullet.
  const bolted = bulletsWithBoltedSoftSkills(roles);
  if (bolted.length > 0) {
    parts.push(
      `${bolted.length} bullet(s) with a soft skill bolted on (`
        + `${JSON.stringify(bolted[0].slice(0, 80))}…)`
    );
  }

  // Issue 7 — bullets that stop at the activity and never say what changed.
  const noOutcome = bulletsWithoutAnOutcome(roles);
  if (noOutcome.length > 0) {
    const total = roles.reduce((n, r) => n + (r.achievements ?? []).length, 0);
    parts.push(
      `${noOutcome.length}/${total} bullet(s) with no outcome clause (`
        + `${JSON.stringify(noOutcome[0].slice(0, 80))}…)`
    );
  }

  if (parts.length === 0) return;
  console.warn(`[Resume bullets] ${profileName}: ${parts.join('; ')}.`);
}

/** How many times a term appears in the achievement bullets. */
function timesInBullets(
  content: { experience?: Array<{ achievements?: string[] }> },
  term: string
): number {
  const bullets = (content.experience ?? []).flatMap((role) => role.achievements ?? []);
  return bullets.filter((bullet) => containsTerm(bullet, term)).length;
}

/**
 * The figures a scanner counts as measurable results.
 *
 * Dates, years and the numbers inside product names are not results, which is
 * why they are taken out before counting: "OAuth 2.0", "S3" and "01/2019" are
 * not achievements, and a resume that scored them as such would pass the floor
 * while saying nothing.
 */
export function countFigures(
  content: { summary?: string; experience?: Array<{ achievements?: string[] }> }
): number {
  const text = [
    content.summary ?? '',
    ...(content.experience ?? []).flatMap((role) => role.achievements ?? []),
  ].join(' ');

  const stripped = text
    .replace(/\b(?:0[1-9]|1[0-2])\/(?:19|20)\d{2}\b/g, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    // A number welded to a name is part of the name: S3, Log4j, p99, H2, ES2015.
    .replace(/\b[A-Za-z]+\d+(?:\.\d+)?[A-Za-z]*\b/g, ' ')
    // And the products that write their version apart from their name, however
    // they separate the two: "OAuth 2.0", "HTTP/2", "Python 3".
    .replace(/\b(?:OAuth|OIDC|HTTP|HTTPS|TLS|SSL|IPv|Python|Java|Node|PHP|Angular|Vue|React|Spring|Kafka|Postgres|PostgreSQL|MySQL|Redis|Kubernetes|Windows|Android|iOS)[\s/.-]?\d+(?:\.\d+)?\b/gi, ' ');

  return (stripped.match(/\d+(?:[.,]\d+)?/g) ?? []).length;
}

/** Each of the posting's five leading skills, this often in the bullets. */
const FOCUS_SKILL_FLOOR = 2;

/** Figures on the page, which is what a measurable-results check counts. */
const FIGURE_FLOOR = 5;

/**
 * The two floors the operator set by number, counted where they are read.
 *
 * Reported, never repaired: the model writes the resume and nothing here edits
 * it. But a floor nobody counts is a floor nobody keeps, and both of these were
 * asked for as numbers - each of the five focus skills in the bullets two or
 * three times, and at least five figures on the page.
 */
function reportFocusAndFigures(
  profileName: string,
  content: { summary?: string; experience?: Array<{ achievements?: string[] }> },
  jobAnalysis?: JobAnalysis
): void {
  const five = focusSkills(jobAnalysis);
  if (five.length > 0) {
    const counted = five.map((skill) => ({ skill, times: timesInBullets(content, skill) }));
    const short = counted.filter((entry) => entry.times < FOCUS_SKILL_FLOOR);
    const line = counted.map((entry) => `${entry.skill} x${entry.times}`).join(', ');
    if (short.length === 0) {
      console.log(`[Resume focus] ${profileName}: ${line}.`);
    } else {
      console.warn(
        `[Resume focus] ${profileName}: ${line} - ${short.length} of the posting's top `
          + `${five.length} below ${FOCUS_SKILL_FLOOR} mentions in the bullets.`
      );
    }
  }

  /*
   * COUNTED IN THE BULLETS ONLY, on the operator's instruction: "at least 5
   * measurable results in bullet points". It used to count the summary too,
   * which inflated the number by one on most resumes and by more on the long
   * summaries - and at 50 words the summary now has room for a single figure,
   * so a floor that counted it would be a floor of four.
   */
  const figures = countFigures({ experience: content.experience });
  if (figures >= FIGURE_FLOOR) {
    console.log(`[Resume metrics] ${profileName}: ${figures} measurable result(s) in the bullets.`);
  } else {
    console.warn(
      `[Resume metrics] ${profileName}: only ${figures} measurable result(s) in the bullets, `
        + `floor ${FIGURE_FLOOR}.`
    );
  }
}

function reportPlacement(
  profileName: string,
  content: {
    summary?: string;
    // `company` and `endDate` are here for the two date-aware checks below: a
    // claim is only too new for the years of the role it sits in.
    experience?: Array<{
      company?: string;
      endDate?: string;
      description?: string;
      achievements?: string[];
    }>;
  },
  jobAnalysis?: JobAnalysis
): PlacementReport | null {
  reportFocusAndFigures(profileName, content, jobAnalysis);
  reportBulletVoice(profileName, content);
  reportAnachronisms(profileName, content);
  reportGarbledMetrics(profileName, content);
  const checklist = getProseChecklist(jobAnalysis);
  if (checklist.length === 0) return null;

  const report = measurePlacement(renderedProse(content), checklist);
  const floor = placementFloor();
  const percent = (report.ratio * 100).toFixed(0);

  /*
   * Soft skills counted on their own, as well as inside the total.
   *
   * They used to have a section of their own, which satisfied a scanner
   * whatever the prose did. The section is gone - it printed the skill
   * library's idea of a soft skill, "Innovation" and "Proactiveness" - so a
   * scanner now finds them only if the sentences carry them. Buried in a
   * 34-term total, a run that drops every one of them still reads as 88%
   * placed, and the thing that changed is invisible.
   */
  /*
   * The posting's concepts, counted where a scanner reads them.
   *
   * The skills block prints the TOOL a concept is built with - PagerDuty for
   * "incident response" - which answers the block and not the scanner: it
   * scores "Incident response" as a hard skill and reported it missing from a
   * resume whose block said PagerDuty. The prompt now requires the phrase
   * itself in the summary or a bullet; this says whether it arrived.
   */
  const conceptsWanted = getConceptKeywords(jobAnalysis);
  if (conceptsWanted.length > 0) {
    const conceptProse = renderedProse(content);
    const placed = conceptsWanted.filter((term) => containsTerm(conceptProse, term));
    const missingConcepts = conceptsWanted.filter((term) => !containsTerm(conceptProse, term));
    const conceptLine =
      `[Resume concepts] ${profileName}: ${placed.length}/${conceptsWanted.length} written into the prose` +
      `${missingConcepts.length > 0 ? `. Missing: ${missingConcepts.slice(0, 8).join(', ')}` : '.'}`;
    // A warning now, for the same reason the soft skills became one: the block
    // used to carry these as entries whatever the sentences did, and it no
    // longer does. A concept missing from the prose is missing from the resume.
    if (missingConcepts.length > 0) console.warn(`${conceptLine} - the bullets are the only place they count now.`);
    else console.log(conceptLine);
  }

  const softWanted = withoutValuesPhrases(normalizeSkillsList([
    ...getSoftSkills(jobAnalysis),
    ...getMatchedLibrarySoftSkills(jobAnalysis),
  ])).terms;
  if (softWanted.length > 0) {
    const prose = renderedProse(content);
    const softPlaced = softWanted.filter((term) => containsTerm(prose, term));
    const missing = softWanted.filter((term) => !containsTerm(prose, term));
    /*
     * A WARNING when any are missing, which it was not while the skills block
     * ended with a group of them: a scanner found them there whatever the
     * sentences did, so a shortfall here cost nothing. That group is gone, so
     * a soft skill that is not in a bullet is not on the resume, and the score
     * falls by exactly the number missing.
     */
    const line =
      `[Resume soft skills] ${profileName}: ${softPlaced.length}/${softWanted.length} placed in the prose` +
      `${missing.length > 0 ? `. Missing: ${missing.slice(0, 8).join(', ')}` : '.'}`;
    if (missing.length > 0) console.warn(`${line} - the bullets are the only place they count now.`);
    else console.log(line);
  }

  if (report.ratio >= floor) {
    console.log(
      `[Resume keywords] ${profileName}: ${report.placed}/${report.total} checklist terms placed (${percent}%).`
    );
    return report;
  }

  console.warn(
    `[Resume keywords] ${profileName}: only ${report.placed}/${report.total} checklist terms placed ` +
      `(${percent}%, floor ${(floor * 100).toFixed(0)}%). Missing: ` +
      `${report.missing.slice(0, 12).join(', ')}${report.missing.length > 12 ? `, +${report.missing.length - 12} more` : ''}`
  );
  return report;
}

function getHardSkillChecklist(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    ...getTechnicalSkills(jobAnalysis),
    ...getRequiredSkills(jobAnalysis),
    ...getPreferredSkills(jobAnalysis),
    ...getSkillTools(jobAnalysis),
    ...getTechnologies(jobAnalysis),
    ...getProtocols(jobAnalysis),
    ...getMethodologies(jobAnalysis),
    ...getArchitecturePatterns(jobAnalysis),
    ...getKeywordChecklist(jobAnalysis),
    ...getIndustryTerms(jobAnalysis),
  ]);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsLibraryTerm(text: string, term: string): boolean {
  const normalizedTerm = term.trim().replace(/\s+/g, ' ');
  if (!normalizedTerm) return false;

  const pattern = escapeRegex(normalizedTerm).replace(/\\\s+/g, '\\s+');
  const flags = normalizedTerm === 'Go' ? '' : 'i';
  return new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, flags).test(text);
}

function getLibraryMatches(sourceText: string, librarySkills: string[]): string[] {
  if (!sourceText.trim()) return [];
  return normalizeSkillsList(librarySkills.filter((skill) => containsLibraryTerm(sourceText, skill)));
}

/**
 * Everything the profile says about the work this person has actually done.
 *
 * Read for skills the same way a job description is, because in practice that
 * is the only place the evidence lives: a profile's own `skills` array is very
 * often empty, and the per-role `skills` arrays nearly always are, while the
 * role titles, companies, descriptions and achievements are always filled in.
 * Anything they HAVE listed is included too, and does not need matching.
 */
function getProfileExperienceSkills(profile?: Profile): string[] {
  if (!profile) return [];

  const experienceText = [
    profile.title,
    profile.summary,
    ...(profile.experience ?? []).flatMap((role) => [
      role.title,
      role.company,
      role.description,
      ...(role.achievements ?? []),
    ]),
    ...(profile.education ?? []).flatMap((entry) => [entry.degree, ...(entry.achievements ?? [])]),
    ...(profile.certifications ?? []).map((entry) => entry.name),
    ...(profile.strengths ?? []).flatMap((entry) => [entry.title, entry.description]),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');

  const claimed = normalizeSkillsList([
    ...(profile.skills ?? []),
    ...(profile.experience ?? []).flatMap((role) => role.skills ?? []),
  ]);

  return normalizeSkillsList([...claimed, ...getLibraryMatches(experienceText, technicalSkills)]);
}

function canonicalSkillKey(skill: string): string {
  return normalizeHardSkillAlias(skill)
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .trim();
}

function isBroaderSkillCoveredBySpecificSkill(broader: string, specific: string): boolean {
  const broadKey = canonicalSkillKey(broader);
  const specificKey = canonicalSkillKey(specific);
  if (!broadKey || !specificKey || broadKey === specificKey) return false;

  return specificKey.startsWith(`${broadKey} `)
    || specificKey.startsWith(`${broadKey}.`)
    || specificKey.startsWith(`${broadKey}-`)
    || specificKey.startsWith(`${broadKey}/`);
}

function removeBroaderCoveredSkills(skills: string[]): string[] {
  const normalized = normalizeSkillsList(skills);
  return normalized.filter((skill) =>
    !normalized.some((candidate) => isBroaderSkillCoveredBySpecificSkill(skill, candidate))
  );
}

type CategorizedSkillGroup = {
  category: LibraryHardSkillCategory;
  skills: string[];
};

const LANGUAGE_LIBRARY_CATEGORY: LibraryHardSkillCategory = 'Languages';
const MIN_LANGUAGE_SKILLS_PER_LIBRARY_CATEGORY = 3;
const MAX_LANGUAGE_SKILLS_PER_LIBRARY_CATEGORY = 5;
const MIN_SKILLS_PER_LIBRARY_CATEGORY = 5;
const MAX_SKILLS_PER_LIBRARY_CATEGORY = 10;
const MIN_LIBRARY_CATEGORY_COUNT = 5;
const LANGUAGE_FILL_EXCLUDED_SKILLS = new Set(['bash', 'c#', 'html', 'css']);
const LANGUAGE_FILL_PRIORITY = new Map(
  [
    'python',
    'java',
    'javascript',
    'typescript',
    'go',
    'ruby',
    'php',
    'sql',
    'swift',
    'kotlin',
    'rust',
    'scala',
    'c++',
    'dart',
    'elixir',
    'r',
  ].map((skill, index) => [skill, index])
);

/**
 * Says what the skill blocks refused, once per distinct reason.
 *
 * Rejections used to be a `continue` inside whichever function noticed, so an
 * operator looking at a resume with a keyword missing had nothing to read. This
 * does not change what is printed; it makes the decision inspectable.
 */
function reportRejectedSkills(kind: 'hard' | 'soft', rejected: SkillVerdict[]): void {
  if (rejected.length === 0) return;
  const byReason = new Map<string, string[]>();
  for (const verdict of rejected) {
    if (verdict.ok) continue;
    byReason.set(verdict.reason, [...(byReason.get(verdict.reason) ?? []), verdict.term]);
  }
  for (const [reason, terms] of byReason) {
    console.log(
      `[Resume skills] ${kind}: ${terms.length} term(s) kept out of the block - ` +
        `${REJECTION_DETAIL[reason as keyof typeof REJECTION_DETAIL]}. ` +
        `They stay in the prose checklists. (${terms.slice(0, 6).join(', ')}${terms.length > 6 ? ', ...' : ''})`
    );
  }
}

function getHardSkillRecord(skill: string): (typeof hardSkillRecords)[number] | undefined {
  const normalized = normalizeHardSkillAlias(skill);
  return hardSkillRecords.find((record) => normalizeHardSkillAlias(record.skill) === normalized);
}

function getLibraryPriority(skill: string): number {
  return getHardSkillRecord(skill)?.priority ?? Number.MAX_SAFE_INTEGER;
}

function sortByLibraryPriorityAndName(skills: string[]): string[] {
  return normalizeSkillsList(skills).sort((left, right) => {
    const priorityDiff = getLibraryPriority(left) - getLibraryPriority(right);
    if (priorityDiff !== 0) return priorityDiff;
    return left.localeCompare(right, undefined, { sensitivity: 'base' });
  });
}

function getCategorySkillMinimum(category: LibraryHardSkillCategory): number {
  return category === LANGUAGE_LIBRARY_CATEGORY
    ? MIN_LANGUAGE_SKILLS_PER_LIBRARY_CATEGORY
    : MIN_SKILLS_PER_LIBRARY_CATEGORY;
}

function getCategorySkillMaximum(category: LibraryHardSkillCategory): number {
  return category === LANGUAGE_LIBRARY_CATEGORY
    ? MAX_LANGUAGE_SKILLS_PER_LIBRARY_CATEGORY
    : MAX_SKILLS_PER_LIBRARY_CATEGORY;
}

function isLibraryFillAllowed(record: (typeof hardSkillRecords)[number]): boolean {
  return (
    record.category !== LANGUAGE_LIBRARY_CATEGORY ||
    !LANGUAGE_FILL_EXCLUDED_SKILLS.has(normalizeHardSkillAlias(record.skill))
  );
}

function compareLibraryFillRecords(
  left: (typeof hardSkillRecords)[number],
  right: (typeof hardSkillRecords)[number]
): number {
  if (left.category === LANGUAGE_LIBRARY_CATEGORY && right.category === LANGUAGE_LIBRARY_CATEGORY) {
    const leftRank = LANGUAGE_FILL_PRIORITY.get(normalizeHardSkillAlias(left.skill)) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = LANGUAGE_FILL_PRIORITY.get(normalizeHardSkillAlias(right.skill)) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
  }

  if (left.priority !== right.priority) return left.priority - right.priority;
  return left.skill.localeCompare(right.skill, undefined, { sensitivity: 'base' });
}

function buildCategorizedLibrarySkills(seedSkills: string[]): CategorizedSkillGroup[] {
  const grouped = new Map<LibraryHardSkillCategory, string[]>(
    HARD_SKILL_CATEGORIES.map((category) => [category, []])
  );
  const used = new Set<string>();

  for (const skill of sortByLibraryPriorityAndName(seedSkills)) {
    const record = getHardSkillRecord(skill);
    if (!record) continue;
    const display = record.skill;
    const key = normalizeHardSkillAlias(display);
    if (!key || used.has(key)) continue;
    used.add(key);
    grouped.get(record.category)?.push(display);
  }

  const hasDynamicCategory = HARD_SKILL_CATEGORIES
    .filter((category) => category !== LANGUAGE_LIBRARY_CATEGORY)
    .some((category) => (grouped.get(category)?.length ?? 0) > 0);
  const includedCategories = new Set<LibraryHardSkillCategory>([LANGUAGE_LIBRARY_CATEGORY]);
  for (const category of HARD_SKILL_CATEGORIES) {
    if (category !== LANGUAGE_LIBRARY_CATEGORY && (grouped.get(category)?.length ?? 0) > 0) {
      includedCategories.add(category);
    }
  }

  if (!hasDynamicCategory) {
    includedCategories.add('Frameworks and Libraries');
    includedCategories.add('Cloud and Infrastructure');
  }

  for (const category of HARD_SKILL_CATEGORIES) {
    if (includedCategories.size >= MIN_LIBRARY_CATEGORY_COUNT) break;
    if (category !== LANGUAGE_LIBRARY_CATEGORY) {
      includedCategories.add(category);
    }
  }

  const recordsByCategory = new Map<LibraryHardSkillCategory, typeof hardSkillRecords>(
    HARD_SKILL_CATEGORIES.map((category) => [
      category,
      hardSkillRecords
        .filter((record) => record.category === category)
        .sort(compareLibraryFillRecords),
    ])
  );

  for (const category of includedCategories) {
    const categorySkills = grouped.get(category) ?? [];
    for (const record of recordsByCategory.get(category) ?? []) {
      if (categorySkills.length >= getCategorySkillMinimum(category)) break;
      if (!isLibraryFillAllowed(record)) continue;
      const key = normalizeHardSkillAlias(record.skill);
      if (!key || used.has(key)) continue;
      used.add(key);
      categorySkills.push(record.skill);
    }
    grouped.set(category, categorySkills.slice(0, getCategorySkillMaximum(category)));
  }

  return HARD_SKILL_CATEGORIES
    .filter((category) => includedCategories.has(category))
    .map((category) => ({
      category,
      skills: grouped.get(category) ?? [],
    }))
    .filter((group) => group.skills.length > 0);
}

function flattenCategorizedSkills(groups: CategorizedSkillGroup[]): string[] {
  return uniqueCaseInsensitive(groups.flatMap((group) => group.skills));
}

function buildLibraryAugmentedPromptLists(jobAnalysis: JobAnalysis): {
  skills: CategorizedSkillGroup[];
  promptSkills: string[];
  keywords: string[];
} {
  const sourceText = getTailoringSourceText(jobAnalysis);
  const extractedKeywords = getKeywordChecklist(jobAnalysis);
  /*
   * The library's matches, AND the technologies this posting named outright.
   *
   * WHY THE SECOND HALF EXISTS. `promptSkills` is what the prompt calls "a
   * starting point for skillGroups" - the list the skills block is built from -
   * and it was library matches alone. The library is 1,247 rows with no entry
   * for MCP, LLM, LLMs or Large Language Models, so a posting that names them
   * every other line put them on `keywordsJson` instead, whose preamble says
   * those are PROSE targets. Measured on one posting: skillsJSON came back as
   * ["RAG","Scrum"] while keywordsJson carried LLMs, MCP, Large Language
   * Models, RAG, MCP server and LLM.
   *
   * So a resume arrived with "Large Language Models" and "RAG" in its bullets
   * and neither in its block, and the model was obeying: they reached it on the
   * list labelled prose. Naming them in the prompt as block-legal only asks the
   * model to cross that boundary, and it did so on two resumes in five. This
   * puts them on the right list instead.
   *
   * TOOLS, TECHNOLOGIES AND PROTOCOLS ONLY - what `getJobNamedHardSkills`
   * returns. Not domainKnowledge, which rule 3 forbids for an industry the
   * candidate has not worked in; not skills.soft; and not keywords.actionVerbs,
   * the field that once put "owned" in a skills block.
   */
  const matchedTechSkills = normalizeSkillsList([
    ...removeBroaderCoveredSkills(getLibraryMatches(sourceText, technicalSkills)),
    ...getJobNamedHardSkills(jobAnalysis),
  ]);
  const matchedSoftSkills = getLibraryMatches(sourceText, softSkills);
  const categorizedSkills = buildCategorizedLibrarySkills(matchedTechSkills);

  return {
    skills: categorizedSkills,
    promptSkills: matchedTechSkills,
    keywords: normalizeSkillsList([
      ...extractedKeywords,
      ...matchedSoftSkills,
    ]),
  };
}

/**
 * The soft skills from the library that this job's text actually asks for.
 *
 * These used to be stitched into the summary after the fact, as a fixed
 * sentence - "Strengths include a, b, c across changing engineering contexts." -
 * appended to any summary that had missed them. It made every resume end on the
 * same clause with a different comma list inside it.
 *
 * They now feed the Soft Skills list, which is the section for them, and which
 * templates render. Reading the whole tailoring source rather than the analysis
 * alone is deliberate and is what the summary insertion did: a job that asks in
 * prose for someone adaptable says so in its description, not necessarily in
 * the `softSkills` array an analysis pass extracted from it.
 */
function getMatchedLibrarySoftSkills(jobAnalysis?: JobAnalysis): string[] {
  if (!jobAnalysis) return [];
  return getLibraryMatches(getTailoringSourceText(jobAnalysis), softSkills);
}


function normalizeHardSkillAlias(skill: string): string {
  return skill.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Job titles to exclude from hard skills - these are roles, not technical skills */
const JOB_TITLE_EXCLUSIONS = new Set([
  'full stack developer', 'fullstack developer', 'full-stack developer',
  'frontend developer', 'front-end developer', 'frotnend developer',
  'backend developer', 'back-end developer',
  'full stack engineer', 'frontend engineer', 'backend engineer',
  'software developer', 'software engineer',
]);

function capitalizeHardSkill(s: string): string {
  if (!s || s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function inferHardSkillCategory(skillAlias: string): HardSkillCategory {
  const rules: Array<{ category: HardSkillCategory; patterns: string[] }> = [
    {
      category: 'backend',
      patterns: [
        'python', 'fastapi', 'django', 'flask', 'pydantic', 'node', 'express', 'nestjs', 'fastify', 'koa',
        'rails', 'gin', 'echo', 'spring', 'laravel', 'symfony', 'grpc', 'websocket', 'server-sent',
        'microservice', 'event-driven', 'domain-driven', 'ddd', 'celery', 'rabbitmq', 'kafka', 'rest api',
        'restful api', 'graphql', 'async', 'background job', 'message queue', 'serverless', 'api gateway',
      ],
    },
    {
      category: 'frontend',
      patterns: [
        'react', 'angular', 'vue', 'next', 'nuxt', 'typescript', 'javascript', 'redux', 'zustand', 'mobx',
        'rxjs', 'html', 'css', 'scss', 'sass', 'tailwind', 'bootstrap', 'mui', 'material ui', 'ant design',
        'chakra', 'styled component', 'emotion', 'chart.js', 'd3', 'three.js', 'responsive design',
        'mobile-first', 'pwa', 'webpack', 'vite', 'rollup', 'babel', 'eslint', 'prettier',
      ],
    },
    {
      category: 'databases',
      patterns: [
        'postgres', 'mysql', 'sql server', 'oracle', 'mongodb', 'dynamodb', 'cassandra', 'couchdb', 'redis',
        'memcached', 'firestore', 'elasticsearch', 'solr', 'influxdb', 'timescaledb', 'neo4j', 'etl',
        'warehouse', 'data lake', 'sqlalchemy', 'prisma', 'typeorm', 'sequelize', 'mongoose', 'activerecord',
        'query optimization', 'indexing', 'sharding', 'replication', 'data model', 'database migration', 'acid',
      ],
    },
    {
      category: 'cloud-devops',
      patterns: [
        'aws', 'lambda', 'eks', 'ecs', 'fargate', 'ec2', 's3', 'cloudfront', 'rds', 'cloudwatch', 'sagemaker',
        'step function', 'sns', 'sqs', 'iam', 'vpc', 'route 53', 'gcp', 'google cloud', 'azure', 'docker',
        'kubernetes', 'helm', 'openshift', 'terraform', 'cloudformation', 'ansible', 'puppet', 'chef',
        'github actions', 'jenkins', 'gitlab ci', 'circleci', 'travis ci', 'argocd', 'flux', 'ci/cd',
        'infrastructure as code', 'iac', 'grafana', 'prometheus', 'datadog', 'new relic', 'elk', 'istio',
        'linkerd', 'load balancing', 'auto scaling',
      ],
    },
    {
      category: 'testing-automation',
      patterns: [
        'pytest', 'jest', 'junit', 'testng', 'mocha', 'chai', 'jasmine', 'cypress', 'playwright', 'selenium',
        'puppeteer', 'webdriverio', 'postman', 'insomnia', 'rest assured', 'locust', 'k6', 'jmeter',
        'artillery', 'unit testing', 'integration testing', 'end-to-end', 'e2e', 'api testing', 'tdd', 'bdd',
        'performance testing', 'security testing', 'penetration testing', 'code coverage', 'sonarqube', 'qa',
        'test automation',
      ],
    },
    {
      category: 'ai-ml',
      patterns: [
        'openai', 'chatgpt', 'claude api', 'langchain', 'llamaindex', 'transformers', 'tensorflow', 'pytorch',
        'keras', 'scikit-learn', 'xgboost', 'lightgbm', 'spacy', 'nltk', 'pandas', 'numpy', 'matplotlib',
        'seaborn', 'jupyter', 'prompt engineering', 'fine-tuning', 'rag', 'pinecone', 'chroma', 'weaviate',
        'mlops', 'computer vision', 'natural language processing', 'nlp', 'deep learning', 'machine learning',
      ],
    },
    {
      category: 'tools-methodologies',
      patterns: [
        'git', 'github', 'gitlab', 'bitbucket', 'jira', 'asana', 'trello', 'linear', 'monday', 'confluence',
        'notion', 'swagger', 'figma', 'sketch', 'adobe xd', 'vscode', 'pycharm', 'intellij', 'webstorm',
        'sublime', 'vim', 'agile', 'scrum', 'kanban', 'devops', 'clean architecture', 'solid', 'design pattern',
        'code review', 'pair programming', 'npm', 'yarn', 'pip', 'poetry', 'maven', 'gradle',
      ],
    },
  ];

  for (const rule of rules) {
    if (rule.patterns.some((pattern) => skillAlias.includes(pattern))) {
      return rule.category;
    }
  }

  return 'other';
}

function resolveHardSkill(skill: string): { display: string; category: HardSkillCategory; priority: number } | null {
  const normalized = skill.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 50 || /[.!?]/.test(normalized)) return null;

  const lower = normalizeHardSkillAlias(normalized);
  // Exclude job titles (full stack developer, frontend developer, etc.)
  if (JOB_TITLE_EXCLUSIONS.has(lower)) return null;
  // Exclude soft skills only (communication, collaboration, ownership, etc.)
  if (SOFT_SKILL_SIGNALS.some((signal) => lower.includes(signal))) return null;

  // If in alias map, return canonical form (already properly capitalized)
  const mapped = HARD_SKILL_ALIAS_MAP.get(lower);
  if (mapped) return mapped;

  // Pass through as hard skill: frameworks, tools, architectures, methodologies, tech names
  const techIndicators = [
    'api', 'rest', 'graphql', 'backend', 'frontend', 'fullstack', 'full-stack',
    'microservice', 'event-driven', 'distributed', 'database', 'sql', 'etl',
    'devops', 'ci/cd', 'docker', 'kubernetes', 'aws', 'cloud', 'architecture',
    'python', 'javascript', 'typescript', 'react', 'vue', 'angular', 'nuxt', 'svelte', 'ember', 'django', 'node', 'go', 'rust', 'rails', 'spring', 'laravel',
    'redis', 'postgres', 'mysql', 'kafka', 'airflow', 'dbt', 'snowflake',
    'terraform', 'testing', 'celery', 'flutter', 'lambda', 'cloudflare',
  ];
  if (techIndicators.some((term) => lower.includes(term))) {
    return {
      display: capitalizeHardSkill(normalized),
      category: inferHardSkillCategory(lower),
      priority: Number.MAX_SAFE_INTEGER,
    };
  }

  // Single-word tech (Airflow, dbt, Kafka) - allow if looks like a tool/framework name
  if (/^[a-z0-9][a-z0-9+\-./]*$/.test(lower) && lower.length >= 2) {
    return {
      display: capitalizeHardSkill(normalized),
      category: inferHardSkillCategory(lower),
      priority: Number.MAX_SAFE_INTEGER,
    };
  }

  return null;
}

function normalizeAllowedHardSkills(skills: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of skills) {
    const resolved = resolveHardSkill(raw);
    if (!resolved) continue;
    const display = resolved.display;
    const key = display.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(display);
  }

  return result;
}

function getHardSkillPriority(skill: string): number {
  return hardSkillPriorityMap.get(skill.trim().toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
}

function containsHardSkillPhrase(text: string, skill: string): boolean {
  const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const flags = skill === 'Go' ? '' : 'i';
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, flags).test(text);
}

function getExperienceSkillText(experience: Profile['experience'][number]): string {
  return [
    experience.title,
    experience.company,
    experience.location,
    experience.description,
    ...(experience.achievements ?? []),
    ...(experience.skills ?? []),
  ]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
}

function getLibraryHardSkillDisplayMap(): Map<string, string> {
  return new Map(technicalSkills.map((skill) => [normalizeHardSkillAlias(skill), skill]));
}

function getMergedExperienceSkills(profile: Profile): string[] {
  const libraryDisplayByKey = getLibraryHardSkillDisplayMap();
  return uniqueCaseInsensitive(
    profile.experience.flatMap((experience) =>
      (experience.skills ?? [])
        .map((skill) => libraryDisplayByKey.get(normalizeHardSkillAlias(skill)))
        .filter((skill): skill is string => !!skill)
    )
  );
}

function restrictExperienceSkillsToLibrary(profile: Profile): Profile {
  const libraryDisplayByKey = getLibraryHardSkillDisplayMap();
  const experience = profile.experience.map((item) => ({
    ...item,
    skills: uniqueCaseInsensitive(
      (item.skills ?? [])
        .map((skill) => libraryDisplayByKey.get(normalizeHardSkillAlias(skill)))
        .filter((skill): skill is string => !!skill)
    ),
  }));

  return {
    ...profile,
    experience,
    skills: getMergedExperienceSkills({ ...profile, experience }),
  };
}

function getMatchedJobDescriptionHardSkills(jobAnalysis: JobAnalysis): string[] {
  const libraryDisplayByKey = getLibraryHardSkillDisplayMap();
  const originalOrder = new Map<string, number>();
  const matchedSkills: string[] = [];
  const candidates = [
    ...getTechnicalSkills(jobAnalysis),
    ...getRequiredSkills(jobAnalysis),
    ...getPreferredSkills(jobAnalysis),
    ...getSkillTools(jobAnalysis),
    ...getTechnologies(jobAnalysis),
    ...getProtocols(jobAnalysis),
    ...getMethodologies(jobAnalysis),
    ...getArchitecturePatterns(jobAnalysis),
    ...extractTechSkills(getTailoringSourceText(jobAnalysis)),
  ];

  for (const rawSkill of candidates) {
    const cleaned = rawSkill.trim();
    if (!cleaned) continue;
    const display = libraryDisplayByKey.get(normalizeHardSkillAlias(cleaned));
    if (!display) continue;

    const key = display.toLowerCase();
    if (!originalOrder.has(key)) {
      originalOrder.set(key, originalOrder.size);
    }
    matchedSkills.push(display);
  }

  return uniqueCaseInsensitive(matchedSkills).sort((a, b) => {
    const aPriority = getHardSkillPriority(a);
    const bPriority = getHardSkillPriority(b);
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }

    return (originalOrder.get(a.toLowerCase()) ?? 0) - (originalOrder.get(b.toLowerCase()) ?? 0);
  });
}

function scoreSkillForExperience(
  skill: string,
  experience: Profile['experience'][number],
  assignedSkills: string[],
  experienceIndex: number
): number {
  const experienceText = getExperienceSkillText(experience);
  const resolved = resolveHardSkill(skill);
  const skillCategory = resolved?.category;
  const assignedCategories = new Set(
    assignedSkills
      .map((assignedSkill) => resolveHardSkill(assignedSkill)?.category)
      .filter((category): category is HardSkillCategory => !!category)
  );

  let score = 0;

  if (containsHardSkillPhrase(experienceText, skill)) {
    score += 100;
  }

  if (skillCategory && assignedCategories.has(skillCategory)) {
    score += 20;
  }

  // Small deterministic recency bias when other relevance signals tie.
  score += Math.max(0, 5 - experienceIndex);

  return score;
}

export function enrichProfileExperienceSkillsForJob(profile: Profile, jobAnalysis: JobAnalysis): Profile {
  const matchedJobSkills = getMatchedJobDescriptionHardSkills(jobAnalysis);
  if (matchedJobSkills.length === 0 || profile.experience.length === 0) {
    return restrictExperienceSkillsToLibrary(profile);
  }

  const libraryDisplayByKey = getLibraryHardSkillDisplayMap();
  const matchedSkillKeys = new Set(matchedJobSkills.map((skill) => skill.toLowerCase()));
  const matchedSkillDisplay = new Map(matchedJobSkills.map((skill) => [skill.toLowerCase(), skill]));
  const assignedSkillKeys = new Set<string>();
  const originalUnmatchedSkillsByExperience: string[][] = [];
  const enrichedExperience = profile.experience.map((experience, index) => {
    const originalSkills = experience.skills ?? [];
    const normalizedOriginalSkills = originalSkills
      .map((skill) => libraryDisplayByKey.get(normalizeHardSkillAlias(skill)))
      .filter((skill): skill is string => !!skill);
    const relevantExistingSkills = normalizedOriginalSkills
      .map((skill) => libraryDisplayByKey.get(normalizeHardSkillAlias(skill)) ?? skill)
      .map((skill) => matchedSkillDisplay.get(skill.toLowerCase()) ?? skill)
      .filter((skill) => matchedSkillKeys.has(skill.toLowerCase()));
    const skills = uniqueCaseInsensitive(relevantExistingSkills);
    const matchedExistingKeys = new Set(skills.map((skill) => skill.toLowerCase()));
    originalUnmatchedSkillsByExperience[index] = uniqueCaseInsensitive(
      normalizedOriginalSkills.filter((skill) => !matchedExistingKeys.has(skill.toLowerCase()))
    );

    for (const skill of skills) {
      assignedSkillKeys.add(skill.toLowerCase());
    }

    return {
      ...experience,
      skills,
    };
  });

  const remainingSkills = matchedJobSkills.filter((skill) => !assignedSkillKeys.has(skill.toLowerCase()));

  for (const skill of remainingSkills) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    enrichedExperience.forEach((experience, index) => {
      const currentSkills = experience.skills ?? [];
      const relevanceScore = scoreSkillForExperience(skill, experience, currentSkills, index);
      const balancePenalty = currentSkills.length * 8;
      const score = relevanceScore - balancePenalty;

      if (
        score > bestScore ||
        (score === bestScore && currentSkills.length < (enrichedExperience[bestIndex].skills ?? []).length)
      ) {
        bestIndex = index;
        bestScore = score;
      }
    });

    enrichedExperience[bestIndex] = {
      ...enrichedExperience[bestIndex],
      skills: uniqueCaseInsensitive([...(enrichedExperience[bestIndex].skills ?? []), skill]),
    };
  }

  enrichedExperience.forEach((experience, index) => {
    const filledSkills = [...(experience.skills ?? [])];
    const seen = new Set(filledSkills.map((skill) => skill.toLowerCase()));

    for (const skill of originalUnmatchedSkillsByExperience[index] ?? []) {
      if (filledSkills.length >= MIN_EXPERIENCE_SKILLS) {
        break;
      }

      const key = skill.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      filledSkills.push(skill);
      seen.add(key);
    }

    enrichedExperience[index] = {
      ...experience,
      skills: filledSkills,
    };
  });

  return {
    ...profile,
    skills: getMergedExperienceSkills({ ...profile, experience: enrichedExperience }),
    experience: enrichedExperience,
  };
}

const MAX_SOFT_SKILL_LENGTH = 30;

/** Map long soft skill phrases to short key points */
const SOFT_SKILL_CONDENSE: Array<{ patterns: RegExp | string[]; key: string }> = [
  { patterns: ['excellent communication', 'communication and collaboration', 'communication skills', 'communicate'], key: 'Communication' },
  { patterns: ['collaboration', 'collaborative', 'collaborate'], key: 'Collaboration' },
  { patterns: ['cross-functional', 'cross functional'], key: 'Cross-functional' },
  { patterns: ['problem-solving', 'problem solving'], key: 'Problem-solving' },
  { patterns: ['ownership', 'high ownership'], key: 'Ownership' },
  { patterns: ['autonomy', 'self-directed', 'independent'], key: 'Autonomy' },
  { patterns: ['transparency', 'transparent'], key: 'Transparency' },
  { patterns: ['reliability', 'reliable'], key: 'Reliability' },
  { patterns: ['supportive', 'support'], key: 'Supportive' },
  { patterns: ['passionate', 'passion'], key: 'Passion' },
  { patterns: ['mentorship', 'mentor', 'help fellow'], key: 'Mentorship' },
  { patterns: ['adaptability', 'adapt'], key: 'Adaptability' },
  { patterns: ['eager to learn', 'lifelong learning'], key: 'Eager to learn' },
  { patterns: ['accountability', 'accountable'], key: 'Accountability' },
  { patterns: ['attention to detail', 'detail-oriented'], key: 'Attention to detail' },
  { patterns: ['team player', 'we are one team'], key: 'Team player' },
  { patterns: ['diverse', 'diversity'], key: 'Diversity' },
  { patterns: ['innovative', 'innovation', 'great ideas'], key: 'Innovation' },
  { patterns: ['analytics', 'applied ai'], key: 'Analytics & AI' },
  { patterns: ['scalable', 'polished'], key: 'Quality focus' },
];

function condenseSoftSkill(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= MAX_SOFT_SKILL_LENGTH) {
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }
  const lower = trimmed.toLowerCase();
  for (const { patterns, key } of SOFT_SKILL_CONDENSE) {
    const matches = Array.isArray(patterns)
      ? patterns.some((p) => lower.includes(p.toLowerCase()))
      : (patterns as RegExp).test(lower);
    if (matches) return key;
  }
  const firstWord = trimmed.split(/\s+/)[0];
  return firstWord ? firstWord.charAt(0).toUpperCase() + firstWord.slice(1) : trimmed;
}

function prioritizeSoftSkills(skills: string[]): string[] {
  return [...skills].sort((a, b) => {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    const aScore = SOFT_SKILL_SIGNALS.reduce((count, signal) =>
      count + (aLower.includes(signal) ? 1 : 0), 0);
    const bScore = SOFT_SKILL_SIGNALS.reduce((count, signal) =>
      count + (bLower.includes(signal) ? 1 : 0), 0);

    if (bScore !== aScore) return bScore - aScore;
    return a.length - b.length;
  });
}

function inferAtsSoftSkillsFromText(text: string): string[] {
  const lower = text.toLowerCase();
  return ATS_SOFT_SKILL_RULES
    .filter((rule) => rule.patterns.some((pattern) => lower.includes(pattern)))
    .map((rule) => rule.canonical);
}

function inferAtsSoftSkillsFromAnalysis(jobAnalysis?: JobAnalysis): string[] {
  if (!jobAnalysis) return [];

  const text = [
    ...getSoftSkills(jobAnalysis),
    ...getKeywordChecklist(jobAnalysis),
    ...getResponsibilities(jobAnalysis),
    ...getIndustryTerms(jobAnalysis),
  ].join(' | ');

  return inferAtsSoftSkillsFromText(text);
}

function buildJobDescriptionSkillPriority(jobAnalysis?: JobAnalysis): Map<string, number> {
  const normalized = normalizeAllowedHardSkills(getHardSkillChecklist(jobAnalysis));
  const priorityMap = new Map<string, number>();

  normalized.forEach((skill, index) => {
    priorityMap.set(skill.toLowerCase(), index);
  });

  return priorityMap;
}

function prioritizeHardSkills(skills: string[], jobAnalysis?: JobAnalysis): string[] {
  // Ordered, not filtered. This used to open with `normalizeAllowedHardSkills`,
  // which canonicalises and deduplicates and drops what it does not recognise -
  // so choosing "order by relevance to the job" silently removed skills. A
  // twenty-skill block came out at fifteen, because React and React.js had
  // already been counted as two and were now printed as one. The renaming is
  // right; doing it here was not, and it now happens during selection where the
  // count can account for it.
  const normalized = uniqueCaseInsensitive(skills);
  const originalOrder = new Map<string, number>();
  const jdPriority = buildJobDescriptionSkillPriority(jobAnalysis);

  normalized.forEach((skill, index) => {
    originalOrder.set(skill.toLowerCase(), index);
  });

  return [...normalized].sort((a, b) => {
    const aResolved = resolveHardSkill(a);
    const bResolved = resolveHardSkill(b);
    const aCategory = aResolved?.category ?? 'other';
    const bCategory = bResolved?.category ?? 'other';
    const categoryDiff = HARD_SKILL_CATEGORY_WEIGHT[aCategory] - HARD_SKILL_CATEGORY_WEIGHT[bCategory];

    if (categoryDiff !== 0) {
      return categoryDiff;
    }

    const aJdOrder = jdPriority.get(a.toLowerCase());
    const bJdOrder = jdPriority.get(b.toLowerCase());
    const aInJd = typeof aJdOrder === 'number';
    const bInJd = typeof bJdOrder === 'number';

    if (aInJd !== bInJd) {
      return aInJd ? -1 : 1;
    }

    if (aInJd && bInJd && aJdOrder !== bJdOrder) {
      return (aJdOrder ?? 0) - (bJdOrder ?? 0);
    }

    const libraryPriorityDiff = getHardSkillPriority(a) - getHardSkillPriority(b);
    if (libraryPriorityDiff !== 0) {
      return libraryPriorityDiff;
    }

    const templatePriorityDiff = (aResolved?.priority ?? Number.MAX_SAFE_INTEGER)
      - (bResolved?.priority ?? Number.MAX_SAFE_INTEGER);
    if (templatePriorityDiff !== 0) {
      return templatePriorityDiff;
    }

    return (originalOrder.get(a.toLowerCase()) ?? 0) - (originalOrder.get(b.toLowerCase()) ?? 0);
  });
}

function sortHardSkillsByLibraryPriority(skills: string[]): string[] {
  return [...skills].sort((a, b) => {
    const priorityDiff = getHardSkillPriority(a) - getHardSkillPriority(b);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });
}

/**
 * "Collaboration" and "Collaboration skills" are one soft skill.
 *
 * MEASURED ON THE FIRST RUN WITH THE SECTION BACK: a ten-term list came back
 * holding "Collaboration" beside "Collaboration skills" and "Problem Solving"
 * beside "Strong problem-solving skills" - two of its ten slots spent saying
 * the same thing twice, in a section eight to ten terms long. The entries come
 * from three sources that spell them differently: the posting's own soft
 * skills, the library's rows, and whatever the model returned.
 *
 * `condenseSoftSkill` does not catch it, by design: it only rewrites an entry
 * that is too LONG to print, and "Collaboration skills" is short enough to pass.
 *
 * The key is the term with the decoration taken off - a leading intensifier, a
 * trailing "skills", the hyphens that make "problem-solving" a different string
 * from "problem solving". Six stop words rather than a vocabulary: this is
 * English grammar around a term, not a judgement about what the term means.
 */
const SOFT_SKILL_INTENSIFIERS = /^(?:strong|excellent|exceptional|great|proven|solid)\s+/;
const SOFT_SKILL_TRAILERS = /\s+(?:skills?|abilities|ability)$/;

function softSkillKey(skill: string): string {
  let key = skill.toLowerCase().replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim();
  key = key.replace(SOFT_SKILL_INTENSIFIERS, '');
  key = key.replace(SOFT_SKILL_TRAILERS, '');
  // "problem solving" and "problem solve" are the same claim.
  return key.replace(/\b(\w+?)ing\b/g, '$1').trim();
}

function dedupeSoftSkills(skills: string[]): string[] {
  const bestByKey = new Map<string, string>();
  const order: string[] = [];

  for (const skill of skills) {
    const key = softSkillKey(skill);
    if (!key) continue;
    const held = bestByKey.get(key);
    if (held === undefined) {
      bestByKey.set(key, skill);
      order.push(key);
      continue;
    }
    // The plainest spelling wins: shortest, and the first seen on a tie, so the
    // priority order above decides when two forms are the same length.
    if (skill.length < held.length) bestByKey.set(key, skill);
  }

  /*
   * AND THE GENERIC INSIDE THE SPECIFIC. "Empathy" beside "Customer empathy",
   * "Communication" beside "Written communication" - the library carries the
   * bare noun and the posting asked for the qualified one, and both printed.
   * In a section eight to ten long that is a slot spent saying a weaker
   * version of the line above it.
   *
   * THE FIRST ONE SURVIVES, which is the whole point of ordering by source
   * first: the posting's "Customer empathy" arrives before the library's
   * "Empathy", so the qualified term is the one kept. A scanner looking for
   * the bare noun still matches it inside the longer phrase, because a term is
   * matched on word boundaries rather than as a whole string.
   */
  const kept: string[] = [];
  for (const key of order) {
    const skill = bestByKey.get(key) as string;
    const words = key.split(' ').filter(Boolean);
    const coveredByEarlier = kept.some((earlier) => {
      const earlierWords = softSkillKey(earlier).split(' ').filter(Boolean);
      if (earlierWords.length <= words.length) {
        // The earlier one is the shorter: is it the tail of this one?
        return earlierWords.length > 0
          && earlierWords.join(' ') === words.slice(words.length - earlierWords.length).join(' ');
      }
      return words.join(' ') === earlierWords.slice(earlierWords.length - words.length).join(' ');
    });
    if (!coveredByEarlier) kept.push(skill);
  }

  return kept;
}

/**
 * The list as it will print: deduped, capped, and IN THE ORDER IT ARRIVED.
 *
 * `prioritizeSoftSkills` used to run here, and it was the second half of the
 * same defect as the merge order above. It re-sorts the whole list by how many
 * of a fixed set of signal words each term contains, which threw away the
 * source ordering the caller had just established - and then the ten-entry cap
 * took the top of a list ordered by that count.
 *
 * MEASURED on a posting asking for eight specific soft skills: "Bias for
 * action", "Ambiguity tolerance" and "Technical mentorship" were all dropped,
 * while "Reliability", "Empathy", "Mentorship" and "Collaboration" - none of
 * which the posting named - survived into the printed ten. The posting's own
 * relevance order, which the prompt asks the model for explicitly, was being
 * discarded one step before the cap.
 *
 * The sort is still there for callers that want it; what changed is that this
 * function no longer imposes it on a list whose order already means something.
 *
 * A POSTING TERM IS NOT REWRITTEN. `condenseSoftSkill` shortens an entry too
 * long to print, and its fallbacks rewrite the words - "Technical mentorship"
 * would become "Mentorship", which is a different string to a scanner, and the
 * prompt spends two sections insisting the posting's spelling is a quotation.
 * So terms the posting named are left exactly as they are and only the rest
 * are condensed.
 */
function finalizeSoftSkills(skills: string[], fromPosting: Iterable<string> = []): string[] {
  const protectedTerms = new Set(
    [...fromPosting].map((term) => term.trim().toLowerCase()).filter(Boolean)
  );
  const shaped = normalizeSkillsList(skills).map((skill) =>
    protectedTerms.has(skill.trim().toLowerCase()) ? skill : condenseSoftSkill(skill)
  );
  return dedupeSoftSkills(uniqueCaseInsensitive(shaped)).slice(0, MAX_SOFT_SKILLS);
}

function buildFallbackExperienceDescription(title: string, jobAnalysis?: JobAnalysis): string {
  const role = title.trim() || 'Engineer';
  const text = `${role} focused on reliable product delivery, maintainable systems, and practical engineering outcomes.`;
  return text.slice(0, MAX_ROLE_BRIEF_LENGTH).trim();
}

function buildFallbackAchievements(jobAnalysis?: JobAnalysis): string[] {
  const base = normalizeSafeResponsibilityList(getResponsibilities(jobAnalysis))
    .slice(0, 3);

  if (base.length > 0) {
    return base.map((item) => `Improved ${item.replace(/\.$/, '').trim()} through practical engineering execution.`);
  }

  return [
    'Improved delivery consistency across critical projects.',
    'Enhanced service reliability and operational efficiency.',
  ];
}

/**
 * A summary for a profile whose model output came back empty.
 *
 * This is the last resort and nothing else, which is a deliberate narrowing of
 * what it used to be. It previously ran on EVERY summary: it discarded whatever
 * opening sentence the model had written and substituted
 * "{Title} with about {N} years of experience in {a}, {b}, {c}." - so every
 * resume this app has ever produced opened on the same sentence with different
 * nouns dropped into it. That single line, not the model, is why the summaries
 * read as interchangeable.
 *
 * The years requirement did not go away, it moved: the tailor-resume prompt now
 * asks for the candidate's experience length in the model's own words and in
 * whatever position suits the sentence, which is what makes one summary differ
 * from the next.
 */
function buildFallbackSummary(profile: Profile): string {
  const years = profile.totalYearsExperience;
  const role = profile.title?.trim() || 'Professional';
  const topSkills = (profile.skills ?? []).slice(0, 3);
  const skillsText = topSkills.length > 0 ? ` in ${topSkills.join(', ')}` : '';

  if (typeof years !== 'number' || !Number.isFinite(years) || years < 0) {
    return `${role}${skillsText}.`;
  }

  const yearsText = Number.isInteger(years) ? String(years) : years.toFixed(1);
  return `${role} with about ${yearsText} years of experience${skillsText}.`;
}

const SPELLED_OUT_NUMBERS = new Map<string, string>([
  ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'],
  ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'], ['ten', '10'],
  ['eleven', '11'], ['twelve', '12'], ['thirteen', '13'], ['fourteen', '14'],
  ['fifteen', '15'], ['sixteen', '16'], ['seventeen', '17'], ['eighteen', '18'],
  ['nineteen', '19'], ['twenty', '20'], ['twenty-five', '25'], ['thirty', '30'],
]);

/**
 * Writes a span of experience as a numeral.
 *
 * "Seven years of engineering work" reads well in prose and scans badly on a
 * resume: a recruiter skimming for a number does not find one, and a filter
 * looking for "7+ years" does not match a word. Only quantities of TIME are
 * converted - a sentence about "three greenfield systems" keeps its word, which
 * is how it would be written anywhere else.
 *
 * Applied to the model's own wording, so a summary that already says "7 years"
 * is left exactly as it is.
 */
function useNumeralsForExperienceYears(summary: string): string {
  const words = [...SPELLED_OUT_NUMBERS.keys()].sort((a, b) => b.length - a.length).join('|');
  const pattern = new RegExp(`\\b(${words})(\\s+|-)(years?|yrs?)\\b`, 'gi');

  return summary.replace(pattern, (match, word: string, gap: string, unit: string) => {
    const digits = SPELLED_OUT_NUMBERS.get(word.toLowerCase());
    return digits ? `${digits}${gap}${unit}` : match;
  });
}

/**
 * Takes the candidate's employers out of the summary.
 *
 * A summary is the one section that is not about a particular job, and naming
 * an employer in it dates the paragraph to whichever company happens to be
 * current - the reader meets the company before they meet the candidate, and
 * the same sentence has to be rewritten the moment they move. The companies are
 * already stated, with dates, ten lines further down.
 *
 * The prepositional form is removed rather than the sentence, because the
 * sentence is usually the good one: "Seven years of engineering work at Capital
 * One shaped a practice built around distributed systems" loses two words and
 * keeps everything that was worth saying.
 *
 * A bare mention is only removed for a multi-word employer. A one-word name is
 * too often an ordinary noun as well - a candidate from Block or Stripe would
 * otherwise have sentences about block storage and stripe charts quietly
 * mangled - so those are left to the prompt, which is told not to write them.
 */
function removeCompanyMentionsFromSummary(summary: string, profile?: Profile): string {
  const companies = uniqueCaseInsensitive(
    (profile?.experience ?? [])
      .map((role) => role.company?.trim() ?? '')
      .filter((company) => company.length >= 3)
  );
  if (companies.length === 0) return summary;

  let output = summary;
  for (const company of companies) {
    const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // A short aside that exists only to name the employer goes whole:
    // "..., most recently for Capital One, across payments" would otherwise
    // leave a dangling "most recently,". Length-capped so this can never take
    // out a clause that was carrying the sentence.
    output = output.replace(
      new RegExp(`,\\s*[^,.]{0,40}\\b${escaped}(?:'s|’s)?\\b[^,.]{0,20},`, 'gi'),
      ','
    );

    // "... work at Capital One shaped ..." -> "... work shaped ..."
    output = output.replace(
      new RegExp(`\\s+(?:at|with|for|within|across|of|from)\\s+${escaped}(?:'s|’s)?\\b`, 'gi'),
      ''
    );

    if (company.trim().includes(' ')) {
      output = output.replace(new RegExp(`\\b${escaped}(?:'s|’s)?\\b`, 'gi'), '');
    }
  }

  return recapitalizeSentences(
    output
      .replace(/\s{2,}/g, ' ')
      .replace(/\s([.,;:!?])/g, '$1')
      .replace(/([.,;:])\s*\1+/g, '$1')
      .replace(/\s*,\s*\./g, '.')
      .trim()
  );
}

/**
 * Restores the capital letter a removal took with it.
 *
 * Dropping a company that opened a sentence - "Capital One systems handled
 * heavy load" - leaves the next word carrying a lower-case letter where the
 * sentence now starts.
 */
function recapitalizeSentences(text: string): string {
  return text.replace(/(^|[.!?]\s+)([a-z])/g, (_match, lead: string, letter: string) =>
    `${lead}${letter.toUpperCase()}`
  );
}

/**
 * The summary's "at most one figure" rule now lives in the prompt.
 *
 * It used to be enforced here by deleting every number after the first, which
 * deletes the number and keeps the sentence around it: "cut latency by 30%"
 * became "cut latency by." That was survivable while the summary's first number
 * was whatever the model happened to write, and became routine once spans of
 * experience were converted to numerals, because "7 years" then claimed the one
 * allowed slot and every real metric after it was stripped.
 *
 * A rule about how many numbers a paragraph should carry is a writing rule, and
 * the model can hold it while still writing a sentence that parses. Deleting
 * tokens afterwards cannot.
 */

/**
 * The headline the resume is printed under: the candidate's own title.
 *
 * WHAT THIS LINE HAS BEEN, in order, because the history is the argument. It was
 * rebuilt into a fixed `Senior <domain> Engineer` shape from whichever title
 * could be found, which renamed the candidate. Then the profile's own title with
 * the posting's discipline in parentheses - "Software Engineer (Integration)".
 * Then the profile's title alone. Then the POSTING's title, to win the job-title
 * match a scanner scores: measured over 495 delivered resumes, the posting's
 * title appeared verbatim in 2% of them and in 68% not even its first two words
 * appeared anywhere.
 *
 * It is the candidate's own title again, on the operator's instruction, and the
 * match it gave up is bought back somewhere the claim is smaller: the summary
 * names the KIND of role in the model's own words - "AI data engineering" for a
 * posting called "Data & AI Engineer - AWS, Java & Python" - which is a sentence
 * about what this person does rather than a title they have not held. See
 * `targetRoleTitle` in the prompt values, and the SUMMARY rule that uses it.
 *
 * The fallbacks are for a profile with no headline at all, and go to the
 * candidate's own most recent role before anything else.
 *
 * A PROFILE MAY SAY ITS OWN. `profileSettings.headerTitle` comes first when it
 * is set, and `appendTargetRole: false` prints it alone. Both exist because the
 * Title field is doing four jobs at once - it is printed, sent to the model as
 * who this person is, scanned for the skills they already claim, and used in
 * the fallback summary - so editing it to fix the printed line moved the other
 * three as well. These move only the printed line.
 */
function buildResumeHeadline(
  contentTitle: string | undefined,
  jobAnalysis: JobAnalysis | undefined,
  profile?: Profile
): string {
  const settings = profile?.profileSettings;
  const candidates = [
    settings?.headerTitle,
    profile?.title,
    contentTitle,
    profile?.experience?.[0]?.title,
  ];

  for (const candidate of candidates) {
    const trimmed = (candidate ?? '').trim().replace(/\s+/g, ' ');
    if (!trimmed) continue;
    // Off is a deliberate choice and is obeyed whatever the headline came from:
    // a profile whose own wording already names the discipline reads as a
    // stutter with the posting's kind of role after it.
    if (settings?.appendTargetRole === false) return trimmed;
    // The candidate's own line, and after it the kind of role this application
    // is for - in one of six shapes, drawn per resume. See
    // `headlineWithTargetRole`: the separator is the one part of the line that
    // can vary without changing what it says, and a batch where every headline
    // takes the same shape is a pattern anyone holding two of them can see.
    return headlineWithTargetRole(trimmed, getJobAnalysisTitle(jobAnalysis));
  }
  return 'Professional';
}

function isCompanyDescriptionLike(value: string, company?: string): boolean {
  const normalized = value.trim().replace(/\s+/g, ' ');
  const companyName = company?.trim();
  if (!normalized || !companyName) return false;

  const escapedCompany = companyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const companyLeadPattern = new RegExp(
    `^(?:category:\\s*)?${escapedCompany}\\b\\s+(?:is|are|was|were|builds|provides|offers|serves|uses|aims|helps|connects|creates|develops|delivers)\\b`,
    'i'
  );
  const marketingContextPattern = new RegExp(
    `\\b${escapedCompany}\\b.{0,80}\\b(?:founded|headquartered|acquired|serves|customers|platform|company|nonprofit|non-profit)\\b`,
    'i'
  );

  return companyLeadPattern.test(normalized) || marketingContextPattern.test(normalized);
}

function stripUnsafeResumeSentences(value: string, company?: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return '';

  const sentences = normalized.split(/(?<=[.!?])\s+/);
  const safeSentences = sentences
    .map((sentence) => sentence.trim())
    .filter((sentence) =>
      sentence &&
      !isUnsafeJobPostingPhrase(sentence) &&
      !isCompanyDescriptionLike(sentence, company)
    );

  return safeSentences.join(' ').trim();
}

/**
 * The profile as the MODEL needs to see it.
 *
 * Built by naming what goes in rather than by spreading the record and deleting
 * from it, so a field added to `Profile` later is not sent to a chat window by
 * default and noticed by nobody.
 *
 * Three groups are left out, and each for its own reason:
 *
 * - `id`, `createdAt`, `updatedAt` are this database's bookkeeping. They mean
 *   nothing to a model rewriting a summary.
 * - `profileSettings` is the operator's own configuration: which prompt
 *   records to use, their output file-name templates, and which AI model they
 *   pay for. Sending it typed the operator's tooling choices into somebody
 *   else's chat history for no purpose whatever.
 * - `contact` is a phone number, an email address and social links. This call
 *   rewrites the summary, the experience and the skills; it is never asked for
 *   contact details and the rendered resume takes them straight from the
 *   profile. No prompt in this app so much as mentions them.
 *
 * Measured on a five-role profile, together with dropping the pretty-printing:
 * the profile went from 7,428 characters to 5,363 and the whole tailoring
 * payload from 9,365 to 6,942 - 26% less, with nothing the model reads removed.
 * On a free chat provider that is also 26% less to type into the composer,
 * which is the slowest step of the turn by a wide margin.
 */
function buildPromptProfile(profile: Profile): Record<string, unknown> {
  return {
    name: profile.name,
    title: profile.title,
    totalYearsExperience: profile.totalYearsExperience,
    summary: profile.summary,
    experience: profile.experience.map((experience) => ({
      title: experience.title,
      company: experience.company,
      startDate: experience.startDate,
      endDate: experience.endDate,
      location: experience.location,
      // The raw description is replaced, not passed alongside: it is the field
      // most likely to carry a sentence about the COMPANY rather than the
      // person, and `stripUnsafeResumeSentences` is what takes those out.
      companyContext: stripUnsafeResumeSentences(experience.description ?? '', experience.company),
      achievements: experience.achievements,
      skills: experience.skills,
    })),
    strengths: profile.strengths,
    skills: profile.skills,
    // Sent when the profile has one: the model is asked to select skills, and
    // the author's own grouping is a fact about them it should not contradict.
    ...(profile.skillCategories?.length ? { skillCategories: profile.skillCategories } : {}),
    education: profile.education,
    certifications: profile.certifications,
  };
}

/**
 * JSON for a prompt: compact, not pretty.
 *
 * Two-space indentation is for a person reading a file. Nothing reads these but
 * a model, which parses both identically, and the indentation is 15-20% of the
 * payload on a nested record like a profile - paid on every call, for
 * whitespace.
 */
function promptJson(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Each concept the posting named, with the tools it is built with.
 *
 * WHY THE MODEL GETS OPTIONS RATHER THAN A DECISION. A posting says "CI/CD",
 * "containerization", "infrastructure as code"; a skills block has to say
 * Jenkins, Docker, Terraform. Which one is right depends on the candidate -
 * a Node shop runs GitHub Actions where a Java shop runs Jenkins - and the
 * model has the profile in front of it. Code does not, and code may not touch
 * the block it returns.
 *
 * WHY THE ORDER IS SHUFFLED. Handed the same list in the same order, a model
 * reaches for the same first entry every time, and fifty resumes come back
 * naming Jenkins. The order changes per request, so the pick varies between
 * candidates while still being one of the tools the concept is actually built
 * with. A tool the POSTING named is not affected: that one is written as the
 * posting spells it, which the prompt says plainly.
 */
function buildConceptToolOptions(
  jobAnalysis: JobAnalysis,
  concepts: string[]
): Array<{ concept: string; tools: string[] }> {
  /*
   * What the posting names as a TOOL - its tools, technologies and protocols.
   *
   * `skills.technical` is deliberately not here. The analyser defines that
   * field as "technical abilities NOT tied to a specific named tool", and its
   * own examples are "code review", "root cause analysis", "load testing".
   * Counting it as a named tool meant every ability was treated as already
   * answered, so the four that most needed a tool - "audit logging", "code
   * review", "observability tooling", "dynamic policy engines" - were skipped
   * by the very step that exists to map them.
   */
  const named = new Set(
    [
      ...getJobNamedHardSkills(jobAnalysis),
      // The raw fields, not `getRequiredSkills`: that one folds
      // `skills.technical` into required, which would put every ability back
      // in here and skip the mapping again.
      ...normalizeSkillsList(jobAnalysis?.skills?.required as string[] | undefined),
      ...normalizeSkillsList(jobAnalysis?.skills?.preferred as string[] | undefined),
    ]
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean)
  );

  /*
   * Every term the posting produced, not only the ones already classified.
   *
   * The options used to be built from the concept list alone, so a phrase the
   * table HAD tools for went without them whenever the concept rules had not
   * recognised it first. Measured on one posting's output: "audit logging",
   * "observability tooling", "Data Observability", "SLA-Based Alerting" and
   * "automation framework" each had an entry in the table and each reached the
   * resume as a phrase, because the code asked the table about classified
   * concepts only. The table is asked about everything now; a term it does not
   * know simply produces no row.
   */
  const candidates = uniqueCaseInsensitive([
    ...concepts,
    ...getTechnicalSkills(jobAnalysis),
    ...getJobNamedHardSkills(jobAnalysis),
    ...getResponsibilities(jobAnalysis),
    ...getDomainKnowledge(jobAnalysis),
    ...getRequiredSkills(jobAnalysis),
    ...getPreferredSkills(jobAnalysis),
  ]);

  const rows: Array<{ concept: string; tools: string[] }> = [];
  const seen = new Set<string>();
  for (const concept of candidates) {
    const options = conceptToolOptions(concept);
    if (options.length === 0) continue;
    // A term the posting names as a tool is not a concept to be mapped: the
    // model writes it as spelled, which the prompt says.
    if (named.has(concept.trim().toLowerCase())) continue;
    const key = concept.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // A tool the posting named for itself comes first and unshuffled - it is
    // not a choice, it is the answer.
    const fromPosting = options.filter((tool) => named.has(tool.toLowerCase()));
    const rest = shuffled(options.filter((tool) => !named.has(tool.toLowerCase())));
    rows.push({ concept, tools: [...fromPosting, ...rest] });
  }
  return rows;
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let at = copy.length - 1; at > 0; at -= 1) {
    const swap = Math.floor(Math.random() * (at + 1));
    [copy[at], copy[swap]] = [copy[swap], copy[at]];
  }
  return copy;
}

/**
 * Says what the model returned for the skills block. Changes nothing.
 *
 * Two things an operator would want to know and cannot see from the page:
 * whether the block came in thin - the prompt asks for about 18 skills and
 * tops up from the candidate's own stack to get there - and how much of it is
 * simply the posting's own list. A block that is entirely the posting's terms
 * is the shape a reader recognises as written for them this morning, which is
 * the thing the prompt is trying to avoid.
 *
 * Reported rather than corrected, because correcting it would mean editing an
 * answer this app asked the model to own.
 */
function reportSkillBlock(
  profileName: string,
  groups: Array<{ category: string; skills: string[] }>,
  skills: string[],
  jobAnalysis?: JobAnalysis
): void {
  if (groups.length === 0) return;

  const posting = new Set(
    [...getJobNamedHardSkills(jobAnalysis), ...getTechnicalSkills(jobAnalysis)]
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean)
  );
  const fromPosting = skills.filter((skill) => posting.has(skill.trim().toLowerCase())).length;
  const share = skills.length > 0 ? Math.round((100 * fromPosting) / skills.length) : 0;

  /*
   * The share of the block the posting did NOT name, said out loud.
   *
   * At a floor of 35 entries, most of the block is read off the candidate's
   * work rather than copied from the job description - no posting names
   * thirty-five tools, and these profiles carry no skill list of their own. The
   * prompt licenses that inference and bounds it: the ordinary companions of a
   * tool somebody plainly used, never a competitor beside it and never an
   * industry they have not worked in. An interviewer can still ask about any
   * line, so the number is worth seeing rather than burying.
   */
  const inferred = 100 - share;
  const thin = skills.length < MIN_SKILL_BLOCK_SIZE
    ? ` - UNDER the floor of ${MIN_SKILL_BLOCK_SIZE}`
    : '';
  const line =
    `[Resume skills] ${profileName}: ${skills.length} skill(s) in ${groups.length} group(s)${thin}. `
    + `${share}% are terms this posting named, ${inferred}% read off the candidate's work.`;
  if (thin) console.warn(line);
  else console.log(line);

  /*
   * Groups too small to stand, reported and not touched.
   *
   * Code did fold them for one batch, into whichever heading shared the most
   * words - and a resume came back with "LLM, APIs, Webhooks, OpenAPI,
   * PostgreSQL, RAG, ETL Pipelines" under CLOUD & INFRASTRUCTURE. The target
   * was a guess every time, and a wrong heading reads worse than a short
   * group, so the merging went back to the prompt where the model knows what
   * the entries are. This counts them.
   */
  const small = groups.filter((group) => group.skills.length < MIN_SKILLS_PER_GROUP);
  if (small.length > 0) {
    console.warn(
      `[Resume skills] ${profileName}: ${small.length} group(s) under ${MIN_SKILLS_PER_GROUP} entries - `
        + `${small.map((group) => `${group.category} (${group.skills.length})`).join(', ')}. `
        + `A thin group is how a block of 35 becomes a block of 16.`
    );
  }

  /*
   * The one fault left that nothing removes.
   *
   * The prompt bans ordinary words as skill names - "Logs", "Reflection",
   * "Less", "Echo", "Behave" - because each is also a real product, so a reader
   * cannot tell whether the resume means the tool or the word. "Logs" was
   * printed in a delivered block beside "prediction logs". It is NOT deleted
   * here: each one genuinely is a product somebody might have used, and a
   * removal that cannot tell which would be guessing. Said out loud instead.
   */
  /*
   * The group the operator calls essential.
   *
   * "Languages & Framework category in the skill section is essential and
   * required." It is the first thing a technical reader looks for and the
   * first thing a scanner matches on, and a block that opens with "Cloud &
   * Infrastructure" has buried it. Reported rather than invented: the entries
   * would have to come from somewhere, and a group of languages this candidate
   * does not write is worse than a block without the heading.
   */
  const hasLanguages = groups.some((group) => /\blanguage/i.test(group.category));
  if (!hasLanguages) {
    console.warn(
      `[Resume skills] ${profileName}: no Languages group in the block - `
        + `${groups.map((group) => group.category).join(', ')}.`
    );
  }
  /*
   * The floor only. The ceiling is enforced before this runs - `capSkillGroups`
   * joins headings until the block is within it - so a warning about too many
   * groups here could only ever fire on a block this code had already fixed,
   * and the merge says so in its own line.
   */
  if (groups.length < MIN_SKILL_GROUPS) {
    console.warn(
      `[Resume skills] ${profileName}: ${groups.length} group(s), under the `
        + `${MIN_SKILL_GROUPS} the prompt asks for.`
    );
  }

  const ordinary = skills.filter((skill) => ORDINARY_WORD_SKILLS.has(skill.trim().toLowerCase()));
  if (ordinary.length > 0) {
    console.warn(
      `[Resume skills] ${profileName}: ${ordinary.length} ordinary word(s) printed as skill names - `
        + `${ordinary.join(', ')}. Each is a product too, so none was removed.`
    );
  }
}

/**
 * The words the prompt names under WHAT STAYS OUT.
 *
 * Every one is both an English word and a real product - Logs, Echo, Behave,
 * Less, Reflection - which is exactly why they reach the page and why code
 * cannot settle them.
 */
const ORDINARY_WORD_SKILLS = new Set([
  'logs',
  'echo',
  'behave',
  'less',
  'reflection',
  'camel',
  'spark',
  'flow',
]);

/**
 * The floor the prompt states, and the operator asked for by number.
 *
 * MEASURED before it moved: "about 30, at most 40" delivered 25 entries on
 * average across a batch, 17 on one resume. A ceiling stated hard and a floor
 * stated soft is obeyed on one side only - the same shape as the 65-word
 * summary floor that produced 52 words - so this is now a floor in both the
 * prompt and the log.
 */
const MIN_SKILL_BLOCK_SIZE = 35;

/*
 * And the shape it asks for: see TECHNICAL SKILLS in the prompt.
 *
 * The maximum is imported rather than written again here, because it is now
 * ENFORCED - `capSkillGroups` joins headings until the block is within it - and
 * a second copy of an enforced number is a copy that drifts. The floor stays
 * local and stays a warning: reaching five groups from three would mean
 * splitting or inventing a category, which is the judgement this code does not
 * make.
 */
const MIN_SKILL_GROUPS = 5;

/**
 * Five to a group, because the arithmetic of the floor depends on it.
 *
 * Five groups of seven, six of six or seven of five all reach 35; a group
 * holding one tool - "Security & Performance: Redis", from a delivered resume -
 * is how a block of 35 turns into a block of 17.
 */
const MIN_SKILLS_PER_GROUP = 5;

function normalizeTailoredContent(
  content: TailoredContent,
  jobAnalysis?: JobAnalysis,
  profile?: Profile,
  options: { alreadyRouted?: boolean } = {}
): TailoredContent {
  /*
   * The skills block, as the model returned it, printed unchanged.
   *
   * WHAT THIS REPLACED. The block used to be chosen by code: library matching,
   * concept mapping, vendor-prefix collapsing, priority ordering, padding each
   * heading to a minimum and truncating it to a maximum. The library is a
   * curated list of 1,492 rows, and what it curated reached every resume -
   * "Echo", "Logs", "Reflection", "Behave", "Amazon Kinesis" printed beside
   * "Kinesis", "REST" beside "REST API". Rules were added for each of those in
   * turn and the next row found the next gap.
   *
   * So the operator took the decision away from the library. The tailor call
   * already has the profile and the posting in front of it, and it now returns
   * the finished block, grouped under its own headings. Nothing here reorders
   * it, filters it or tops it up: a rule worth keeping is stated in the prompt,
   * where the model can act on it, rather than applied afterwards to an answer
   * this file did not write.
   *
   * THE ONE EXCEPTION IS THE SAME STRING TWICE, and it is an exception because
   * there is no judgement in it. Measured over a batch: a third of resumes
   * printed an identical entry twice - "python, sql, rest, postgresql, dbt, aws,
   * git" all doubled on one of them - usually because the same tool belongs in
   * two of the model's own groups and it wrote it in both. Removing the second
   * copy cannot be wrong and cannot be argued with.
   *
   * AND THE SAME STRING PLUS FILLER, which the operator reported as keyword
   * stuffing: "performance" beside "performance tuning", "GitHub Copilot"
   * beside "GitHub Copilot app", "agent runtime" beside "agent runtime
   * execution" - 3.1 entries per resume, measured over 70 of them. That used to
   * be left to the prompt on the grounds that "Spring" against "Spring
   * Framework" is a judgement. It is not, once the test is narrow enough:
   * `dropRestatedSkillsFromGroups` removes an entry only when every word it
   * adds is filler, which is why "AWS Lambda" still stands beside "AWS". What it
   * cannot see - "production pipeline operations" against "data pipelines" -
   * remains a judgement and remains in the prompt.
   *
   * The flat list is kept in step because templates, the DOCX writer and the
   * keyword measurement all read `hardSkills`.
   */
  /*
   * The entries are passed through UNTOUCHED, because they carry their kind.
   *
   * This used to coerce each one with `String(skill)`, which was right while an
   * entry was a bare string and became the bug that printed "LANGUAGES &
   * FRAMEWORKS: [object Object]" on every resume the moment the model started
   * labelling them: every entry stringified to the same six words, and the
   * exact-duplicate rule then collapsed the whole block to one. `parseSkillEntry`
   * takes either shape and does the trimming this used to do.
   */
  const modelSkillGroups = (content.skillGroups ?? [])
    .map((group) => ({
      category: String(group?.category ?? '').trim(),
      skills: Array.isArray(group?.skills) ? (group.skills as unknown[]) : [],
    }))
    .filter((group) => group.category);

  /*
   * EVERYTHING THIS POSTING NAMED, in one set, so the router can tell a
   * keyword from an invention.
   *
   * Read from the analysis rather than from a list in code: these are the
   * employer's own words for this one job, which is the only thing that makes
   * the exception safe. `getKeywordChecklist` is the widest of them - tools,
   * technologies, protocols, methodologies, domain knowledge and the
   * must-include list - and a capability phrase reaches it from whichever
   * field the analyser filed it under.
   */
  const postingVocabulary = normalizeSkillsList([
    ...getKeywordChecklist(jobAnalysis),
    ...getConceptKeywords(jobAnalysis),
  ]);

  const tidied = tidySkillGroups(modelSkillGroups, { postingTerms: postingVocabulary });
  const skillGroups = tidied.groups;

  const said: string[] = [];
  const list = (entries: readonly string[], show: number) =>
    entries.slice(0, show).join(', ') + (entries.length > show ? ', ...' : '');
  if (tidied.report.repeated.length > 0) {
    said.push(`${tidied.report.repeated.length} repeated (${list(tidied.report.repeated, 6)})`);
  }
  if (tidied.report.routedToProse.length > 0) {
    said.push(
      `${tidied.report.routedToProse.length} the model labelled for the prose `
        + `(${list(tidied.report.routedToProse.slice(0, 4).map((entry) => `${entry.name} [${entry.kind}]`), 4)})`
    );
  }
  if (tidied.report.duplicates.length > 0) {
    said.push(
      `${tidied.report.duplicates.length} one name under two spellings `
        + `(${list(tidied.report.duplicates.slice(0, 4).map((pair) => `${pair.dropped} -> ${pair.kept}`), 4)})`
    );
  }
  if (tidied.report.trimmed.length > 0) {
    said.push(`${tidied.report.trimmed.length} past the ${MAX_SKILL_BLOCK_SIZE}-entry ceiling (${list(tidied.report.trimmed, 4)})`);
  }
  /*
   * An unlabelled block is an older prompt answering, or a custom one an admin
   * wrote. It is kept rather than emptied - see `parseSkillEntry` - and said
   * out loud, because nothing is being routed on a resume that arrives this way
   * and the block is only as clean as the model made it.
   */
  if (tidied.report.unlabelled.length > 0 && !options.alreadyRouted) {
    console.warn(
      `[Resume skills] ${profile?.name ?? 'resume'}: ${tidied.report.unlabelled.length} entry(ies) `
        + `arrived with no kind, so nothing could be routed on them - ${list(tidied.report.unlabelled, 5)}. `
        + `Is the tailoring prompt the current one?`
    );
  }
  if (said.length > 0) {
    console.log(`[Resume skills] ${profile?.name ?? 'resume'}: removed ${said.join('; ')}.`);
  }
  /*
   * Said apart from the removals above, because nothing was removed: a merge
   * costs the page a heading and keeps every skill under it.
   */
  if (tidied.report.mergedGroups.length > 0) {
    console.log(
      `[Resume skills] ${profile?.name ?? 'resume'}: joined `
        + `${tidied.report.mergedGroups.length} heading(s) to reach the ${MAX_SKILL_GROUPS}-group `
        + `maximum - ${tidied.report.mergedGroups
          .map((pair) => `${pair.kept} + ${pair.joined}`).join('; ')}.`
    );
  }

  const hardSkills = skillGroups.length > 0
    ? skillGroups.flatMap((group) => group.skills)
    // No groups in the answer - an older prompt, or a build with no posting to
    // tailor against. The model's flat list, then the profile's own skills.
    : normalizeSkillsList(content.hardSkills ?? content.skills ?? profile?.skills ?? []);

  reportSkillBlock(profile?.name ?? 'resume', skillGroups, hardSkills, jobAnalysis);

  /*
   * HOW MUCH OF THE BLOCK THIS POSTING ACTUALLY ASKED FOR.
   *
   * MEASURED across five jobs for one profile: only five entries recurred on
   * every resume - C#, Docker, Git, Jenkins, Unreal Engine - but three of
   * those five appear ZERO times in the candidate's history and all three are
   * named as examples in this prompt's own layer checklist. Separately, 78 of
   * 183 delivered entries (43%) were product names the prompt uses as
   * illustrations.
   *
   * So the number worth watching is not the block's size, it is how much of it
   * the employer asked for. Counted here rather than argued about later.
   */
  if (jobAnalysis && hardSkills.length > 0) {
    const asked = new Set(postingVocabulary.map((term) => term.toLowerCase()));
    const matched = hardSkills.filter((skill) => asked.has(skill.toLowerCase()));
    console.log(
      `[Resume block] ${profile?.name ?? 'resume'}: ${hardSkills.length} entries, `
        + `${matched.length} named by this posting `
        + `(${Math.round((matched.length / hardSkills.length) * 100)}%); the rest come from the `
        + `candidate's history or are inferred from it.`
    );
  }

  // Ordering used to happen here - job-priority first, or the library's own
  // priority column. Neither applies now: the model returns the block in the
  // order it wants it read, and that order is part of the answer.
  const atsSoftPriority = inferAtsSoftSkillsFromAnalysis(jobAnalysis);
  const softFromModel = normalizeSkillsList(content.softSkills);
  const softFromAnalysis = getSoftSkills(jobAnalysis);
  const softFromLibrary = getMatchedLibrarySoftSkills(jobAnalysis);
  /*
   * THE POSTING'S OWN WORDS FIRST, THE CANNED VOCABULARY LAST.
   *
   * MEASURED across a delivered batch of five: a Data Developer role, an AI
   * Lead role and an Applied AI role came back with near-identical soft-skill
   * sections - "Supportive, Leadership, Reliability, Communication,
   * Collaboration skills, Cross-functional team" - because the nine canned
   * canonicals in ATS_SOFT_SKILL_RULES were merged FIRST and a list capped at
   * ten has no room left by the time the posting's own terms arrive.
   *
   * A scanner matches strings. A section that says "Cross-functional team" to
   * a posting that asked for "stakeholder management" matches nothing, and it
   * is also the clearest possible tell that nobody read the job.
   *
   * So the order is now by SOURCE: what the model returned (it read the
   * posting and is told to spell terms as the posting spells them), then what
   * the analyser extracted from the posting, then the library's matches
   * against the posting text, and only then the canonicals - which are a
   * fallback for a posting that named almost nothing, not a headline.
   */
  const softMerged = normalizeSkillsList([
    ...softFromModel,
    ...softFromAnalysis,
    ...softFromLibrary,
    ...atsSoftPriority,
  ]);
  const softVerdicts = partitionSkills(softMerged, validateSoftSkill);
  reportRejectedSkills('soft', softVerdicts.rejected);
  /*
   * THE POSTING'S CULTURE LANGUAGE DOES NOT GET A LINE IN THIS SECTION.
   *
   * `validateSoftSkill` passes "accuracy obsession", "valued all voices" and
   * "relentless bias toward action" - they are soft-skill shaped, and the
   * analyser hands them over under `skills.soft`. The first run with the
   * section back printed all three. A row of slogans is the thing the operator
   * objected to when the old group was removed, and bringing the section back
   * is not a reason to bring them with it. The same filter already keeps them
   * out of the prompt's checklists and out of the coverage measurement, so all
   * three agree about what belongs on the page.
   */
  const softWithoutValues = withoutValuesPhrases(softVerdicts.accepted);
  // The posting's own words, which are the ones that may not be rewritten.
  const postingSoft = normalizeSkillsList([...softFromModel, ...softFromAnalysis]);
  const softLimited = finalizeSoftSkills(softWithoutValues.terms, postingSoft);

  /*
   * WHERE THE PRINTED TERMS CAME FROM, because the alternative is arguing
   * about it. A section built out of the canned canonicals rather than the
   * posting is the defect this ordering was changed to fix, and the only way
   * to see it on the next batch is to count it on this one.
   */
  const postingSet = new Set(postingSoft.map((term) => term.toLowerCase()));
  const fromPosting = softLimited.filter((term) => postingSet.has(term.toLowerCase()));
  console.log(
    `[Resume soft section] ${profile?.name ?? 'resume'}: ${softLimited.length} printed, `
      + `${fromPosting.length} of them the posting's own words`
      + `${softLimited.length > fromPosting.length
        ? ` - filled out with ${softLimited.filter((t) => !postingSet.has(t.toLowerCase())).join(', ')}`
        : ''}.`
  );
  if (softLimited.length < MIN_SOFT_SKILLS) {
    console.warn(
      `[Resume soft section] ${profile?.name ?? 'resume'}: ${softLimited.length} entry(ies) for the `
        + `Soft Skills section, under the ${MIN_SOFT_SKILLS} asked for - `
        + `${softLimited.join(', ') || '(none)'}. The posting and the library between them named `
        + `no more; nothing is invented to reach the floor.`
    );
  }

  const trimIncompleteEnd = (s: string): string =>
    s.trim().replace(/,+\s*$/, '').replace(/\s+(and|or)\s*$/i, '').trim();
  /*
   * Every prose funnel below starts here, so the clean-ups ride along with the
   * tag strip rather than being remembered in four places: the stand-in dashes
   * a model writes when told not to use em-dashes, and the banned vocabulary -
   * "leveraged", "spearheaded", "scalable", "cross-functional" and the rest.
   * The prompt asks for plain words; this is what makes it true of every
   * resume rather than of most of them.
   */
  /*
   * The terms the posting asked for, which the rewrite must not touch.
   *
   * Without this the app asked for a word and then deleted it: the analyser
   * extracts past-tense action verbs as required keywords - its own examples
   * are "architected" and "orchestrated" - the prompt tells the model to write
   * every one of them, and the vocabulary rules swapped them straight back
   * out. Measured on an answer that placed every term perfectly, coverage fell
   * from 34/34 to 17/34, eleven of them lost exactly this way.
   */
  const askedFor = getProseChecklist(jobAnalysis);

  const stripBoldTags = (s: string): string =>
    plainLanguage(normalizeDashes(s.replace(/<\/?strong>/gi, '').replace(/<\/?b>/gi, '')), askedFor);
  const sanitizeResumeText = (s: string): string => {
    const clean = stripUnsafeResumeSentences(stripBoldTags(s), undefined);
    return isUnsafeJobPostingPhrase(clean) ? '' : clean;
  };

  const clampRoleBrief = (description: string, company?: string, title?: string): string => {
    const stripped = stripBoldTags(description).trim().replace(/\s+/g, ' ');
    const cleanBase = stripUnsafeResumeSentences(stripped, company);
    const fallback = buildFallbackExperienceDescription(title ?? '', jobAnalysis);
    const clean = cleanBase || fallback;
    if (isUnsafeJobPostingPhrase(clean) || isCompanyDescriptionLike(clean, company)) {
      return fallback;
    }
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
  };

  const normalizeSummary = (summary: string): string =>
    stripUnsafeResumeSentences(stripBoldTags(summary), undefined);

  // The cover letter is written by the same model call and carries the same
  // stand-in dashes. It is not prose the resume renders, so none of the
  // funnels above has seen it; an absent letter stays absent.
  const coverLetterFields = content.coverLetter
    // No protected terms: the letter is a separate document and does not count
    // towards keyword coverage, so it can be plain throughout.
    ? { coverLetter: plainLanguage(normalizeDashes(content.coverLetter)) }
    : {};

  const cap = bulletCap();
  const trimmed: string[] = [];
  const normalizedExperience = (content.experience ?? []).map((item) => {
    const written = normalizeSkillsList(item.achievements).map(sanitizeResumeText).filter(Boolean);
    const achievements = written.length > 0
      ? chooseBullets(written, cap, jobAnalysis)
      : buildFallbackAchievements(jobAnalysis);
    if (written.length > achievements.length) {
      trimmed.push(`${item.company ?? item.title ?? 'a role'} ${written.length} -> ${achievements.length}`);
    }
    return {
      ...item,
      /*
       * No paragraph under the company name. A role used to open with two or
       * three sentences of scene-setting before the first bullet, and it was the
       * part of the page that read most like it had been generated: the bullets
       * say what the person did, and the paragraph said it again with adjectives.
       * Emptied here rather than left to each template, so the PDF, the DOCX and
       * the preview all drop it together.
       */
      description: '',
      achievements,
    };
  });

  if (trimmed.length > 0) {
    // Worth a line in the log rather than a silent trim: the prompt asks for at
    // most `cap` and a model that returns twenty-two is a model ignoring the
    // length budget, which is a prompt problem as well as a page problem.
    console.warn(
      `[Resume bullets] ${profile?.name ?? 'resume'}: over the ${cap}-bullet cap, ` +
        `kept the ones carrying the most checklist terms - ${trimmed.join(', ')}.`
    );
  }

  const strengthKeywordPool = normalizeSafeKeywordList([
    ...getRequiredSkills(jobAnalysis),
    ...getPreferredSkills(jobAnalysis),
    ...getKeywordChecklist(jobAnalysis),
    ...getIndustryTerms(jobAnalysis),
  ]).filter((keyword) => keyword.length >= 3);

  const fallbackStrengths = normalizeSafeResponsibilityList(getResponsibilities(jobAnalysis))
    .slice(0, 4)
    .map((item, index) => ({
      title: `Core Strength ${index + 1}`,
      description: `Demonstrated impact in ${item.trim().replace(/\.$/, '')}.`,
    }));

  const baseStrengths = (content.strengths ?? []).length > 0 ? (content.strengths ?? []) : fallbackStrengths;
  const normalizedStrengths = baseStrengths.map((strength, index) => {
    const title = capitalizeFirstCharacter(
      (strength?.title ?? `Core Strength ${index + 1}`).trim() || `Core Strength ${index + 1}`
    );
    const rawDescription = (strength?.description ?? '').trim();
    const keywordA = strengthKeywordPool[index % Math.max(strengthKeywordPool.length, 1)] ?? '';
    const keywordB = strengthKeywordPool[(index + 7) % Math.max(strengthKeywordPool.length, 1)] ?? '';
    const keywordSnippet = [keywordA, keywordB]
      .filter(Boolean)
      .join(' and ');

    const normalizedDescription = rawDescription && !isUnsafeJobPostingPhrase(rawDescription)
      ? stripBoldTags(rawDescription).replace(/\s+/g, ' ').replace(/\.$/, '')
      : 'Demonstrated impact in complex engineering environments';

    const hasKeyword = strengthKeywordPool.some((kw) =>
      normalizedDescription.toLowerCase().includes(kw.toLowerCase())
    );
    const suffix = hasKeyword || !keywordSnippet
      ? '.'
      : `. Focused on ${keywordSnippet}.`;

    return {
      title,
      description: `${normalizedDescription}${suffix}`,
    };
  });

  // The model's own wording, kept. Only sanitising and the numeric cap run over
  // it; the shape of the sentences is the model's to choose, and forcing a lead
  // sentence here is what made every summary read alike.
  const modelSummary = useNumeralsForExperienceYears(
    removeCompanyMentionsFromSummary(normalizeSummary((content.summary ?? '').trim()), profile)
  );
  // Last, after the sanitising: trimming first and then removing an employer
  // mention would leave a paragraph shorter than the cap meant to allow.
  const capped = capSummaryWords(modelSummary);
  if (capped.dropped > 0) {
    console.log(
      `[Resume summary] ${profile?.name ?? 'resume'}: trimmed to ${capped.words} words, ` +
        `dropping ${capped.dropped} sentence(s) past the ${summaryWordCap()}-word cap.`
    );
  } else if (capped.words > summaryWordCap()) {
    // One sentence longer than the whole budget. Nothing was cut, because
    // there is no cut that improves it - but the prompt asked for 3-4
    // sentences and got one, which is worth seeing.
    console.log(
      `[Resume summary] ${profile?.name ?? 'resume'}: ${capped.words} words in a single ` +
        `sentence, past the ${summaryWordCap()}-word cap. Left alone rather than cut mid-sentence.`
    );
  }
  const finalSummary = capped.summary || (profile ? buildFallbackSummary(profile) : '');

  // Measured on what will actually be rendered, after the summary has been
  // sanitised and the experience normalised. Measuring the model's raw answer
  // would count terms that the cleanup steps then removed.
  reportPlacement(profile?.name ?? 'resume', {
    summary: finalSummary,
    experience: normalizedExperience,
  }, jobAnalysis);

  /*
   * A technology the posting NAMED that reached the prose and not the block.
   *
   * REPORTED BY THE OPERATOR as "MCP and LLMs missing from the skills section
   * even though they are in the JD". Measured on a delivered resume: "Large
   * Language Models" and "RAG" were in the bullets and in neither group of the
   * block. The cause was upstream - those terms arrived on the PROSE checklist
   * because the skill library has no row for them - and that is fixed where
   * `promptSkills` is built. This is the check that says whether it held.
   *
   * Named technologies only, and only where the prose shows the model knew the
   * term: a posting term nobody wrote anywhere is an ordinary coverage miss and
   * the placement report above already counts it.
   */
  // A separator no term can span, so `containsTerm` cannot match across two
  // entries that happen to sit next to each other.
  const SKILL_TEXT_SEPARATOR = ' | ';
  const named = getJobNamedHardSkills(jobAnalysis);
  if (named.length > 0 && hardSkills.length > 0) {
    const blockText = hardSkills.join(SKILL_TEXT_SEPARATOR);
    const proseText = [finalSummary, ...normalizedExperience.flatMap((role) => role.achievements ?? [])].join(SKILL_TEXT_SEPARATOR);
    const proseOnly = named.filter((term) => containsTerm(proseText, term) && !containsTerm(blockText, term));
    if (proseOnly.length > 0) {
      console.warn(
        `[Resume skills] ${profile?.name ?? 'resume'}: ${proseOnly.length} technology(ies) this posting `
          + `named are in the bullets but not the block - ${proseOnly.slice(0, 6).join(', ')}`
          + `${proseOnly.length > 6 ? ', ...' : ''}`
      );
    }
  }

  /*
   * A concept taken out of the block has to turn up in a bullet.
   *
   * ASKED FOR: "regarding concepts, don't remove but add them to bullets of
   * experience section." The block loses it; the resume must not. The prompt
   * has required this for a long time - every concept it maps to a tool still
   * has to appear in a sentence, spelled as the posting spells it - and nothing
   * ever checked, which is how "tool calling" and "agent orchestration" ended
   * up listed in the block and written nowhere else.
   *
   * Reported, never inserted: putting the phrase into a bullet means rewriting
   * the sentence around it, and a bullet written by this file is the thing the
   * whole prompt exists to avoid.
   */
  // A separator no term can span, so a match cannot straddle two bullets.
  const PROSE_SEPARATOR = ' | ';
  if (tidied.report.routedToProse.length > 0) {
    const bullets = normalizedExperience.flatMap((role) => role.achievements ?? []).join(PROSE_SEPARATOR);
    const prose = `${finalSummary}${PROSE_SEPARATOR}${bullets}`;
    const stranded = tidied.report.routedToProse.filter((entry) => !containsTerm(prose, entry.name));
    if (stranded.length > 0) {
      console.warn(
        `[Resume routing] ${profile?.name ?? 'resume'}: ${stranded.length} of `
          + `${tidied.report.routedToProse.length} entry(ies) the model moved out of the block are `
          + `on no part of the page - `
          + `${stranded.slice(0, 6).map((entry) => `${entry.name} [${entry.kind}]`).join(', ')}`
          + `${stranded.length > 6 ? ', ...' : ''}. Each is a keyword the resume no longer has.`
      );
    } else {
      console.log(
        `[Resume routing] ${profile?.name ?? 'resume'}: all ${tidied.report.routedToProse.length} `
          + `entry(ies) moved out of the block appear in the prose.`
      );
    }
  }

  /*
   * THE HOLE THE CHECK ABOVE LEAVES, and the one the scans fell through.
   *
   * That check only looks at entries the MODEL wrote into the block and the
   * router then moved out. A concept the posting named and the model never
   * wrote anywhere is checked by nothing at all: it is not in the block, so
   * the router never saw it; it is not in a sentence; and it leaves no trace.
   *
   * MEASURED on two delivered resumes, against the scanner's own report: of
   * fourteen skills called missing, all fourteen were on no part of the page,
   * and eleven were concept or category phrases of exactly this kind.
   *
   * Reported, never inserted - the same rule as everywhere else here. What it
   * buys is the revision call, because `measureCoverageGap` counts these too.
   */
  if (jobAnalysis) {
    const blockText = hardSkills.join(SKILL_TEXT_SEPARATOR);
    const bullets = normalizedExperience.flatMap((role) => role.achievements ?? []).join(PROSE_SEPARATOR);
    const wholePage = `${finalSummary}${PROSE_SEPARATOR}${bullets}${PROSE_SEPARATOR}${blockText}`;
    const conceptsWanted = withoutValuesPhrases(getConceptKeywords(jobAnalysis)).terms;
    const neverWritten = conceptsWanted.filter((term) => !containsTerm(wholePage, term));
    if (neverWritten.length > 0) {
      console.warn(
        `[Resume concepts] ${profile?.name ?? 'resume'}: ${neverWritten.length} of `
          + `${conceptsWanted.length} concept(s) this posting named are on NO part of the page - `
          + `${neverWritten.slice(0, 8).join(', ')}${neverWritten.length > 8 ? ', ...' : ''}. `
          + `A scanner counts each of these as a hard skill.`
      );
    } else if (conceptsWanted.length > 0) {
      console.log(
        `[Resume concepts] ${profile?.name ?? 'resume'}: all ${conceptsWanted.length} `
          + `concept(s) this posting named reached the page.`
      );
    }
  }
  // Separately, because this one needs the skills block as its vocabulary: a
  // bullet "names a tool" if it names one of the technologies THIS resume
  // claims, which is a sharper test than a list of tools kept in code.
  reportBulletShape(profile?.name ?? 'resume', normalizedExperience, hardSkills);

  // Issue 1 — phrases repeated three or more times on one resume.
  const repeated = repeatedPhrases(normalizedExperience, finalSummary);
  if (repeated.length > 0) {
    console.warn(
      `[Resume repetition] ${profile?.name ?? 'resume'}: `
        + `${repeated.length} phrase(s) repeated 3+ times: `
        + `${repeated.slice(0, 3).map((r) => `"${r.phrase}" ×${r.count}`).join(', ')}.`
    );
  }

  /*
   * What the swaps could not take out.
   *
   * A banned adjective is deleted and a banned verb is swapped, so anything
   * still here is the kind that cannot be fixed a word at a time: a metaphor
   * needs the sentence rewritten, and only the model knows what it meant.
   * Said out loud, once per resume, because the answer is a prompt change and
   * an operator cannot ask for one they cannot see.
   */
  const leftover = bannedTermsIn(
    [finalSummary, ...normalizedExperience.flatMap((role) => role.achievements ?? [])].join(' '),
    askedFor
  );
  if (leftover.length > 0) {
    console.log(
      `[Resume tone] ${profile?.name ?? 'resume'}: ${leftover.length} banned term(s) the rewrite ` +
        `could not remove: ${leftover.slice(0, 8).join(', ')}${leftover.length > 8 ? ', ...' : ''}`
    );
  }

  return {
    ...content,
    ...coverLetterFields,
    title: buildResumeHeadline(content.title, jobAnalysis, profile),
    summary: finalSummary,
    experience: normalizedExperience,
    hardSkills,
    skillGroups,
    /*
     * The Soft Skills section, printed under the technical block.
     *
     * IT WAS EMPTY HERE FOR SEVERAL ROUNDS, and not because the list could not
     * be built: everything above - the posting's own soft skills, the library
     * matches, the validation and the cap - ran exactly as it does now, and the
     * result was dropped on the next line. The operator asked for the section
     * back, 8 to 10 entries.
     *
     * What was right about removing it is kept: 44 of the library's entries are
     * the register the operator objected to - "Innovation", "Creative
     * solutions", "Proactiveness", "Visionary Leadership".
     *
     * THE SECTION IS OFF AGAIN, and this is the third position this field has
     * held. It was removed once as "a row of unprovable adjectives", brought
     * back when the operator asked for 8 to 10 of them, and is now off because
     * a reviewer read the delivered batch: MEASURED across 60 resumes, every
     * one carried the section and there were only TWELVE distinct lists among
     * them - five resumes to a list, word for word, whatever the job. A
     * recruiter seeing two of those sees a template.
     *
     * The list is still BUILT, because `softLimited` is what the Unconfirmed
     * Skills panel reconciles against and what the coverage report counts. It
     * is simply not printed. Soft skills reach the page the way the reviewer
     * asked for - shown by the work a bullet describes - and the prompt's
     * SOFT SKILLS section is what says how.
     */
    softSkills: [],
    strengths: normalizedStrengths,
    // Keep legacy field aligned with hard skills for older templates/components.
    skills: hardSkills,
  };
}

export async function analyzeJobDescription(
  jobDescription: string,
  choice: AiChoice,
  promptId?: string,
  signal?: AbortSignal
): Promise<JobAnalysis> {
  const { provider, modelName } = choice;
  const resolvedPromptId = promptId?.trim() || DEFAULT_ANALYZE_JOB_PROMPT_ID;
  const promptValues = buildAnalyzeJobDescriptionPromptValues(jobDescription);
  const firstCallStartedAt = process.hrtime.bigint();

  /**
   * The cheapest token is the one never sent.
   *
   * This app re-analyses the same posting constantly: a sheet import re-run
   * after fixing one row, a batch regenerated against a different template, a
   * preview followed by the generate that writes the file. The call is
   * deterministic - fixed prompt, `temperature: 0` - so the same three inputs
   * give the same answer, and all three are in the key.
   *
   * The prompt's own TEXT is in it, not just its id: an admin who edits a
   * prompt and sees nothing change would have no way to tell the difference
   * between a cache and a prompt that does not work.
   */
  const promptRecord = await resolvePromptByExactId(resolvedPromptId).catch(() => null);
  const cacheKey = analysisCacheKey({
    jobDescription,
    promptText: promptRecord?.content ?? resolvedPromptId,
    model: `${provider}/${modelName}`,
  });
  const cached = readAnalysisCache<JobAnalysis>(cacheKey);
  if (cached) {
    console.log(
      '[Resume timing] First LLM call skipped: this job description was already analysed ' +
        `(${describeAiChoice(choice)})`
    );
    // The cache hands out its own copy; see `detach`. This only has to record
    // that the call took no time.
    resumeBuildTiming.set(cached, { firstCallEndedAt: process.hrtime.bigint() });
    return cached;
  }

  console.log(`[Resume timing] First LLM call started: analyze job description (${describeAiChoice(choice)})`);
  const content = await createPromptCompletion({
    promptId: resolvedPromptId,
    promptValues,
    fallbackProvider: provider,
    fallbackModelName: modelName,
    effort: choice.effort,
    thinking: choice.thinking,
    route: choice.route,
    maxTokens: 7000,
    temperature: 0,
    responseFormat: 'json',
    // Rendered by exact id, so resolved by exact id too. These used to
    // disagree: the text came from this literal record while the model
    // override came from whichever record was activated for the feature.
    useExactPromptId: true,
    signal,
  });
  const firstCallEndedAt = process.hrtime.bigint();
  console.log(`[Resume timing] First LLM call finished in ${formatDuration(firstCallStartedAt, firstCallEndedAt)}`);

  const analysis = parseJobAnalysisContent(content, jobDescription);
  writeAnalysisCache(cacheKey, analysis);
  resumeBuildTiming.set(analysis, { firstCallEndedAt });
  return analysis;
}

export async function analyzeJobDescriptionPromptRaw(
  jobDescription: string,
  choice: AiChoice,
  promptId?: string
): Promise<unknown> {
  const resolvedPromptId = promptId?.trim() || DEFAULT_ANALYZE_JOB_PROMPT_ID;
  const promptValues = buildAnalyzeJobDescriptionPromptValues(jobDescription);
  const content = await createPromptCompletion({
    promptId: resolvedPromptId,
    promptValues,
    fallbackProvider: choice.provider,
    fallbackModelName: choice.modelName,
    effort: choice.effort,
    thinking: choice.thinking,
    maxTokens: 7000,
    temperature: 0,
    responseFormat: 'json',
    useExactPromptId: true,
  });

  try {
    return JSON.parse(extractJSON(content));
  } catch (error) {
    console.error('Failed to parse raw prompt test response:', error, content);
    throw new Error('Failed to parse prompt test response');
  }
}

export function buildAnalyzeJobDescriptionPromptValues(jobDescription: string): Record<string, string> {
  return {
    jobDescription,
  };
}

export function parseJobAnalysisContent(content: string, jobDescription: string): JobAnalysis {
  try {
    const jsonText = extractJSON(content);
    const parsed = JSON.parse(jsonText) as RawNestedJobAnalysis;
    return normalizeJobAnalysisResponse(parsed, jobDescription);
  } catch (error) {
    console.error('Failed to parse model response:', error, content);
    throw new Error('Failed to parse job analysis response');
  }
}

export function buildTailorResumePromptValues(
  profile: Profile,
  jobAnalysis: JobAnalysis
): Record<string, string> {
  const { sourceJobDescription: _sourceJobDescription, ...jobAnalysisForPrompt } = jobAnalysis;
  const profileForPrompt = buildPromptProfile(profile);
  const augmentedPromptLists = buildLibraryAugmentedPromptLists(jobAnalysis);

  /*
   * The posting's culture language never reaches the model.
   *
   * REPORTED AS pasted job-description phrases: "radical ownership mindset",
   * "accuracy obsession", "valued all voices", "relentless bias toward action",
   * tacked onto the ends of bullets where they break the sentence. The prompt
   * now refuses them under fault 1 - and a rule alone could not have held,
   * because these arrive on the analyser's own checklists and three things in
   * this file then push them onto the page: the prompt is told to place EVERY
   * term, the coverage measurement counts a missing one as a shortfall, and a
   * big enough shortfall buys a revision call whose whole job is to write the
   * missing terms in. A model obeying the rule would have been overruled by
   * its own corrections.
   *
   * So the phrase is taken off the lists here, at the one point they are
   * assembled. Set aside, not missed: the same decision rule 3 makes about an
   * industry the candidate has never worked in.
   */
  const setAside = new Set<string>();
  const withoutValues = (terms: string[]): string[] => {
    const result = withoutValuesPhrases(terms);
    for (const term of result.setAside) setAside.add(term);
    return result.terms;
  };

  const promptSkills = withoutValues(augmentedPromptLists.promptSkills);
  const conceptKeywords = withoutValues(getConceptKeywords(jobAnalysis, promptSkills));
  const conceptSet = new Set(conceptKeywords.map((keyword) => keyword.toLowerCase()));

  /*
   * Nothing the posting said is allowed to reach the prompt in no list at all.
   *
   * Every list here is assembled by its own function reading its own subset of
   * the analysis, and for a long time nobody compared the union of them against
   * the posting. A field left out of one list - `skills.required` and
   * `skills.preferred` were both out of the prose checklist - meant a term
   * extracted from the posting, carried through the whole analysis, and then
   * written nowhere.
   *
   * So the last step subtracts: take every term the analysis produced, remove
   * everything already spoken for, and append the remainder to the prose
   * checklist. Fixing the checklist itself is the real repair and was done
   * above; this is the backstop that makes the guarantee hold for the NEXT
   * field somebody adds, rather than relying on them to remember this file.
   *
   * Concepts are excluded because they have their own list and the two are kept
   * disjoint, so a term is asked for once rather than twice.
   */
  const spokenFor = [promptSkills, augmentedPromptLists.keywords, conceptKeywords,
    getResponsibilities(jobAnalysis), getDomainKnowledge(jobAnalysis)];
  const uncovered = findUncoveredKeywords(collectJobKeywords(jobAnalysis), spokenFor)
    .filter((keyword) => !conceptSet.has(keyword.toLowerCase()));

  const proseKeywords = withoutValues(normalizeSkillsList([
    ...augmentedPromptLists.keywords.filter((keyword) => !conceptSet.has(keyword.toLowerCase())),
    ...uncovered,
  ]));

  if (setAside.size > 0) {
    console.log(
      `[Resume values] ${profile.name}: set aside ${setAside.size} values phrase(s) the `
        + `posting asked for - ${[...setAside].slice(0, 6).join(', ')}`
        + `${setAside.size > 6 ? ', ...' : ''}`
    );
  }
  const promptValues = {
    profileJson: promptJson(profileForPrompt),
    jobAnalysisJson: promptJson(jobAnalysisForPrompt),
    jobTitle: getJobAnalysisTitle(jobAnalysis),
    skillsJSON: promptJson(promptSkills),
    // The same list under a second name. Kept because a custom prompt record an
    // admin wrote may reference either, and a variable a prompt names but the
    // code does not supply renders as the literal `[[hardSkillsJson]]`.
    // Unreferenced variables cost nothing: `assemblePrompt` substitutes, it
    // does not append.
    hardSkillsJson: promptJson(promptSkills),
    // The terms the Technical Skills block will NOT carry, because they name
    // ideas rather than tools and the block lists the tools instead. They are
    // still keywords an ATS scores, so the prompt is told to place each one in
    // the prose - which is where a concept belongs anyway, attached to
    // something the candidate actually did.
    //
    // Read from the ANALYSIS, not from the library matches. Sourcing it from
    // the library meant a concept the library had never heard of - which is
    // most of them, the library being 1,492 entries against an industry that is
    // larger - was dropped from the skills block for being a concept and never
    // named to the prompt either, because it was not in the library. It landed
    // nowhere at all. "Full-stack engineering" and "Product Engineering" went
    // missing from finished resumes exactly that way.
    conceptKeywordsJson: promptJson(conceptKeywords),
    // Disjoint from the list above, so a term is asked for once. Both are prose
    // checklists; splitting them lets the prompt say something specific about
    // concepts without saying it twice about everything else.
    keywordsJson: promptJson(proseKeywords),
    // The tools each concept this posting names is actually built with, so a
    // concept becomes a tool on the resume rather than a line of jargon.
    // Shuffled per request: see `buildConceptToolOptions`.
    conceptToolsJson: promptJson(buildConceptToolOptions(jobAnalysis, conceptKeywords)),
    keyResponsibilitiesJson: promptJson(getResponsibilities(jobAnalysis)),

    // The five the posting leans on. The prompt builds bullets around these.
    topSkillsJson: promptJson(focusSkills(jobAnalysis)),
    // The kind of role this resume is aimed at, for the summary to name in its
    // own words. The head of the title only: a sentence can carry "Data & AI
    // Engineer" and cannot carry ", AWS, Java & Python".
    targetRoleTitle: shortRoleTitle(getJobAnalysisTitle(jobAnalysis)),
    domainKnowledge: promptJson([
      ...getDomainKnowledge(jobAnalysis),
      jobAnalysis.jobMeta.industry,
      jobAnalysis.jobMeta.department,
    ]),
  };

  return promptValues;
}

export function parseTailoredResumeContent(
  content: string,
  profile: Profile,
  jobAnalysis: JobAnalysis,
  /*
   * Set by the revision pass, which re-parses a block this function has
   * already routed. Those entries are plain strings by then - their kinds were
   * spent on the first pass - and without this every revised resume would
   * report "arrived with no kind", which is the warning that means the prompt
   * did not reach the model. A false alarm on a real failure signal is worth
   * one parameter.
   */
  options: { alreadyRouted?: boolean } = {}
): TailoredContent {
  const jsonText = extractJSON(content);
  const parsed = JSON.parse(jsonText) as TailoredContent;
  const finalResult = normalizeTailoredContent(parsed, jobAnalysis, profile, options);
  const tailoringSourceText = getTailoringSourceText(jobAnalysis);

  const {
    confirmedSkills: confirmedSoftSkills,
    unconfirmedSkills: unconfirmedSoftSkills,
  } = reconcileSkillBuckets({
    extractedSkills: extractSoftSkills(tailoringSourceText),
    modelSkills: finalResult.softSkills,
    referenceSkills: softSkills,
    supplementSkills: supplimentSoftSkills,
    minimumCount: 5,
    finalizeSkills: finalizeSoftSkills,
  });
  /**
   * The terms that reached the resume without a library entry behind them.
   *
   * Reported rather than swallowed, because the app already has somewhere to
   * report them: the Unconfirmed Skills panel lists them with a control that
   * adds them to the library for good. So a posting naming a technology nobody
   * has catalogued yet puts it on this resume AND offers to catalogue it,
   * instead of dropping it in silence as it used to.
   */
  // Empty now, and the panel with it. It listed skills that reached a resume
  // without a library row behind them, so an operator could add them - useful
  // while the library chose the block. It no longer does: the model writes the
  // block, and every skill on it would be "unconfirmed", which is a list of
  // everything and therefore a list of nothing.
  const unconfirmedHardSkills: string[] = [];

  return {
    ...finalResult,
    // Carried through rather than blanked. This used to empty the list because
    // there was no section to print it in; there is one again, and emptying it
    // here would undo the work done upstream without saying so. The
    // reconciliation above still runs either way - the Unconfirmed Skills panel
    // is built from it.
    softSkills: finalResult.softSkills,
    unconfirmedHardSkills,
    unconfirmedSoftSkills,
    skills: finalResult.hardSkills,
  };
}

function getProfileResumePromptId(profile: Profile): string {
  return profile.profileSettings?.resumePromptId?.trim() || DEFAULT_RESUME_PROMPT_ID;
}

function getProfileCoverLetterPromptId(profile: Profile): string {
  return profile.profileSettings?.coverLetterPromptId?.trim() || DEFAULT_COVER_LETTER_PROMPT_ID;
}

export async function tailorResume(
  profile: Profile,
  jobAnalysis: JobAnalysis,
  choice: AiChoice,
  signal?: AbortSignal
): Promise<TailoredContent> {
  const { provider, modelName } = choice;
  const promptId = getProfileResumePromptId(profile);
  const promptValues = buildTailorResumePromptValues(profile, jobAnalysis);
  const secondCallStartedAt = process.hrtime.bigint();
  const timing = resumeBuildTiming.get(jobAnalysis);
  if (timing) {
    console.log(`[Resume timing] Time between first LLM finish and second LLM start: ${formatDuration(timing.firstCallEndedAt, secondCallStartedAt)}`);
  }
  console.log(`[Resume timing] Second LLM call started: tailor resume (${describeAiChoice(choice)})`);
  const content = await createPromptCompletion({
    promptId,
    // The prompt record can be a per-profile custom one; the timeout and the
    // usage bucket belong to the FEATURE, which is always this.
    callSite: DEFAULT_RESUME_PROMPT_ID,
    promptValues,
    fallbackProvider: provider,
    fallbackModelName: modelName,
    effort: choice.effort,
    thinking: choice.thinking,
    route: choice.route,
    maxTokens: 11000,
    temperature: 0.2,
    responseFormat: 'json',
    useExactPromptId: true,
    // Appended to the user turn rather than concatenated onto the rendered
    // text, which is what it used to be. That concatenation only reached
    // providers taking a single flat string, so the instruction was silently
    // absent on the structured path - and the code below assumes the model
    // obeyed it, because skills are decided here, not by the model.
    appendToUserBody: finalSkillOverride(),
    signal,
  });
  const secondCallEndedAt = process.hrtime.bigint();
  console.log(`[Resume timing] Second LLM call finished in ${formatDuration(secondCallStartedAt, secondCallEndedAt)}`);

  let tailored: TailoredContent;
  try {
    tailored = parseTailoredResumeContent(content, profile, jobAnalysis);
  } catch {
    console.error('Failed to parse model response:', content);
    throw new Error('Failed to parse tailored resume response');
  }

  /*
   * The floors, enforced rather than requested - but only where the call pays
   * for itself.
   *
   * WHAT THIS COST BEFORE THE GATE. The first version asked again whenever
   * anything at all was missing, which with a 100% floor over a 25-45 term
   * checklist is nearly every resume: a batch of 500 went from 0.84 hours of
   * working time to 2.21. Now a stray ordinary term is reported and left; a
   * missing FOCUS skill or concept, three or more missing terms, or a page
   * under the figure floor is what buys a call.
   *
   * And the call is a small one: its own short prompt, the draft's sentences,
   * and a patch back - not the whole 36,853-character tailoring prompt and the
   * whole resume, which is what made the second call cost as much as the first.
   *
   * If the revision fails, parses badly, or covers no more than the draft did,
   * the draft stands: a thin resume is worth more than no resume.
   */
  const gap = measureCoverageGap(tailored, jobAnalysis);
  if (gap.inBlockOnly.length > 0) {
    console.log(
      `[Resume coverage] ${profile.name}: ${gap.inBlockOnly.length} checklist term(s) are in the `
        + `skills block and in no sentence. Counted as placed, not asked for again - `
        + `${gap.inBlockOnly.slice(0, 8).join(', ')}${gap.inBlockOnly.length > 8 ? ', ...' : ''}`
    );
  }
  const hasBullets = (tailored.experience ?? []).some((role) => (role.achievements ?? []).length > 0);
  if (!gap.short || !hasBullets || !coverageRevisionEnabled()) {
    if (gap.missingTerms.length > 0) {
      console.log(
        `[Resume coverage] ${profile.name}: ${gap.missingTerms.length} checklist term(s) missing, `
          + `not enough to pay for a revision. Missing: ${gap.missingTerms.slice(0, 8).join(', ')}`
      );
    }
    return tailored;
  }

  console.log(`[Resume coverage] ${profile.name}: ${gap.reason} - asking for a revision.`);
  try {
    const revisedText = await createPromptCompletion({
      promptId: RESUME_REVISION_PROMPT_ID,
      callSite: RESUME_REVISION_PROMPT_ID,
      promptValues: revisionPromptValues(tailored, gap),
      fallbackProvider: provider,
      fallbackModelName: modelName,
      effort: choice.effort,
      thinking: choice.thinking,
      route: choice.route,
      // A patch, not a resume: the summary and the bullets of the roles it
      // touched. A tenth of what the tailoring call has to produce.
      maxTokens: 2500,
      temperature: 0.2,
      responseFormat: 'json',
      useExactPromptId: true,
      signal,
    });

    const merged = mergeRevision(tailored, JSON.parse(extractJSON(revisedText)));
    if (!merged) {
      console.warn(`[Resume coverage] ${profile.name}: the revision changed nothing. Keeping the draft.`);
      return tailored;
    }

    // Back through the same normalisation the draft went through: the bullet
    // cap, the plain-language pass and the reports all apply to a revised
    // sentence exactly as they did to the first one.
    const revised = parseTailoredResumeContent(JSON.stringify({
      title: merged.title,
      summary: merged.summary,
      experience: merged.experience,
      skillGroups: merged.skillGroups,
      coverLetter: merged.coverLetter,
      // The block came back from the first pass already routed, so its entries
      // are names without kinds and there is nothing left to route.
    }), profile, jobAnalysis, { alreadyRouted: true });
    const after = measureCoverageGap(revised, jobAnalysis);
    // Better on either axis, worse on neither: a revision that places three
    // terms by dropping two figures has not helped.
    const placedMore = after.missingTerms.length < gap.missingTerms.length;
    const countedMore = after.figures > gap.figures;
    if ((placedMore || countedMore) && after.missingTerms.length <= gap.missingTerms.length
      && after.figures >= gap.figures) {
      console.log(
        `[Resume coverage] ${profile.name}: revision placed `
          + `${gap.missingTerms.length - after.missingTerms.length} more term(s) and carries ${after.figures} figure(s).`
      );
      return revised;
    }
    /*
     * WHICH CONDITION FAILED, and both numbers for each.
     *
     * "No better" covered three different outcomes - fewer terms placed, fewer
     * figures, or neither axis moved - and an operator reading it could not
     * tell which. The one that matters is a revision REJECTED for losing a
     * checklist term while adding the figures a page was short of: the gate
     * takes it whole or not at all, so a draft under the figure floor ships.
     */
    const lostTerms = after.missingTerms.length > gap.missingTerms.length;
    const lostFigures = after.figures < gap.figures;
    const why = lostTerms && lostFigures
      ? 'it lost ground on both'
      : lostTerms
        ? 'it placed more figures but lost a checklist term, and the gate takes the revision whole'
        : lostFigures
          ? 'it placed more terms but lost a figure, and the gate takes the revision whole'
          : 'neither axis moved';
    console.warn(
      `[Resume coverage] ${profile.name}: the revision was rejected - ${why}. `
        + `Missing terms ${gap.missingTerms.length} -> ${after.missingTerms.length}, `
        + `figures ${gap.figures} -> ${after.figures} (floor ${FIGURE_FLOOR}). Keeping the draft.`
    );
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    /*
     * THE CALL FAILED, which is a different thing from the answer being no
     * better - and the two used to end in the same place, this catch, with the
     * draft shipping either way.
     */
    if (coverageRevisionFailureIsFatal()) {
      console.warn(
        `[Resume coverage] ${profile.name}: the revision call failed (${said}). `
          + `Failing the build so it is retried rather than shipped short. `
          + `Set RESUME_REVISION_SOFT_FAIL to keep the draft instead.`
      );
      throw asRevisionFailure(error);
    }
    console.warn(
      `[Resume coverage] ${profile.name}: the revision failed (${said}). Keeping the draft `
        + `(RESUME_REVISION_SOFT_FAIL).`
    );
  }
  return tailored;
}

/**
 * Generate a cover letter body when no job description is provided.
 * Returns only the body text (no salutation or sign-off).
 */
export async function generateCoverLetter(
  profile: Profile,
  companyName: string,
  role: string,
  choice: AiChoice,
  signal?: AbortSignal
): Promise<string> {
  const promptId = getProfileCoverLetterPromptId(profile);
  const promptValues = {
    // The same projection the tailoring call uses. A cover letter needs the
    // person's history and nothing about this installation - and it certainly
    // does not need their phone number, which is what the whole record carried.
    profileJson: promptJson(buildPromptProfile(profile)),
    companyName,
    role,
  };
  const content = await createPromptCompletion({
    promptId,
    callSite: DEFAULT_COVER_LETTER_PROMPT_ID,
    promptValues,
    fallbackProvider: choice.provider,
    fallbackModelName: choice.modelName,
    effort: choice.effort,
    thinking: choice.thinking,
    route: choice.route,
    maxTokens: 1500,
    // The only caller that wants sampling variety rather than determinism.
    // The CLI provider cannot honour it and says so once; pin this prompt to
    // the `claude` provider in the admin UI if the prose becomes too uniform.
    temperature: 0.7,
    responseFormat: 'text',
    useExactPromptId: true,
    signal,
  });
  return content.trim();
}

export async function extractTemplateFromPDF(
  pdfText: string,
  templateName: string,
  provider: AIProvider = DEFAULT_PROVIDER,
  signal?: AbortSignal
): Promise<{ html: string; css: string; sections: string[] }> {
  const promptValues = {
    pdfText,
    templateName,
  };
  const content = await createPromptCompletion({
    promptId: 'extract-template-from-pdf',
    signal,
    promptValues,
    fallbackProvider: provider,
    maxTokens: 8000,
    temperature: 0,
    responseFormat: 'json',
    // Runtime resolution on purpose: this feature's prompt can be replaced by
    // an activated custom variant in the admin panel, and pinning the exact id
    // would ignore it. (The tailor and analyze callers are exact because that
    // is what their rendering already used.)
  });

  try {
    const jsonText = extractJSON(content);
    return JSON.parse(jsonText);
  } catch {
    console.error('Failed to parse model response:', content);
    throw new Error('Failed to parse template extraction response');
  }
}

export async function extractProfileFromResume(
  resumeText: string,
  provider: AIProvider = DEFAULT_PROVIDER,
  signal?: AbortSignal
): Promise<Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>> {
  const promptValues = {
    resumeText,
  };
  const content = await createPromptCompletion({
    promptId: 'extract-profile-from-resume',
    signal,
    promptValues,
    fallbackProvider: provider,
    maxTokens: 4000,
    temperature: 0,
    responseFormat: 'json',
    // Runtime resolution: see the note in extractTemplateFromPDF.
  });

  try {
    const jsonText = extractJSON(content);
    return JSON.parse(jsonText);
  } catch {
    console.error('Failed to parse model response:', content);
    throw new Error('Failed to parse profile extraction response');
  }
}

export { DEFAULT_PROVIDER };
