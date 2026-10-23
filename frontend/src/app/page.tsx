'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  profilesApi,
  groupsApi,
  resumeApi,
  DEFAULT_PUBLIC_APP_SETTINGS,
  PublicAppSettings,
  AiPreferences,
  normalizeAiPreferences,
  toAiRequestOverrides,
  Profile,
  Group,
  JobAnalysis,
  TailoredContent,
  ShutdownReport,
} from '@/lib/api';
import AppTopNav from '@/components/AppTopNav';
import GenerationProgress, { type GenerationProgressState } from '@/components/GenerationProgress';
import ProfileSelector from '@/components/ProfileSelector';
import AiPreferenceFields from '@/components/AiPreferenceFields';
import ResumePreview from '@/components/ResumePreview';
import SheetsImportModal, { ImportedSheetJob } from '@/components/SheetsImportModal';
import { applyTheme, getStoredTheme, setStoredDefaultTheme } from '@/lib/theme';

type GenerateMode = 'single' | 'multiple';
type BuilderMode = 'manual' | 'sheets' | null;
type SheetsTargetMode = 'single' | 'all' | 'group';

/** One job, in the shape `generateMultiJob` takes it back. */
type BuildableJob = {
  companyName: string;
  role: string;
  jobDescription: string;
  jobAnalysis: JobAnalysis;
  sourceRowNumber?: number;
};

/**
 * A profile x job pair that did not build.
 *
 * Carries the JOB with it, not just its name: re-running needs the analysis
 * back, and the analysis is thrown away when the run ends. Without this a retry
 * would have to re-analyse every failed posting - minutes of model time spent
 * redoing work that had succeeded.
 */
type FailedBuild = {
  profileId: string;
  profileName: string;
  companyName: string;
  sourceRowNumber?: number;
  error: string;
  /** Absent when the run died before the jobs were built, so there is nothing to retry. */
  job?: BuildableJob;
};

type MultiplePreview = {
  profileId: string;
  profileName: string;
  html: string;
  tailoredContent?: TailoredContent;
  draft: string;
  error: string;
};

type GenerationFailure = {
  profileId: string;
  profileName: string;
  companyName: string;
  error: string;
};

function formatCompanySummary(companyNames: string[]): string {
  const uniqueCompanies = [...new Set(companyNames.map((name) => name.trim()).filter(Boolean))];
  if (uniqueCompanies.length === 0) return '';
  if (uniqueCompanies.length <= 3) return uniqueCompanies.join(', ');
  return `${uniqueCompanies.slice(0, 3).join(', ')}, ...`;
}

function getAnalysisJobTitle(analysis?: JobAnalysis): string {
  return analysis?.jobMeta?.title?.trim() ?? '';
}

export default function Home() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [builderMode, setBuilderMode] = useState<BuilderMode>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  /**
   * Model, effort and thinking for THIS run only.
   *
   * Empty means every field falls through to the selected profile's own
   * setting, and then to the app default - nothing here is persisted.
   */
  const [aiOverrides, setAiOverrides] = useState<AiPreferences>({});
  const [generateMode, setGenerateMode] = useState<GenerateMode>('single');
  const [multipleTarget, setMultipleTarget] = useState<'all' | 'group'>('group');
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [sheetsTargetMode, setSheetsTargetMode] = useState<SheetsTargetMode>('single');
  const [selectedSheetsProfileId, setSelectedSheetsProfileId] = useState<string | null>(null);
  const [selectedSheetsGroupId, setSelectedSheetsGroupId] = useState<string>('');
  const [selectedSheetsSourceId, setSelectedSheetsSourceId] = useState<string>('');
  const [companyName, setCompanyName] = useState('');
  const [role, setRole] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [modelSettings, setModelSettings] = useState<PublicAppSettings>(DEFAULT_PUBLIC_APP_SETTINGS);
  const [jobAnalysis, setJobAnalysis] = useState<JobAnalysis | null>(null);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewTailored, setPreviewTailored] = useState(false);
  const [isSinglePreviewOpen, setIsSinglePreviewOpen] = useState(false);
  const [tailoredContent, setTailoredContent] = useState<TailoredContent | null>(null);
  const [tailoredContentDraft, setTailoredContentDraft] = useState('');
  const [tailoredContentError, setTailoredContentError] = useState('');
  const [multiplePreviews, setMultiplePreviews] = useState<MultiplePreview[]>([]);
  const [multiplePreviewTailored, setMultiplePreviewTailored] = useState(false);
  const [multiplePreviewIndex, setMultiplePreviewIndex] = useState(0);
  const [autoGenerate, setAutoGenerate] = useState(false);
  const [isSheetsImportOpen, setIsSheetsImportOpen] = useState(false);

  /*
   * "Turn off computer after complete", and what came of it.
   *
   * Per run and never remembered: a batch of 500 is started and walked away
   * from, and the next one is often watched. A remembered tick is a machine that
   * turns itself off on a run nobody meant to arm.
   */
  /*
   * What failed, and enough to run it again.
   *
   * The red banner used to say "Some builds failed (10/15)" with three company
   * names and an ellipsis, which is not something anybody can act on. These are
   * listed in full and can be re-queued without re-running the ones that worked.
   */
  const [failedPairs, setFailedPairs] = useState<FailedBuild[]>([]);
  const [isRegenerating, setIsRegenerating] = useState(false);

  const [shutdownAfterComplete, setShutdownAfterComplete] = useState(false);
  const [shutdownReport, setShutdownReport] = useState<ShutdownReport | null>(null);
  const [isCancellingShutdown, setIsCancellingShutdown] = useState(false);

  const [isLoadingData, setIsLoadingData] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStep, setGenerationStep] = useState('');
  const [generationProgress, setGenerationProgress] = useState<GenerationProgressState | null>(null);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  /*
   * Seconds left before the machine goes off, ticked locally against the moment
   * the SERVER named. A countdown counted in the page would drift from the one
   * Windows is running, and the two disagreeing about a shutdown is the kind of
   * disagreement that gets noticed at the wrong moment.
   */
  const [secondsToShutdown, setSecondsToShutdown] = useState<number | null>(null);
  useEffect(() => {
    const at = shutdownReport?.shutdownAt;
    if (!at) {
      setSecondsToShutdown(null);
      return;
    }
    const tick = () => setSecondsToShutdown(Math.max(0, Math.round((at - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [shutdownReport?.shutdownAt]);

  /**
   * Builds the failed pairs again, and nothing else.
   *
   * ONE CALL PER JOB, carrying only the profiles that failed on it. The batch
   * endpoint builds the whole profile x job grid it is given, so handing it the
   * failed jobs and the failed profiles as two lists would rebuild pairs that
   * already succeeded - overwriting good files and spending model time on work
   * that was done. Grouping keeps the retry to exactly what failed.
   *
   * The analyses ride along from the first run, so nothing is analysed twice.
   */
  const regenerateFailed = async () => {
    const retryable = failedPairs.filter((pair) => pair.job);
    if (retryable.length === 0) return;

    setIsRegenerating(true);
    setError('');
    setSuccessMessage('');

    const byJob = new Map<string | number, { job: BuildableJob; profileIds: string[] }>();
    for (const pair of retryable) {
      const job = pair.job as BuildableJob;
      const key = job.sourceRowNumber ?? job.companyName;
      const group = byJob.get(key) ?? { job, profileIds: [] };
      if (!group.profileIds.includes(pair.profileId)) group.profileIds.push(pair.profileId);
      byJob.set(key, group);
    }

    const stillFailed: FailedBuild[] = [];
    let rebuilt = 0;

    try {
      for (const [, group] of byJob) {
        setGenerationStep(`Regenerating ${group.job.companyName}`);
        const result = await resumeApi.generateMultiJob({
          ...aiRequestOverrides,
          ...getDefaultGenerationOptions(),
          jobs: [group.job],
          profileIds: group.profileIds,
        });
        rebuilt += result.generated;
        for (const failure of result.failures) {
          stillFailed.push({ ...failure, job: group.job });
        }
      }

      setFailedPairs(stillFailed);
      setSuccessMessage(
        stillFailed.length === 0
          ? `Regenerated all ${rebuilt} build(s) that had failed.`
          : `Regenerated ${rebuilt} build(s). ${stillFailed.length} still failing.`
      );
    } catch (err) {
      // The pairs are left on screen: a failed retry must not lose the list of
      // what to retry, which is the only record of it once the run has ended.
      setError(err instanceof Error ? err.message : 'Could not regenerate the failed builds');
    } finally {
      setIsRegenerating(false);
      setGenerationStep('');
    }
  };

  const cancelShutdown = async () => {
    setIsCancellingShutdown(true);
    try {
      const result = await resumeApi.abortShutdown();
      // Either way the machine is staying on - a refusal from `shutdown /a`
      // means there was nothing scheduled to begin with.
      setShutdownReport((report) => (report ? { ...report, scheduled: false, shutdownAt: null } : report));
      if (!result.aborted && result.note) {
        setSuccessMessage('The shutdown is not pending any more. The computer stays on.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel the shutdown');
    } finally {
      setIsCancellingShutdown(false);
    }
  };

  useEffect(() => {
    loadInitialData();
  }, []);

  const resetTailoredEditor = useCallback(() => {
    setTailoredContent(null);
    setTailoredContentDraft('');
    setTailoredContentError('');
  }, []);

  const resetGenerationOutputs = useCallback(() => {
    setPreviewHtml('');
    setPreviewTailored(false);
    setIsSinglePreviewOpen(false);
    resetTailoredEditor();
    setJobAnalysis(null);
    setSuccessMessage('');
    setMultiplePreviews([]);
    setMultiplePreviewTailored(false);
    setMultiplePreviewIndex(0);
    setFailedPairs([]);
  }, [resetTailoredEditor]);

  useEffect(() => {
    resetGenerationOutputs();
  }, [builderMode, companyName, role, jobDescription, selectedProfileId, generateMode, resetGenerationOutputs]);

  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) ?? null;
  const aiRequestOverrides = toAiRequestOverrides(aiOverrides);
  const hasAiOverrides = Object.keys(aiRequestOverrides).length > 0;
  /**
   * What the override selects fall back to.
   *
   * In single mode that is the chosen profile's own setting, which is the
   * layer directly beneath this one; with no profile in scope - multiple mode,
   * or nothing selected yet - it is the app default.
   */
  const profilePreferences = normalizeAiPreferences(selectedProfile?.profileSettings?.ai);
  const inheritsFromProfile = generateMode === 'single' && Boolean(selectedProfile);
  // The profile's own model, but only while it is one that can still run: a
  // profile pointing at a model this installation has since locked falls back
  // to the app default, and this label has to name what will really be used.
  const inheritedModel =
    modelSettings.aiModels.find((model) => model.id === profilePreferences.modelId) ??
    modelSettings.aiModels.find((model) => model.id === modelSettings.defaultModelId);
  const inheritedChoice = {
    modelLabel: inheritedModel?.name || 'the first enabled model',
    effort: profilePreferences.effort ?? modelSettings.aiPreferenceDefaults.effort,
    thinking: profilePreferences.thinking ?? modelSettings.aiPreferenceDefaults.thinking,
  };

  const loadInitialData = async () => {
    try {
      const [profilesData, groupsData, modelData] = await Promise.all([
        profilesApi.getAll({ includeDisabled: true }),
        groupsApi.getAll().catch(() => []),
        resumeApi.getModels().catch(() => DEFAULT_PUBLIC_APP_SETTINGS),
      ]);
      const enabledProfiles = profilesData.filter((p) => !p.disabled);
      setProfiles(enabledProfiles);
      setGroups(groupsData);
      setModelSettings(modelData);
      setAutoGenerate(modelData.defaultMode === 'generate');
      setStoredDefaultTheme(modelData.defaultTheme);

      if (!getStoredTheme()) {
        applyTheme(modelData.defaultTheme);
      }

      if (enabledProfiles.length > 0) {
        const defaultProfileExists = enabledProfiles.some((profile) => profile.id === modelData.defaultProfileId);
        const initialProfileId = defaultProfileExists ? modelData.defaultProfileId : enabledProfiles[0].id;
        setSelectedProfileId(initialProfileId);
        setSelectedSheetsProfileId(initialProfileId);
      }

      setSelectedSheetsSourceId((current) => {
        if (current && modelData.googleSheetsSources.some((source) => source.id === current)) {
          return current;
        }
        return modelData.googleSheetsSources[0]?.id ?? '';
      });

      if (modelData.defaultResumeSelection === 'single') {
        setGenerateMode('single');
        setMultipleTarget('group');
        setSelectedGroupId('');
        setSheetsTargetMode('single');
        setSelectedSheetsGroupId('');
      } else if (modelData.defaultResumeSelection === 'all') {
        setGenerateMode('multiple');
        setMultipleTarget('all');
        setSelectedGroupId('');
        setSheetsTargetMode('all');
        setSelectedSheetsGroupId('');
      } else {
        const defaultGroupExists = groupsData.some((group) => group.id === modelData.defaultGroupId);
        setGenerateMode('multiple');
        setMultipleTarget('group');
        const initialGroupId = defaultGroupExists ? modelData.defaultGroupId : '';
        setSelectedGroupId(initialGroupId);
        setSheetsTargetMode('group');
        setSelectedSheetsGroupId(initialGroupId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setIsLoadingData(false);
    }
  };

  const getDefaultGenerationOptions = () => ({
    format: (modelSettings.defaultResumeDocxEnabled ? 'both' : 'pdf') as 'both' | 'pdf',
    includeCoverLetterDocx: modelSettings.defaultCoverLetterDocxEnabled,
  });
  const shouldShowRoleInput = modelSettings.outputPathUsesJobTitle;
  const hasGoogleSheetSources = modelSettings.googleSheetsSources.length > 0;
  const selectedSheetsProfileName = sheetsTargetMode === 'single'
    ? profiles.find((profile) => profile.id === selectedSheetsProfileId)?.name ?? ''
    : '';

  useEffect(() => {
    if (hasGoogleSheetSources || !isSheetsImportOpen) return;
    setIsSheetsImportOpen(false);
  }, [hasGoogleSheetSources, isSheetsImportOpen]);

  const getSelectedProfilesForSheetsBuilder = () => {
    if (sheetsTargetMode === 'single') {
      if (!selectedSheetsProfileId) {
        throw new Error('Please select a profile before importing from Sheets.');
      }
      const profile = profiles.find((item) => item.id === selectedSheetsProfileId);
      if (!profile) {
        throw new Error('Selected profile could not be found.');
      }
      return [profile];
    }

    if (sheetsTargetMode === 'all') {
      if (!profiles.length) {
        throw new Error('No profiles available for multi-profile generation.');
      }
      return profiles;
    }

    const selectedGroup = groups.find((group) => group.id === selectedSheetsGroupId);
    if (!selectedGroup) {
      throw new Error('Please select a group before importing from Sheets.');
    }

    const selectedProfiles = profiles.filter((profile) => selectedGroup.profileIds.includes(profile.id));
    if (!selectedProfiles.length) {
      throw new Error('Selected group has no enabled profiles.');
    }

    return selectedProfiles;
  };

  const clearGenerationProgress = () => {
    setGenerationProgress(null);
  };

  const updateGenerationProgress = (
    total: number,
    completed: number,
    phase: string,
    currentProfileName?: string,
    currentCompanyName?: string,
    currentJobTitle?: string,
    currentJobNumber?: number,
    importedJobCount?: number,
    // Counted separately from `completed`, which includes them: a failed
    // build is still a build that finished, so a bar that only shows
    // completed says "10 / 15" for a run that produced nothing.
    failed?: number,
    lastError?: string,
    inFlight?: string[]
  ) => {
    setGenerationProgress({
      total,
      completed,
      phase,
      currentProfileName,
      currentCompanyName,
      currentJobTitle,
      currentJobNumber,
      importedJobCount,
      failed,
      lastError,
      inFlight,
    });
  };

  const getSelectedProfilesForManualBuilder = (): Profile[] => {
    if (multipleTarget === 'all') {
      return profiles;
    }

    const selectedGroup = groups.find((group) => group.id === selectedGroupId);
    if (!selectedGroup) {
      throw new Error('Please select a group');
    }

    const selectedProfiles = profiles.filter((profile) => selectedGroup.profileIds.includes(profile.id));
    if (!selectedProfiles.length) {
      throw new Error('Selected group has no enabled profiles.');
    }

    return selectedProfiles;
  };

  const generateSequentialResumes = async ({
    targetProfiles,
    analysis,
    targetCompanyName,
    resolvedRole,
    tailoredContentByProfileId,
  }: {
    targetProfiles: Profile[];
    analysis: JobAnalysis;
    targetCompanyName: string;
    resolvedRole: string;
    tailoredContentByProfileId?: Map<string, TailoredContent | undefined>;
  }) => {
    const failures: GenerationFailure[] = [];
    const total = targetProfiles.length;
    let completed = 0;

    updateGenerationProgress(total, 0, 'Preparing resume generation', undefined, targetCompanyName);

    for (const profile of targetProfiles) {
      setGenerationStep(`Generating ${completed + 1}/${total}: ${profile.name} x ${targetCompanyName}`);
      updateGenerationProgress(total, completed, 'Building resumes', profile.name, targetCompanyName);

      try {
        await resumeApi.generate({
          ...aiRequestOverrides,
          profileId: profile.id,
          templateId: profile.preferredTemplate || 'default',
          jobDescription,
          jobAnalysis: analysis,
          tailoredContent: tailoredContentByProfileId?.get(profile.id),
          companyName: targetCompanyName,
          role: resolvedRole,
          ...getDefaultGenerationOptions(),
        });
      } catch (err) {
        failures.push({
          profileId: profile.id,
          profileName: profile.name,
          companyName: targetCompanyName,
          error: err instanceof Error ? err.message : 'Generation failed',
        });
      } finally {
        completed += 1;
        updateGenerationProgress(total, completed, 'Building resumes', profile.name, targetCompanyName);
      }
    }

    return {
      generated: total - failures.length,
      failed: failures.length,
      failures,
      failedCompanies: failures.length > 0 ? [targetCompanyName] : [],
    };
  };

  /**
   * Generates every profile x job combination from a sheet import.
   *
   * Two batch calls, not two nested loops. The loops this replaces awaited one
   * analysis and then one build at a time, so exactly one request was ever in
   * flight and exactly one chat browser was ever busy - registering sixteen of
   * them bought nothing. `/analyze-multi-job` and `/generate-multi-job` both run
   * a worker pool at the chosen provider's real width (under a hybrid route,
   * Claude's browsers plus ChatGPT's), pulling the next item the moment any
   * browser frees up.
   *
   * The cost is the progress bar. There is no streaming channel from the
   * server, so per-resume progress came from knowing when each await returned,
   * and that knowledge is what was traded away. Progress is now per PHASE.
   */
  const handleImportJobsFromSheets = async (
    importedJobs: ImportedSheetJob[],
    meta: { skippedRows: number }
  ) => {
    const selectedProfiles = getSelectedProfilesForSheetsBuilder();
    const fallbackRole = shouldShowRoleInput ? role.trim() : '';
    const normalizedJobs = importedJobs.map((job) => ({
      ...job,
      jobTitle: job.jobTitle.trim() || fallbackRole,
    }));

    setIsGenerating(true);
    setError('');
    setSuccessMessage('');
    resetGenerationOutputs();

    const failures: string[] = [];
    const failedCompanies = new Set<string>();
    const totalBuilds = selectedProfiles.length * normalizedJobs.length;
    let failedBuilds = 0;

    try {
      setGenerationStep(`Analyzing ${normalizedJobs.length} job(s)`);
      updateGenerationProgress(
        totalBuilds,
        0,
        'Analyzing job description',
        undefined,
        undefined,
        undefined,
        undefined,
        normalizedJobs.length
      );

      const analysisResponse = await resumeApi.analyzeMultiJob({
        ...aiRequestOverrides,
        jobs: normalizedJobs.map((job) => ({
          companyName: job.companyName.trim(),
          jobDescription: job.jobDescription.trim(),
          sourceRowNumber: job.sourceRowNumber,
        })),
      });

      // A job whose analysis failed has no title and no keywords, so every
      // profile paired with it is already lost. Counted here rather than left
      // to the build call, which is never told about it.
      for (const failure of analysisResponse.failures) {
        failedCompanies.add(failure.companyName);
        failedBuilds += selectedProfiles.length;
        failures.push(`${failure.companyName}: ${failure.error}`);
      }
      // Kept in their own shape as well, for the report an armed run writes: the
      // build call never hears about a job that died at analysis, and a report
      // missing them describes a shorter run than the one that happened.
      const analysisFailures = analysisResponse.failures.map((failure) => ({
        companyName: failure.companyName,
        sourceRowNumber: failure.sourceRowNumber,
        error: failure.error,
      }));

      if (analysisResponse.analyses.length > 0) {
        setJobAnalysis(analysisResponse.analyses[0].analysis);
      }

      // Matched on the row number the import carried, falling back to the
      // company name: the response is not promised in request order, and two
      // rows may name the same company.
      const titleByJob = new Map<string | number, string>(
        normalizedJobs.map((job) => [
          job.sourceRowNumber ?? job.companyName.trim(),
          job.jobTitle.trim(),
        ])
      );

      const buildableJobs = analysisResponse.analyses.map((entry) => {
        const importedTitle = titleByJob.get(entry.sourceRowNumber ?? entry.companyName) ?? '';
        return {
          companyName: entry.companyName,
          role: importedTitle || getAnalysisJobTitle(entry.analysis) || fallbackRole,
          jobDescription: entry.jobDescription,
          jobAnalysis: entry.analysis,
          sourceRowNumber: entry.sourceRowNumber,
        };
      });

      if (buildableJobs.length > 0) {
        const buildCount = buildableJobs.length * selectedProfiles.length;
        const alreadyFailed = totalBuilds - buildCount;
        setGenerationStep(`Building ${buildCount} resume(s)`);
        updateGenerationProgress(
          totalBuilds,
          alreadyFailed,
          'Building resumes',
          undefined,
          undefined,
          undefined,
          undefined,
          normalizedJobs.length
        );

        /*
         * The whole grid is one request, so its response says nothing until the
         * last resume is done. Without this the bar sat on "0 / 360" for an
         * hour and read as frozen - and the line under it said "preparing
         * resume generation" the entire time, because nothing had completed.
         *
         * Subscribed BEFORE the work starts, so the gap between the two calls
         * cannot lose the first few units.
         */
        const progressId = `sheets-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const stopWatching = resumeApi.watchBatchProgress(progressId, (progress) => {
          if (!progress.total) return;
          updateGenerationProgress(
            totalBuilds,
            alreadyFailed + progress.completed,
            'Building resumes',
            progress.profileName,
            progress.companyName,
            undefined,
            undefined,
            normalizedJobs.length,
            alreadyFailed + progress.failed,
            progress.lastError,
            progress.inFlight
          );
        });

        let result;
        try {
          result = await resumeApi.generateMultiJob({
            ...aiRequestOverrides,
            ...getDefaultGenerationOptions(),
            // Deliberately no templateId: the server then resolves each profile's
            // own preferred template, which is what the per-profile loop did.
            jobs: buildableJobs,
            profileIds: selectedProfiles.map((profile) => profile.id),
            progressId,
            shutdownAfterComplete,
            priorFailures: analysisFailures,
          });
        } finally {
          stopWatching();
        }

        failedBuilds += result.failed;
        for (const failure of result.failures) {
          failedCompanies.add(failure.companyName);
          failures.push(`${failure.companyName} / ${failure.profileName}: ${failure.error}`);
        }

        /*
         * Kept with the job each one came from, so they can be re-queued without
         * re-analysing the posting. Matched on the sheet row where there is one,
         * because two rows can name the same company.
         */
        const jobByKey = new Map<string | number, BuildableJob>(
          buildableJobs.map((job) => [job.sourceRowNumber ?? job.companyName, job])
        );
        setFailedPairs(
          result.failures.map((failure) => ({
            ...failure,
            job: jobByKey.get(failure.sourceRowNumber ?? failure.companyName),
          }))
        );

        // The server has already written the report and closed the browsers by
        // the time this arrives; the banner below is the countdown and the way
        // back out of it.
        if (result.shutdown) setShutdownReport(result.shutdown);
      }

      updateGenerationProgress(
        totalBuilds,
        totalBuilds,
        'Building resumes',
        undefined,
        undefined,
        undefined,
        undefined,
        normalizedJobs.length
      );

      const generatedCount = totalBuilds - failedBuilds;
      const skippedNote = meta.skippedRows
        ? ` Skipped ${meta.skippedRows} imported row(s) with missing required values.`
        : '';
      setSuccessMessage(
        `Generated ${generatedCount} build(s) from ${normalizedJobs.length} imported job(s) across ${selectedProfiles.length} profile(s).${skippedNote}`
      );

      if (failures.length) {
        const failedCompanySummary = formatCompanySummary(Array.from(failedCompanies));
        setError(
          `Some builds failed (${failedBuilds}/${totalBuilds}). Failed companies: ${failedCompanySummary || 'Unknown'}. ${failures.slice(0, 3).join(' | ')}${failures.length > 3 ? ' | ...' : ''}`
        );
      }
    } catch (err) {
      // One failed batch call is the whole run: without the per-item loop there
      // is nothing partial to report, so say so plainly rather than leaving the
      // success line to claim a number nothing produced.
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
    }
  };

  const handleGenerate = async () => {
    if (!companyName.trim()) {
      setError('Please enter a company name');
      return;
    }
    if (shouldShowRoleInput && !role.trim()) {
      setError('Please enter a role');
      return;
    }
    if (jobDescription.trim().length < 50) {
      setError('Please provide a job description (minimum 50 characters)');
      return;
    }
    if (generateMode === 'single' && !selectedProfileId) {
      setError('Please select a profile');
      return;
    }
    if (generateMode === 'multiple' && profiles.length === 0) {
      setError('No profiles available');
      return;
    }
    if (generateMode === 'multiple' && multipleTarget === 'group') {
      const selectedGroup = groups.find((group) => group.id === selectedGroupId);
      if (!selectedGroup) {
        setError('Please select a group');
        return;
      }
      if (!selectedGroup.profileIds.length) {
        setError('Selected group has no members');
        return;
      }
    }

    setIsGenerating(true);
    setError('');
    setSuccessMessage('');
    setPreviewHtml('');
    setPreviewTailored(false);
    setIsSinglePreviewOpen(false);
    resetTailoredEditor();
    setJobAnalysis(null);
    setMultiplePreviews([]);
    setMultiplePreviewTailored(false);
    setMultiplePreviewIndex(0);

    try {
      setGenerationStep('Analyzing job description...');
      clearGenerationProgress();
      const analysis = await resumeApi.analyze(jobDescription, aiRequestOverrides);
      setJobAnalysis(analysis);

      if (generateMode === 'single' && !autoGenerate) {
        setGenerationStep('Building preview...');
        const profile = profiles.find((p) => p.id === selectedProfileId);
        const templateId = profile?.preferredTemplate || 'default';
        const preview = await resumeApi.preview({
          ...aiRequestOverrides,
          profileId: selectedProfileId!,
          templateId,
          jobDescription,
          role,
          jobAnalysis: analysis,
        });
        setPreviewHtml(preview.html);
        setPreviewTailored(preview.tailored);
        setIsSinglePreviewOpen(true);
        if (preview.tailoredContent) {
          setTailoredContent(preview.tailoredContent);
          setTailoredContentDraft(JSON.stringify(preview.tailoredContent, null, 2));
          setTailoredContentError('');
        }
        setSuccessMessage('Preview generated. Review, edit manually if needed, then click Generate Resume to finalize.');
        return;
      }

      if (generateMode === 'multiple' && !autoGenerate) {
        const profileIds =
          multipleTarget === 'group'
            ? groups.find((group) => group.id === selectedGroupId)?.profileIds
            : undefined;
        if (multipleTarget === 'group' && !profileIds) {
          setError('Please select a group');
          return;
        }

        setGenerationStep('Building previews...');
        const res = await resumeApi.previewAll({
          jobDescription,
          role,
          jobAnalysis: analysis,
          profileIds,
        });
        const previewsWithDrafts = res.previews.map((preview) => ({
          ...preview,
          draft: preview.tailoredContent
            ? JSON.stringify(preview.tailoredContent, null, 2)
            : '',
          error: '',
        }));
        setMultiplePreviews(previewsWithDrafts);
        setMultiplePreviewTailored(res.tailored);
        setMultiplePreviewIndex(0);
        setSuccessMessage(`Preview generated for ${res.previews.length} profile(s). Review, then click Generate All to finalize.`);
        return;
      }


      if (generateMode === 'single') {
        const profile = profiles.find((p) => p.id === selectedProfileId);
        const templateId = profile?.preferredTemplate || 'default';
        updateGenerationProgress(1, 0, 'Building resume', profile?.name, companyName.trim());
        setGenerationStep(`Generating 1/1: ${profile?.name ?? 'Selected profile'} x ${companyName.trim()}`);
        await resumeApi.generate({
          ...aiRequestOverrides,
          profileId: selectedProfileId!,
          templateId,
          jobDescription,
          jobAnalysis: analysis,
          companyName: companyName.trim(),
          role: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
          ...getDefaultGenerationOptions(),
        });
        updateGenerationProgress(1, 1, 'Building resume', profile?.name, companyName.trim());
        setSuccessMessage('Resume generated successfully.');
        setIsSinglePreviewOpen(false);
      } else {
        const targetProfiles = getSelectedProfilesForManualBuilder();
        const res = await generateSequentialResumes({
          targetProfiles,
          analysis,
          targetCompanyName: companyName.trim(),
          resolvedRole: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
        });
        if (multipleTarget === 'group') {
          const selectedGroup = groups.find((group) => group.id === selectedGroupId)!;
          setSuccessMessage(`Generated ${res.generated} resume(s) for group "${selectedGroup.name}".`);
        } else {
          setSuccessMessage(`Generated ${res.generated} resume(s) successfully.`);
        }
        if (res.failed > 0) {
          setError(
            `Skipped ${res.failed} build(s). Failed companies: ${formatCompanySummary(res.failedCompanies) || companyName.trim()}. ${res.failures.slice(0, 3).map((failure) => `${failure.profileName}: ${failure.error}`).join(' | ')}${res.failures.length > 3 ? ' | ...' : ''}`
          );
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate resume');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
    }
  };


  const handleTailoredContentChange = (value: string) => {
    setTailoredContentDraft(value);
    if (!value.trim()) {
      setTailoredContent(null);
      setTailoredContentError('');
      return;
    }
    try {
      const parsed = JSON.parse(value) as TailoredContent;
      setTailoredContent(parsed);
      setTailoredContentError('');
    } catch {
      setTailoredContentError('Invalid JSON. Fix errors before generating.');
    }
  };

  const handleUpdatePreview = async () => {
    if (!selectedProfileId) {
      setError('Please select a profile');
      return;
    }
    if (tailoredContentError) {
      setError('Fix manual edits before updating preview.');
      return;
    }
    if (!tailoredContent) {
      setError('No tailored content to preview.');
      return;
    }

    setIsGenerating(true);
    setError('');
    setSuccessMessage('');

    try {
      setGenerationStep('Updating preview...');
      const profile = profiles.find((p) => p.id === selectedProfileId);
      const templateId = profile?.preferredTemplate || 'default';
      const preview = await resumeApi.preview({
        ...aiRequestOverrides,
        profileId: selectedProfileId!,
        templateId,
        jobDescription,
        role,
        jobAnalysis: jobAnalysis || undefined,
        tailoredContent,
      });
      setPreviewHtml(preview.html);
      setPreviewTailored(preview.tailored);
      setIsSinglePreviewOpen(true);
      setSuccessMessage('Preview updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update preview');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
    }
  };

  const handleFinalizeGenerate = async () => {
    if (!companyName.trim() || (shouldShowRoleInput && !role.trim()) || jobDescription.trim().length < 50 || !selectedProfileId) {
      setError('Please complete the required fields before generating.');
      return;
    }
    if (tailoredContentError) {
      setError('Fix manual edits before generating.');
      return;
    }

    setIsGenerating(true);
    setError('');
    setSuccessMessage('');

    try {
      const analysis = jobAnalysis || (await resumeApi.analyze(jobDescription, aiRequestOverrides));
      if (!jobAnalysis) {
        setJobAnalysis(analysis);
      }
      const profile = profiles.find((p) => p.id === selectedProfileId);
      const templateId = profile?.preferredTemplate || 'default';
      updateGenerationProgress(1, 0, 'Building resume', profile?.name, companyName.trim());
      setGenerationStep(`Generating 1/1: ${profile?.name ?? 'Selected profile'} x ${companyName.trim()}`);
      await resumeApi.generate({
        ...aiRequestOverrides,
        profileId: selectedProfileId!,
        templateId,
        jobDescription,
        jobAnalysis: analysis,
        tailoredContent: tailoredContent || undefined,
        companyName: companyName.trim(),
        role: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
        ...getDefaultGenerationOptions(),
      });
      updateGenerationProgress(1, 1, 'Building resume', profile?.name, companyName.trim());
      setSuccessMessage('Resume generated successfully.');
      setIsSinglePreviewOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate resume');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
    }
  };

  const handleMultipleDraftChange = (profileId: string, value: string) => {
    setMultiplePreviews((prev) =>
      prev.map((preview) => {
        if (preview.profileId != profileId) return preview;
        let nextError = '';
        let nextTailored = preview.tailoredContent;
        if (!value.trim()) {
          nextTailored = undefined;
        } else {
          try {
            nextTailored = JSON.parse(value) as TailoredContent;
          } catch {
            nextError = 'Invalid JSON. Fix errors before updating preview.';
          }
        }
        return {
          ...preview,
          draft: value,
          error: nextError,
          tailoredContent: nextTailored,
        };
      })
    );
  };

  const handleUpdateMultiplePreview = async (profileId: string) => {
    const preview = multiplePreviews.find((item) => item.profileId === profileId);
    if (!preview) return;
    if (preview.error) {
      setError('Fix manual edits before updating preview.');
      return;
    }
    if (!preview.tailoredContent) {
      setError('No tailored content to preview.');
      return;
    }

    setIsGenerating(true);
    setError('');
    setSuccessMessage('');

    try {
      setGenerationStep(`Updating preview for ${preview.profileName}...`);
      const profile = profiles.find((p) => p.id === profileId);
      const templateId = profile?.preferredTemplate || 'default';
      const updated = await resumeApi.preview({
        ...aiRequestOverrides,
        profileId,
        templateId,
        jobDescription,
        role,
        jobAnalysis: jobAnalysis || undefined,
        tailoredContent: preview.tailoredContent,
      });
      const nextPreviews = multiplePreviews.map((item) => {
        if (item.profileId !== profileId) return item;
        const nextTailored = updated.tailoredContent;
        return {
          ...item,
          html: updated.html,
          tailoredContent: nextTailored,
          draft: nextTailored ? JSON.stringify(nextTailored, null, 2) : '',
          error: '',
        };
      });
      setMultiplePreviews(nextPreviews);
      setSuccessMessage(`Preview updated for ${preview.profileName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update preview');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
    }
  };

  const handleFinalizeGenerateMultiple = async () => {
    if (!companyName.trim() || (shouldShowRoleInput && !role.trim()) || jobDescription.trim().length < 50) {
      setError('Please complete the required fields before generating.');
      return;
    }

    if (multipleTarget === 'group') {
      const selectedGroup = groups.find((group) => group.id === selectedGroupId);
      if (!selectedGroup) {
        setError('Please select a group');
        return;
      }
      if (!selectedGroup.profileIds.length) {
        setError('Selected group has no members');
        return;
      }
    }

    setIsGenerating(true);
    setError('');
    setSuccessMessage('');

    try {
      const analysis = jobAnalysis || (await resumeApi.analyze(jobDescription, aiRequestOverrides));
      if (!jobAnalysis) {
        setJobAnalysis(analysis);
      }

      if (!autoGenerate && multiplePreviews.length > 0) {
        const previewMap = new Map(multiplePreviews.map((p) => [p.profileId, p]));
        const targetProfiles =
          multipleTarget === 'group'
            ? profiles.filter((p) => p.id &&
                groups.find((g) => g.id === selectedGroupId)?.profileIds.includes(p.id))
            : profiles;
        const profilesToGenerate = targetProfiles.filter((profile) => previewMap.get(profile.id)?.tailoredContent);
        if (!profilesToGenerate.length) {
          throw new Error('No preview content available to generate.');
        }
        const total = profilesToGenerate.length;
        let completed = 0;

        updateGenerationProgress(total, 0, 'Preparing resume generation', undefined, companyName.trim());
        for (const profile of profilesToGenerate) {
          const preview = previewMap.get(profile.id);
          if (!preview?.tailoredContent) continue;
          const templateId = profile.preferredTemplate || 'default';
          setGenerationStep(`Generating ${completed + 1}/${total}: ${profile.name} x ${companyName.trim()}`);
          updateGenerationProgress(total, completed, 'Building resumes', profile.name, companyName.trim());
          await resumeApi.generate({
            ...aiRequestOverrides,
            profileId: profile.id,
            templateId,
            jobDescription,
            jobAnalysis: analysis,
            tailoredContent: preview.tailoredContent,
            companyName: companyName.trim(),
            role: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
            ...getDefaultGenerationOptions(),
          });
          completed += 1;
          updateGenerationProgress(total, completed, 'Building resumes', profile.name, companyName.trim());
        }
        setSuccessMessage(`Generated ${profilesToGenerate.length} resume(s) successfully.`);
        setMultiplePreviews([]);
        setMultiplePreviewIndex(0);
        setMultiplePreviewTailored(false);
        return;
      }

      const targetProfiles = getSelectedProfilesForManualBuilder();
      const res = await generateSequentialResumes({
        targetProfiles,
        analysis,
        targetCompanyName: companyName.trim(),
        resolvedRole: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
      });
      if (multipleTarget === 'group') {
        const selectedGroup = groups.find((group) => group.id === selectedGroupId)!;
        setSuccessMessage(`Generated ${res.generated} resume(s) for group "${selectedGroup.name}".`);
      } else {
        setSuccessMessage(`Generated ${res.generated} resume(s) successfully.`);
      }
      if (res.failed > 0) {
        setError(
          `Skipped ${res.failed} build(s). Failed companies: ${formatCompanySummary(res.failedCompanies) || companyName.trim()}. ${res.failures.slice(0, 3).map((failure) => `${failure.profileName}: ${failure.error}`).join(' | ')}${res.failures.length > 3 ? ' | ...' : ''}`
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate resume');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
    }
  };

  const activeMultiplePreview = multiplePreviews[multiplePreviewIndex];

  if (isLoadingData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <AppTopNav />

      {/* Main Content */}
      <main className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Generate Resumes</h1>

        {failedPairs.length > 0 && (
          <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-amber-900">
                  {failedPairs.length} build(s) failed
                </p>
                <p className="mt-0.5 text-xs text-amber-800">
                  Regenerating runs only these, with the analyses from the last run - the builds
                  that succeeded are left alone.
                </p>
              </div>
              <button
                type="button"
                onClick={regenerateFailed}
                disabled={isRegenerating || isGenerating || failedPairs.every((pair) => !pair.job)}
                className="shrink-0 rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-amber-400"
              >
                {isRegenerating ? 'Regenerating...' : 'Regenerate failed'}
              </button>
            </div>
            <ul className="mt-2 max-h-56 overflow-y-auto text-xs text-amber-900">
              {failedPairs.map((pair, index) => (
                <li key={`${pair.profileId}-${pair.sourceRowNumber ?? pair.companyName}-${index}`} className="py-0.5">
                  <span className="font-medium">
                    {pair.sourceRowNumber ? `Row ${pair.sourceRowNumber}` : pair.companyName}
                    {' - '}
                    {pair.profileName}
                  </span>
                  {': '}
                  <span className="opacity-90">{pair.error}</span>
                  {!pair.job && <span className="ml-1 italic">(cannot be re-queued)</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {shutdownReport && (
          <div
            className={`mb-6 rounded-lg border px-4 py-3 ${
              shutdownReport.shutdownAt
                ? 'border-amber-300 bg-amber-50 text-amber-900'
                : 'border-gray-200 bg-gray-50 text-gray-700'
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="text-sm">
                <p className="font-semibold">
                  {shutdownReport.shutdownAt
                    ? `This computer turns off in ${secondsToShutdown ?? shutdownReport.graceSeconds}s.`
                    : shutdownReport.scheduled
                      ? 'Shutdown cancelled. The computer stays on.'
                      : 'The computer could not be turned off, so it stays on.'}
                </p>
                <p className="mt-1">
                  {shutdownReport.reportPath
                    ? `Failed profiles written to ${shutdownReport.reportPath}.`
                    : 'The failure report could not be written.'}
                  {` ${shutdownReport.browsersClosed} AI account browser(s) closed.`}
                </p>
                {shutdownReport.note && <p className="mt-1 text-xs opacity-80">{shutdownReport.note}</p>}
              </div>
              {shutdownReport.shutdownAt ? (
                <button
                  type="button"
                  onClick={cancelShutdown}
                  disabled={isCancellingShutdown}
                  className="shrink-0 rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-amber-400"
                >
                  {isCancellingShutdown ? 'Cancelling...' : 'Cancel shutdown'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setShutdownReport(null)}
                  className="shrink-0 font-bold text-gray-500 hover:text-gray-700"
                >
                  ×
                </button>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg flex justify-between items-center">
            <span>{error}</span>
            <button onClick={() => setError('')} className="text-red-700 hover:text-red-900 font-bold">
              ×
            </button>
          </div>
        )}

        {successMessage && (
          <div className="mb-6 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg">
            {successMessage}
          </div>
        )}

        {builderMode === 'sheets' && isGenerating && generationProgress && (
          <GenerationProgress progress={generationProgress} className="mb-6" />
        )}

        {builderMode === null && (
          <div className="mb-6 grid gap-4 md:grid-cols-2">
          <button
            type="button"
            onClick={() => setBuilderMode('manual')}
            disabled={isGenerating}
            className={`rounded-xl border px-6 py-6 text-left transition ${
              builderMode === 'manual'
                ? 'border-blue-300 bg-blue-50 shadow-sm'
                : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            <div className="text-lg font-semibold text-gray-900">Building Manually</div>
            <div className="mt-2 text-sm text-gray-600">
              Original builder flow. Enter company, role, and job description manually, then preview or generate.
            </div>
          </button>

          <button
            type="button"
            onClick={() => setBuilderMode('sheets')}
            disabled={isGenerating}
            className={`rounded-xl border px-6 py-6 text-left transition ${
              builderMode === 'sheets'
                ? 'border-blue-300 bg-blue-50 shadow-sm'
                : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            <div className="text-lg font-semibold text-gray-900">Building Automatically from Google Sheet</div>
            <div className="mt-2 text-sm text-gray-600">
              Import jobs from Google Sheets, map columns once, then generate every selected profile against every imported row.
            </div>
          </button>
          </div>
        )}

        {builderMode !== null && (builderMode === 'manual' ? (
          <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setBuilderMode(null);
                  setIsSheetsImportOpen(false);
                }}
                disabled={isGenerating}
                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                Back
              </button>
            </div>
            <button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="w-full py-3 px-4 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isGenerating ? (
                <>
                  <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent"></span>
                  {generationStep || 'Generating...'}
                </>
              ) : (
                generateMode === 'single'
                  ? autoGenerate
                    ? 'Generate Resume'
                    : 'Analyze & Preview'
                  : autoGenerate
                    ? `Generate All (${profiles.length} profiles)`
                    : 'Analyze & Preview'
              )}
            </button>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">
                Generate mode
              </label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="generateMode"
                    value="single"
                    checked={generateMode === 'single'}
                    onChange={() => setGenerateMode('single')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>Single (one profile)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="generateMode"
                    value="multiple"
                    checked={generateMode === 'multiple'}
                    onChange={() => setGenerateMode('multiple')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>Multiple (all profiles)</span>
                </label>
              </div>
            </div>

            {generateMode === 'single' && (
              <ProfileSelector
                profiles={profiles}
                selectedId={selectedProfileId}
                onChange={setSelectedProfileId}
                isLoading={false}
              />
            )}

            <details className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
              <summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-200">
                Model, effort and thinking
                {hasAiOverrides && (
                  <span className="ml-2 rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                    overridden for this run
                  </span>
                )}
              </summary>
              <div className="mt-4 space-y-3">
                <AiPreferenceFields
                  idPrefix="builder-ai"
                  value={aiOverrides}
                  onChange={setAiOverrides}
                  models={modelSettings.aiModels}
                  providerLocks={modelSettings.providerLocks}
                  providerTuning={modelSettings.providerTuning}
                  effortLevels={modelSettings.aiPreferenceDefaults.effortLevels}
                  thinkingModes={modelSettings.aiPreferenceDefaults.thinkingModes}
                  inheritedFrom={inheritsFromProfile ? "profile's setting" : 'app default'}
                  inherited={inheritedChoice}
                  disabled={isGenerating}
                />
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {inheritsFromProfile
                      ? `Defaults come from ${selectedProfile?.name}. Anything set here applies to this run only.`
                      : 'Each profile uses its own default; anything set here applies to this run only.'}
                  </p>
                  {hasAiOverrides && (
                    <button
                      type="button"
                      onClick={() => setAiOverrides({})}
                      disabled={isGenerating}
                      className="shrink-0 text-xs text-blue-600 hover:underline disabled:text-gray-400"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
            </details>

            {generateMode === 'multiple' && (
              <div className="space-y-4 border border-gray-200 rounded-lg p-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Target</label>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="multipleTarget"
                        value="all"
                        checked={multipleTarget === 'all'}
                        onChange={() => setMultipleTarget('all')}
                        disabled={isGenerating}
                        className="w-4 h-4 text-blue-600"
                      />
                      <span>All profiles</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="multipleTarget"
                        value="group"
                        checked={multipleTarget === 'group'}
                        onChange={() => setMultipleTarget('group')}
                        disabled={isGenerating}
                        className="w-4 h-4 text-blue-600"
                      />
                      <span>Specific group</span>
                    </label>
                  </div>
                </div>

                {multipleTarget === 'group' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Select Group</label>
                    <select
                      value={selectedGroupId}
                      onChange={(e) => setSelectedGroupId(e.target.value)}
                      disabled={isGenerating}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Choose a group...</option>
                      {groups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name} ({group.profileIds.length})
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Company Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                disabled={isGenerating}
                placeholder="Enter company name"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {shouldShowRoleInput && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Role <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  disabled={isGenerating}
                  placeholder="Enter job role/title"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Job Description <span className="text-red-500">*</span>
              </label>
              <textarea
                value={jobDescription}
                onChange={(e) => setJobDescription(e.target.value)}
                disabled={isGenerating}
                placeholder="Paste the job description (min 50 characters)"
                rows={4}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
              <p className="text-sm text-gray-500 mt-1">{jobDescription.length} characters</p>
            </div>

            <div
              className={`flex items-center justify-between border rounded-lg p-4 transition-colors ${
                autoGenerate ? 'border-blue-200 bg-blue-50' : 'border-red-200 bg-red-50'
              }`}
            >
              <div>
                <div className="text-sm font-semibold text-gray-800">
                  {autoGenerate ? 'Auto-generate (On)' : 'Preview mode (On)'}
                </div>
                <div className="text-xs text-gray-600">
                  {autoGenerate
                    ? 'Analyze + generate in one step.'
                    : 'Analyze + preview first. Generate manually.'}
                </div>
              </div>
              <label className="inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoGenerate}
                  onChange={(e) => setAutoGenerate(e.target.checked)}
                  disabled={isGenerating}
                  className="sr-only"
                />
                <span
                  className={`relative w-11 h-6 rounded-full peer-focus:outline-none transition-colors ${
                    autoGenerate ? 'bg-blue-600' : 'bg-red-500'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 h-5 w-5 bg-white rounded-full transition-transform ${
                      autoGenerate ? 'translate-x-5' : ''
                    }`}
                  />
                </span>
              </label>
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setBuilderMode(null);
                  setIsSheetsImportOpen(false);
                }}
                disabled={isGenerating}
                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                Back
              </button>
            </div>
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
              Import a Google Sheet range where each row is one job. After column mapping, the builder will generate every selected profile against every imported row.
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">
                Build target
              </label>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="sheetsTargetMode"
                    value="single"
                    checked={sheetsTargetMode === 'single'}
                    onChange={() => setSheetsTargetMode('single')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>Single profile</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="sheetsTargetMode"
                    value="all"
                    checked={sheetsTargetMode === 'all'}
                    onChange={() => setSheetsTargetMode('all')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>All profiles</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="sheetsTargetMode"
                    value="group"
                    checked={sheetsTargetMode === 'group'}
                    onChange={() => setSheetsTargetMode('group')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>Specific group</span>
                </label>
              </div>
            </div>

            {sheetsTargetMode === 'single' && (
              <ProfileSelector
                profiles={profiles}
                selectedId={selectedSheetsProfileId}
                onChange={setSelectedSheetsProfileId}
                isLoading={false}
              />
            )}

            {sheetsTargetMode === 'group' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Select Group</label>
                <select
                  value={selectedSheetsGroupId}
                  onChange={(e) => setSelectedSheetsGroupId(e.target.value)}
                  disabled={isGenerating}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Choose a group...</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name} ({group.profileIds.length})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {shouldShowRoleInput && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Fallback Role
                </label>
                <input
                  type="text"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  disabled={isGenerating}
                  placeholder="Optional fallback if a sheet row has no mapped job title"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="mt-1 text-sm text-gray-500">
                  Leave this blank if your imported rows already include a mapped job title column.
                </p>
              </div>
            )}

            {!hasGoogleSheetSources && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                Save at least one Google Sheet in the Admin Google Sheets panel before importing jobs here.
              </div>
            )}

            <label className="flex items-start gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 cursor-pointer">
              <input
                type="checkbox"
                checked={shutdownAfterComplete}
                onChange={(e) => setShutdownAfterComplete(e.target.checked)}
                disabled={isGenerating}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm">
                <span className="font-medium text-gray-900">Turn off computer after complete</span>
                <span className="mt-0.5 block text-gray-500">
                  Writes a text file of the failed profiles and their sheet rows into the output
                  folder, closes the AI account browsers, then shuts down after a short
                  countdown you can still cancel.
                </span>
              </span>
            </label>

            <button
              type="button"
              onClick={() => {
                if (!hasGoogleSheetSources) {
                  setError('Save at least one Google Sheet in the Admin Google Sheets panel before importing.');
                  return;
                }
                setError('');
                setIsSheetsImportOpen(true);
              }}
              disabled={isGenerating}
              className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
            >
              {isGenerating ? generationStep || 'Generating...' : 'Import from Google Sheet'}
            </button>
          </div>
        ))}

        {builderMode === 'manual' && generateMode === 'multiple' && !autoGenerate && multiplePreviews.length > 0 && activeMultiplePreview && (
          <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm">
            <div className="absolute inset-4 bg-white rounded-xl shadow-2xl flex flex-col">
              <div className="flex items-center justify-between px-6 py-4 border-b">
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-semibold text-gray-900">Resume Preview</h3>
                  <span className="px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded-full">
                    {multiplePreviewIndex + 1} / {multiplePreviews.length}
                  </span>
                  {multiplePreviewTailored && (
                    <span className="px-2 py-1 bg-green-100 text-green-700 text-xs rounded-full">
                      ATS OPTIMIZATION
                    </span>
                  )}
                  <span className="text-sm text-gray-600">{activeMultiplePreview.profileName}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMultiplePreviewIndex((i) => Math.max(0, i - 1))}
                    disabled={multiplePreviewIndex === 0 || isGenerating}
                    className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setMultiplePreviewIndex((i) => Math.min(multiplePreviews.length - 1, i + 1))}
                    disabled={multiplePreviewIndex >= multiplePreviews.length - 1 || isGenerating}
                    className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    Next
                  </button>
                  <button
                    onClick={handleFinalizeGenerateMultiple}
                    disabled={isGenerating}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed font-medium transition-colors"
                  >
                    {isGenerating ? generationStep || 'Generating...' : 'Generate All'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMultiplePreviews([]);
                      setMultiplePreviewIndex(0);
                    }}
                    disabled={isGenerating}
                    className="px-3 py-2 text-sm bg-white text-gray-600 border border-gray-200 rounded-md hover:bg-gray-50"
                  >
                    Close
                  </button>
                </div>
              </div>
              <div className="flex-1 grid grid-cols-2 overflow-hidden">
                <div className="h-full overflow-y-auto bg-gray-100 p-6">
                  {isGenerating && generationProgress && (
                    <GenerationProgress progress={generationProgress} className="mb-4" />
                  )}
                  <div className="resume-paper-shell bg-white shadow-lg mx-auto max-w-[816px]">
                    <iframe
                      srcDoc={activeMultiplePreview.html}
                      className="w-full h-[1056px] border-0"
                      title={`Resume Preview - ${activeMultiplePreview.profileName}`}
                    />
                  </div>
                </div>
                <div className="h-full overflow-y-auto border-l p-6 space-y-6">
                  <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
                    <div className="text-sm font-medium text-gray-700 mb-2">Manual Edits (JSON)</div>
                    <textarea
                      value={activeMultiplePreview.draft}
                      onChange={(e) => handleMultipleDraftChange(activeMultiplePreview.profileId, e.target.value)}
                      rows={8}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Edit tailored content JSON here."
                    />
                    {activeMultiplePreview.error && (
                      <p className="text-sm text-red-600 mt-2">{activeMultiplePreview.error}</p>
                    )}
                    <div className="mt-3 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => handleUpdateMultiplePreview(activeMultiplePreview.profileId)}
                        disabled={isGenerating || !!activeMultiplePreview.error}
                        className="px-3 py-2 text-sm bg-gray-800 text-white rounded-md hover:bg-gray-900 disabled:bg-gray-400"
                      >
                        Update Preview
                      </button>
                      <span className="text-xs text-gray-500">
                        Apply edits to preview before final generate.
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {builderMode === 'manual' && generateMode === 'single' && previewHtml && (
          <ResumePreview
            html={previewHtml}
            onGenerate={handleFinalizeGenerate}
            isGenerating={isGenerating}
            isTailored={previewTailored}
            isOpen={isSinglePreviewOpen}
            onClose={() => setIsSinglePreviewOpen(false)}
            generationStep={generationStep}
            sidebar={
              <>
                <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
                  <div className="text-sm font-medium text-gray-700 mb-2">Manual Edits (JSON)</div>
                  <textarea
                    value={tailoredContentDraft}
                    onChange={(e) => handleTailoredContentChange(e.target.value)}
                    rows={8}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Edit tailored content JSON here."
                  />
                  {tailoredContentError && (
                    <p className="text-sm text-red-600 mt-2">{tailoredContentError}</p>
                  )}
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleUpdatePreview}
                      disabled={isGenerating || !!tailoredContentError}
                      className="px-3 py-2 text-sm bg-gray-800 text-white rounded-md hover:bg-gray-900 disabled:bg-gray-400"
                    >
                      Update Preview
                    </button>
                    <span className="text-xs text-gray-500">
                      Apply edits to preview before final generate.
                    </span>
                  </div>
                </div>
              </>
            }
          />
        )}

        {builderMode === 'manual' && generateMode === 'single' && previewHtml && !isSinglePreviewOpen && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setIsSinglePreviewOpen(true)}
              className="px-3 py-2 text-sm bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Open Preview
            </button>
          </div>
        )}
      </main>

      <SheetsImportModal
        isOpen={isSheetsImportOpen}
        isSubmitting={isGenerating}
        showJobTitleMapping={shouldShowRoleInput}
        sources={modelSettings.googleSheetsSources}
        selectedSourceId={selectedSheetsSourceId}
        selectedProfileName={selectedSheetsProfileName}
        generationProgress={generationProgress}
        onSelectSource={setSelectedSheetsSourceId}
        onClose={() => setIsSheetsImportOpen(false)}
        onConfirm={handleImportJobsFromSheets}
      />

      {/* Footer */}
      <footer className="mt-auto py-6 text-center text-sm text-gray-500">
        <p>Tailored Resume Builder - Powered by your Claude subscription, with OpenAI, Anthropic and DeepSeek as options</p>
      </footer>
    </div>
  );
}
