/** Stored config for manual templates; enables edit. Matches ManualTemplateConfig shape. */
export interface ManualTemplateConfigStored {
  name: string;
  description?: string;
  columns: 1 | 2;
  accentColor?: string;
  bodyColor?: string;
  bodyFontSizePt?: number;
  titleFontSizePt?: number;
  sectionOrder?: string[];
  leftSectionOrder?: string[];
  rightSectionOrder?: string[];
  nameStyle?: Record<string, unknown>;
  headerTitleStyle?: Record<string, unknown>;
  contactStyle?: Record<string, unknown>;
  sectionStyles?: Record<string, Record<string, Record<string, unknown>>>;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  disabled?: boolean;
  htmlContent: string;
  cssContent: string;
  sections: string[];
  createdAt: string;
  updatedAt: string;
  /** Stored config for manual templates; enables edit */
  manualConfig?: ManualTemplateConfigStored;
  /** True for templates shipped as static files; their HTML cannot be edited or deleted */
  isBuiltIn?: boolean;
}

export interface CreateTemplateDTO {
  name: string;
  description?: string;
}

export interface JobAnalysis {
  jobMeta: {
    title: string;
    seniority: string;
    industry: string;
    department: string;
  };
  skills: {
    technical: string[];
    required: string[];
    preferred: string[];
    tools: string[];
    soft: string[];
    technologies: string[];
  };
  technologies: string[];
  protocols: string[];
  methodologies: string[];
  architecturePatterns: string[];
  responsibilities: string[];
  domainKnowledge: string[];
  softSkills: string[];
  keywords: {
    actionVerbs: string[];
    buzzwords: string[];
    mustInclude: string[];
  };
  sourceJobDescription?: string;
}

/**
 * The AI providers this app can run a completion on.
 *
 * `claude-cli` drives the locally installed `claude` binary against the
 * operator's Claude subscription seat; `claude` is the metered Anthropic HTTP
 * API. They are deliberately separate ids: conflating a keyless seat with a
 * billed API key is exactly the invisible-spend failure this app avoids.
 *
 * The former `openrouter` id was replaced by `claude-cli`; stored records that
 * still carry it are coerced by `coerceProviderId` in config/providerCatalog.
 */
export type AIProvider =
  | 'claude-cli'
  | 'claude'
  | 'openai'
  | 'deepseek'
  | 'claude-web'
  | 'chatgpt-web';

export type RawNestedJobAnalysis = Partial<JobAnalysis> & {
  jobMeta?: {
    title?: unknown;
    seniority?: unknown;
    industry?: unknown;
    department?: unknown;
  };
  skills?: {
    technical?: unknown;
    required?: unknown;
    preferred?: unknown;
    tools?: unknown;
    soft?: unknown;
    technologies?: unknown;
  };
  technologies?: unknown;
  protocols?: unknown;
  methodologies?: unknown;
  architecturePatterns?: unknown;
  responsibilities?: unknown;
  domainKnowledge?: unknown;
  softSkills?: unknown;
  keywords?: {
    actionVerbs?: unknown,
    buzzwords?: unknown,
    mustInclude?: unknown
  }
};

/** One heading of the Technical Skills block, as the model grouped it. */
export interface TailoredSkillGroup {
  category: string;
  skills: string[];
}

export interface TailoredContent {
  title: string;
  /**
   * The skills block, grouped, exactly as the model returned it.
   *
   * Printed verbatim: no library matching, no reordering, no padding to a
   * category count, no validation gate. The skill library is no longer
   * consulted for what appears on a resume - it was adding its own rows
   * ("Echo", "Logs", "Amazon Kinesis" beside "Kinesis") to every block it
   * touched - so the rules that used to be enforced in code are stated in the
   * prompt instead, and what comes back is what gets printed.
   */
  skillGroups?: TailoredSkillGroup[];
  summary: string;
  experience: TailoredExperience[];
  skills: string[];
  hardSkills: string[];
  softSkills: string[];
  unconfirmedSoftSkills: string[];
  unconfirmedHardSkills: string[];
  // Optional fields from job analysis merged into tailored content
  requiredSkills?: string[];
  preferredSkills?: string[];
  strengths: TailoredStrength[];
  /** Cover letter body content without the greeting or sign-off */
  coverLetter?: string;
}

export interface TailoredExperience {
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  location: string;
  description: string;
  achievements: string[];
}

export interface TailoredStrength {
  title: string;
  description: string;
}

export type ResumeFormat = 'pdf' | 'docx' | 'both';

export interface GenerateResumeRequest {
  profileId: string;
  templateId: string;
  jobDescription?: string;
  jobAnalysis?: JobAnalysis;
  tailoredContent?: TailoredContent;
  /** An AI model record id; overrides the profile's own for this run. */
  model?: string;
  /** Overrides the profile's effort for this run. */
  effort?: string;
  /** Overrides the profile's thinking mode for this run. */
  thinking?: string;
  companyName: string;
  role: string;
  sourceRowNumber?: number;
  format?: ResumeFormat;
  includeCoverLetterDocx?: boolean;
}
