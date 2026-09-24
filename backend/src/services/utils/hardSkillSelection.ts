import type { HardSkillCategory, HardSkillRecord } from '../../database/skillsDatabase';

/**
 * Which technical skills go on the resume, and in what order.
 *
 * The block used to be whatever the skill library matched in the job
 * description, and nothing else: a profile contributed nothing, a short posting
 * produced a short list, and terms like "Microservices" or "Agile Development"
 * went on as skills in their own right. Three things are wrong with that.
 *
 * A concept is not a skill. "Microservices" tells a reader nothing they can
 * screen for, and an ATS matching a requisition for Docker does not match it.
 * Concepts are therefore not listed; they are translated into the tools that
 * implement them, and the tools are listed instead.
 *
 * The candidate's own history is evidence. What the job asks for decides
 * relevance, but the roles somebody has actually held are where the defensible
 * skills come from, so both are read and the job's are ranked first.
 *
 * A six-skill block reads as a thin candidate. The list is topped up towards a
 * target from the categories the job is already asking about, so a terse posting
 * does not produce a resume that looks underqualified.
 */

/** How many skills the block aims for. */
export const TARGET_HARD_SKILLS = 20;

/**
 * The ceiling, and it only ever binds on a posting that names this many
 * technologies outright.
 *
 * It was 24, which is close to the target and reads as "about 20" - and on a
 * dense posting it threw away the terms the resume is scored on. Measured: a
 * job naming 40 real technologies printed 24 and dropped Docker, Kubernetes,
 * Kafka, Azure, GraphQL, gRPC, Jenkins and nine more, every one of them a term
 * the posting had asked for by name.
 *
 * Raising it cannot pad anything. The top-up stops at TARGET_HARD_SKILLS, so
 * the only skills that can reach the space between the target and this ceiling
 * are ones the job or the candidate's own history named. A thin posting still
 * produces twenty; a dense one now produces what it asked for.
 */
export const MAX_HARD_SKILLS = 35;

/**
 * How far the last-resort fill may widen before it gives up.
 *
 * Each round raises the per-category allowance by one and reaches one step
 * further from the job's own categories. Four rounds is enough for the widest
 * case measured - a posting naming one unmapped language against a profile with
 * nothing in it - and the loop stops the moment the target is reached, so on
 * almost every real job this is one round or none.
 */
export const MAX_FILL_ROUNDS = 4;

function normalize(skill: string): string {
  return skill.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Named products whose names read like concepts.
 *
 * Checked before the pattern rules below, which would otherwise throw away real
 * technologies: "Ant Design" ends in Design, "Solidity" starts with SOLID,
 * "Azure API Management" ends in Management. Every entry here is a thing you can
 * install, import or sign in to.
 */
const CONCRETE_DESPITE_PATTERN = new Set(
  [
    // Ends in "Security", which the last-word rule now claims. It is a Spring
    // module you import, and the only product among the library's six
    // "-Security" rows: the other five - Application Security, API Security,
    // Network Security, Webhook Security, Supply Chain Security - are fields of
    // work, which is why the word was finally added.
    'Spring Security',
    'Ant Design',
    'Solid.js',
    'SolidJS',
    'Solidity',
    'Spring Integration',
    'Azure API Management',
    'AWS Systems Manager',
    'Amazon API Gateway',
    'Apigee',
    'AWS AppSync',
    'Power BI',
    // Real products inside groups the last-word rule claims: "Azure Pipelines"
    // is a service, while "ETL Pipelines" is an activity; "Secrets Manager" is a
    // product, while "Secrets Detection" is not.
    'Azure Pipelines',
    'Azure DevOps',
    // Products whose names end in "Services". The rule that claims that word is
    // right about "Cloud services" and "Event-Driven Services" and wrong about
    // these, which are trade names.
    'Amazon Web Services',
    'Azure Cognitive Services',
    'Google Play Services',
    'Azure Media Services',
    // Fields of work rather than ideas about work, and each is a term a
    // recruiter screens on directly. "Static Analysis" and "Responsive Design"
    // are deliberately NOT here: they are techniques, and the table below turns
    // them into the tools that do them.
    'Natural Language Processing',
    'Computer Vision',
    'Feature Engineering',
    'Prompt Engineering',
    'Retrieval-Augmented Generation',
  ].map(normalize)
);

/**
 * Concepts the pattern rules below do not catch, because their names carry no
 * giveaway word. Mostly methodologies and architectural vocabulary.
 */
const CONCEPT_EXACT = new Set(
  [
    'agile', 'agile development', 'scrum', 'kanban', 'sprint planning',
    'pair programming', 'trunk-based development', 'lean software development',
    'tdd', 'bdd', 'atdd', 'test-driven development', 'behavior-driven development',
    'ci/cd', 'cicd', 'ci-cd', 'continuous integration', 'continuous delivery',
    'continuous deployment', 'devops', 'devsecops', 'gitops', 'mlops',
    'microservices', 'microservice', 'monolith', 'monorepo', 'polyrepo',
    'cqrs', 'ddd', 'solid', 'solid principles', 'design patterns', 'gof patterns',
    'event-driven', 'event driven', 'distributed systems', 'distributed locking',
    'caching', 'caching layers', 'scalability', 'scalable systems',
    'high availability', 'fault tolerance', 'load balancing',
    // "REST" is NOT here. The analyser files it under `protocols` - "communication
    // standards, API paradigms" - beside gRPC and GraphQL, and those two are
    // listable. Calling one of the three an idea meant a posting that asked for
    // REST by name got gRPC and GraphQL on the resume and not REST.
    'apis', 'api', 'restful services', 'restful api', 'web services',
    'backend development', 'frontend development', 'full-stack development',
    'full stack development', 'mobile app architecture', 'cloud-native development',
    'android development', 'ios development',
    'automation', 'infrastructure', 'infrastructure as code', 'iac',
    'cloud computing', 'cloud platforms', 'cloud infrastructure', 'edge computing',
    'gpu computing', 'serverless', 'containerization', 'orchestration',
    'business intelligence', 'data governance', 'data modeling', 'data modelling',
    'etl', 'elt', 'data warehousing', 'machine learning', 'deep learning',
    'observability', 'monitoring', 'logging', 'alerting', 'incident response',
    'root cause analysis', 'postmortem analysis', 'site reliability engineering',
    'resilience engineering', 'chaos engineering', 'capacity planning',
    'technical documentation', 'design docs', 'technical design', 'technical planning',
    'code review', 'refactoring', 'debugging', 'troubleshooting',
    'unit testing', 'integration testing', 'end-to-end testing', 'e2e testing',
    'regression testing', 'performance testing', 'load testing', 'scalability testing',
    'test automation', 'quality assurance', 'quality assurance process',
    'threat modeling', 'penetration testing', 'vulnerability analysis',
    'identity and access management', 'iam', 'authentication', 'authorization',
    'encryption', 'compliance', 'acid compliance', 'wcag compliance',
    'version control', 'branching strategy', 'release management', 'release planning',
    'change management', 'configuration management', 'dependency management',
    'package management', 'risk management', 'project management',
    'process improvement', 'requirements analysis', 'system design', 'systems design',
    'software architecture', 'system architecture', 'cloud architecture',
    'engineering practices', 'best practices', 'performance optimization',
    'cost optimization', 'query optimization', 'index optimization',
    'http caching', 'performance baselines', 'performance profiling',
    'database design', 'schema design', 'database schema design',
    // Reported on generated resumes. None has a giveaway last word, so the
    // rule below cannot reach them and they have to be named.
    'artificial intelligence', 'generative ai', 'multi-region', 'multi region',
    'front-end', 'back-end', 'full-stack', 'owasp top 10', 'owasp',
    'llmops', 'aiops', 'dataops', 'finops', 'secops', 'platform engineering',
    'high concurrency', 'low latency', 'fault isolation', 'blue-green',
  ].map(normalize)
);

/**
 * The same names with their spaces, dots and hyphens taken out.
 *
 * `CONCEPT_EXACT` is an exact-string set, so it held "mlops" and let "ML Ops"
 * straight through - and the analyser emits both spellings depending on how the
 * posting wrote it. "Dev Ops", "LLM Ops" and "Front end" got in the same way.
 * Comparing the collapsed forms costs one extra lookup and closes the whole
 * family at once.
 *
 * Collapsing cannot create a false positive here because the concrete list is
 * collapsed too and checked first: "SolidJS" collapses to "solidjs" and never
 * meets "solid".
 */
function collapseSpacing(normalized: string): string {
  return normalized.replace(/[\s._\-/]+/g, '');
}

const CONCEPT_EXACT_COLLAPSED = new Set([...CONCEPT_EXACT].map(collapseSpacing));
const CONCRETE_DESPITE_PATTERN_COLLAPSED = new Set(
  [...CONCRETE_DESPITE_PATTERN].map(collapseSpacing)
);

/**
 * Last words that make the whole phrase an activity rather than a product.
 *
 * This is the rule that does the real work, and it replaced a list of
 * hand-written suffix regexes that could only ever catch what someone had
 * thought of. The skill library is 1,492 entries and a large minority of them
 * are activities: FIFTY end in "Testing" alone, nine in "Automation", eight in
 * "Awareness", six in "Prevention". None of those is a thing you can install,
 * and a resume listing "Testing", "Automated testing" and "Distributed Tracing"
 * as technical skills is listing the job, not the toolkit.
 *
 * Chosen by reading every group in the library rather than by guessing, which
 * is also why some plausible-looking words are NOT here: "-security" would take
 * Spring Security with it, "-integration" would take Spring Integration, and
 * "-api", "-server", "-sdk", "-gateway", "-framework" and "-ui" are almost
 * entirely real products.
 */
const CONCEPT_LAST_WORDS = new Set([
  'architecture', 'pattern', 'patterns', 'principle', 'principles',
  'practice', 'practices', 'methodology', 'methodologies',
  'strategy', 'strategies', 'management', 'governance', 'analysis',
  'planning', 'optimization', 'design', 'development', 'engineering',
  'services', 'systems', 'baseline', 'baselines', 'profiling', 'records',
  // Activities the old suffix list missed entirely. Each was reported on a real
  // generated resume, or sits in a group where every member is an activity.
  'testing', 'monitoring', 'automation', 'tracing', 'procedures', 'requests',
  'awareness', 'prevention', 'detection', 'validation', 'deployment',
  'programming', 'basics', 'review', 'reviews', 'migration', 'migrations',
  'modeling', 'modelling', 'versioning', 'documentation', 'tuning',
  'pipelines', 'scaling', 'processing', 'generation', 'instrumentation',
  'provisioning', 'hardening', 'remediation', 'troubleshooting', 'estimation',
  'prioritization', 'onboarding', 'mentoring', 'delivery', 'ownership',
  // Verbal nouns and plural categories. The job analyser is asked for a
  // "specificity ladder" - "PostgreSQL query optimization" is expanded into
  // "query optimization", "database optimization" - so it emits a steady supply
  // of these, and they are activities around a tool rather than tools.
  // Checked against the library first: the only entries they claim are "BI
  // Tools", "Backend APIs", "ADR Writing", "PII Handling" and the like, which
  // are activities too. The real technologies are "REST API" and "GraphQL API",
  // singular, and those are untouched.
  'tools', 'apis', 'assistants', 'usage', 'definition', 'reasoning',
  'writing', 'handling', 'tracking',
  // Surfaced once the fill started reaching further into the library, which is
  // where entries like these live. Checked first: "-test" claims only "Go Test",
  // and "-injection" only "SQL Injection" and "Dependency Injection". All three
  // are things you do, not things you use.
  'test', 'injection',
  // Database and data-handling activities. Each was audited against the library
  // before being added and claims only activities:
  //   -normalization  Normalization          -indexing     Indexing
  //   -sharding       Sharding               -partitioning Partitioning
  //   -transactions   Transactions           -encryption   Data Encryption,
  //   -serialization  Serialization                        Encryption
  //   -deserialization Deserialization       -sanitization Input Sanitization
  'normalization', 'normalisation', 'indexing', 'sharding', 'partitioning',
  'transactions', 'serialization', 'serialisation', 'deserialization',
  'deserialisation', 'sanitization', 'sanitisation', 'encryption',
  // Web and platform activities. -rendering claims Server-Side Rendering and
  // Template Rendering; -proxy claims Reverse Proxy; -limiting claims Rate
  // Limiting; -gates claims Code Quality Gates; -recovery claims Backup and
  // Recovery and Disaster Recovery; -visualization claims Data Visualization.
  'rendering', 'proxy', 'limiting', 'gates', 'recovery',
  'visualization', 'visualisation',
  // Plural of "integration", which stays out: the singular claims Spring
  // Integration and five other real names, the plural claims only "API
  // integrations".
  'integrations',
  // -security was excluded for years to protect Spring Security, and that one
  // name is now handled by CONCRETE_DESPITE_PATTERN instead. The other five
  // library rows ending in it are fields of work, and the analyser produces a
  // steady supply more: "Application Security", "APISecurity", "Cloud Security".
  'security',
  /*
   * Plural category nouns - the shape a posting uses when it will not name the
   * product: "experience with CRM platforms", "familiarity with SIEM platforms",
   * "exposure to AI frameworks". They are slots, not skills, and they were the
   * single largest group of junk on the finished resumes.
   *
   * GENERIC_TERMS already blocked the bare words, but only bare: "platforms"
   * was caught and "CRM platforms" was not. Audited against the library, these
   * claim "Cloud platforms", "Mocking Frameworks", "Classification Models" and
   * "Regression Models" - all four activities or categories, none a product.
   */
  'platforms', 'frameworks', 'models', 'copilots', 'suites', 'solutions',
]);

/** Name shapes that mark a concept, where the last word alone is not enough. */
const CONCEPT_PATTERNS: RegExp[] = [
  /^scalab/,
  /^best practice/,
  /^event[- ]driven\b/,
  /^adr\b/,
];

function lastWordOf(normalized: string): string {
  const parts = normalized.split(/\s+/);
  return (parts[parts.length - 1] ?? '').replace(/[^a-z]/g, '');
}

/**
 * Whether a skill names an idea rather than something you can use.
 *
 * Exported because the renderer applies the same test to profiles that are
 * rendered untailored, where nothing has been through the selection below.
 */
export function isConceptSkill(skill: string): boolean {
  const normalized = normalize(skill);
  if (!normalized) return true;
  const collapsed = collapseSpacing(normalized);
  if (CONCRETE_DESPITE_PATTERN.has(normalized)) return false;
  if (CONCRETE_DESPITE_PATTERN_COLLAPSED.has(collapsed)) return false;
  if (CONCEPT_EXACT.has(normalized)) return true;
  // The spacing-insensitive pass: catches "ML Ops" from "mlops", "Dev Ops" from
  // "devops", "Front end" from "front-end".
  if (CONCEPT_EXACT_COLLAPSED.has(collapsed)) return true;
  if (CONCEPT_LAST_WORDS.has(lastWordOf(normalized))) return true;
  return CONCEPT_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * What each concept is actually built with.
 *
 * Matched on the normalized name containing the key, so one entry covers the
 * spelling variants the library carries ("Microservices", "Microservice
 * architecture", "Microservices architecture"). Order matters: the first
 * matching entry wins, so the specific keys are listed before the general ones.
 *
 * Every target is validated against the skill library before use - see
 * `mapConceptToConcreteSkills` - so a name that is wrong or that a future
 * library edit removes drops out rather than putting an invented skill on
 * somebody's resume.
 */
const CONCEPT_TO_CONCRETE: Array<{ key: string; concrete: string[] }> = [
  { key: 'infrastructure as code', concrete: ['Terraform', 'Ansible', 'CloudFormation'] },
  { key: 'immutable infrastructure', concrete: ['Terraform', 'Docker'] },
  { key: 'infrastructure automation', concrete: ['Terraform', 'Ansible'] },
  { key: 'configuration management', concrete: ['Ansible', 'Puppet', 'Chef'] },
  { key: 'serverless', concrete: ['AWS Lambda', 'CloudFormation'] },
  { key: 'containeriz', concrete: ['Docker', 'Kubernetes'] },
  { key: 'orchestration', concrete: ['Kubernetes', 'Helm'] },
  { key: 'microservice', concrete: ['Docker', 'Kubernetes', 'gRPC'] },
  { key: 'service mesh', concrete: ['Istio', 'Kubernetes'] },
  { key: 'event-driven', concrete: ['Apache Kafka', 'RabbitMQ'] },
  { key: 'event driven', concrete: ['Apache Kafka', 'RabbitMQ'] },
  { key: 'pub/sub', concrete: ['Apache Kafka', 'RabbitMQ'] },
  { key: 'message queue', concrete: ['RabbitMQ', 'Apache Kafka'] },
  { key: 'distributed system', concrete: ['Kubernetes', 'Apache Kafka'] },
  { key: 'distributed locking', concrete: ['Redis', 'Apache ZooKeeper'] },
  { key: 'caching', concrete: ['Redis', 'Memcached'] },
  { key: 'ci/cd', concrete: ['Jenkins', 'GitHub Actions', 'GitLab CI'] },
  { key: 'cicd', concrete: ['Jenkins', 'GitHub Actions'] },
  { key: 'continuous integration', concrete: ['Jenkins', 'GitHub Actions'] },
  { key: 'continuous delivery', concrete: ['GitHub Actions', 'Jenkins'] },
  { key: 'continuous deployment', concrete: ['GitHub Actions', 'Jenkins'] },
  { key: 'gitops', concrete: ['Kubernetes', 'GitHub Actions'] },
  { key: 'devsecops', concrete: ['GitHub Actions', 'Docker'] },
  { key: 'devops', concrete: ['Docker', 'Jenkins', 'Terraform'] },
  { key: 'mlops', concrete: ['Docker', 'Kubernetes', 'Python'] },
  { key: 'release management', concrete: ['Jenkins', 'GitHub Actions'] },
  { key: 'branching strategy', concrete: ['Git', 'GitHub'] },
  { key: 'trunk-based development', concrete: ['Git', 'GitHub Actions'] },
  { key: 'version control', concrete: ['Git', 'GitHub'] },
  { key: 'agile', concrete: ['Jira'] },
  { key: 'scrum', concrete: ['Jira'] },
  { key: 'kanban', concrete: ['Jira'] },
  { key: 'sprint planning', concrete: ['Jira'] },
  { key: 'test-driven development', concrete: ['Jest', 'pytest'] },
  { key: 'tdd', concrete: ['Jest', 'pytest'] },
  { key: 'behavior-driven development', concrete: ['Cucumber', 'Jest'] },
  { key: 'bdd', concrete: ['Cucumber'] },
  { key: 'test automation', concrete: ['Selenium', 'Playwright', 'Cypress'] },
  { key: 'end-to-end testing', concrete: ['Playwright', 'Cypress'] },
  { key: 'e2e testing', concrete: ['Playwright', 'Cypress'] },
  { key: 'integration testing', concrete: ['pytest', 'Jest'] },
  { key: 'unit testing', concrete: ['Jest', 'pytest', 'JUnit'] },
  { key: 'performance testing', concrete: ['JMeter', 'k6'] },
  { key: 'load testing', concrete: ['JMeter', 'k6'] },
  { key: 'static analysis', concrete: ['ESLint', 'Linting'] },
  { key: 'code quality', concrete: ['ESLint', 'Jest', 'GitHub Actions'] },
  { key: 'api design', concrete: ['OpenAPI', 'Swagger'] },
  { key: 'api development', concrete: ['REST API', 'OpenAPI'] },
  { key: 'api management', concrete: ['Apigee', 'Amazon API Gateway'] },
  { key: 'api gateway', concrete: ['Amazon API Gateway', 'Apigee'] },
  { key: 'restful', concrete: ['REST API', 'OpenAPI'] },
  { key: 'web services', concrete: ['REST API', 'gRPC'] },
  { key: 'observability', concrete: ['Prometheus', 'Grafana', 'OpenTelemetry'] },
  { key: 'monitoring', concrete: ['Prometheus', 'Grafana', 'Datadog'] },
  { key: 'alerting', concrete: ['Prometheus', 'Grafana'] },
  { key: 'logging', concrete: ['Elasticsearch', 'Splunk'] },
  { key: 'site reliability engineering', concrete: ['Prometheus', 'Kubernetes'] },
  { key: 'resilience engineering', concrete: ['Kubernetes', 'Prometheus'] },
  { key: 'chaos engineering', concrete: ['Kubernetes'] },
  { key: 'incident response', concrete: ['PagerDuty', 'Datadog'] },
  { key: 'cloud computing', concrete: ['AWS', 'Azure'] },
  { key: 'cloud platform', concrete: ['AWS', 'Azure'] },
  { key: 'cloud infrastructure', concrete: ['AWS', 'Terraform'] },
  { key: 'cloud architecture', concrete: ['AWS', 'Kubernetes'] },
  { key: 'cloud migration', concrete: ['AWS', 'Terraform'] },
  { key: 'cloud-native', concrete: ['Kubernetes', 'Docker'] },
  { key: 'multi-cloud', concrete: ['Terraform', 'Kubernetes'] },
  { key: 'edge computing', concrete: ['CloudFront', 'Kubernetes'] },
  { key: 'data modeling', concrete: ['PostgreSQL', 'SQL'] },
  { key: 'data modelling', concrete: ['PostgreSQL', 'SQL'] },
  { key: 'database design', concrete: ['PostgreSQL', 'SQL'] },
  { key: 'schema design', concrete: ['PostgreSQL', 'SQL'] },
  { key: 'query optimization', concrete: ['SQL', 'PostgreSQL'] },
  { key: 'index optimization', concrete: ['SQL', 'PostgreSQL'] },
  { key: 'database migration', concrete: ['SQL', 'PostgreSQL'] },
  { key: 'data warehous', concrete: ['Snowflake', 'BigQuery'] },
  { key: 'lakehouse', concrete: ['Databricks', 'Apache Spark'] },
  { key: 'etl', concrete: ['Apache Airflow', 'dbt'] },
  { key: 'elt', concrete: ['dbt', 'Apache Airflow'] },
  { key: 'batch processing', concrete: ['Apache Spark', 'Apache Airflow'] },
  { key: 'stream processing', concrete: ['Apache Kafka', 'Apache Spark'] },
  { key: 'data pipeline', concrete: ['Apache Airflow', 'Apache Spark'] },
  { key: 'data governance', concrete: ['dbt', 'Snowflake'] },
  { key: 'business intelligence', concrete: ['Power BI', 'Tableau'] },
  { key: 'machine learning', concrete: ['TensorFlow', 'PyTorch', 'scikit-learn'] },
  { key: 'deep learning', concrete: ['PyTorch', 'TensorFlow'] },
  { key: 'natural language processing', concrete: ['spaCy', 'PyTorch'] },
  { key: 'computer vision', concrete: ['OpenCV', 'PyTorch'] },
  { key: 'identity and access management', concrete: ['OAuth', 'OIDC'] },
  { key: 'iam', concrete: ['OAuth', 'OIDC'] },
  { key: 'authentication', concrete: ['OAuth', 'JWT'] },
  { key: 'authorization', concrete: ['OAuth', 'OIDC'] },
  { key: 'secrets management', concrete: ['HashiCorp Vault'] },
  { key: 'threat modeling', concrete: ['AWS WAF', 'AWS Inspector'] },
  { key: 'vulnerability', concrete: ['AWS Inspector', 'AWS Security Hub'] },
  { key: 'penetration testing', concrete: ['Wireshark', 'AWS Inspector'] },
  { key: 'encryption', concrete: ['TLS', 'SSL/TLS'] },
  { key: 'load balancing', concrete: ['Nginx', 'Kubernetes'] },
  { key: 'high availability', concrete: ['Kubernetes', 'Nginx'] },
  { key: 'backend development', concrete: ['Node.js', 'Python'] },
  { key: 'frontend development', concrete: ['React', 'TypeScript'] },
  { key: 'full-stack development', concrete: ['React', 'Node.js'] },
  { key: 'full stack development', concrete: ['React', 'Node.js'] },
  { key: 'responsive design', concrete: ['CSS', 'Tailwind CSS'] },
  { key: 'android development', concrete: ['Kotlin', 'Android'] },
  { key: 'ios development', concrete: ['Swift', 'SwiftUI'] },
  { key: 'mobile app architecture', concrete: ['React Native', 'Swift'] },
  // Concepts the widened rules above now catch. Same ordering discipline as the
  // rest of the table: specific keys first, and every target checked against the
  // library before it was written down.
  { key: 'api integration', concrete: ['OpenAPI', 'Postman', 'Swagger'] },
  { key: 'data visualization', concrete: ['Power BI', 'Tableau', 'D3.js'] },
  { key: 'data visualisation', concrete: ['Power BI', 'Tableau', 'D3.js'] },
  { key: 'api security', concrete: ['OAuth 2.0', 'JWT', 'AWS WAF'] },
  { key: 'application security', concrete: ['AWS WAF', 'AWS Inspector', 'AWS Security Hub'] },
  { key: 'network security', concrete: ['Azure Firewall', 'AWS Shield', 'Nginx'] },
  { key: 'owasp', concrete: ['AWS WAF', 'OAuth 2.0', 'JWT'] },
  { key: 'rate limiting', concrete: ['Nginx', 'Redis', 'Envoy'] },
  { key: 'reverse proxy', concrete: ['Nginx', 'HAProxy', 'Traefik'] },
  { key: 'disaster recovery', concrete: ['AWS Backup', 'Terraform'] },
  { key: 'multi-region', concrete: ['Terraform', 'Kubernetes', 'AWS'] },
  { key: 'multi region', concrete: ['Terraform', 'Kubernetes', 'AWS'] },
  { key: 'transactions', concrete: ['PostgreSQL', 'SQL'] },
  { key: 'normaliz', concrete: ['PostgreSQL', 'SQL'] },
  { key: 'normalis', concrete: ['PostgreSQL', 'SQL'] },
  { key: 'indexing', concrete: ['Elasticsearch', 'PostgreSQL'] },
  { key: 'sharding', concrete: ['PostgreSQL', 'Redis'] },
  { key: 'partitioning', concrete: ['PostgreSQL', 'Apache Kafka'] },
  { key: 'serializ', concrete: ['Protobuf', 'Avro'] },
  { key: 'deserializ', concrete: ['Protobuf', 'Avro'] },
  { key: 'encryption', concrete: ['AWS KMS', 'Azure Key Vault', 'Vault'] },
  { key: 'server-side rendering', concrete: ['Next.js', 'React'] },
  { key: 'front-end', concrete: ['React', 'TypeScript', 'Next.js'] },
  { key: 'back-end', concrete: ['Node.js', 'PostgreSQL'] },
  // AI and ML. Most of the obvious targets - Salesforce, SAP, SageMaker,
  // GitHub Copilot, Snyk, SonarQube - are not in the library, so those keys map
  // to nothing on purpose and the term goes to the prose instead.
  { key: 'llmops', concrete: ['LangChain', 'MLflow', 'Docker'] },
  { key: 'llm ops', concrete: ['LangChain', 'MLflow', 'Docker'] },
  { key: 'mlops', concrete: ['MLflow', 'Kubeflow', 'Docker'] },
  { key: 'ml platform', concrete: ['MLflow', 'Kubeflow', 'Databricks'] },
  { key: 'ai framework', concrete: ['PyTorch', 'TensorFlow', 'LangChain'] },
  { key: 'ai model', concrete: ['PyTorch', 'TensorFlow', 'Hugging Face Transformers'] },
  { key: 'artificial intelligence', concrete: ['Python', 'PyTorch', 'TensorFlow'] },
  { key: 'generative ai', concrete: ['LangChain', 'PyTorch', 'Python'] },
  { key: 'siem', concrete: ['Splunk', 'Azure Sentinel', 'Elasticsearch'] },
  // Last, deliberately. The table is searched in order and the first key the
  // concept CONTAINS wins, so these one-word catch-alls have to sit below every
  // phrase that contains them - otherwise "infrastructure as code" would be
  // answered by the generic entry instead of by Terraform and Ansible.
  { key: 'infrastructure', concrete: ['Terraform', 'AWS'] },
  { key: 'automation', concrete: ['Ansible', 'GitHub Actions'] },
];

/**
 * The concrete skills a concept stands for, restricted to ones the library
 * actually carries.
 *
 * The library filter is the safeguard that keeps this table from becoming a
 * source of invented skills: a target that is misspelled, or that a later
 * library edit removes, simply produces nothing.
 */
/**
 * The tools a concept is built with, ungated.
 *
 * `mapConceptToConcreteSkills` filters the same table against the skill
 * library, which was right while the library decided the block. It no longer
 * does - the model writes the block - and the options are sent to the model as
 * a hint, where a library filter would only hide the ones nobody has
 * catalogued yet.
 */
export function conceptToolOptions(concept: string): string[] {
  const normalized = normalize(concept);
  const entry = CONCEPT_TO_CONCRETE.find((candidate) => normalized.includes(candidate.key));
  return entry ? [...entry.concrete] : [];
}

export function mapConceptToConcreteSkills(
  concept: string,
  librarySkills: ReadonlySet<string>
): string[] {
  const normalized = normalize(concept);
  const entry = CONCEPT_TO_CONCRETE.find((candidate) => normalized.includes(candidate.key));
  if (!entry) return [];
  return entry.concrete.filter((skill) => librarySkills.has(normalize(skill)));
}

/**
 * The stack that usually comes with a given skill.
 *
 * Used only to top a short list up, and only outwards from skills that are
 * already on it: a posting that named Python gets Django and pytest, not Elixir
 * and MATLAB. The entries are ecosystems rather than opinions about quality -
 * what someone working with the anchor would plausibly also have touched.
 *
 * Anchors are matched exactly (normalized), not by substring, because a
 * substring rule would make "Java" an anchor for JavaScript's ecosystem.
 */
const RELATED_SKILLS: Record<string, string[]> = {
  python: ['Django', 'Flask', 'FastAPI', 'pytest', 'pandas', 'NumPy', 'Celery'],
  java: ['Spring', 'Spring Boot', 'Maven', 'Gradle', 'JUnit', 'Hibernate', 'Kotlin'],
  kotlin: ['Java', 'Spring Boot', 'Gradle', 'Android'],
  javascript: ['TypeScript', 'React', 'Node.js', 'Express', 'Jest', 'Webpack'],
  typescript: ['React', 'Node.js', 'Express', 'Jest', 'Next.js', 'JavaScript'],
  'node.js': ['Express', 'TypeScript', 'Jest', 'npm', 'NestJS'],
  react: ['TypeScript', 'Redux', 'Next.js', 'Jest', 'React Testing Library', 'Tailwind CSS'],
  angular: ['TypeScript', 'RxJS', 'Jasmine', 'Karma'],
  'vue.js': ['TypeScript', 'Vuex', 'Nuxt.js', 'Vite'],
  'c#': ['.NET', 'ASP.NET Core', 'Entity Framework', 'NUnit', 'Azure'],
  '.net': ['C#', 'ASP.NET Core', 'Entity Framework', 'Azure'],
  go: ['Docker', 'Kubernetes', 'gRPC', 'PostgreSQL'],
  ruby: ['Ruby on Rails', 'RSpec', 'PostgreSQL', 'Sidekiq'],
  php: ['Laravel', 'Symfony', 'MySQL', 'Composer'],
  rust: ['WebAssembly', 'C++', 'Linux'],
  swift: ['SwiftUI', 'Xcode', 'iOS Development'],
  scala: ['Apache Spark', 'Akka', 'Java'],
  django: ['Python', 'PostgreSQL', 'Celery', 'Django REST Framework'],
  flask: ['Python', 'PostgreSQL', 'SQLAlchemy'],
  fastapi: ['Python', 'PostgreSQL', 'Pydantic'],
  'spring boot': ['Java', 'Maven', 'Hibernate', 'PostgreSQL', 'JUnit'],
  spring: ['Java', 'Spring Boot', 'Maven', 'Hibernate'],
  express: ['Node.js', 'TypeScript', 'MongoDB', 'Jest'],
  'ruby on rails': ['Ruby', 'PostgreSQL', 'RSpec', 'Sidekiq'],
  laravel: ['PHP', 'MySQL', 'Composer'],
  aws: ['AWS Lambda', 'Amazon S3', 'Amazon EC2', 'Amazon RDS', 'CloudFormation', 'Terraform'],
  azure: ['Azure DevOps', 'Azure Functions', 'Terraform', 'C#'],
  'google cloud platform': ['BigQuery', 'Terraform', 'Kubernetes'],
  kubernetes: ['Docker', 'Helm', 'Terraform', 'Prometheus', 'Istio'],
  docker: ['Kubernetes', 'Docker Compose', 'Helm'],
  terraform: ['AWS', 'Ansible', 'Kubernetes'],
  ansible: ['Terraform', 'Linux', 'Bash'],
  jenkins: ['Docker', 'Groovy', 'Git'],
  'github actions': ['Docker', 'Git', 'GitHub'],
  postgresql: ['SQL', 'Redis', 'pgAdmin', 'PostGIS'],
  mysql: ['SQL', 'Redis', 'MariaDB'],
  mongodb: ['Node.js', 'Mongoose', 'Redis'],
  redis: ['PostgreSQL', 'Memcached'],
  'sql server': ['SQL', 'T-SQL', 'C#', 'SSIS'],
  sql: ['PostgreSQL', 'MySQL', 'SQL Server'],
  'apache kafka': ['Apache Spark', 'Kubernetes', 'RabbitMQ', 'Zookeeper'],
  'apache spark': ['Python', 'Scala', 'Databricks', 'Apache Airflow'],
  'apache airflow': ['Python', 'Apache Spark', 'dbt'],
  snowflake: ['SQL', 'dbt', 'Apache Airflow'],
  elasticsearch: ['Kibana', 'Logstash'],
  prometheus: ['Grafana', 'Kubernetes', 'OpenTelemetry'],
  grafana: ['Prometheus', 'Loki'],
  datadog: ['Prometheus', 'Grafana'],
  graphql: ['Apollo', 'TypeScript', 'REST API'],
  'rest api': ['OpenAPI', 'Swagger', 'Postman'],
  openapi: ['Swagger', 'REST API', 'Postman'],
  git: ['GitHub', 'GitLab', 'Bitbucket'],
  jest: ['React Testing Library', 'TypeScript'],
  pytest: ['Python', 'Selenium'],
  selenium: ['Playwright', 'Cypress', 'pytest'],
  playwright: ['Cypress', 'Selenium', 'TypeScript'],
  tensorflow: ['Python', 'Keras', 'NumPy', 'PyTorch'],
  pytorch: ['Python', 'NumPy', 'TensorFlow'],
  'power bi': ['SQL', 'Tableau', 'T-SQL'],
  tableau: ['SQL', 'Power BI'],
  'android': ['Kotlin', 'Java', 'React Native'],

  /*
   * The second half of the table, and the reason it exists.
   *
   * The first 61 anchors covered the stacks this app was tested against and
   *4.1% of the skill library, so anything outside them - C, Rust, Elixir,
   * COBOL, Perl, Scala - got no ecosystem walk and the block stopped at three
   * or four skills. Measured across every library skill used as a lone anchor,
   * 1,105 of 1,165 produced fewer than five.
   *
   * Every target below was checked against the library before being written
   * here; names it does not carry (Cargo, npm, Xcode, Kibana) are left out
   * rather than listed and silently dropped.
   */
  c: ['C++', 'Linux', 'Bash', 'CMake'],
  'c++': ['C', 'Linux', 'CMake', 'Qt'],
  elixir: ['Phoenix', 'Erlang', 'PostgreSQL'],
  erlang: ['Elixir', 'Phoenix'],
  phoenix: ['Elixir', 'PostgreSQL'],
  cobol: ['Mainframe', 'SQL', 'Linux'],
  perl: ['Bash', 'Linux', 'Regular Expressions'],
  r: ['Python', 'SQL', 'Tableau'],
  matlab: ['Python', 'NumPy'],
  lua: ['C', 'Redis'],
  groovy: ['Java', 'Gradle', 'Jenkins'],
  dart: ['Flutter', 'Firebase'],
  'objective-c': ['Swift', 'SwiftUI'],
  bash: ['Linux', 'Shell Scripting', 'Ansible'],
  'shell scripting': ['Bash', 'Linux'],
  powershell: ['Windows Server', 'Azure', 'Active Directory'],
  linux: ['Bash', 'Docker', 'Nginx'],
  nginx: ['Linux', 'Docker', 'Kubernetes'],
  webassembly: ['Rust', 'JavaScript'],

  // Frameworks reaching back to their platform, so an anchor deep in a stack
  // still finds the rest of it.
  maven: ['Java', 'Spring Boot', 'JUnit'],
  gradle: ['Java', 'Kotlin', 'Groovy'],
  junit: ['Java', 'Maven', 'Mockito'],
  hibernate: ['Java', 'Spring Boot', 'PostgreSQL'],
  'asp.net core': ['C#', '.NET', 'Entity Framework'],
  'entity framework': ['C#', '.NET', 'SQL Server'],
  nunit: ['C#', '.NET'],
  rspec: ['Ruby', 'Ruby on Rails'],
  sidekiq: ['Ruby on Rails', 'Redis'],
  symfony: ['PHP', 'MySQL'],
  celery: ['Python', 'Redis', 'RabbitMQ'],
  pandas: ['Python', 'NumPy', 'Apache Spark'],
  numpy: ['Python', 'pandas', 'MATLAB'],
  keras: ['TensorFlow', 'Python'],
  nestjs: ['Node.js', 'TypeScript'],
  mongoose: ['MongoDB', 'Node.js'],
  redux: ['React', 'TypeScript'],
  'next.js': ['React', 'TypeScript', 'Vercel'],
  webpack: ['JavaScript', 'Babel'],
  vite: ['TypeScript', 'React'],
  rxjs: ['Angular', 'TypeScript'],
  jasmine: ['Angular', 'Karma'],
  vuex: ['Vue.js', 'TypeScript'],
  'nuxt.js': ['Vue.js', 'TypeScript'],
  swiftui: ['Swift', 'iOS Development'],
  'react native': ['React', 'TypeScript', 'Android'],
  flutter: ['Dart', 'Firebase', 'Android'],

  // Data, infrastructure and the rest of the operational stack.
  mariadb: ['MySQL', 'SQL'],
  cassandra: ['Apache Kafka', 'Java'],
  neo4j: ['Cypher Query Language', 'Java'],
  solr: ['Elasticsearch', 'Java'],
  firebase: ['Flutter', 'Android'],
  databricks: ['Apache Spark', 'Python', 'Snowflake'],
  bigquery: ['SQL', 'Google Cloud Platform'],
  't-sql': ['SQL Server', 'SQL'],
  helm: ['Kubernetes', 'Docker'],
  istio: ['Kubernetes', 'Helm'],
  'docker compose': ['Docker', 'Kubernetes'],
  consul: ['Terraform', 'Kubernetes'],
  etcd: ['Kubernetes'],
  vagrant: ['Terraform', 'Linux'],
  packer: ['Terraform', 'Ansible'],
  rabbitmq: ['Apache Kafka', 'Redis'],
  memcached: ['Redis', 'PostgreSQL'],
  splunk: ['Elasticsearch', 'Grafana'],
  loki: ['Grafana', 'Prometheus'],
  pagerduty: ['Prometheus', 'Datadog'],
  postman: ['REST API', 'OpenAPI'],
  'amazon s3': ['AWS', 'Amazon EC2', 'CloudFront'],
  'amazon ec2': ['AWS', 'Amazon S3', 'Terraform'],
  'amazon rds': ['AWS', 'PostgreSQL'],
  cloudfront: ['AWS', 'Amazon S3'],
  'azure functions': ['Azure', 'C#'],
  'cloud functions': ['Google Cloud Platform', 'Python'],
  wireshark: ['Linux', 'Network Security'],
  grpc: ['Protocol Buffers', 'Kubernetes', 'Go'],
};

/**
 * How many top-ups one category may contribute in the fallback pass.
 *
 * Languages are held lowest on purpose: a resume claiming fifteen programming
 * languages reads as padding, which is precisely what it would be.
 */
function categoryFillLimit(category: HardSkillCategory): number {
  if (category === 'Languages') return 2;
  return 3;
}

function getRelatedSkills(anchor: string, librarySkills: ReadonlySet<string>): string[] {
  const related = RELATED_SKILLS[normalize(anchor)];
  if (!related) return [];
  return related.filter((skill) => librarySkills.has(normalize(skill)));
}

/**
 * The job's concept terms, which the skills block does not list.
 *
 * Wanted by the prompt, not by the renderer. Keeping "Microservices" out of the
 * Technical Skills block is a formatting decision, not a decision to drop the
 * keyword: an ATS reads the whole document, so the term still has to be ON the
 * resume, written into the summary, a bullet or a strength where it reads as
 * something the candidate did rather than as a line in a list. This is the list
 * the tailoring prompt is handed to make sure that happens.
 *
 * Ordered as the job stated them, and deduplicated case-insensitively.
 */
export function extractConceptKeywords(jobSkills: string[]): string[] {
  const seen = new Set<string>();
  const concepts: string[] = [];
  for (const skill of jobSkills) {
    const key = normalize(skill);
    if (!key || seen.has(key) || !isConceptSkill(skill)) continue;
    seen.add(key);
    concepts.push(skill.trim());
  }
  return concepts;
}

/**
 * Where a term the library does not carry sorts, once it is let through.
 *
 * Below every library priority, which run 1-5. It was 3, chosen to put a term
 * the job named outright ahead of most of the library - and that turned out to
 * be the wrong trade. The bottom-weighting cuts both ways: AWS is priority 4,
 * Docker 4, Kubernetes 4, Node.js 5, so "ERP platforms" and "AI copilots"
 * outranked the tools the candidate had actually used. On one measured run
 * sixteen loose phrases took slots 3-18 and pushed AWS, Node.js, PostgreSQL and
 * Docker to the bottom of the block.
 *
 * A term the library has never heard of is the least verified thing on the
 * list, so it sorts last within its band. It still appears - the band is
 * decided by whether the job and the candidate named it, not by this number.
 */
export const UNLISTED_SKILL_PRIORITY = 6;

/** Last words that make a phrase a job title rather than a technology. */
const ROLE_LAST_WORDS = new Set([
  'developer', 'engineer', 'manager', 'architect', 'analyst', 'designer',
  'lead', 'specialist', 'consultant', 'administrator', 'scientist', 'intern',
  'director', 'officer', 'programmer', 'technician', 'contributor',
]);

/** Bare nouns that name a heading rather than a skill. */
const GENERIC_TERMS = new Set(
  [
    'experience', 'tools', 'technologies', 'technology', 'software', 'platform',
    'platforms', 'frameworks', 'languages', 'language', 'skills', 'stack',
    'tooling', 'libraries', 'other', 'various', 'etc', 'knowledge', 'expertise',
    'proficiency', 'familiarity', 'requirements', 'qualifications',
  ].map(normalize)
);

/**
 * Whether a term the library has never heard of may go on the resume anyway.
 *
 * The library is 1,492 entries and the industry is bigger than that: a posting
 * naming Temporal, Supabase or LaunchDarkly used to have those terms silently
 * dropped, including when the candidate's own roles named them too. Requiring a
 * library entry made the library a vocabulary ceiling rather than a spelling
 * aid.
 *
 * So this is a shape test, not a knowledge test - it cannot tell a real tool
 * from a plausible-looking one, and does not try. What keeps it honest is where
 * the terms come from: only the job description and the candidate's own claims
 * feed it. Nothing here is invented, and what comes through is reported back as
 * an unconfirmed skill so it can be added to the library properly.
 */
export function looksLikeUnlistedHardSkill(term: string): boolean {
  const trimmed = term.trim();
  if (!trimmed || trimmed.length > 40) return false;
  if (!/[a-z]/i.test(trimmed)) return false;
  // Sentence punctuation means a clause was captured, not a name.
  if (/[.!?;:,]/.test(trimmed)) return false;

  const words = trimmed.split(/\s+/);
  if (words.length > 4) return false;

  // A conjunction joins two things; a product is one thing. "SLA and SLO
  // definition" is a sentence fragment describing work. The only library
  // entries with one are "Backup and Recovery" and "Identity and Access
  // Management", both of which are in the library and so never reach here.
  if (/\s(and|or)\s/i.test(trimmed)) return false;

  // A role, not a tool. Same last-word test the concept rules use, and for the
  // same reason: "Full Stack Developer" is a job title however it is capitalised.
  if (ROLE_LAST_WORDS.has(lastWordOf(normalize(trimmed)))) return false;

  // Prose gives itself away by staying lower case. A product name carries a
  // capital or a digit somewhere - "dbt" and "npm" are single words and pass on
  // the clause below - while "query optimization" does not.
  if (words.length > 1 && !/[A-Z0-9]/.test(trimmed)) return false;

  // Past two words, ONE capital is no longer evidence of a name: an acronym
  // supplies it and the rest of the phrase is free to be prose. That is exactly
  // how "AI coding tool usage", "SQL query writing" and "SLA and SLO
  // definition" got through - AI, SQL and SLA did the work. A real three-word
  // product capitalises all of it ("Amazon Web Services", "Azure Container
  // Apps"), bar the small connecting words.
  if (words.length >= 3 && !words.every((word) => CONNECTORS.has(word.toLowerCase()) || /^[A-Z0-9(]/.test(word))) {
    return false;
  }

  if (isConceptSkill(trimmed)) return false;
  return !GENERIC_TERMS.has(normalize(trimmed));
}

/**
 * The word boundaries inside a camel-cased token.
 *
 * The standard pair of rules: a lower-case letter or digit followed by a
 * capital ("DataFactory" -> Data | Factory), and a run of capitals followed by
 * a capitalised word ("APISecurity" -> API | Security).
 */
function camelTokens(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1\u0000$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1\u0000$2')
    .split('\u0000');
}

type SplitCandidate = {
  /** The term's words after splitting, in order. */
  pieces: string[];
  /** Indices in `pieces` that a NEW boundary was opened in front of. */
  introduced: number[];
};

/**
 * Every way of joining or splitting each word's camel tokens, fewest splits first.
 *
 * Which boundaries are new is recorded here rather than worked out afterwards
 * by looking for the phrase in the original string: the pieces are joined with
 * spaces the original does not have, so that comparison reported boundaries as
 * introduced when they had been plain whitespace all along.
 */
function splitCombinations(tokenised: string[][], atomic: boolean[] = []): SplitCandidate[] {
  let results: SplitCandidate[] = [{ pieces: [], introduced: [] }];

  for (const [index, tokens] of tokenised.entries()) {
    const joins: SplitCandidate[] = [];
    // A word that is a name in its own right is never taken apart, so only the
    // fully-joined form is offered for it.
    const masks = atomic[index] ? 1 : 2 ** (tokens.length - 1);
    // A bitmask over the gaps between one word's tokens: bit set means split.
    for (let mask = 0; mask < masks; mask += 1) {
      const pieces: string[] = [tokens[0] ?? ''];
      const introduced: number[] = [];
      for (let gap = 0; gap < tokens.length - 1; gap += 1) {
        if (mask & (1 << gap)) {
          introduced.push(pieces.length);
          pieces.push(tokens[gap + 1] ?? '');
        } else {
          pieces[pieces.length - 1] += tokens[gap + 1] ?? '';
        }
      }
      joins.push({ pieces, introduced });
    }

    results = results.flatMap((prefix) =>
      joins.map((join) => ({
        pieces: [...prefix.pieces, ...join.pieces],
        introduced: [
          ...prefix.introduced,
          ...join.introduced.map((index) => index + prefix.pieces.length),
        ],
      }))
    );
  }

  return results.sort((a, b) => a.introduced.length - b.introduced.length);
}

/** How many camel boundaries a repair attempt will consider before giving up. */
const MAX_GLUE_BOUNDARIES = 4;

/**
 * Vocabulary for judging a split: which terms vouch for each leading phrase.
 *
 * A phrase vouched for by a term OTHER than the one being repaired is evidence
 * that the phrase is a real name. "UiPath Integration Service" vouches for
 * "UiPath", which is what lets "UiPathAction Center" be split correctly while
 * "UiPath Integration Service" itself is left alone - nothing vouches for "Ui".
 */
export function buildSpellingVocabulary(terms: string[]): Map<string, Set<string>> {
  const vocabulary = new Map<string, Set<string>>();
  for (const term of terms) {
    const self = normalize(term);
    const words = term.trim().split(/\s+/);
    for (let length = 1; length <= words.length; length += 1) {
      const prefix = normalize(words.slice(0, length).join(' '));
      if (!prefix) continue;
      if (!vocabulary.has(prefix)) vocabulary.set(prefix, new Set());
      (vocabulary.get(prefix) as Set<string>).add(self);
    }
  }
  return vocabulary;
}

/**
 * Puts back a space that the PDF text extractor dropped.
 *
 * Job descriptions fetched as PDFs go through `pdf-parse`, which loses the
 * space between two text runs often enough to be a standing problem: "Code
 * Quality Gates" arrives as "CodeQuality Gates", "Application Security" as
 * "ApplicationSecurity", "Azure Data Factory" as "Azure DataFactory". The shape
 * test below then REWARDS the damage - losing a space cuts the word count and
 * leaves every remaining word capitalised, so the glued form passes rules the
 * correct spelling would have to argue for - and the resume ends up carrying
 * both spellings as two separate skills.
 *
 * Repair only, never rejection. Plenty of real names are camel-cased on purpose
 * - UiPath, LogStream, FortiProxy, NetScaler, BigQuery, JavaScript - so a rule
 * that dropped anything with an internal capital would do far more damage than
 * the bug. A split has to be vouched for before it is made:
 *
 *   1. the split lands exactly on a library entry, or
 *   2. another term in the same batch vouches for the name to the left of it.
 *
 * Returns the repaired spelling, or null to leave the term alone.
 */
export function repairGluedSkillName(
  term: string,
  librarySkills: ReadonlySet<string>,
  canonicalOf: ReadonlyMap<string, string>,
  vocabulary: ReadonlyMap<string, ReadonlySet<string>>
): string | null {
  const words = term.trim().split(/\s+/);
  if (!words.length) return null;

  const self = normalize(term);
  const tokenised = words.map(camelTokens);
  const boundaries = tokenised.reduce((total, tokens) => total + tokens.length - 1, 0);
  if (boundaries === 0 || boundaries > MAX_GLUE_BOUNDARIES) return null;

  const vouched = (phrase: string): boolean => {
    const sources = vocabulary.get(phrase);
    return sources ? [...sources].some((source) => source !== self) : false;
  };

  /*
   * A word that is already a name is never split, however camel-cased it is.
   *
   * Without this the boundary evidence below reads the wrong way round:
   * "JavaScript" splits at Java|Script because "Java" is a library entry that
   * vouches for the left side, and the resume gets "Java Script". "GoLang" goes
   * the same way on "Go". The name being whole is much stronger evidence than
   * one of its halves being a name elsewhere.
   */
  const atomic = words.map((word) => {
    const key = normalize(word);
    return librarySkills.has(key) || vouched(key);
  });

  const combinations = splitCombinations(tokenised, atomic).filter(
    (candidate) => candidate.introduced.length > 0
  );

  // 1. A library entry is the strongest evidence there is, and its spelling is
  //    the one that gets printed - which also merges the repaired term with the
  //    entry it was duplicating.
  for (const { pieces } of combinations) {
    const key = normalize(pieces.join(' '));
    if (key !== self && librarySkills.has(key)) return canonicalOf.get(key) ?? pieces.join(' ');
  }

  // 2. Otherwise every boundary this split OPENS has to be vouched for by the
  //    phrase that ends at it. Anchoring on the new boundary rather than on any
  //    prefix of the result is what leaves a legitimately camel-cased word
  //    alone: splitting "UiPath Integration Service" would have to find
  //    evidence for "Ui", and there is none.
  for (const { pieces, introduced } of combinations) {
    const vouchedAt = introduced.every((index) => {
      const phrase = normalize(pieces.slice(0, index).join(' '));
      return librarySkills.has(phrase) || vouched(phrase);
    });
    if (vouchedAt) return pieces.join(' ');
  }

  return null;
}

/**
 * Vendors whose name in front of a product is a label, not a different product.
 *
 * Kept to names that brand something rather than name it, which is why "Ant",
 * "Spring" and "Apache" style prefixes that are PART of the product name are
 * not all here - the collapse below also requires the remainder to be a library
 * entry, so a wrong guess produces nothing rather than a wrong skill.
 */
const VENDOR_WORDS = new Set([
  'chrome', 'google', 'microsoft', 'ms', 'azure', 'aws', 'amazon', 'apache',
  'oracle', 'ibm', 'adobe', 'atlassian', 'jetbrains', 'meta', 'facebook',
  'cisco', 'vmware', 'citrix', 'fortinet', 'salesforce', 'elastic',
  'hashicorp', 'grafana', 'confluent', 'databricks', 'cloudflare', 'redhat',
  'intel', 'nvidia', 'alibaba', 'netflix', 'linkedin', 'github', 'gitlab',
  'mozilla', 'firefox', 'sap', 'sun', 'linux', 'open',
]);

/**
 * Whether a term is a library entry wearing a vendor's name in front.
 *
 * "Chrome Lighthouse" and "Lighthouse" are one tool, and the resume was listing
 * both, because identity is the normalized name and those are two of them.
 * `isRedundantWithLibraryTerm` deliberately does not fire here - it only
 * collapses when the extra words are LOWER case, which is what protects
 * "Grafana Loki" and "Temporal Cloud" - so the vendor list does the work
 * instead, and the library's own spelling is what gets printed.
 *
 * Returns the library spelling to fold into, or null.
 */
export function collapseVendorPrefix(
  term: string,
  librarySkills: ReadonlySet<string>,
  canonicalOf: ReadonlyMap<string, string>
): string | null {
  const words = term.trim().split(/\s+/);
  if (words.length < 2) return null;

  for (let start = 1; start < words.length; start += 1) {
    if (!VENDOR_WORDS.has((words[start - 1] ?? '').toLowerCase())) break;
    const remainder = words.slice(start).join(' ');
    const key = normalize(remainder);
    // Two characters of remainder is not a product, it is an abbreviation left
    // over from a bad split.
    if (key.length >= 4 && librarySkills.has(key)) return canonicalOf.get(key) ?? remainder;
  }

  return null;
}

/**
 * Nouns that, tacked onto a name already on the list, make the same thing again.
 *
 * A posting that says "Open Storefront" in one line and "Open Storefront
 * Framework" in the next was putting both on the resume, since neither is in
 * the library and the two spellings are two different keys. Kept deliberately
 * short and generic: "Code" is not here, so "Visual Studio" and "Visual Studio
 * Code" stay two products, which is what they are.
 */
const GENERIC_SUFFIX_WORDS = new Set([
  'framework', 'frameworks', 'platform', 'platforms', 'service', 'services',
  'tool', 'tools', 'suite', 'software', 'system', 'systems', 'solution',
]);

/**
 * The shorter spelling `term` makes redundant, if there is one on the list.
 *
 * Given "Open Storefront Framework" while "Open Storefront" is also admitted,
 * returns the latter, which is then dropped: the longer form is the more
 * specific of the two and is the one worth printing.
 *
 * Only ever consulted for terms the library does not carry - a library entry
 * has already been judged.
 */
export function genericSuffixStem(
  term: string,
  admittedKeys: ReadonlySet<string>
): string | null {
  const words = term.trim().split(/\s+/);
  if (words.length < 2) return null;

  for (let drop = 1; drop < words.length; drop += 1) {
    const tail = words.slice(words.length - drop);
    if (!tail.every((word) => GENERIC_SUFFIX_WORDS.has(word.toLowerCase()))) break;
    const stem = normalize(words.slice(0, words.length - drop).join(' '));
    if (stem && admittedKeys.has(stem)) return stem;
  }

  return null;
}

/** Words a product name may leave lower case: "Ruby on Rails", "Weights & Biases". */
const CONNECTORS = new Set(['of', 'for', 'on', 'in', 'at', 'to', 'the', 'a', 'an', 'with', '&', '+']);

/**
 * Whether a phrase is just a skill already on the list with activity words on it.
 *
 * "SQL query writing" and "SQL performance reasoning" both reduce to SQL, which
 * the library already carries and the selection has already chosen; listing
 * them as well says nothing new and reads as padding. Same for "versioned
 * APIs", which reduces to APIs.
 *
 * The extra words have to be lower case for this to fire, which is what keeps
 * it from eating real products built on a known name: "Grafana Loki" and
 * "Temporal Cloud" carry a second capitalised word and are left alone.
 */
export function isRedundantWithLibraryTerm(
  term: string,
  librarySkills: ReadonlySet<string>
): boolean {
  const words = term.trim().split(/\s+/);
  if (words.length < 2) return false;

  for (let length = words.length - 1; length >= 1; length -= 1) {
    for (let start = 0; start + length <= words.length; start += 1) {
      const candidate = normalize(words.slice(start, start + length).join(' '));
      if (!librarySkills.has(candidate)) continue;
      const rest = [...words.slice(0, start), ...words.slice(start + length)];
      if (rest.length > 0 && rest.every((word) => !/[A-Z0-9]/.test(word))) return true;
    }
  }

  return false;
}

export type HardSkillSelectionInput = {
  /** Library skills found in the job description. */
  jobSkills: string[];
  /** Library skills found in the candidate's own roles, and any they listed. */
  experienceSkills: string[];
  /** The skill library, for categories, priorities and spelling. */
  library: HardSkillRecord[];
  /**
   * Terms the library does not carry, split by where they came from.
   *
   * Kept apart because the bands below care: a technology the posting asked for
   * outranks one only the candidate claims, exactly as it does for terms the
   * library does know. They take no part in the top-up, which needs the
   * categories and ecosystems the library is the only source of.
   */
  unlistedJobSkills?: string[];
  unlistedExperienceSkills?: string[];
  /**
   * The job's concept terms, for their TOOLS - never for themselves.
   *
   * Concepts already reach the ranking when the library happens to carry them,
   * because the job's library matches are scanned for them. Most are not in the
   * library, and those were lost: a posting written entirely in abilities -
   * "full-stack engineering, network operations, distributed computing" - named
   * no library term, so nothing anchored the selection and the block came out
   * EMPTY. Reading the analysis's own concepts gives that posting something to
   * translate, and a tool implied by what the job asks for is a far better
   * answer than a tool picked off the top of the library.
   *
   * They are mapped through `CONCEPT_TO_CONCRETE` like any other concept, so
   * what is placed is Docker and Kafka, never "Distributed computing".
   */
  jobConceptSkills?: string[];
  /**
   * The name a skill is finally printed under, if the caller renames any.
   *
   * Needed because the caller does rename them: "React" is printed as
   * "React.js", "Azure" as "Microsoft Azure", "Express" as "Express.js". That
   * used to happen AFTER this function had counted to twenty, and the dedupe
   * that came with it then collapsed pairs the count had treated as two - so a
   * block selected at twenty was printed at fifteen, and the top-up had already
   * finished and could not make up the difference.
   *
   * Applied here instead, so the target counts the skills a reader will
   * actually see. Defaults to identity, which is what every caller that does no
   * renaming wants.
   */
  canonicalize?: (skill: string) => string;
  target?: number;
  max?: number;
};

type Ranked = { skill: string; rank: number };

/**
 * Builds the Technical Skills list.
 *
 * Ranked in bands rather than sorted, because the bands are the decision and a
 * single comparator would blur them:
 *
 *   0. asked for by the job AND evidenced by the candidate's roles
 *   1. asked for by the job
 *   2. the FIRST tool each of the job's concepts is built with
 *   3. evidenced by the candidate's roles
 *   4. the job's concepts' remaining tools
 *   5. the first tool each of the candidate's own concepts is built with
 *   6. those concepts' remaining tools
 *   7. a top-up, from the categories the job is already asking about
 *
 * The split between a concept's first tool and its rest is what keeps one
 * concept from crowding out the others: a posting naming five concepts is
 * represented by five tools before any concept is allowed a second one, so
 * "test automation" cannot spend three of the twenty slots on Selenium,
 * Playwright and Cypress while infrastructure as code goes unrepresented.
 *
 * Within a band the skill library's own priority decides. Concepts never enter
 * any band; they are read only to be translated.
 */
export function selectHardSkills({
  jobSkills,
  experienceSkills,
  library,
  unlistedJobSkills = [],
  unlistedExperienceSkills = [],
  jobConceptSkills = [],
  canonicalize = (skill) => skill,
  target = TARGET_HARD_SKILLS,
  max = MAX_HARD_SKILLS,
}: HardSkillSelectionInput): string[] {
  const librarySkills = new Set(library.map((record) => normalize(record.skill)));
  const priorityOf = new Map(library.map((record) => [normalize(record.skill), record.priority]));
  const categoryOf = new Map(library.map((record) => [normalize(record.skill), record.category]));
  const canonicalOf = new Map(library.map((record) => [normalize(record.skill), record.skill]));

  // Built from every term in play, before anything is admitted, so one term can
  // vouch for the spelling of another.
  const vocabulary = buildSpellingVocabulary([
    ...jobSkills,
    ...experienceSkills,
    ...unlistedJobSkills,
    ...unlistedExperienceSkills,
  ]);

  /**
   * The spelling a term should be carried under: a space put back where the PDF
   * extractor dropped one, a vendor prefix folded into the entry it duplicated,
   * or the term unchanged.
   */
  const resolveSpelling = (skill: string): string =>
    repairGluedSkillName(skill, librarySkills, canonicalOf, vocabulary)
    ?? collapseVendorPrefix(skill, librarySkills, canonicalOf)
    ?? skill;

  // Spelled as the job or the candidate spelled it, since there is no library
  // entry to take a canonical form from. First spelling wins, so one term
  // written two ways does not become two skills.
  const allowed = new Set<string>();
  const pendingUnlisted: string[] = [];
  const admit = (skills: string[]): string[] => {
    const kept: string[] = [];
    for (const original of skills) {
      const skill = resolveSpelling(original);
      const key = normalize(skill);
      if (!key) continue;
      // Repairing or collapsing can land on a library entry, and then the term
      // is not unlisted any more - it goes through as the library's own row,
      // which is also what merges it with the row it was duplicating.
      if (librarySkills.has(key)) {
        kept.push(skill);
        continue;
      }
      if (!allowed.has(key)) {
        if (!looksLikeUnlistedHardSkill(skill)) continue;
        if (isRedundantWithLibraryTerm(skill, librarySkills)) continue;
        allowed.add(key);
        pendingUnlisted.push(key);
        canonicalOf.set(key, skill.trim());
        priorityOf.set(key, UNLISTED_SKILL_PRIORITY);
      }
      kept.push(skill);
    }
    return kept;
  };

  // Merged into the bands rather than handled beside them, so an unlisted term
  // is ranked by the same rules as everything else and needs no special case
  // further down.
  jobSkills = [...jobSkills, ...admit(unlistedJobSkills)];
  experienceSkills = [...experienceSkills, ...admit(unlistedExperienceSkills)];

  /*
   * Drop the shorter of two admitted spellings of one thing.
   *
   * Done after both calls rather than inside `admit`, because the two spellings
   * routinely arrive in different batches and in either order - the stem can be
   * admitted before the suffixed form or after it, and the rule has to reach the
   * same answer both ways.
   */
  for (const key of pendingUnlisted) {
    const stem = genericSuffixStem(key, allowed);
    if (stem) allowed.delete(stem);
  }

  const jobSet = new Set(jobSkills.map(normalize));
  const experienceSet = new Set(experienceSkills.map(normalize));

  const ranked = new Map<string, Ranked>();
  const place = (skill: string, rank: number) => {
    const raw = normalize(skill);
    if (!raw || !(librarySkills.has(raw) || allowed.has(raw))) return;
    // Three different questions, deliberately kept apart.
    //
    // Membership is judged on the name as given, because that is what the
    // library and the allow-list hold. The name PRINTED is the library's own
    // spelling, which is the one thing in this system that is curated. Identity
    // is judged on the canonical form, so two library rows that mean one thing -
    // "React" and "React.js" - take one slot between them instead of two.
    //
    // Folding the printed name into the canonical one as well was the first
    // attempt and it was wrong: it renamed React to React.js on every resume,
    // for no reason beyond an alias table that exists to recognise input.
    const display = canonicalOf.get(raw) ?? skill;
    const key = normalize(canonicalize(display));
    if (!key) return;
    const existing = ranked.get(key);
    if (existing && existing.rank <= rank) return;
    ranked.set(key, { skill: display, rank });
  };

  const jobConcrete = jobSkills.filter((skill) => !isConceptSkill(skill));
  const jobConcepts = jobSkills.filter((skill) => isConceptSkill(skill));
  const experienceConcrete = experienceSkills.filter((skill) => !isConceptSkill(skill));
  const experienceConcepts = experienceSkills.filter((skill) => isConceptSkill(skill));

  const placeMapped = (concepts: string[], firstRank: number, restRank: number) => {
    for (const concept of concepts) {
      const mapped = mapConceptToConcreteSkills(concept, librarySkills);
      mapped.forEach((skill, index) => place(skill, index === 0 ? firstRank : restRank));
    }
  };

  for (const skill of jobConcrete) {
    place(skill, experienceSet.has(normalize(skill)) ? 0 : 1);
  }
  placeMapped(jobConcepts, 2, 4);
  // The analysis's own concepts, which the library may never have heard of.
  // Ranked below the library's, whose spelling and standing are known.
  placeMapped(jobConceptSkills.filter(isConceptSkill), 4, 4);
  for (const skill of experienceConcrete) {
    place(skill, jobSet.has(normalize(skill)) ? 0 : 3);
  }
  placeMapped(experienceConcepts, 5, 6);

  // Top-up, in two passes.
  //
  // The first pass fills from the ecosystems of the skills already chosen: a
  // Python role is filled out with Django and pytest, a Java one with Spring and
  // Maven. Weighting by CATEGORY alone was tried first and is what a naive
  // reading of "add relevant skills" produces - it answered a one-line Python
  // posting with every language in the library, because one Python match made
  // Languages the heaviest category. Relatedness has to be to the skills, not to
  // the bucket they happen to sit in.
  //
  // The second pass is the fallback for an anchor with no ecosystem listed. It
  // is category-weighted like the original, but capped per category, so the
  // worst case is a few plausible neighbours rather than a wall of one kind.
  // Walked outwards a hop at a time rather than once, so a single anchor can
  // still fill a block: Python reaches Django, Django reaches PostgreSQL,
  // PostgreSQL reaches Redis. Each hop is ordered by how many skills already on
  // the list vouch for the candidate, so the list thickens around what the job
  // and the candidate actually have in common instead of wandering.
  while (ranked.size < target) {
    const vouches = new Map<string, number>();
    for (const { skill } of ranked.values()) {
      for (const related of getRelatedSkills(skill, librarySkills)) {
        const key = normalize(related);
        if (ranked.has(key) || isConceptSkill(key)) continue;
        vouches.set(key, (vouches.get(key) ?? 0) + 1);
      }
    }
    if (vouches.size === 0) break;

    const hop = [...vouches.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const priorityA = priorityOf.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
      const priorityB = priorityOf.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
      if (priorityA !== priorityB) return priorityA - priorityB;
      return a[0].localeCompare(b[0]);
    });

    const before = ranked.size;
    for (const [key] of hop) {
      if (ranked.size >= target) break;
      place(canonicalOf.get(key) ?? key, 7);
    }
    if (ranked.size === before) break;
  }

  if (ranked.size < target) {
    const weight = new Map<HardSkillCategory, number>();
    for (const { skill } of ranked.values()) {
      const category = categoryOf.get(normalize(skill));
      if (category) weight.set(category, (weight.get(category) ?? 0) + 1);
    }

    /*
     * Widening rounds, rather than one capped pass.
     *
     * The capped pass it replaces stopped after four skills and only ever
     * looked at categories the selection had already reached. Both limits were
     * there to stop the fill padding a one-line Python posting with every
     * language in the library - and both went too far:
     *
     *   - four was a ceiling on the whole pass, so a COBOL posting that had
     *     found one anchor stopped at five skills and stayed there;
     *   - requiring an existing category meant a posting that named no tools at
     *     all had no category to start from, and produced an EMPTY block.
     *
     * What actually prevented the padding was the per-category limit, and that
     * is kept. Each round raises it by one and the rounds work outwards: the
     * categories this job is already about first, then the rest of the library.
     * So the fill stays proportional - a few from each of many categories
     * rather than fifteen languages - while still being able to reach the
     * target when the job is one this app's ecosystem map has never heard of.
     */
    const byRelevance = (a: HardSkillRecord, b: HardSkillRecord): number => {
      const byCategory = (weight.get(b.category) ?? 0) - (weight.get(a.category) ?? 0);
      if (byCategory !== 0) return byCategory;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.skill.localeCompare(b.skill, undefined, { sensitivity: 'base' });
    };

    const pool = library
      .filter((record) => !isConceptSkill(record.skill))
      .sort(byRelevance);

    const addedPerCategory = new Map<HardSkillCategory, number>();
    // Bounded by the rounds, not by a while(true): the widest round allows
    // every category its whole contents, so nothing here can spin.
    for (let round = 1; round <= MAX_FILL_ROUNDS && ranked.size < target; round += 1) {
      // `related` first, so the widening only reaches unrelated categories once
      // the job's own have given what they reasonably can.
      for (const related of [true, false]) {
        for (const record of pool) {
          if (ranked.size >= target) break;
          if (related !== weight.has(record.category)) continue;
          if (ranked.has(normalize(canonicalize(record.skill)))) continue;
          const used = addedPerCategory.get(record.category) ?? 0;
          if (used >= categoryFillLimit(record.category) * round) continue;
          const before = ranked.size;
          place(record.skill, 7);
          if (ranked.size > before) addedPerCategory.set(record.category, used + 1);
        }
      }
    }
  }

  return [...ranked.values()]
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const priorityA = priorityOf.get(normalize(a.skill)) ?? Number.MAX_SAFE_INTEGER;
      const priorityB = priorityOf.get(normalize(b.skill)) ?? Number.MAX_SAFE_INTEGER;
      if (priorityA !== priorityB) return priorityA - priorityB;
      return a.skill.localeCompare(b.skill, undefined, { sensitivity: 'base' });
    })
    .slice(0, max)
    .map((entry) => entry.skill);
}
