import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { getOutputStorageSettings } from '../config/aiModelConfig';
import { closeAllAccountBrowsers } from './ai';

/**
 * "Turn off computer after complete".
 *
 * WHAT THIS IS FOR. A 500-resume run takes hours, and the operator starts it and
 * leaves. Three things have to happen at the end of one, in this order:
 *
 *   1. The failures are written to a text file, because the console scrollback
 *      and the page's red banner both die with the machine. This is the only
 *      record that survives to the morning, so it is written FIRST and awaited -
 *      a report that loses the race with the shutdown is worth nothing.
 *   2. The account browsers are closed, so the next start is clean rather than
 *      fifty windows restored by Chrome's crash recovery.
 *   3. The machine is turned off.
 *
 * NOTHING HERE RUNS UNLESS THE OPERATOR ASKED FOR IT on that run. There is no
 * setting that arms this quietly and no default that turns anything off: the
 * flag rides on the one request, and a run started without it behaves as before.
 *
 * The shutdown is ISSUED WITH A DELAY rather than immediately, and the delay is
 * the point: Windows shows its own countdown, and `shutdown /a` - the Cancel
 * button on the page, and `abortPendingShutdown` here - calls it off. Turning
 * off someone's machine is not an undoable thing, so there is a window in which
 * a person who did not mean it can say so.
 */

export type RunFailure = {
  /** Absent for a job that failed before any profile was paired with it. */
  profileName?: string;
  companyName: string;
  /** The sheet row, which is the handle an operator actually re-runs. */
  sourceRowNumber?: number;
  error: string;
};

export type RunOutcome = {
  /** Profile x job units the run set out to build. */
  totalUnits: number;
  /** How many profiles were in the run, for "failed for every profile". */
  profileCount: number;
  failures: RunFailure[];
  /** Jobs that failed analysis, so no profile ever reached a build. */
  priorFailures?: RunFailure[];
};

/**
 * How long Windows counts down before it goes off.
 *
 * Long enough that someone sitting at the machine can read the notice and press
 * Cancel; short enough that it is not still waiting when they come back. The
 * report and the browsers are both already dealt with before this starts.
 */
export const SHUTDOWN_GRACE_SECONDS = 90;

/**
 * How long the browsers get to close before the shutdown goes ahead anyway.
 *
 * A browser that will not quit must not keep the machine on all night. Chrome is
 * killed by the shutdown itself in that case, which is untidy and harmless - the
 * accounts stay signed in either way, because a profile outlives its window.
 */
const BROWSER_CLOSE_TIMEOUT_MS = 60_000;

export type ShutdownDeps = {
  /** Runs a program. Injected so no test ever turns off a real machine. */
  run?: (file: string, args: string[]) => Promise<void>;
  closeBrowsers?: () => Promise<Array<{ closed: boolean }>>;
  writeReport?: (outcome: RunOutcome, now: Date) => Promise<string>;
  platform?: NodeJS.Platform;
  graceSeconds?: number;
  now?: () => Date;
  log?: (message: string) => void;
};

export type ShutdownResult = {
  /** Where the record landed, or null if it could not be written. */
  reportPath: string | null;
  browsersClosed: number;
  /** False when the shutdown command itself refused. */
  scheduled: boolean;
  /** When the machine goes off, so the page can count down to the same moment. */
  shutdownAt: number | null;
  graceSeconds: number;
  note?: string;
};

const runProgram = (file: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, args, (error) => (error ? reject(error) : resolve()));
  });

/** `2026-10-06_07-12-04`, which sorts and is legal in a file name on both platforms. */
function stamp(now: Date): string {
  const pad = (value: number) => `${value}`.padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  );
}

const order = (values: Array<number | string>): Array<number | string> =>
  [...values].sort((a, b) =>
    typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))
  );

/** The row number if the job has one, and its company in quotes if it does not. */
const handleFor = (failure: RunFailure): number | string =>
  failure.sourceRowNumber ?? `"${failure.companyName}"`;

/**
 * Failures grouped the two ways that matter, shared by the console summary at
 * the end of every run and by the file an armed run leaves behind.
 *
 * One grouping rather than two: the console and the file disagreeing about which
 * rows failed would be worse than either of them being wrong on its own.
 */
export function groupFailures(
  failures: RunFailure[],
  profileCount: number
): { rowsByProfile: Map<string, Array<number | string>>; failedForEveryProfile: Array<number | string> } {
  const rowsByProfile = new Map<string, Set<number | string>>();
  const profilesByRow = new Map<number | string, Set<string>>();

  for (const failure of failures) {
    const name = failure.profileName ?? '(unknown profile)';
    const row = handleFor(failure);
    if (!rowsByProfile.has(name)) rowsByProfile.set(name, new Set());
    (rowsByProfile.get(name) as Set<number | string>).add(row);
    if (!profilesByRow.has(row)) profilesByRow.set(row, new Set());
    (profilesByRow.get(row) as Set<string>).add(name);
  }

  return {
    rowsByProfile: new Map([...rowsByProfile].map(([name, rows]) => [name, order([...rows])])),
    failedForEveryProfile: order(
      [...profilesByRow.entries()]
        .filter(([, names]) => profileCount > 0 && names.size >= profileCount)
        .map(([row]) => row)
    ),
  };
}

/**
 * The report, as plain text.
 *
 * ORGANISED THE WAY A RE-RUN IS: by profile, because that is the unit the
 * operator re-queues, and by sheet row inside each, because that is what they
 * open to read the posting. A row that failed for EVERY profile is called out
 * separately - that is a problem with the job, an unreadable posting or a
 * description that never downloaded, and no amount of re-running fixes it, while
 * a row that failed for one profile of three is the ordinary transient kind.
 *
 * The same grouping is what the console prints at the end of a run; this is that
 * summary written somewhere that outlives the machine being turned off.
 */
export function renderRunReport(outcome: RunOutcome, now: Date): string {
  const priorFailures = outcome.priorFailures ?? [];
  const failures = outcome.failures;
  const failedUnits = failures.length;
  const delivered = Math.max(0, outcome.totalUnits - failedUnits);
  const lines: string[] = [];

  lines.push('Free Tailor - run report');
  lines.push(`Finished: ${now.toLocaleString()}`);
  lines.push(
    `Builds: ${outcome.totalUnits} requested, ${delivered} delivered, ${failedUnits} failed` +
      ` (across ${outcome.profileCount} profile(s))`
  );
  lines.push('');

  if (failedUnits === 0 && priorFailures.length === 0) {
    lines.push(`All ${outcome.totalUnits} build(s) succeeded. Nothing to re-run.`);
    lines.push('');
    return lines.join('\r\n');
  }

  if (failedUnits > 0) {
    const { rowsByProfile, failedForEveryProfile } = groupFailures(failures, outcome.profileCount);

    lines.push('FAILED PROFILES');
    const width = Math.max(...[...rowsByProfile.keys()].map((name) => name.length));
    for (const [name, rows] of rowsByProfile) {
      lines.push(`  ${name.padEnd(width)}  ${rows.length} job(s): row ${rows.join(', ')}`);
    }
    lines.push('');

    if (failedForEveryProfile.length > 0) {
      lines.push('FAILED FOR EVERY PROFILE - look at the job, not the run');
      lines.push(`  row ${failedForEveryProfile.join(', ')}`);
      lines.push('');
    }
  }

  if (priorFailures.length > 0) {
    // These never reached a build at all, so they are absent from the counts
    // above and would otherwise go unrecorded.
    lines.push('NEVER REACHED A BUILD - the job analysis failed, so every profile was lost');
    for (const failure of priorFailures) {
      lines.push(`  row ${handleFor(failure)}  ${failure.companyName}  - ${failure.error}`);
    }
    lines.push('');
  }

  lines.push('DETAIL');
  for (const failure of [...priorFailures, ...failures]) {
    const who = failure.profileName ? `  ${failure.profileName}` : '';
    lines.push(`  row ${handleFor(failure)}  ${failure.companyName}${who}  - ${failure.error}`);
  }
  lines.push('');

  return lines.join('\r\n');
}

/**
 * Writes the report beside the resumes the run produced.
 *
 * In the output directory rather than beside the server: that folder is the one
 * the operator opens in the morning, and a report in the install directory is a
 * report nobody finds. CRLF line endings, because this is opened in Notepad.
 */
export async function writeRunReport(outcome: RunOutcome, now: Date): Promise<string> {
  const { outputBaseDir } = await getOutputStorageSettings();
  const file = path.join(outputBaseDir, `failed_profiles_${stamp(now)}.txt`);
  await fs.mkdir(outputBaseDir, { recursive: true });
  await fs.writeFile(file, renderRunReport(outcome, now), 'utf8');
  return file;
}

/** The command that turns this platform off, and the one that calls it back off. */
function shutdownCommand(platform: NodeJS.Platform, seconds: number): { file: string; args: string[] } {
  if (platform === 'win32') {
    return {
      file: 'shutdown',
      args: ['/s', '/t', `${seconds}`, '/c', 'Free Tailor: the run has finished.'],
    };
  }
  // `+minutes` is all `shutdown` takes here, and it rounds up: a 90-second grace
  // becomes two minutes rather than none.
  return { file: 'shutdown', args: ['-h', `+${Math.max(1, Math.ceil(seconds / 60))}`] };
}

function abortCommand(platform: NodeJS.Platform): { file: string; args: string[] } {
  return platform === 'win32'
    ? { file: 'shutdown', args: ['/a'] }
    : { file: 'shutdown', args: ['-c'] };
}

let pending: { shutdownAt: number; graceSeconds: number } | null = null;

/** What the page counts down against, and null once it has been called off. */
export function pendingShutdown(): { shutdownAt: number; graceSeconds: number } | null {
  return pending;
}

/**
 * The end of an armed run: write the record, close the browsers, go off.
 *
 * Sequential on purpose. The report is the only thing that survives the machine
 * powering down, so it is finished before anything else is attempted, and a
 * failure to write it does NOT cancel the shutdown - the operator asked for the
 * machine to be off, and losing the summary is not a reason to leave it running
 * all night. Every step is reported in the return value instead.
 */
export async function shutdownAfterRun(
  outcome: RunOutcome,
  deps: ShutdownDeps = {}
): Promise<ShutdownResult> {
  const run = deps.run ?? runProgram;
  const closeBrowsers = deps.closeBrowsers ?? (() => closeAllAccountBrowsers());
  const writeReport = deps.writeReport ?? ((value: RunOutcome, now: Date) => writeRunReport(value, now));
  const platform = deps.platform ?? process.platform;
  const graceSeconds = deps.graceSeconds ?? SHUTDOWN_GRACE_SECONDS;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message: string) => console.log(message));

  const at = now();
  let reportPath: string | null = null;
  try {
    reportPath = await writeReport(outcome, at);
    log(`[Shutdown] Run report written to ${reportPath}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`[Shutdown] Could not write the run report: ${detail}`);
  }

  let browsersClosed = 0;
  try {
    const results = await Promise.race([
      closeBrowsers(),
      new Promise<Array<{ closed: boolean }>>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`browsers did not close within ${BROWSER_CLOSE_TIMEOUT_MS / 1000}s`)),
          BROWSER_CLOSE_TIMEOUT_MS
        ).unref?.()
      ),
    ]);
    browsersClosed = results.filter((row) => row.closed).length;
    log(`[Shutdown] Closed ${browsersClosed} of ${results.length} account browser(s).`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`[Shutdown] Could not close the account browsers: ${detail}`);
  }

  const command = shutdownCommand(platform, graceSeconds);
  try {
    await run(command.file, command.args);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`[Shutdown] The shutdown command failed, so the machine stays on: ${detail}`);
    return { reportPath, browsersClosed, scheduled: false, shutdownAt: null, graceSeconds, note: detail };
  }

  const shutdownAt = at.getTime() + graceSeconds * 1000;
  pending = { shutdownAt, graceSeconds };
  log(`[Shutdown] The machine goes off in ${graceSeconds}s. Cancel on the page, or run "shutdown /a".`);
  return { reportPath, browsersClosed, scheduled: true, shutdownAt, graceSeconds };
}

/** The Cancel button. Safe to call when nothing is pending; says so if so. */
export async function abortPendingShutdown(
  deps: Pick<ShutdownDeps, 'run' | 'platform' | 'log'> = {}
): Promise<{ aborted: boolean; note?: string }> {
  const run = deps.run ?? runProgram;
  const platform = deps.platform ?? process.platform;
  const log = deps.log ?? ((message: string) => console.log(message));

  const command = abortCommand(platform);
  try {
    await run(command.file, command.args);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // The usual reason is that nothing was scheduled - Windows says so with its
    // own error - and the state the caller asked for is the state we are in.
    pending = null;
    return { aborted: false, note: detail };
  }
  pending = null;
  log('[Shutdown] Cancelled. The machine stays on.');
  return { aborted: true };
}

export function resetPendingShutdownForTests(): void {
  pending = null;
}
