/**
 * Live progress for a batch that runs inside one HTTP request.
 *
 * WHY THIS EXISTS. `/generate-multi-job` builds the whole profile x job grid in
 * a single request, which is what lets it run every browser at once. The cost
 * was the progress bar: the page knew the batch had started and nothing else
 * until the response came back, so a 360-resume run sat on "0 / 360" for an
 * hour and read as frozen. It also said "preparing resume generation" the whole
 * time, because zero completed means nothing has started.
 *
 * So the batch reports each unit as it lands, here, and the page subscribes
 * over SSE. Deliberately in memory and deliberately small: this is a local
 * single-process app, and progress for a run that is no longer happening is
 * worth nothing to anybody.
 */

export type BatchProgress = {
  total: number;
  completed: number;
  failed: number;
  phase: string;
  /** What finished most recently, for the line under the bar. */
  profileName?: string;
  companyName?: string;
  done: boolean;
};

type Listener = (progress: BatchProgress) => void;

type Entry = {
  progress: BatchProgress;
  listeners: Set<Listener>;
  /** Cleared whenever anything happens, so an abandoned run is collected. */
  expiresAt: number;
};

/**
 * How long a run is remembered after its last update.
 *
 * Long enough that a page reloading mid-batch can re-attach and still see the
 * bar move; short enough that a browser left open for a week is not holding
 * yesterday's runs.
 */
const IDLE_TTL_MS = 10 * 60_000;

const runs = new Map<string, Entry>();

function sweep(now: number): void {
  for (const [id, entry] of runs) {
    if (entry.expiresAt <= now && entry.listeners.size === 0) runs.delete(id);
  }
}

function entryFor(id: string, total: number, now: number): Entry {
  const existing = runs.get(id);
  if (existing) return existing;
  const created: Entry = {
    progress: { total, completed: 0, failed: 0, phase: 'Starting', done: false },
    listeners: new Set(),
    expiresAt: now + IDLE_TTL_MS,
  };
  runs.set(id, created);
  return created;
}

/** Opens a run, or re-opens one a reconnecting page is already watching. */
export function startBatch(id: string, total: number, phase: string, now: number = Date.now()): void {
  sweep(now);
  const entry = entryFor(id, total, now);
  entry.progress = { ...entry.progress, total, phase, done: false };
  entry.expiresAt = now + IDLE_TTL_MS;
  publish(entry);
}

/** One unit finished, for better or worse. */
export function advanceBatch(
  id: string,
  outcome: { ok: boolean; profileName?: string; companyName?: string },
  now: number = Date.now()
): void {
  const entry = runs.get(id);
  if (!entry) return;
  entry.progress = {
    ...entry.progress,
    completed: entry.progress.completed + 1,
    failed: entry.progress.failed + (outcome.ok ? 0 : 1),
    profileName: outcome.profileName,
    companyName: outcome.companyName,
  };
  entry.expiresAt = now + IDLE_TTL_MS;
  publish(entry);
}

export function setBatchPhase(id: string, phase: string, now: number = Date.now()): void {
  const entry = runs.get(id);
  if (!entry) return;
  entry.progress = { ...entry.progress, phase };
  entry.expiresAt = now + IDLE_TTL_MS;
  publish(entry);
}

/**
 * The run is over.
 *
 * Kept for a moment rather than deleted, so the last event reaches a listener
 * that is about to be told to close - and so a page that subscribes a beat late
 * is told "done" instead of waiting on a run that will never report again.
 */
export function finishBatch(id: string, now: number = Date.now()): void {
  const entry = runs.get(id);
  if (!entry) return;
  entry.progress = { ...entry.progress, done: true };
  entry.expiresAt = now + 30_000;
  publish(entry);
}

function publish(entry: Entry): void {
  for (const listener of entry.listeners) {
    try {
      listener(entry.progress);
    } catch {
      // A listener whose socket has gone is not the batch's problem.
    }
  }
}

/**
 * Watches a run. Returns an unsubscribe, and fires once immediately with
 * whatever is known - including for a run that has not started yet, which is
 * the ordinary case: the page subscribes before it POSTs.
 */
export function watchBatch(
  id: string,
  listener: Listener,
  now: number = Date.now()
): () => void {
  sweep(now);
  const entry = entryFor(id, 0, now);
  entry.listeners.add(listener);
  // Guarded like every later event. A listener whose socket died between the
  // request arriving and this line would otherwise throw straight out of the
  // route handler, turning one dead client into a failed request.
  try {
    listener(entry.progress);
  } catch {
    // Its problem, not the batch's.
  }
  return () => {
    entry.listeners.delete(listener);
  };
}

export function getBatchProgress(id: string): BatchProgress | null {
  return runs.get(id)?.progress ?? null;
}

export function resetBatchProgressForTests(): void {
  runs.clear();
}
