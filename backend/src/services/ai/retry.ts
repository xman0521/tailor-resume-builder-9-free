import { isAIProviderError } from './errors';

/**
 * Retrying one item of a batch, so a transient refusal does not cost a resume.
 *
 * WHY THIS EXISTS. A 500-resume run finished with 76 failures, nearly all of
 * them a browser that took the prompt and then did not answer in time. Every
 * one of those was already marked `retryable`, and nothing was retrying them:
 * the failover inside a single call tries the OTHER free account once and then
 * gives up, which is the right scope for "this account is walled" and the wrong
 * one for "that turn went wrong". The unit of work that matters to an operator
 * is the resume, and until now nothing owned retrying it.
 *
 * Deliberately at the BATCH level rather than inside the provider. A retry here
 * goes back through the tab pool, so the second attempt takes whichever browser
 * is free rather than insisting on the one that just failed - which is the
 * whole reason a retry has any chance of a different outcome.
 */

/** Retries per item, on top of the first attempt. */
const DEFAULT_ATTEMPTS = 3;

/** A ceiling, so a misconfigured value cannot turn a batch into an afternoon. */
const MAX_ATTEMPTS = 6;

const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;

export function unitAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.AI_UNIT_ATTEMPTS || '', 10);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_ATTEMPTS;
  return Math.min(MAX_ATTEMPTS, raw);
}

/**
 * Whether trying again could plausibly go differently.
 *
 * The provider already answers this for its own errors, and that answer is
 * taken as final: `auth`, `disabled`, `locked` and `binaryMissing` say
 * something about the installation that a second attempt cannot change, and
 * hammering them would turn one clear message into three.
 *
 * Anything that is NOT an AIProviderError is retried once or twice on purpose.
 * Those are the unclassified faults - a socket closing, a tab that went away
 * mid-read - and they are exactly the population that a retry helps most.
 */
export function isRetryableFailure(error: unknown): boolean {
  if (isAIProviderError(error)) return error.retryable;
  // A deliberate cancellation is not a failure to retry.
  if (error instanceof Error && /abort|cancel/i.test(error.name)) return false;
  return true;
}

/**
 * How long to wait before trying again.
 *
 * A provider that said when to come back is believed - a rate limit answers
 * this question better than any formula. Otherwise exponential, with jitter so
 * that twenty units failing together do not all come back in the same instant
 * and fail together again.
 */
export function backoffMs(
  attempt: number,
  error: unknown,
  random: () => number = Math.random
): number {
  if (isAIProviderError(error) && typeof error.retryAfterSeconds === 'number') {
    return Math.min(MAX_BACKOFF_MS, Math.max(0, error.retryAfterSeconds * 1_000));
  }
  const exponential = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential * (0.5 + random() * 0.5));
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Retry wait aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export type RetryOptions = {
  attempts?: number;
  signal?: AbortSignal;
  /** Called before each wait, so a batch can say why it is going round again. */
  onRetry?: (info: { attempt: number; attempts: number; waitMs: number; error: unknown }) => void;
  random?: () => number;
};

/**
 * Runs `work`, trying again while the failure looks transient.
 *
 * Returns the first success. Throws the LAST error when every attempt fails,
 * not the first: the last one is the state the system is actually in, and is
 * what the operator's failure list should name.
 */
export async function withUnitRetry<T>(
  work: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? unitAttempts());
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await work(attempt);
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) throw error;
      if (attempt >= attempts || !isRetryableFailure(error)) throw error;

      const waitMs = backoffMs(attempt, error, options.random);
      options.onRetry?.({ attempt, attempts, waitMs, error });
      await sleep(waitMs, options.signal);
    }
  }

  throw lastError;
}
