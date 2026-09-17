import { Router, Request, Response } from 'express';
import path from 'path';
import {
  analyzeJobDescription,
  analyzeJobDescriptionPromptRaw,
  generateCoverLetter,
  parseTailoredResumeContent,
  tailorResume,
} from '../services/resumeService';
import { generateResumePDF, generatePreviewHTML, getGeneratedPDFPath } from '../generators/pdfGenerator';
import { generateResumeDOCX } from '../generators/docxGenerator';
import { saveCoverLetter, saveCoverLetterDOCX } from '../generators/coverLetterGenerator';
import { getGeneratedOutputPath } from '../utils/generatedPath';
import { getTemplateById } from '../extractors/templateExtractor';
import { getPublicAppSettings } from '../config/aiModelConfig';
import {
  normalizeAiPreferences,
  resolveAiChoice,
  type AiChoice,
  type AiPreferences,
} from '../config/aiPreferences';
import { mapWithConcurrency, resolveBatchCapacity } from '../services/ai';
import { withUnitRetry } from '../services/ai/retry';
import {
  advanceBatch,
  finishBatch,
  setBatchPhase,
  startBatch,
  watchBatch,
} from '../services/batchProgress';
import { describeFailure, sendAiError } from '../middleware/aiErrors';
import { confirmSkill, createSkill, deleteSkillHandler, listSkills, updateSkillHandler } from '../controllers/skills';
import { Profile } from '../types/profile';
import { getProfile, listProfiles } from '../database/profileRepository';
import { DEFAULT_ANALYZE_JOB_PROMPT_ID } from '../services/profileService';
import { AIProvider, GenerateResumeRequest, JobAnalysis, TailoredContent, Template } from '../types/template';

const router = Router();

/**
 * A signal that fires when the client goes away before the response is sent.
 *
 * Threaded down to the AI transport so a user who closes the tab mid-batch
 * kills the model calls (and, on the CLI provider, the child processes) rather
 * than leaving them to run out the clock against the subscription seat.
 *
 * Keyed on `res` rather than `req`: `req` emits 'close' on normal completion
 * too, so listening there would abort work that had already succeeded.
 */
const requestControllers = new WeakMap<Response, AbortController>();

function requestSignal(req: Request, res: Response): AbortSignal {
  // Memoised per response. All current callers ask once, but the helper reads
  // as though it were safe to call in a loop - and there it would attach a
  // listener per iteration and trip Node's max-listeners warning.
  const existing = requestControllers.get(res);
  if (existing) {
    return existing.signal;
  }

  const controller = new AbortController();
  requestControllers.set(res, controller);
  res.on('close', () => {
    if (!res.writableFinished) {
      controller.abort();
    }
  });
  return controller.signal;
}

function formatDuration(start: bigint, end: bigint): string {
  return `${(Number(end - start) / 1_000_000_000).toFixed(2)}s`;
}

async function timeResumeStage<T>(label: string, action: () => Promise<T>): Promise<T> {
  const startedAt = process.hrtime.bigint();
  try {
    return await action();
  } finally {
    console.log(`[Resume timing] ${label} finished in ${formatDuration(startedAt, process.hrtime.bigint())}`);
  }
}

function shouldGenerateCoverLetterDocx(value: unknown): boolean {
  return typeof value === 'boolean' ? value : true;
}

function resolveGenerationRole(role: unknown, analysis?: import('../types/template').JobAnalysis): string {
  if (typeof role === 'string' && role.trim()) {
    return role.trim();
  }
  return analysis?.jobMeta?.title?.trim() || '';
}

/**
 * The analysis, carrying the title this build was actually asked for.
 *
 * WHY. The headline's discipline tag - "Software Engineer (Integration)" - is
 * read from `jobAnalysis.jobMeta.title`, which is whatever the analyser wrote.
 * Every route here already knew a better answer and discarded it: the sheet
 * import sends the posting's title from its own job-title column as `role`,
 * and `resolveGenerationRole` prefers exactly that. The two only ever met in
 * the output folder name.
 *
 * So when the analyser came back with an empty or generic title, the tag
 * vanished from every resume in the run while the folder names beside them
 * showed the right title. Reproduced end to end: the same nine builds tag
 * correctly with the title in the analysis and not at all without it, with the
 * correct role sitting in the request the whole time.
 *
 * A copy, never an edit. One analysis is shared by every profile built for a
 * job, and by the page that sent it.
 */
function withResolvedTitle<T extends import('../types/template').JobAnalysis | undefined>(
  analysis: T,
  role: string
): T {
  if (!analysis) return analysis;
  const title = role.trim();
  if (!title || analysis.jobMeta?.title?.trim() === title) return analysis;
  return { ...analysis, jobMeta: { ...analysis.jobMeta, title } };
}

/**
 * Runs one batch item, trying again while the failure looks transient.
 *
 * WHY EVERY BATCH GOES THROUGH THIS. A 500-resume run ended with 76 failures,
 * almost all of them a browser that took the prompt and then did not answer in
 * time - already marked retryable, and retried by nothing. The failover inside
 * a single call tries the other free account once and stops, which is the right
 * scope for "this account is walled" and the wrong one for "that turn went
 * wrong".
 *
 * The retry re-enters the tab pool, so the next attempt takes whichever browser
 * is free rather than the one that just failed.
 */
/**
 * What failed, by profile, at the end of a run.
 *
 * WHY BY PROFILE AND BY ROW. A 360-build run that loses ten of them leaves the
 * operator with a red banner naming three companies and an ellipsis, which is
 * not enough to do anything with. The sheet row is the handle they actually
 * have: it is what they open to read the posting and what they re-run.
 *
 * The last line is the one worth reading first. A row that failed for EVERY
 * profile is a problem with that job - an unreadable posting, a description
 * that never downloaded - while a row that failed for one profile out of three
 * is the ordinary transient kind that a re-run usually fixes. Those two want
 * different responses, and separating them is most of the value here.
 */
function logFailedJobsByProfile(
  failures: Array<{ profileName: string; sourceRowNumber?: number; companyName: string }>,
  totalUnits: number,
  profileCount: number
): void {
  if (failures.length === 0) {
    console.log(`[Resume batch] All ${totalUnits} build(s) succeeded.`);
    return;
  }

  const rowsByProfile = new Map<string, Set<number | string>>();
  const profilesByRow = new Map<number | string, Set<string>>();

  for (const failure of failures) {
    // A job imported without a row number is named by its company instead,
    // which is the only other handle there is.
    const row = failure.sourceRowNumber ?? `"${failure.companyName}"`;
    if (!rowsByProfile.has(failure.profileName)) rowsByProfile.set(failure.profileName, new Set());
    (rowsByProfile.get(failure.profileName) as Set<number | string>).add(row);
    if (!profilesByRow.has(row)) profilesByRow.set(row, new Set());
    (profilesByRow.get(row) as Set<string>).add(failure.profileName);
  }

  const order = (values: Array<number | string>): Array<number | string> =>
    [...values].sort((a, b) =>
      typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))
    );

  console.log(
    `[Resume batch] ${failures.length} of ${totalUnits} build(s) failed. Failed jobs by profile:`
  );
  const width = Math.max(...[...rowsByProfile.keys()].map((name) => name.length));
  for (const [profileName, rows] of rowsByProfile) {
    console.log(
      `  ${profileName.padEnd(width)}  ${rows.size} job(s): row ${order([...rows]).join(', ')}`
    );
  }

  const everyProfile = order(
    [...profilesByRow.entries()]
      .filter(([, names]) => names.size >= profileCount && profileCount > 0)
      .map(([row]) => row)
  );
  if (everyProfile.length > 0) {
    console.log(
      `[Resume batch] Failed for EVERY profile, so look at the job rather than the run: ` +
        `row ${everyProfile.join(', ')}`
    );
  }
}

function runBatchUnit<T>(label: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  return withUnitRetry(work, {
    signal,
    onRetry: ({ attempt, attempts, waitMs, error }) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[Resume retry] ${label}: attempt ${attempt}/${attempts} failed (${reason}). ` +
          `Retrying in ${Math.round(waitMs / 1000)}s.`
      );
    },
  });
}

async function resolveTemplateForProfile(profile: Profile, requestedTemplateId?: string): Promise<Template | null> {
  const candidateIds = [
    typeof requestedTemplateId === 'string' ? requestedTemplateId.trim() : '',
    typeof profile.preferredTemplate === 'string' ? profile.preferredTemplate.trim() : '',
    'default',
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

  for (const candidateId of candidateIds) {
    const template = await getTemplateById(candidateId);
    if (template && !template.disabled) {
      return template;
    }
  }

  return null;
}

function getProfileAnalyzeJobPromptId(profile?: Profile): string {
  return profile?.profileSettings?.analyzeJobPromptId?.trim() || DEFAULT_ANALYZE_JOB_PROMPT_ID;
}

// Get enabled AI models
router.get('/models', async (req: Request, res: Response) => {
  try {
    const settings = await getPublicAppSettings();
    res.json(settings);
  } catch {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Confirm and persist a new skill
router.post('/skills/confirm', confirmSkill);


// List skills
router.get('/skills', listSkills);

// Add skill
router.post('/skills', createSkill);

// Update skill
router.put('/skills', updateSkillHandler);

// Delete skill
router.delete('/skills', deleteSkillHandler);

// Analyze job description
router.post('/analyze', async (req: Request, res: Response) => {
  const requestStartedAt = process.hrtime.bigint();
  console.log('[Resume timing] /resume/analyze started');
  try {
    const { jobDescription, promptId } = req.body as {
      jobDescription?: string;
      promptId?: string;
    };

    if (!jobDescription || jobDescription.trim().length < 50) {
      res.status(400).json({ error: 'Job description must be at least 50 characters' });
      return;
    }

    const selectedModel = await resolveAiChoice(readAiOverrides(req.body));
    const analysis = await analyzeJobDescription(
      jobDescription,
      selectedModel,
      promptId,
      requestSignal(req, res)
    );
    console.log(`[Resume timing] /resume/analyze finished in ${formatDuration(requestStartedAt, process.hrtime.bigint())}`);
    res.json(analysis);
  } catch (error) {
    console.error('Error analyzing job description:', error);
    if (sendAiError(res, error)) return;
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to analyze job description'
    });
  }
});

router.post('/analyze-prompt-test', async (req: Request, res: Response) => {
  try {
    const { jobDescription, promptId } = req.body as {
      jobDescription?: string;
      promptId?: string;
    };

    if (!jobDescription || jobDescription.trim().length < 50) {
      res.status(400).json({ error: 'Job description must be at least 50 characters' });
      return;
    }

    const selectedModel = await resolveAiChoice(readAiOverrides(req.body));
    const result = await analyzeJobDescriptionPromptRaw(
      jobDescription,
      selectedModel,
      promptId
    );
    res.json(result);
  } catch (error) {
    console.error('Error testing job description prompt:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to test job description prompt',
    });
  }
});

/**
 * Live progress for one batch, as server-sent events.
 *
 * GET rather than POST and text/event-stream rather than JSON, because this is
 * the one thing the page needs WHILE the batch request is still in flight - it
 * cannot learn it from the response it is waiting on.
 *
 * The id is chosen by the client and passed to the batch call, so the page can
 * start listening before it starts the work and miss nothing.
 */
router.get('/batch-progress/:id', (req: Request<{ id: string }>, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx and friends buffer an event stream into uselessness otherwise.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (payload: unknown): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const stop = watchBatch(req.params.id, (progress) => {
    send(progress);
    if (progress.done) res.end();
  });

  // A comment line every twenty seconds. It is not an event, so no client sees
  // it, but it keeps a proxy from closing a stream that is legitimately quiet
  // while one long model call runs.
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
  keepAlive.unref?.();

  const close = (): void => {
    clearInterval(keepAlive);
    stop();
  };
  req.on('close', close);
  res.on('close', close);
});

router.post('/analyze-multi-job', async (req: Request, res: Response) => {
  try {
    const {
      jobs,
      model,
    } = req.body as {
      jobs?: Array<{
        companyName?: string;
        jobDescription?: string;
        sourceRowNumber?: number;
      }>;
      model?: string;
    };

    if (!Array.isArray(jobs) || jobs.length === 0) {
      res.status(400).json({ error: 'At least one job is required' });
      return;
    }

    const selectedModel = await resolveAiChoice(readAiOverrides(req.body));

    const validJobs: Array<{
      customId: string;
      companyName: string;
      jobDescription: string;
      sourceRowNumber?: number;
    }> = [];
    const failures: Array<{
      companyName: string;
      sourceRowNumber?: number;
      error: string;
    }> = [];

    for (const [index, job] of jobs.entries()) {
      const companyName = typeof job.companyName === 'string' ? job.companyName.trim() : '';
      const jobDescription = typeof job.jobDescription === 'string' ? job.jobDescription.trim() : '';

      if (!companyName) {
        failures.push({
          companyName: `Job ${index + 1}`,
          sourceRowNumber: job.sourceRowNumber,
          error: 'Company name is required',
        });
        continue;
      }

      if (jobDescription.length < 50) {
        failures.push({
          companyName,
          sourceRowNumber: job.sourceRowNumber,
          error: 'Job description must be at least 50 characters',
        });
        continue;
      }

      validJobs.push({
        customId: `job_${index + 1}`,
        companyName,
        jobDescription,
        sourceRowNumber: job.sourceRowNumber,
      });
    }

    const analyses: Array<{
      companyName: string;
      sourceRowNumber?: number;
      jobDescription: string;
      analysis: JobAnalysis;
    }> = [];

    // The analyses go out at the chosen provider's width too. They are the
    // short calls, but there is one per job and a sheet import brings dozens.
    const analysisCapacity = await resolveBatchCapacity(selectedModel);
    const analysisOutcomes = await mapWithConcurrency(validJobs, analysisCapacity.limit, (job) =>
      runBatchUnit(`analysis of ${job.companyName}`, requestSignal(req, res), () =>
        analyzeJobDescription(
          job.jobDescription,
          selectedModel,
          undefined,
          requestSignal(req, res)
        )
      )
    );

    analysisOutcomes.forEach((outcome, index) => {
      const job = validJobs[index];
      if (outcome.ok) {
        analyses.push({
          companyName: job.companyName,
          sourceRowNumber: job.sourceRowNumber,
          jobDescription: job.jobDescription,
          analysis: outcome.value,
        });
        return;
      }
      failures.push({
        companyName: job.companyName,
        sourceRowNumber: job.sourceRowNumber,
        error: describeFailure(outcome.error, 'Analysis failed'),
      });
    });

    res.json({
      provider: selectedModel.provider,
      analyzed: analyses.length,
      analyses,
      failed: failures.length,
      failures,
    });
  } catch (error) {
    console.error('Error analyzing multiple job descriptions:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to analyze job descriptions',
    });
  }
});

// Load all non-disabled profiles
async function loadAllProfiles(profileIds?: string[]): Promise<Profile[]> {
  const selectedIds = Array.isArray(profileIds)
    ? new Set(profileIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))
    : null;
  return listProfiles()
    .filter((profile) => !selectedIds || selectedIds.has(profile.id))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function collectUnconfirmedSkillMaps(
  content: TailoredContent | undefined,
  hardMap: Map<string, string>,
  softMap: Map<string, string>
): void {
  if (!content) return;

  for (const skill of content.unconfirmedHardSkills ?? []) {
    const key = skill.trim().toLowerCase();
    if (key && !hardMap.has(key)) {
      hardMap.set(key, skill.trim());
    }
  }

  for (const skill of content.unconfirmedSoftSkills ?? []) {
    const key = skill.trim().toLowerCase();
    if (key && !softMap.has(key)) {
      softMap.set(key, skill.trim());
    }
  }
}

/**
 * How many AI-only batch items one request offers up at once.
 *
 * The provider's own process-wide semaphore is what actually bounds concurrent
 * `claude` processes across simultaneous requests; this only decides how many
 * items this loop hands it. Deliberately NOT set above that limit: the excess
 * can do nothing but queue, and a queued item still spends its caller's
 * deadline, so a wider fan-out buys nothing and risks turning a slow batch
 * into a failed one.
 */
/**
 * The model, effort and thinking a single request asks for.
 *
 * All three are overrides for THIS run only. Anything absent falls through to
 * the profile's own setting, and then to the app default, which is why they
 * are normalized into preferences rather than resolved here.
 */
function readAiOverrides(body: unknown): AiPreferences {
  const record = (body ?? {}) as Record<string, unknown>;
  return normalizeAiPreferences({
    modelId: typeof record.model === 'string' ? record.model : undefined,
    effort: record.effort,
    thinking: record.thinking,
  });
}

async function tailorResumesForProfiles(
  profiles: Profile[],
  analysis: JobAnalysis,
  requestChoice: AiChoice,
  overrides: AiPreferences,
  signal?: AbortSignal
): Promise<{
  tailoredByProfileId: Map<string, TailoredContent>;
  failures: Array<{ profileId: string; profileName: string; error: string }>;
  unconfirmedHardSkills: string[];
  unconfirmedSoftSkills: string[];
}> {
  const tailoredByProfileId = new Map<string, TailoredContent>();
  const failures: Array<{ profileId: string; profileName: string; error: string }> = [];
  const unconfirmedHardMap = new Map<string, string>();
  const unconfirmedSoftMap = new Map<string, string>();

  // Tailoring is pure model work with no shared state, so running profiles in
  // parallel is only a question of how many at once. It used to be one - a
  // five-profile batch was five full model calls end to end, with the user
  // waiting through all of them. Failures are still collected per profile
  // rather than aborting the batch, exactly as the sequential loop did.
  // Resolved per profile, not once for the batch: the model, effort and
  // thinking are a PROFILE setting, so a batch of profiles that disagree must
  // run each on its own choice rather than on whichever profile came first.
  // The request's own overrides still win over every one of them.
  // Width from the provider the REQUEST resolved to. Each profile may still
  // resolve its own model below - that is a per-profile setting - but the
  // capacity question is about the resource in front of the batch, and asking
  // it once per profile would read the settings row once per profile to get the
  // same answer.
  const capacity = await resolveBatchCapacity(requestChoice);
  const outcomes = await mapWithConcurrency(profiles, capacity.limit, async (profile) => {
    const choice = await resolveAiChoice(overrides, profile);
    return runBatchUnit(`tailoring for ${profile.name}`, signal, () =>
      tailorResume(profile, analysis, choice, signal)
    );
  });

  outcomes.forEach((outcome, index) => {
    const profile = profiles[index];
    if (outcome.ok) {
      tailoredByProfileId.set(profile.id, outcome.value);
      collectUnconfirmedSkillMaps(outcome.value, unconfirmedHardMap, unconfirmedSoftMap);
      return;
    }
    failures.push({
      profileId: profile.id,
      profileName: profile.name,
      error: describeFailure(outcome.error, 'Failed to tailor resume'),
    });
  });

  return {
    tailoredByProfileId,
    failures,
    unconfirmedHardSkills: Array.from(unconfirmedHardMap.values()),
    unconfirmedSoftSkills: Array.from(unconfirmedSoftMap.values()),
  };
}

// Generate for all profiles at once
router.post('/generate-all', async (req: Request, res: Response) => {
  try {
    const {
      templateId,
      jobDescription,
      jobAnalysis,
      companyName,
      role,
      model,
      profileIds,
      format = 'both',
      includeCoverLetterDocx,
    } = req.body;

    const appSettings = await getPublicAppSettings();
    const aiOverrides = readAiOverrides(req.body);
    const selectedModel = await resolveAiChoice(aiOverrides);

    if (!companyName?.trim()) {
      res.status(400).json({ error: 'Company name is required' });
      return;
    }

    // Load profiles
    const profiles = await loadAllProfiles(profileIds);
    if (profiles.length === 0) {
      res.status(400).json({ error: 'No matching profiles available. Add profiles in Admin or update group members.' });
      return;
    }


    let analysis: JobAnalysis | undefined;

    const trimmedJobDescription = jobDescription?.trim();

    if (trimmedJobDescription && trimmedJobDescription.length > 50) {
      analysis = jobAnalysis || await analyzeJobDescription(
        trimmedJobDescription,
        selectedModel,
        getProfileAnalyzeJobPromptId(profiles[0]),
        requestSignal(req, res)
      );
    }

    const resolvedRole = resolveGenerationRole(role, analysis);
    if (appSettings.outputPathUsesJobTitle && !resolvedRole) {
      res.status(400).json({ error: 'Role is required' });
      return;
    }
    analysis = withResolvedTitle(analysis, resolvedRole);

    const normalizedCompanyName = companyName.trim();
    const results: { profileId: string; profileName: string; pdf?: string; docx?: string; coverLetterPdf?: string; coverLetterDocx?: string }[] = [];
    const failures: Array<{ profileId: string; profileName: string; companyName: string; error: string }> = [];
    const unconfirmedHardMap = new Map<string, string>();
    const unconfirmedSoftMap = new Map<string, string>();
    const formatNorm = (format as string) === 'both' ? 'both' : format === 'docx' ? 'docx' : 'pdf';
    const generateCoverLetterDocx = shouldGenerateCoverLetterDocx(includeCoverLetterDocx);
    const bulkTailoring = analysis
      ? await tailorResumesForProfiles(
          profiles,
          analysis,
          selectedModel,
          aiOverrides,
          requestSignal(req, res)
        )
      : null;

    // The tailoring above already ran every profile at once; this is what came
    // after it, and it was still one profile at a time. That is not a small
    // remainder: a profile with no cover letter in its tailored content needs a
    // second model call, so a batch of ten with no job description was ten full
    // calls end to end with every browser but one idle.
    const capacity = await resolveBatchCapacity(selectedModel);
    const buildable = profiles.filter((profile): profile is Profile => Boolean(profile));
    console.log(
      `[Resume timing] generate-all: ${buildable.length} resume${buildable.length === 1 ? '' : 's'}, ` +
        `${capacity.limit} at a time (${capacity.reason})`
    );

    const outcomes = await mapWithConcurrency(buildable, capacity.limit, (profile) =>
      runBatchUnit(`${profile.name} for ${normalizedCompanyName}`, requestSignal(req, res), async () => {
        const template = await resolveTemplateForProfile(profile, templateId);
        if (!template) {
          throw new Error('Default template not available');
        }

        const tailoringFailure = bulkTailoring?.failures.find((item) => item.profileId === profile.id);
        if (tailoringFailure) {
          throw new Error(tailoringFailure.error);
        }

        let tailoredContent: TailoredContent | undefined;
        if (analysis) {
          tailoredContent = bulkTailoring
            ? bulkTailoring.tailoredByProfileId.get(profile.id)
            : await tailorResume(profile, analysis, selectedModel, requestSignal(req, res));
        }

        let coverLetterBody: string;
        if (tailoredContent?.coverLetter?.trim()) {
          coverLetterBody = tailoredContent.coverLetter.trim();
        } else {
          coverLetterBody = await generateCoverLetter(
            profile,
            normalizedCompanyName,
            resolvedRole,
            selectedModel,
            requestSignal(req, res)
          );
        }
        const pathInfo = await getGeneratedOutputPath(profile, normalizedCompanyName, resolvedRole);
        const coverLetterPdfPath = await saveCoverLetter(profile, coverLetterBody, pathInfo);
        const coverLetterDocxPath = generateCoverLetterDocx
          ? await saveCoverLetterDOCX(profile, coverLetterBody, pathInfo)
          : undefined;

        const entry: (typeof results)[0] = {
          profileId: profile.id,
          profileName: profile.name,
          coverLetterPdf: coverLetterPdfPath,
          coverLetterDocx: coverLetterDocxPath,
        };
        if (formatNorm === 'both') {
          const [pdfFilename, docxFilename] = await Promise.all([
            generateResumePDF(profile, template, tailoredContent, pathInfo, normalizedCompanyName, resolvedRole),
            generateResumeDOCX(profile, tailoredContent, pathInfo, normalizedCompanyName, resolvedRole)
          ]);
          entry.pdf = pdfFilename;
          entry.docx = docxFilename;
        } else {
          const filename = formatNorm === 'docx'
            ? await generateResumeDOCX(profile, tailoredContent, pathInfo, normalizedCompanyName, resolvedRole)
            : await generateResumePDF(profile, template, tailoredContent, pathInfo, normalizedCompanyName, resolvedRole);
          entry[formatNorm] = filename;
        }
        return { entry, tailoredContent };
      })
    );

    // Input order, not completion order: the page lists what comes back, and a
    // list that reshuffled itself by how fast each call happened to be would
    // read as a different batch every run.
    outcomes.forEach((outcome, index) => {
      const profile = buildable[index];
      if (outcome.ok) {
        collectUnconfirmedSkillMaps(
          outcome.value.tailoredContent,
          unconfirmedHardMap,
          unconfirmedSoftMap
        );
        results.push(outcome.value.entry);
        return;
      }
      const message = describeFailure(outcome.error, 'Failed to generate resume');
      console.error(
        `Error generating resume for profile ${profile.id} (${profile.name}) at ${normalizedCompanyName}:`,
        outcome.error
      );
      failures.push({
        profileId: profile.id,
        profileName: profile.name,
        companyName: normalizedCompanyName,
        error: message,
      });
    });

    res.json({
      generated: results.length,
      results,
      failed: failures.length,
      failures,
      failedCompanies: failures.length > 0 ? [normalizedCompanyName] : [],
      tailored: !!analysis,
      unconfirmedHardSkills: bulkTailoring?.unconfirmedHardSkills ?? Array.from(unconfirmedHardMap.values()),
      unconfirmedSoftSkills: bulkTailoring?.unconfirmedSoftSkills ?? Array.from(unconfirmedSoftMap.values()),
    });
  } catch (error) {
    console.error('Error generating resumes for all profiles:', error);
    if (sendAiError(res, error)) return;
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to generate resumes'
    });
  }
});

router.post('/generate-multi-job', async (req: Request, res: Response) => {
  try {
    const {
      templateId,
      jobs,
      model,
      profileIds,
      format = 'both',
      includeCoverLetterDocx,
      progressId,
    } = req.body as {
      templateId?: string;
      jobs?: Array<{
        companyName?: string;
        role?: string;
        jobDescription?: string;
        jobAnalysis?: JobAnalysis;
        sourceRowNumber?: number;
      }>;
      model?: string;
      profileIds?: string[];
      format?: 'pdf' | 'docx' | 'both';
      includeCoverLetterDocx?: boolean;
      progressId?: string;
    };

    const aiOverrides = readAiOverrides(req.body);
    const selectedModel = await resolveAiChoice(aiOverrides);

    if (!Array.isArray(jobs) || jobs.length === 0) {
      res.status(400).json({ error: 'At least one job is required' });
      return;
    }

    const profiles = await loadAllProfiles(profileIds);
    if (profiles.length === 0) {
      res.status(400).json({ error: 'No matching profiles available. Add profiles in Admin or update group members.' });
      return;
    }

    const appSettings = await getPublicAppSettings();
    const normalizedJobs = jobs.map((job, index) => {
      const normalizedCompanyName = typeof job.companyName === 'string' ? job.companyName.trim() : '';
      const trimmedJobDescription = typeof job.jobDescription === 'string' ? job.jobDescription.trim() : '';

      if (!normalizedCompanyName) {
        throw new Error(`Job ${index + 1} is missing a company name`);
      }

      const analysis = job.jobAnalysis;
      const resolvedRole = resolveGenerationRole(job.role, analysis);
      if (appSettings.outputPathUsesJobTitle && !resolvedRole) {
        throw new Error(`Job ${index + 1} (${normalizedCompanyName}) is missing a role`);
      }

      return {
        companyName: normalizedCompanyName,
        role: resolvedRole,
        jobDescription: trimmedJobDescription,
        analysis: withResolvedTitle(analysis, resolvedRole),
        sourceRowNumber: job.sourceRowNumber,
      };
    });

    const formatNorm = (format as string) === 'both' ? 'both' : format === 'docx' ? 'docx' : 'pdf';
    const generateCoverLetterDocx = shouldGenerateCoverLetterDocx(includeCoverLetterDocx);
    const results: Array<{
      profileId: string;
      profileName: string;
      companyName: string;
      role: string;
      pdf?: string;
      docx?: string;
      coverLetterPdf?: string;
      coverLetterDocx?: string;
    }> = [];
    const failures: Array<{
      profileId: string;
      profileName: string;
      companyName: string;
      sourceRowNumber?: number;
      error: string;
    }> = [];
    const failedCompanies = new Set<string>();
    const unconfirmedHardMap = new Map<string, string>();
    const unconfirmedSoftMap = new Map<string, string>();

    /**
     * One unit of work: this profile, for this job.
     *
     * Flattened before anything runs, rather than left as nested loops, so the
     * whole grid is a single queue. Nested, a slow job at the head held every
     * profile behind it even when other browsers sat idle - the outer loop
     * could not move on until the inner one finished, and the inner one was one
     * at a time as well.
     */
    const units = normalizedJobs.flatMap((job) => profiles.map((profile) => ({ job, profile })));

    // How wide to run, taken from the CHOSEN PROVIDER's real capacity: the
    // browsers registered for that site, both sites' added together under a
    // hybrid route, or the seat's process slots. See `resolveBatchCapacity`.
    // The queues themselves are already there - the tab pool hands a free
    // browser to the head of its line as each is released - so this only has to
    // offer them enough work to stay busy.
    const capacity = await resolveBatchCapacity(selectedModel);
    console.log(
      `[Resume timing] multi-job batch: ${units.length} resume${units.length === 1 ? '' : 's'}, ` +
        `${capacity.limit} at a time (${capacity.reason})`
    );

    // Reported per unit as it lands, so the page's bar can move while this one
    // request is still open. See services/batchProgress.
    if (progressId) startBatch(progressId, units.length, 'Building resumes');

    const outcomes = await mapWithConcurrency(units, capacity.limit, ({ job, profile }) =>
      runBatchUnit(`${profile.name} x ${job.companyName}`, requestSignal(req, res), async () => {
        const template = await resolveTemplateForProfile(profile, templateId);
        if (!template) {
          throw new Error('Default template not available');
        }

        let tailoredContent: TailoredContent | undefined;
        if (job.analysis) {
          tailoredContent = await tailorResume(
            profile,
            job.analysis,
            selectedModel,
            requestSignal(req, res)
          );
        }

        let coverLetterBody: string;
        if (tailoredContent?.coverLetter?.trim()) {
          coverLetterBody = tailoredContent.coverLetter.trim();
        } else {
          coverLetterBody = await generateCoverLetter(
            profile,
            job.companyName,
            job.role,
            selectedModel,
            requestSignal(req, res)
          );
        }

        const pathInfo = await getGeneratedOutputPath(profile, job.companyName, job.role, job.sourceRowNumber);
        const coverLetterPdfPath = await saveCoverLetter(profile, coverLetterBody, pathInfo);
        const coverLetterDocxPath = generateCoverLetterDocx
          ? await saveCoverLetterDOCX(profile, coverLetterBody, pathInfo)
          : undefined;

        const entry: (typeof results)[0] = {
          profileId: profile.id,
          profileName: profile.name,
          companyName: job.companyName,
          role: job.role,
          coverLetterPdf: coverLetterPdfPath,
          coverLetterDocx: coverLetterDocxPath,
        };

        if (formatNorm === 'both') {
          const [pdfFilename, docxFilename] = await Promise.all([
            generateResumePDF(profile, template, tailoredContent, pathInfo, job.companyName, job.role),
            generateResumeDOCX(profile, tailoredContent, pathInfo, job.companyName, job.role),
          ]);
          entry.pdf = pdfFilename;
          entry.docx = docxFilename;
        } else {
          const filename = formatNorm === 'docx'
            ? await generateResumeDOCX(profile, tailoredContent, pathInfo, job.companyName, job.role)
            : await generateResumePDF(profile, template, tailoredContent, pathInfo, job.companyName, job.role);
          entry[formatNorm] = filename;
        }

        return { entry, tailoredContent };
      })
        // Reported on settle, not in the loop below: that loop runs after the
        // LAST unit, which is exactly too late to be progress.
        .then(
          (value) => {
            if (progressId) {
              advanceBatch(progressId, { ok: true, profileName: profile.name, companyName: job.companyName });
            }
            return value;
          },
          (error: unknown) => {
            if (progressId) {
              advanceBatch(progressId, { ok: false, profileName: profile.name, companyName: job.companyName });
            }
            throw error;
          }
        )
    );

    // Collected in INPUT order, not completion order. `mapWithConcurrency`
    // preserves the index, and the page lists what comes back - so results that
    // reordered themselves by how fast each model call happened to be would
    // read as a different batch every run.
    outcomes.forEach((outcome, index) => {
      const { job, profile } = units[index];
      if (outcome.ok) {
        collectUnconfirmedSkillMaps(
          outcome.value.tailoredContent,
          unconfirmedHardMap,
          unconfirmedSoftMap
        );
        results.push(outcome.value.entry);
        return;
      }
      const message = describeFailure(outcome.error, 'Failed to generate resume');
      console.error(
        `Error generating resume for profile ${profile.id} (${profile.name}) at ${job.companyName}:`,
        outcome.error
      );
      failures.push({
        profileId: profile.id,
        profileName: profile.name,
        companyName: job.companyName,
        // The sheet row, which is how an operator refers to a job: it is what
        // they would open to look at the posting, and what they would re-run.
        // The company name is not enough - two rows can name one company.
        sourceRowNumber: job.sourceRowNumber,
        error: message,
      });
      failedCompanies.add(job.companyName);
    });

    logFailedJobsByProfile(failures, units.length, profiles.length);

    // Closes the stream the page is watching. Also on the error path below, so
    // a run that blew up does not leave a bar turning forever.
    if (progressId) finishBatch(progressId);

    res.json({
      generated: results.length,
      failed: failures.length,
      results,
      failures,
      failedCompanies: Array.from(failedCompanies),
      tailored: normalizedJobs.some((job) => Boolean(job.analysis)),
      unconfirmedHardSkills: Array.from(unconfirmedHardMap.values()),
      unconfirmedSoftSkills: Array.from(unconfirmedSoftMap.values()),
    });
  } catch (error) {
    const { progressId } = req.body as { progressId?: string };
    if (progressId) finishBatch(progressId);
    console.error('Error generating resumes for multiple jobs:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to generate resumes for multiple jobs',
    });
  }
});

// Preview resumes for all profiles
router.post('/preview-all', async (req: Request, res: Response) => {
  try {
    const {
      templateId,
      jobDescription,
      jobAnalysis,
      model,
      profileIds,
      role,
    } = req.body as {
      templateId?: string;
      jobDescription?: string;
      jobAnalysis?: import('../types/template').JobAnalysis;
      model?: string;
      profileIds?: string[];
      role?: string;
    };

    const aiOverrides = readAiOverrides(req.body);
    const selectedModel = await resolveAiChoice(aiOverrides);

    const profiles = await loadAllProfiles(profileIds);
    if (profiles.length === 0) {
      res.status(400).json({ error: 'No matching profiles available. Add profiles in Admin or update group members.' });
      return;
    }


    let analysis: JobAnalysis | undefined;
    const trimmedJobDescription = jobDescription?.trim();
    if (trimmedJobDescription && trimmedJobDescription.length > 50) {
      analysis = jobAnalysis || await analyzeJobDescription(
        trimmedJobDescription,
        selectedModel,
        getProfileAnalyzeJobPromptId(profiles[0]),
        requestSignal(req, res)
      );
    }
    // The preview shows the same headline tag the saved file will carry.
    analysis = withResolvedTitle(analysis, resolveGenerationRole(role, analysis));

    const previews: Array<{
      profileId: string;
      profileName: string;
      html: string;
      tailoredContent?: TailoredContent;
    }> = [];
    const unconfirmedHardMap = new Map<string, string>();
    const unconfirmedSoftMap = new Map<string, string>();
    const bulkTailoring = analysis
      ? await tailorResumesForProfiles(
          profiles,
          analysis,
          selectedModel,
          aiOverrides,
          requestSignal(req, res)
        )
      : null;

    if (bulkTailoring && bulkTailoring.failures.length > 0) {
      throw new Error(
        `Failed to tailor ${bulkTailoring.failures.length} profile(s): ${bulkTailoring.failures
          .slice(0, 3)
          .map((item) => `${item.profileName}: ${item.error}`)
          .join(' | ')}${bulkTailoring.failures.length > 3 ? ' | ...' : ''}`
      );
    }

    const capacity = await resolveBatchCapacity(selectedModel);
    const previewable = profiles.filter((profile): profile is Profile => Boolean(profile));
    const outcomes = await mapWithConcurrency(previewable, capacity.limit, (profile) =>
      runBatchUnit(`preview for ${profile.name}`, requestSignal(req, res), async () => {
        const template = await resolveTemplateForProfile(profile, templateId);
        if (!template) {
          throw new Error('Default template not available');
        }

        const tailoredContent = analysis
          ? bulkTailoring
            ? bulkTailoring.tailoredByProfileId.get(profile.id)
            : await tailorResume(profile, analysis, selectedModel, requestSignal(req, res))
          : undefined;

        return {
          tailoredContent,
          preview: {
            profileId: profile.id,
            profileName: profile.name,
            html: await generatePreviewHTML(profile, template, tailoredContent),
            tailoredContent,
          },
        };
      })
    );

    // A missing template fails THIS profile, not the whole preview.
    //
    // The loop this replaced answered 500 and returned the moment one profile
    // had no template, discarding every preview already built - including the
    // model calls that produced them. A batch that throws away finished work
    // over one bad row is the thing every other batch path here avoids.
    for (const [index, outcome] of outcomes.entries()) {
      const profile = previewable[index];
      if (!outcome.ok) {
        console.error(`Error previewing resume for profile ${profile.id} (${profile.name}):`, outcome.error);
        continue;
      }
      collectUnconfirmedSkillMaps(outcome.value.tailoredContent, unconfirmedHardMap, unconfirmedSoftMap);
      previews.push(outcome.value.preview);
    }

    res.json({
      previews,
      tailored: !!analysis,
      unconfirmedHardSkills: bulkTailoring?.unconfirmedHardSkills ?? Array.from(unconfirmedHardMap.values()),
      unconfirmedSoftSkills: bulkTailoring?.unconfirmedSoftSkills ?? Array.from(unconfirmedSoftMap.values()),
    });
  } catch (error) {
    console.error('Error previewing resumes for all profiles:', error);
    if (sendAiError(res, error)) return;
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to preview resumes'
    });
  }
});

// Generate tailored resume (single profile)
router.post('/generate', async (req: Request, res: Response) => {
  const requestStartedAt = process.hrtime.bigint();
  console.log('[Resume timing] /resume/generate started');
  try {
    const {
      profileId,
      templateId,
      jobDescription,
      jobAnalysis,
      companyName,
      role,
      sourceRowNumber,
      model,
      format = 'pdf',
      includeCoverLetterDocx,
    }: GenerateResumeRequest = req.body;
    const appSettings = await getPublicAppSettings();

    if (!profileId) {
      res.status(400).json({ error: 'Profile ID is required' });
      return;
    }

    if (!companyName || !companyName.trim()) {
      res.status(400).json({ error: 'Company name is required' });
      return;
    }

    // Load profile
    const profile = getProfile(profileId);
    if (!profile) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    if (profile.disabled) {
      res.status(400).json({ error: 'Selected profile is disabled' });
      return;
    }

    // Resolved here rather than at the top of the handler: the model, effort
    // and thinking are a per-profile setting, so the profile has to be loaded
    // before they can be read. The request's own overrides still win.
    const selectedModel = await resolveAiChoice(readAiOverrides(req.body), profile);

    // Ensure built-in templates exist, then load requested template
    const template = await resolveTemplateForProfile(profile, templateId);
    if (!template) {
      res.status(500).json({ error: 'Default template not available' });
      return;
    }

    // If job description provided, tailor the resume. Existing/manual content still
    // gets normalized so skills remain code-decided from the library.
    let tailoredContent = (req.body as GenerateResumeRequest).tailoredContent as TailoredContent | undefined;
    let analysis = jobAnalysis;
    if (!analysis && jobDescription && jobDescription.trim().length > 50) {
      analysis = jobAnalysis || await analyzeJobDescription(
        jobDescription,
        selectedModel,
        getProfileAnalyzeJobPromptId(profile),
        requestSignal(req, res)
      );
    }
    // Resolved BEFORE tailoring, so the headline is tagged from the title this
    // build was asked for rather than from whatever the analyser wrote.
    const resolvedRole = resolveGenerationRole(role, analysis);
    if (appSettings.outputPathUsesJobTitle && !resolvedRole) {
      res.status(400).json({ error: 'Role is required' });
      return;
    }
    analysis = withResolvedTitle(analysis, resolvedRole);

    if (tailoredContent && analysis) {
      tailoredContent = parseTailoredResumeContent(JSON.stringify(tailoredContent), profile, analysis);
    }
    if (!tailoredContent && analysis) {
      tailoredContent = await tailorResume(profile, analysis, selectedModel, requestSignal(req, res));
    }

    const generateBoth = (format as string) === 'both';
    const generateCoverLetterDocx = shouldGenerateCoverLetterDocx(includeCoverLetterDocx);
    const unconfirmedHardSkills = tailoredContent?.unconfirmedHardSkills ?? [];
    const unconfirmedSoftSkills = tailoredContent?.unconfirmedSoftSkills ?? [];
    const buildAfterLlmStartedAt = process.hrtime.bigint();

    // Get cover letter body: from tailored content or generate when no job description
    const coverLetterBody = await timeResumeStage('Cover letter body setup', async () => {
      if (tailoredContent?.coverLetter?.trim()) {
        return tailoredContent.coverLetter.trim();
      }
      return generateCoverLetter(
        profile,
        companyName.trim(),
        resolvedRole,
        selectedModel,
        requestSignal(req, res)
      );
    });

    const pathInfo = await getGeneratedOutputPath(
      profile,
      companyName.trim(),
      resolvedRole,
      sourceRowNumber
    );
    const { coverLetterPdfPath, coverLetterDocxPath } = await timeResumeStage('Cover letter file generation', async () => {
      const pdfPath = await saveCoverLetter(profile, coverLetterBody, pathInfo);
      const docxPath = generateCoverLetterDocx
        ? await saveCoverLetterDOCX(profile, coverLetterBody, pathInfo)
        : undefined;
      return { coverLetterPdfPath: pdfPath, coverLetterDocxPath: docxPath };
    });

    if (generateBoth) {
      const [pdfFilename, docxFilename] = await timeResumeStage('Resume PDF/DOCX generation', () =>
        Promise.all([
          generateResumePDF(profile, template, tailoredContent, pathInfo, companyName.trim(), resolvedRole),
          generateResumeDOCX(profile, tailoredContent, pathInfo, companyName.trim(), resolvedRole),
        ])
      );
      console.log(`[Resume timing] Build after LLM finished in ${formatDuration(buildAfterLlmStartedAt, process.hrtime.bigint())}`);
      console.log(`[Resume timing] /resume/generate finished in ${formatDuration(requestStartedAt, process.hrtime.bigint())}`);
      res.json({
        pdf: { filename: pdfFilename, downloadUrl: `/api/resume/download/${pdfFilename}` },
        docx: { filename: docxFilename, downloadUrl: `/api/resume/download/${docxFilename}` },
        coverLetter: {
          pdf: { filename: coverLetterPdfPath, downloadUrl: `/api/resume/download/${coverLetterPdfPath}` },
          ...(coverLetterDocxPath
            ? {
                docx: {
                  filename: coverLetterDocxPath,
                  downloadUrl: `/api/resume/download/${coverLetterDocxPath}`,
                },
              }
            : {}),
        },
        tailored: !!tailoredContent,
        unconfirmedHardSkills,
        unconfirmedSoftSkills,
      });
    } else {
      const formatNorm = format === 'docx' ? 'docx' : 'pdf';
      const filename = await timeResumeStage(`Resume ${formatNorm.toUpperCase()} generation`, () =>
        formatNorm === 'docx'
          ? generateResumeDOCX(profile, tailoredContent, pathInfo, companyName.trim(), resolvedRole)
          : generateResumePDF(profile, template, tailoredContent, pathInfo, companyName.trim(), resolvedRole)
      );

      console.log(`[Resume timing] Build after LLM finished in ${formatDuration(buildAfterLlmStartedAt, process.hrtime.bigint())}`);
      console.log(`[Resume timing] /resume/generate finished in ${formatDuration(requestStartedAt, process.hrtime.bigint())}`);
      res.json({
        filename,
        downloadUrl: `/api/resume/download/${filename}`,
        coverLetter: {
          pdf: { filename: coverLetterPdfPath, downloadUrl: `/api/resume/download/${coverLetterPdfPath}` },
          ...(coverLetterDocxPath
            ? {
                docx: {
                  filename: coverLetterDocxPath,
                  downloadUrl: `/api/resume/download/${coverLetterDocxPath}`,
                },
              }
            : {}),
        },
        tailored: !!tailoredContent,
        format: formatNorm,
        unconfirmedHardSkills,
        unconfirmedSoftSkills,
      });
    }
  } catch (error) {
    console.error('Error generating resume:', error);
    if (sendAiError(res, error)) return;
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to generate resume'
    });
  }
});

// Preview resume HTML
router.post('/preview', async (req: Request, res: Response) => {
  const requestStartedAt = process.hrtime.bigint();
  console.log('[Resume timing] /resume/preview started');
  try {
    const { profileId, templateId, jobDescription, jobAnalysis, role, tailoredContent: manualTailoredContent }: GenerateResumeRequest = req.body;

    if (!profileId) {
      res.status(400).json({ error: 'Profile ID is required' });
      return;
    }

    // Load profile
    const profile = getProfile(profileId);
    if (!profile) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    if (profile.disabled) {
      res.status(400).json({ error: 'Selected profile is disabled' });
      return;
    }

    // Resolved here rather than at the top of the handler: the model, effort
    // and thinking are a per-profile setting, so the profile has to be loaded
    // before they can be read. The request's own overrides still win.
    const selectedModel = await resolveAiChoice(readAiOverrides(req.body), profile);

    // Ensure built-in templates exist, then load requested template
    const template = await resolveTemplateForProfile(profile, templateId);
    if (!template) {
      res.status(500).json({ error: 'Default template not available' });
      return;
    }

    // If job description provided, tailor the resume. Existing/manual content still
    // gets normalized so skills remain code-decided from the library.
    let tailoredContent = manualTailoredContent;
    let analysis = jobAnalysis;
    if (!analysis && jobDescription && jobDescription.trim().length > 50) {
      analysis = await analyzeJobDescription(
        jobDescription,
        selectedModel,
        getProfileAnalyzeJobPromptId(profile),
        requestSignal(req, res)
      );
    }
    // The preview shows the same headline tag the saved file will carry.
    analysis = withResolvedTitle(analysis, resolveGenerationRole(role, analysis));
    if (tailoredContent && analysis) {
      tailoredContent = parseTailoredResumeContent(JSON.stringify(tailoredContent), profile, analysis);
    }
    if (!tailoredContent && analysis) {
      tailoredContent = await tailorResume(profile, analysis, selectedModel, requestSignal(req, res));
    }

    // Generate HTML preview
    const html = await timeResumeStage('Preview HTML generation', () =>
      generatePreviewHTML(profile, template, tailoredContent)
    );

    console.log(`[Resume timing] /resume/preview finished in ${formatDuration(requestStartedAt, process.hrtime.bigint())}`);
    res.json({ html, tailored: !!tailoredContent, tailoredContent });
  } catch (error) {
    console.error('Error generating preview:', error);
    if (sendAiError(res, error)) return;
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to generate preview'
    });
  }
});

// Download generated resume (PDF or DOCX)
router.get('/download/:filename(*)', async (req: Request<{ filename: string }>, res: Response) => {
  try {
    const filepath = await getGeneratedPDFPath(req.params.filename);
    if (!filepath) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const ext = path.extname(req.params.filename).toLowerCase();
    const contentType =
      ext === '.docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/pdf';

    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(req.params.filename)}"`);
    res.setHeader('Content-Type', contentType);
    res.download(filepath);
  } catch (error) {
    res.status(500).json({ error: 'Failed to download file' });
  }
});

export default router;
