import { probeDebugBrowser } from '../debugBrowser';
import {
  BROWSER_CHAT_SITE_IDS,
  type BrowserChatSiteId,
} from '../../config/providerCatalog';
import type { BrowserChatEndpoint } from '../../config/aiModelConfig';

/**
 * How many of the registered chat browsers are actually up.
 *
 * WHY THIS EXISTS. Batch width was taken from how many browsers are REGISTERED,
 * which is a settings row, not a running process. An operator who registers
 * sixteen and starts two gets a queue fourteen deep, and because one deadline
 * covers both the queue wait and the answer, the tail of that queue reaches the
 * composer with nothing left and fails as "still writing when the deadline
 * passed". The registration count was never the thing that could do the work.
 *
 * The probe behind this is the same one the Settings page shows "running, tab
 * open" from, so the number the batch uses and the number an operator can see
 * come from one source.
 */

/**
 * Long enough that a batch does not re-probe per item, short enough that
 * starting a browser is noticed within one resume. The probe is two small HTTP
 * calls per port against localhost, so this is about tidiness, not cost.
 */
const CACHE_MS = 15_000;

/**
 * "Running" is the bar, not "tab open".
 *
 * The pool opens the site's tab itself when a browser has none, so a running
 * Chrome with no tab yet can still take work - the Settings page calls that
 * state "running, no tab yet" and it is usable. Requiring an open tab would
 * undercount a browser that is merely idle.
 */
type LiveCounts = Map<BrowserChatSiteId, number>;

let cached: { at: number; key: string; counts: LiveCounts } | null = null;

const keyOf = (endpoints: BrowserChatEndpoint[]): string =>
  endpoints
    .map((entry) => `${entry.siteId}:${entry.port}`)
    .sort()
    .join(',');

/**
 * Live browser counts per site, or null when the question could not be
 * answered.
 *
 * Null rather than zeroes on failure, and the difference matters: the caller
 * falls back to the registered count, because "the probe did not run" is not
 * the same as "nothing is running", and only the second is grounds for
 * narrowing a batch to one.
 */
export async function countLiveBrowsers(
  endpoints: BrowserChatEndpoint[],
  now: () => number = Date.now
): Promise<LiveCounts | null> {
  if (endpoints.length === 0) return new Map();

  const key = keyOf(endpoints);
  if (cached && cached.key === key && now() - cached.at < CACHE_MS) {
    return new Map(cached.counts);
  }

  const probes = await Promise.all(
    endpoints.map(async (entry) => {
      try {
        const status = await probeDebugBrowser(entry.port);
        return { siteId: entry.siteId, running: status.running };
      } catch {
        // One unreachable port is a browser that is down, which is exactly what
        // this is measuring. Only a total failure is "could not answer".
        return { siteId: entry.siteId, running: false };
      }
    })
  );

  const counts: LiveCounts = new Map(BROWSER_CHAT_SITE_IDS.map((site) => [site, 0]));
  for (const probe of probes) {
    if (probe.running) counts.set(probe.siteId, (counts.get(probe.siteId) ?? 0) + 1);
  }

  cached = { at: now(), key, counts: new Map(counts) };
  return new Map(counts);
}

/** Drops the cache so a test, or a just-started browser, is seen at once. */
export function resetBrowserLivenessCache(): void {
  cached = null;
}
