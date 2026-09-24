import type { AiChoice } from '../config/aiPreferences';
import { describeAiChoice } from '../config/aiPreferences';
import { Profile } from '../types/profile';
import type { AIProvider, JobAnalysis, RawNestedJobAnalysis, TailoredContent } from '../types/template';
import { createPromptCompletion, DEFAULT_PROVIDER } from './ai';
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
import { normalizeDashes } from './utils/dashes';
import { bannedTermsIn, plainLanguage } from './utils/plainLanguage';
import {
  measurePlacement,
  placementFloor,
  renderedProse,
  type PlacementReport,
} from './utils/placementCoverage';
import {
  partitionSkills,
  validateHardSkill,
  validateSoftSkill,
  REJECTION_DETAIL,
  type SkillVerdict,
} from './utils/skillValidation';
import {
  extractConceptKeywords,
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
 * The code below decides every skill list from the skill library and the job
 * analysis, then overwrites whatever the model returned. Telling the model to
 * omit those fields is therefore not a preference, it is what keeps the model
 * from spending output tokens on text that is discarded. It lives here rather
 * than in the stored prompt so an admin editing the prompt cannot remove it
 * without also changing the code that depends on it.
 */
const FINAL_SKILL_OVERRIDE = `FINAL SKILL OVERRIDE:
Do not decide, generate, or return skills. Omit the fields "skills", "hardSkills", "softSkills", "unconfirmedHardSkills", and "unconfirmedSoftSkills" from the JSON output. Technical skills and soft-skill keywords are already decided by code from skillsJSON and keywordsJson.`;

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
function getProseChecklist(jobAnalysis?: JobAnalysis): string[] {
  if (!jobAnalysis) return [];
  const promptSkills = buildLibraryAugmentedPromptLists(jobAnalysis).promptSkills;
  const concepts = getConceptKeywords(jobAnalysis, promptSkills);
  const conceptSet = new Set(concepts.map((term) => term.toLowerCase()));
  const keywords = buildLibraryAugmentedPromptLists(jobAnalysis).keywords
    .filter((term) => !conceptSet.has(term.toLowerCase()));
  return normalizeSkillsList([...keywords, ...concepts]);
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
function reportPlacement(
  profileName: string,
  content: { summary?: string; experience?: Array<{ description?: string; achievements?: string[] }> },
  jobAnalysis?: JobAnalysis
): PlacementReport | null {
  const checklist = getProseChecklist(jobAnalysis);
  if (checklist.length === 0) return null;

  const report = measurePlacement(renderedProse(content), checklist);
  const floor = placementFloor();
  const percent = (report.ratio * 100).toFixed(0);

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
  const matchedTechSkills = removeBroaderCoveredSkills(getLibraryMatches(sourceText, technicalSkills));
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

function finalizeSoftSkills(skills: string[]): string[] {
  const condensed = prioritizeSoftSkills(normalizeSkillsList(skills)).map(condenseSoftSkill);
  return uniqueCaseInsensitive(condensed).slice(0, MAX_SOFT_SKILLS);
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

function toTitleCase(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

/**
 * The headline the resume is printed under: the candidate's own, unchanged.
 *
 * WHAT THIS REPLACED, AND WHY. It used to rebuild the headline into a fixed
 * `Senior <domain> Engineer` shape from whichever title it could find, and the
 * result was a resume that renamed the person. A profile that says "Software
 * Engineer" came out as "Senior Software Engineer" - a promotion this app is in
 * no position to hand out - and a MuleSoft posting turned the same person into
 * "Senior Mulesoft Integration Engineer", which is the resume renaming itself
 * for the job. The tailoring prompt already says not to do that: "The
 * candidate's existing headline from their profile... Never the target job
 * title, and never role-targeted."
 *
 * So the profile's title is used verbatim. The only thing added is the
 * discipline tag in `withTargetTitle`, which is a parenthetical after it rather
 * than a rewrite of it.
 *
 * The fallbacks are for a profile with no headline at all, and go to the
 * candidate's own most recent role before anything else - still theirs.
 */
function buildResumeHeadline(
  contentTitle: string | undefined,
  _jobAnalysis?: JobAnalysis,
  profile?: Profile
): string {
  const candidates = [
    profile?.title,
    contentTitle,
    profile?.experience?.[0]?.title,
  ];

  for (const candidate of candidates) {
    const trimmed = (candidate ?? '').trim().replace(/\s+/g, ' ');
    if (trimmed) return trimmed;
  }
  return 'Professional';
}

/**
 * The discipline a job title is really about, in one or two words.
 *
 * WHY THIS REPLACED THE LAST ATTEMPT. The first version put the target title in
 * parentheses only when every meaningful word of it already appeared in the
 * candidate's own history. That test almost never passes - a posting says
 * "Mulesoft Integration Engineer" and the profile says "built integrations",
 * which shares one word out of three - so across ten test resumes it fired
 * exactly zero times. A rule that never fires is not a conservative rule, it is
 * a dead one.
 *
 * So the claim is smaller and the trigger is simpler. Rather than repeating the
 * posting's whole title, the headline carries the FIELD it belongs to:
 *
 *   Mulesoft Integration Engineer                      -> (Integration)
 *   Senior Machine Learning Engineer                   -> (AI/ML)
 *   Full Stack Software Engineer (Node.js)             -> (Full-Stack)
 *   Backend Engineer - AI Platform and Cloud Native    -> (Backend, AI/ML, Cloud)
 *   AWS DevOps                                         -> (DevOps)
 *   Senior Engineer I, DevOps                          -> (DevOps)
 *   Staff Data Engineer                                -> (Data Engineer)
 *
 * A discipline is a much weaker statement than a job title - it says which part
 * of the field the resume is aimed at, which the rest of the document already
 * says - and it is the part a scanner matching on "DevOps" or "Machine
 * Learning" is looking for.
 */
type Discipline = { label: string; patterns: RegExp[] };

/**
 * Ordered most specific first, because the first match wins per discipline and
 * several of these overlap: "full stack" must not also read as "backend", and
 * "site reliability" must not read as "reliability engineering".
 *
 * Note what is NOT a trigger. A cloud VENDOR - AWS, Azure, GCP - does not make
 * a title a cloud role: "AWS DevOps" is a DevOps job that happens to be on AWS,
 * and tagging it (Cloud, DevOps) would say something the posting did not. The
 * word "cloud" itself does, which is why "Cloud Native Services" tags Cloud.
 */
const DISCIPLINES: Discipline[] = [
  { label: 'Full-Stack', patterns: [/\bfull[\s-]?stack\b/i] },
  { label: 'AI/ML', patterns: [
    /\bmachine[\s-]?learning\b/i, /\bdeep[\s-]?learning\b/i, /\bartificial[\s-]?intelligence\b/i,
    /\bml\b/i, /\bai\b/i, /\bllm(s)?\b/i, /\bgen[\s-]?ai\b/i, /\bnlp\b/i, /\bcomputer[\s-]?vision\b/i,
    // Agent work is AI work. "RL" only in capitals: reinforcement learning.
    /\bagentic\b/i, /\breinforcement[\s-]?learning\b/i, /\bRL\b/,
  ] },
  { label: 'Data Engineer', patterns: [
    /\bdata[\s-]?engineer(ing)?\b/i, /\betl\b/i, /\belt\b/i, /\bdata[\s-]?platform\b/i,
    /\bdata[\s-]?warehous(e|ing)\b/i, /\bdata[\s-]?lake(house)?\b/i,
  ] },
  { label: 'Data Science', patterns: [
    /\bdata[\s-]?scien(ce|tist)\b/i, /\banalytics\b/i,
    // "Senior Statistician" is a data science job; "(Statistician)" only
    // repeated the job's name.
    /\bdata[\s-]?analysts?\b/i, /\bstatistic(s|al|ian|ians)\b/i,
  ] },
  { label: 'DevOps', patterns: [
    /\bdev[\s-]?ops\b/i, /\bsre\b/i, /\bsite[\s-]?reliability\b/i,
    /\bplatform[\s-]?engineer(ing)?\b/i, /\bci\/?cd\b/i, /\binfrastructure\b/i,
    /\bbuild[\s-]*(and|&)?[\s-]*release\b/i, /\brelease[\s-]?engineer(ing)?\b/i, /\bbuild[\s-]?engineer(ing)?\b/i,
  ] },
  { label: 'Integration', patterns: [/\bintegration(s)?\b/i, /\bmulesoft\b/i, /\bmiddleware\b/i, /\bipaas\b/i, /\besb\b/i, /\bboomi\b/i] },
  { label: 'Security', patterns: [
    /\bsecurity\b/i, /\bappsec\b/i, /\binfosec\b/i, /\bcyber\b/i, /\bidentity\b/i,
    /\bfortinet\b/i, /\bpalo[\s-]?alto\b/i, /\bfirewalls?\b/i,
  ] },
  { label: 'Cloud', patterns: [/\bcloud\b/i, /\bkubernetes\b/i, /\bserverless\b/i] },
  { label: 'Mobile', patterns: [/\bmobile\b/i, /\bios\b/i, /\bandroid\b/i, /\breact[\s-]?native\b/i, /\bflutter\b/i] },
  { label: 'Frontend', patterns: [/\bfront[\s-]?end\b/i, /\bui[\s-]?engineer\b/i, /\bweb[\s-]?ui\b/i] },
  { label: 'Backend', patterns: [/\bback[\s-]?end\b/i, /\bserver[\s-]?side\b/i, /\bapi[\s-]?engineer(ing)?\b/i] },
  { label: 'QA', patterns: [
    /\bqa\b/i, /\bquality[\s-]?assurance\b/i, /\bsdet\b/i, /\btest(ing)?[\s-]?automation\b/i,
    /\btest(ing)?[\s-]?engineer(ing)?\b/i, /\bquality[\s-]?engineer(ing)?\b/i, /\bsoftware[\s-]?quality\b/i,
  ] },
  { label: 'Embedded', patterns: [/\bembedded\b/i, /\bfirmware\b/i, /\brtos\b/i] },
  { label: 'Network', patterns: [/\bnetwork(ing)?\b/i, /\bnetscaler\b/i] },
  { label: 'Database', patterns: [/\bdba\b/i, /\bdatabase[\s-]?admin/i] },
  { label: 'Salesforce', patterns: [/\bsalesforce\b/i, /\bapex\b/i] },
  { label: 'Automation', patterns: [/\brpa\b/i, /\buipath\b/i, /\bautomation\b/i] },
  // Products a title names often enough to be worth a tag, but which the hard
  // skill list either lacks or spells differently ("Golang" is listed as "Go").
  { label: 'Go', patterns: [/\bgolang\b/i] },
  { label: 'ServiceNow', patterns: [/\bservice[\s-]?now\b/i] },
  { label: 'SAP', patterns: [/\bsap\b/i] },
  { label: 'Oracle', patterns: [/\boracle\b/i] },
  { label: 'Drupal', patterns: [/\bdrupal\b/i] },
  /*
   * Last, and narrow. "IT" counts only in capitals: case-blind, it also matched
   * the English word "it". And "support engineer" is no longer a trigger - it
   * was tagging Technical, Product and SailPoint Support Engineers as (IT),
   * which is a different job.
   */
  { label: 'IT', patterns: [/\bIT\b/, /\bhelp[\s-]?desk\b/i, /\bservice[\s-]?desk\b/i] },
];

/** Words that describe the arrangement or the grade, never the field. */
const TITLE_NOISE = new Set([
  'a', 'an', 'and', 'for', 'of', 'the', 'to', 'with', 'at', 'in', 'on', 'or',
  'senior', 'sr', 'junior', 'jr', 'mid', 'staff', 'principal', 'lead', 'head',
  'contract', 'contractor', 'remote', 'hybrid', 'onsite', 'fulltime', 'parttime',
  'i', 'ii', 'iii', 'iv', 'v', 'level', 'entry', 'engineer', 'engineering',
  'developer', 'development', 'architect', 'specialist', 'manager', 'analyst',
  'consultant', 'administrator', 'scientist', 'programmer', 'technician',
  'services', 'platform', 'systems', 'system', 'software', 'technology', 'team',
  // More role nouns, found by running this over 401 real postings: without them
  // "Senior Fraud Strategist" fell back to "(Fraud Strategist)" rather than
  // "(Fraud)".
  'strategist', 'evangelist', 'owner', 'coordinator', 'associate', 'director',
  'officer', 'partner', 'generalist', 'expert', 'professional', 'practitioner',
  // Words about the hiring, not the job. "IT Engineer, First IT Hire" was
  // producing "(It First)".
  'first', 'hire', 'new', 'grad', 'graduate', 'intern', 'internship', 'opening',
  'position', 'role', 'job', 'opportunity', 'urgent', 'immediate', 'needed',
]);

/** How many tags a headline may carry before it stops being a headline. */
const MAX_DISCIPLINES = 3;

/** How long the whole headline may get. */
const MAX_HEADLINE_LENGTH = 72;

/**
 * The disciplines a title names, in the order the title names them.
 *
 * Order matters to a reader: "Backend Engineer - AI Platform and Cloud Native
 * Services" is a backend job first, and listing it (AI/ML, Backend, Cloud)
 * because that is alphabetical would misdescribe it.
 */
export function titleDisciplines(title: string, skills: readonly string[] = technicalSkills): string[] {
  const text = String(title ?? '').trim();
  if (!text) return [];

  const found: Array<{ label: string; at: number }> = [];
  for (const discipline of DISCIPLINES) {
    let earliest = -1;
    for (const pattern of discipline.patterns) {
      const match = text.match(pattern);
      if (match?.index !== undefined && (earliest < 0 || match.index < earliest)) earliest = match.index;
    }
    if (earliest >= 0) found.push({ label: discipline.label, at: earliest });
  }

  if (found.length > 0) {
    return found
      .sort((a, b) => a.at - b.at)
      .map((entry) => entry.label)
      .slice(0, MAX_DISCIPLINES);
  }

  /*
   * Nothing in the table matched. The tag then comes from the hard skill list
   * or not at all.
   *
   * This used to take the first word left once grades and role nouns were
   * removed. A blocklist cannot name every company, team, level or place, so
   * over 613 real titles 221 were tagged that way, and most tags were wrong:
   * (Everhealth), (Experience), (Executive), (L4), (Part-time), (Us), (90-140/hour).
   * A skill on the list is something a scanner matches on, and it comes with
   * its proper spelling - (.NET), (SQL), (DevSecOps) rather than (Net), (Sql),
   * (Devsecops). A title that names neither a field nor a skill gets no tag:
   * no tag is better than a wrong one.
   */
  const skill = skillNamedIn(text, skills);
  return skill ? [skill] : [];
}

/**
 * Skills that are also everyday words, places or names. In a job title the
 * word is usually not the tool: "L2 Field Engineer (Aurora)" is a town,
 * "Rocket Mobius Developer" is a company. Compared in lower case.
 */
const AMBIGUOUS_IN_TITLES = new Set([
  'ada', 'analysis', 'apex', 'assembly', 'astro', 'aurora', 'awk', 'bamboo', 'beam',
  'behave', 'bosh', 'bun', 'capacitor', 'chai', 'chef', 'chroma', 'consul', 'cron',
  'crystal', 'cucumber', 'delphi', 'echo', 'elm', 'ember', 'emotion', 'envoy', 'expo',
  'express', 'falcon', 'feign', 'fiber', 'flux', 'gatsby', 'gin', 'hack', 'hanami',
  'harbor', 'hive', 'hugo', 'insomnia', 'ionic', 'jasmine', 'jetty', 'julia', 'kind',
  'less', 'lighthouse', 'lit', 'locust', 'logs', 'macros', 'math', 'maven', 'mercurial',
  'mocha', 'mocking', 'monit', 'netty', 'nomad', 'packer', 'paging', 'parcel', 'phoenix',
  'pony', 'prefect', 'presto', 'puppet', 'pyramid', 'racket', 'realm', 'reflection',
  'relay', 'remix', 'render', 'ribbon', 'rocket', 'scheme', 'sed', 'semaphore', 'sentry',
  'sinatra', 'sorbet', 'spanner', 'spring', 'spying', 'streams', 'stubbing', 'superset',
  'swift', 'thrift', 'tornado', 'transactions', 'triggers', 'vapor', 'vault', 'vector',
  'warp', 'waterfall',
]);

/** The longest skill name, in words, worth looking for: "Google Cloud Platform". */
const LONGEST_SKILL_NAME = 3;

/**
 * The first hard skill a title names, spelled as the skill list spells it.
 *
 * Longest name first at each position, so "Ruby on Rails" wins over "Ruby" and
 * "SQL Server" over "SQL".
 */
function skillNamedIn(title: string, skills: readonly string[]): string | undefined {
  const byName = new Map<string, string>();
  for (const skill of skills) {
    const name = String(skill ?? '').trim();
    if (name && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), name);
  }
  if (byName.size === 0) return undefined;

  const words = title
    .replace(/[^A-Za-z0-9+#/.\s-]/g, ' ')
    .split(/\s+/)
    // Punctuation on the END is the sentence, not the name ("Sr.", "Remote-").
    // A leading dot is kept: it is half of ".NET".
    .map((word) => word.replace(/[./-]+$/, ''))
    // "Java/Python" names two skills; "PL/SQL" and "CI/CD" are one each.
    .flatMap((word) => (word.includes('/') && !byName.has(word.toLowerCase()) ? word.split('/') : [word]))
    .filter(Boolean);

  for (let at = 0; at < words.length; at += 1) {
    for (let size = Math.min(LONGEST_SKILL_NAME, words.length - at); size >= 1; size -= 1) {
      const phrase = words.slice(at, at + size).join(' ');
      const skill = byName.get(phrase.toLowerCase());
      if (skill && (size > 1 || usableAlone(phrase, skill))) return skill;
    }
  }
  return undefined;
}

function usableAlone(word: string, skill: string): boolean {
  // Trailing punctuation is why "(Sr.)" once reached a printed resume: the
  // token was "Sr." and the noise list holds "sr". Stripped on both sides for
  // the comparison only.
  const bare = word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').toLowerCase();
  if (TITLE_NOISE.has(bare) || AMBIGUOUS_IN_TITLES.has(bare)) return false;
  // One letter is a language only with its marks - C#, C++, F#. A bare "R" or
  // "C" is usually "R&D" or an initial.
  if (bare.length < 2 && !/[+#]/.test(word)) return false;
  // "Go" is the language; "go" is a verb. Same rule the skill extractor uses.
  if (skill === 'Go') return word === 'Go';
  return true;
}

/**
 * The headline with the target role's discipline after it.
 *
 * Skipped when the headline already says it, which is common - somebody whose
 * own title is "Senior Data Engineer" applying for a data engineering job does
 * not need "(Data Engineer)" after it.
 */
export function withTargetTitle(
  headline: string,
  jobAnalysis?: JobAnalysis,
  _profile?: Profile
): string {
  const base = headline.trim();
  const target = getJobAnalysisTitle(jobAnalysis).trim();
  if (!base || !target) return base;

  const disciplines = titleDisciplines(target);
  if (disciplines.length === 0) return base;

  const spoken = base.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const fresh = disciplines.filter((label) => {
    const words = label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return !words.every((word) => spoken.includes(word));
  });
  if (fresh.length === 0) return base;

  const combined = `${base} (${fresh.join(', ')})`;
  return combined.length <= MAX_HEADLINE_LENGTH ? combined : `${base} (${fresh[0]})`;
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

function normalizeTailoredContent(content: TailoredContent, jobAnalysis?: JobAnalysis, profile?: Profile): TailoredContent {
  // What the job asks for, plus what this person's own roles show they have,
  // with concepts translated into the tools that implement them and the list
  // topped up towards a full block. See `selectHardSkills`.
  // `promptSkills`, not `skills`. The categorized list is padded to make a
  // heading grid look full - it fills each category from the library up to a
  // minimum and then truncates it to a maximum - so reading it here put filler
  // like "SQL Injection" and "Ruby on Rails" on the resume as though the job had
  // asked for them, and the per-category truncation dropped ones it HAD asked
  // for. `promptSkills` is the unpadded set of library terms actually found in
  // the posting, which is the honest input to a selection.
  const codeDecidedHardSkills = jobAnalysis
    ? selectHardSkills({
      // The analyser's own named technologies FIRST, then the library terms
      // found in the raw text. The union, not either alone: raw-text matching
      // catches what a posting mentions in passing, and the extracted fields
      // catch what it lists. Both are the job speaking; neither is code
      // choosing skills on the job's behalf.
      jobSkills: normalizeSkillsList([
        ...getJobNamedHardSkills(jobAnalysis),
        ...buildLibraryAugmentedPromptLists(jobAnalysis).promptSkills,
      ]),
      experienceSkills: getProfileExperienceSkills(profile),
      library: hardSkillRecords,
      // The library is a spelling and grouping aid here, not a vocabulary
      // ceiling: a technology the job named is allowed on the resume whether or
      // not somebody has added it to the library yet.
      unlistedJobSkills: getUnlistedJobSkills(jobAnalysis),
      unlistedExperienceSkills: getUnlistedProfileSkills(profile),
      // For the tools they imply, not for themselves. A posting written wholly
      // in abilities names no library term, and without this there is nothing
      // for the selection to anchor on at all.
      jobConceptSkills: getConceptKeywords(jobAnalysis),
      // The name each skill is finally printed under, so the count to twenty is
      // a count of lines a reader will see rather than of library rows.
      canonicalize: (skill) => resolveHardSkill(skill)?.display ?? skill,
    })
    : normalizeSkillsList(content.hardSkills ?? content.skills ?? []);

  /*
   * The last gate before either block is printed.
   *
   * The selection already refuses concepts, job titles and prose - but it
   * refuses them among the CANDIDATES, and two things reach the block without
   * ever being a candidate: a library row that the concept rules did not catch
   * when it was written, and the model's own `hardSkills` when there is no job
   * analysis to select from. Both have put sentences in the skills block
   * before. This is the check that applies the same standard to whatever is
   * actually about to be printed.
   *
   * What it rejects is NOT lost. Every term here came from the posting or the
   * profile, and the prose checklists already carry the posting in full - see
   * `collectJobKeywords` and the coverage backstop in
   * `buildTailorResumePromptValues` - so a keyword refused a bullet here has
   * already been asked for in the summary and the experience bullets.
   */
  const librarySkillKeys = new Set(
    hardSkillRecords.map((record) => record.skill.trim().toLowerCase().replace(/\s+/g, ' '))
  );
  const hardVerdicts = partitionSkills(
    normalizeSkillsList(codeDecidedHardSkills),
    (term) => validateHardSkill(term, librarySkillKeys)
  );
  reportRejectedSkills('hard', hardVerdicts.rejected);

  const atsSoftPriority = inferAtsSoftSkillsFromAnalysis(jobAnalysis);
  const finalizedHardSkills = hardVerdicts.accepted;
  const hardSkills = usesJobPriorityHardSkillOrdering(profile)
    ? prioritizeHardSkills(finalizedHardSkills, jobAnalysis)
    : sortHardSkillsByLibraryPriority(finalizedHardSkills);
  const softFromModel = normalizeSkillsList(content.softSkills);
  const softFromAnalysis = getSoftSkills(jobAnalysis);
  const softFromLibrary = getMatchedLibrarySoftSkills(jobAnalysis);
  const softMerged = normalizeSkillsList([
    ...atsSoftPriority,
    ...softFromModel,
    ...softFromAnalysis,
    // Last, so it fills the list out rather than displacing what the analysis
    // named outright. These are the terms the job asked for in prose.
    ...softFromLibrary,
  ]);
  const softVerdicts = partitionSkills(softMerged, validateSoftSkill);
  reportRejectedSkills('soft', softVerdicts.rejected);
  const softLimited = finalizeSoftSkills(softVerdicts.accepted);

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

  const normalizedExperience = (content.experience ?? []).map((item) => ({
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
    achievements: normalizeSkillsList(item.achievements).map(sanitizeResumeText).filter(Boolean).length > 0
      ? normalizeSkillsList(item.achievements).map(sanitizeResumeText).filter(Boolean)
      : buildFallbackAchievements(jobAnalysis),
  }));

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
  const finalSummary = modelSummary || (profile ? buildFallbackSummary(profile) : '');

  // Measured on what will actually be rendered, after the summary has been
  // sanitised and the experience normalised. Measuring the model's raw answer
  // would count terms that the cleanup steps then removed.
  reportPlacement(profile?.name ?? 'resume', {
    summary: finalSummary,
    experience: normalizedExperience,
  }, jobAnalysis);

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
    title: withTargetTitle(
      buildResumeHeadline(content.title, jobAnalysis, profile),
      jobAnalysis,
      profile
    ),
    summary: finalSummary,
    experience: normalizedExperience,
    hardSkills,
    /*
     * No soft-skills block. It was a row of nouns nobody reads - and 44 of the
     * library's entries are the exact register the operator asked to be rid
     * of: "Innovation", "Creative solutions", "Proactiveness", "Visionary
     * Leadership". The soft skills a posting names are still written into the
     * prose, where they are attached to something the candidate did.
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
  const promptSkills = augmentedPromptLists.promptSkills;
  const conceptKeywords = getConceptKeywords(jobAnalysis, promptSkills);
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

  const proseKeywords = normalizeSkillsList([
    ...augmentedPromptLists.keywords.filter((keyword) => !conceptSet.has(keyword.toLowerCase())),
    ...uncovered,
  ]);
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
    keyResponsibilitiesJson: promptJson(getResponsibilities(jobAnalysis)),
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
  jobAnalysis: JobAnalysis
): TailoredContent {
  const jsonText = extractJSON(content);
  const parsed = JSON.parse(jsonText) as TailoredContent;
  const finalResult = normalizeTailoredContent(parsed, jobAnalysis, profile);
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
  const unconfirmedHardSkills = uniqueCaseInsensitive([
    ...getUnlistedJobSkills(jobAnalysis),
    ...getUnlistedProfileSkills(profile),
  ]).filter((skill) =>
    finalResult.hardSkills.some((selected) => selected.toLowerCase() === skill.toLowerCase())
  );

  return {
    ...finalResult,
    // Empty on purpose: there is no soft-skills block on the resume any more.
    // The reconciliation above still runs, because the Unconfirmed Skills
    // panel is built from it and an operator still catalogues terms there.
    softSkills: [],
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
    appendToUserBody: FINAL_SKILL_OVERRIDE,
    signal,
  });
  const secondCallEndedAt = process.hrtime.bigint();
  console.log(`[Resume timing] Second LLM call finished in ${formatDuration(secondCallStartedAt, secondCallEndedAt)}`);

  try {
    return parseTailoredResumeContent(content, profile, jobAnalysis);
  } catch {
    console.error('Failed to parse model response:', content);
    throw new Error('Failed to parse tailored resume response');
  }
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
