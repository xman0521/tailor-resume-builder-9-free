import { AsyncSemaphore } from '../services/ai/concurrency';

/**
 * How many documents may be rendered to PDF at once.
 *
 * WHY THIS EXISTS. The batch width is taken from how many chat browsers are
 * registered, because that is what bounds the MODEL calls. But every item that
 * finishes a model call then renders a document, and rendering is a different
 * resource entirely: a resume takes a tab in the shared Chrome, and a cover
 * letter launches a whole Chrome of its own. Fifty browsers therefore meant
 * fifty simultaneous renders, and `MAX_BATCH_CONCURRENCY` was holding the line
 * for both - its comment claimed "the render fan-out is bounded separately",
 * and it was not. This is that separate bound.
 *
 * Process-wide rather than per-batch, because the resource is the machine: two
 * requests arriving at once must not each get the full allowance.
 */
const DEFAULT_RENDER_CONCURRENCY = 4;

/** A ceiling on the knob, so a typo cannot ask for hundreds of Chromes. */
const MAX_RENDER_CONCURRENCY = 16;

export function renderConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.PDF_RENDER_CONCURRENCY || '', 10);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_RENDER_CONCURRENCY;
  return Math.min(MAX_RENDER_CONCURRENCY, raw);
}

let semaphore: AsyncSemaphore | null = null;
let semaphoreLimit = 0;

function renderSemaphore(): AsyncSemaphore {
  const limit = renderConcurrency();
  // Rebuilt when the knob changes, which in practice is only ever in tests -
  // the environment does not move under a running process.
  if (!semaphore || semaphoreLimit !== limit) {
    semaphore = new AsyncSemaphore(limit);
    semaphoreLimit = limit;
  }
  return semaphore;
}

/**
 * Runs `render` with a rendering permit held, releasing it however it ends.
 *
 * The permit covers the WHOLE render - opening the page, loading the HTML and
 * writing the file - not just the `page.pdf()` call. Holding it for the narrow
 * call only would let fifty tabs exist at once and merely take turns on the
 * last step, which is the memory problem this exists to prevent.
 */
export async function withRenderPermit<T>(render: () => Promise<T>): Promise<T> {
  const release = await renderSemaphore().acquire();
  try {
    return await render();
  } finally {
    release();
  }
}

export function getRenderConcurrencyStats(): {
  limit: number;
  inFlight: number;
  queued: number;
  peak: number;
} {
  const current = renderSemaphore();
  return {
    limit: current.size,
    inFlight: current.inFlight,
    queued: current.queued,
    peak: current.peak,
  };
}

/** Drops the shared semaphore so a test can set the knob and start clean. */
export function resetRenderConcurrencyForTests(): void {
  semaphore = null;
  semaphoreLimit = 0;
}
