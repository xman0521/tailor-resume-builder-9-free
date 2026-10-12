'use client';

export type GenerationProgressState = {
  total: number;
  completed: number;
  phase: string;
  currentProfileName?: string;
  currentCompanyName?: string;
  currentJobTitle?: string;
  currentJobNumber?: number;
  importedJobCount?: number;
  /**
   * How many of `completed` failed.
   *
   * `completed` counts an item that finished, for better or worse, so a run
   * where everything failed still reads "10 / 15" and looks like progress.
   * The operator who reported that had no way to tell the two apart.
   */
  failed?: number;
  /** Why the most recent failure failed, as the server described it. */
  lastError?: string;
  /**
   * What is being worked on right now.
   *
   * The first item of a run can take minutes against a free chat browser, and
   * until it landed this panel said "preparing resume generation" with a bar
   * at zero - which reads as a hang rather than as work.
   */
  inFlight?: string[];
};

type GenerationProgressProps = {
  progress: GenerationProgressState;
  className?: string;
};

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function pluralizeJob(count: number): string {
  return count === 1 ? 'job' : 'jobs';
}

export default function GenerationProgress({ progress, className = '' }: GenerationProgressProps) {
  const activeIndex = progress.currentProfileName || progress.currentCompanyName
    ? Math.min(progress.completed + 1, progress.total)
    : Math.min(progress.completed, progress.total);
  const displayedPercent = progress.total > 0
    ? clampPercentage(((progress.completed + (activeIndex > progress.completed ? 0.45 : 0)) / progress.total) * 100)
    : 0;
  const completedLabel = `${Math.min(progress.completed, progress.total)} / ${progress.total}`;
  const failedCount = Math.min(progress.failed ?? 0, progress.completed);
  // Every one so far. Worth saying outright rather than leaving somebody to
  // work it out from a bar that is moving.
  const allFailing = failedCount > 0 && failedCount >= progress.completed;
  const inFlight = progress.inFlight ?? [];
  const isSheetsImport = typeof progress.importedJobCount === 'number';
  const jobDetails = [progress.currentCompanyName, progress.currentJobTitle].filter(Boolean).join(' - ');
  const jobDetailsSuffix = jobDetails ? ` - ${jobDetails}` : '';
  const sheetsStatus = (() => {
    if (!isSheetsImport) return '';

    const importedJobCount = progress.importedJobCount ?? 0;
    if (progress.phase.toLowerCase().includes('analyz')) {
      const currentJobNumber = Math.min(progress.currentJobNumber ?? 1, importedJobCount || 1);
      return `Imported ${importedJobCount} ${pluralizeJob(importedJobCount)}, now analyzing job ${currentJobNumber} of ${importedJobCount}${jobDetailsSuffix}`;
    }

    if (activeIndex > 0) {
      return `Imported ${importedJobCount} ${pluralizeJob(importedJobCount)}, now building resume ${activeIndex} of ${progress.total}${jobDetailsSuffix}`;
    }

    // Only truly preparing when nothing has started. Once units are in flight
    // this said "preparing" for minutes while five resumes were being written.
    if (inFlight.length > 0) {
      return `Imported ${importedJobCount} ${pluralizeJob(importedJobCount)}, building ${inFlight.length} resume(s)`;
    }
    return `Imported ${importedJobCount} ${pluralizeJob(importedJobCount)}, preparing resume generation`;
  })();

  return (
    <div className={`rounded-xl border border-blue-200 bg-blue-50/80 px-4 py-4 ${className}`.trim()}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-blue-900">{progress.phase}</div>
          <div className="mt-1 text-sm text-blue-800">
            {isSheetsImport
              ? sheetsStatus
              : activeIndex > 0 ? `Resume ${activeIndex} of ${progress.total}` : `Preparing ${progress.total} resume(s)`}
          </div>
          {!isSheetsImport && (
            <div className="mt-1 text-sm text-blue-700">
              {progress.currentProfileName
                ? `Building ${progress.currentProfileName}${progress.currentCompanyName ? ` for ${progress.currentCompanyName}` : ''}`
                : 'Preparing generation queue'}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-medium text-blue-900">{completedLabel}</div>
          {failedCount > 0 && (
            <div className="text-sm font-semibold text-red-700">{failedCount} failed</div>
          )}
        </div>
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ease-out ${
            allFailing ? 'bg-red-500' : 'bg-blue-600'
          }`}
          style={{ width: `${displayedPercent}%` }}
        />
      </div>

      {inFlight.length > 0 && (
        <div className="mt-3 text-sm text-blue-800">
          <span className="font-medium">{inFlight.length} in progress</span>
          {': '}
          {inFlight.slice(0, 3).join(', ')}
          {inFlight.length > 3 ? ` and ${inFlight.length - 3} more` : ''}
        </div>
      )}

      {failedCount > 0 && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <span className="font-semibold">
            {allFailing
              ? 'Every build so far has failed, so nothing is being saved.'
              : `${failedCount} of ${progress.completed} finished builds failed.`}
          </span>
          {/* The server's own words. Guessing at a cause here was worse than
              saying nothing: the reason is known, it was just never sent. */}
          {progress.lastError && <span className="mt-1 block">{progress.lastError}</span>}
        </div>
      )}
    </div>
  );
}
