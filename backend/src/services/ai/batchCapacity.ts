import {
  BROWSER_CHAT_MAX_ENDPOINTS,
  getBrowserChatEndpoints,
  type BrowserChatEndpoint,
} from '../../config/aiModelConfig';
import { isBrowserChatSiteId, type BrowserChatSiteId } from '../../config/providerCatalog';
import { countLiveBrowsers } from './browserLiveness';
import { planRoute, type FreeChatRoute } from './freeChatRouting';
import type { AIProvider } from '../../types/template';

/**
 * How many items of a batch may be in flight at once.
 *
 * The number is a property of the CHOSEN PROVIDER, not of the batch, and that
 * is the whole of this module. A fixed fan-out cannot be right for both of the
 * things this app runs on:
 *
 * - The free chat providers hold one conversation per browser window. Two
 *   prompts typed into one composer do not queue, they interleave, and both
 *   answers are lost - so the ceiling is exactly how many debug browsers the
 *   operator started for that site, and a fan-out above it is not extra
 *   throughput but a queue with a longer wait at the end of it.
 * - The subscription seat spawns a process per call and its ceiling is
 *   `AI_CLI_CONCURRENCY`.
 *
 * Fixed at four, a batch on one browser queued three calls behind every answer,
 * while a batch on six browsers left four of them idle for the whole run. Both
 * of those look like the app being slow and neither is visible from the page.
 *
 * The queues themselves already exist and are not this module's business: the
 * tab pool hands a free browser to the head of its line as each one is
 * released, and the CLI semaphore does the same for process slots. This only
 * decides how much work to offer them, and offering exactly their capacity is
 * what keeps every tab busy without piling up a queue nobody can see.
 */

/** An operator override. Set, it wins over everything worked out below. */
function configuredOverride(env: NodeJS.ProcessEnv): number | null {
  const raw = Number.parseInt(env.AI_BATCH_CONCURRENCY || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

/**
 * Where the fan-out lands when nothing else can be worked out.
 *
 * The metered HTTP providers have no local resource to count - their limit is
 * the vendor's, not this machine's - so they keep the number this app has
 * always used for them.
 */
const DEFAULT_BATCH_CONCURRENCY = 4;

/**
 * A ceiling on the whole thing, whatever the arithmetic says.
 *
 * Raised from 16 to match `BROWSER_CHAT_MAX_ENDPOINTS`, so registering more
 * browsers now actually buys more parallelism instead of stopping at sixteen.
 *
 * This used to carry a second job it could not do. Each in-flight item is a
 * model call AND, later, a document render - a tab in the shared Chrome for a
 * resume, a whole Chrome of its own for a cover letter - and the comment here
 * claimed the render fan-out was "bounded separately" when nothing bounded it
 * at all. So this number was quietly holding the line for both, and lifting it
 * without fixing that would have turned fifty browsers into fifty simultaneous
 * renders. `generators/renderConcurrency` is now that separate bound, and this
 * one is free to be about model calls alone.
 */
const MAX_BATCH_CONCURRENCY = BROWSER_CHAT_MAX_ENDPOINTS;

/** Mirrors `AI_CLI_CONCURRENCY` in claudeCli/options, bounds included. */
export function cliConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.AI_CLI_CONCURRENCY || '', 10);
  if (!Number.isInteger(raw)) return 4;
  return Math.min(32, Math.max(1, raw));
}

function countBrowsers(endpoints: BrowserChatEndpoint[], site: BrowserChatSiteId): number {
  return endpoints.filter((entry) => entry.siteId === site).length;
}

export type BatchCapacity = {
  /** How many batch items to run at once. */
  limit: number;
  /** Why, in one clause, for the line the route logs. */
  reason: string;
};

/**
 * The capacity for one resolved choice.
 *
 * `route` matters as much as `provider`: a hybrid run has both free accounts to
 * spend, so its capacity is both sites' browsers added together. That is the
 * arrangement the three-queue setup describes - Claude's browsers, ChatGPT's
 * browsers, and the seat's process slots, each pulling from its own line as it
 * frees up - and the only thing the batch has to get right is offering enough
 * work to keep all of them fed.
 */
/**
 * Reads how many browsers are up. Injectable for the same reason `env` is:
 * the real one opens sockets to localhost, so a test that did not supply its
 * own would be asserting against whatever the developer happens to be running.
 */
export type LiveBrowserReader = (
  endpoints: BrowserChatEndpoint[]
) => Promise<Map<BrowserChatSiteId, number> | null>;

export async function resolveBatchCapacity(
  choice: { provider: AIProvider; route?: FreeChatRoute },
  env: NodeJS.ProcessEnv = process.env,
  readLive: LiveBrowserReader = countLiveBrowsers
): Promise<BatchCapacity> {
  const override = configuredOverride(env);
  if (override !== null) {
    return { limit: override, reason: `AI_BATCH_CONCURRENCY=${override}` };
  }

  if (choice.provider === 'claude-cli') {
    // The same variable and the same default the CLI provider's own semaphore
    // is built from, read here rather than imported because that reader takes
    // no environment and these have to be testable. `batchCapacity.test.js`
    // pins the two to the same answer.
    const limit = cliConcurrency(env);
    return { limit, reason: `${limit} Claude CLI slot${limit === 1 ? '' : 's'}` };
  }

  if (choice.route === 'hybrid' || isBrowserChatSiteId(choice.provider)) {
    const endpoints = await readEndpoints();
    const sites =
      choice.route === 'hybrid'
        ? planRoute('hybrid')
        : [choice.provider as BrowserChatSiteId];

    /*
     * Counted from browsers that are RUNNING, not merely registered.
     *
     * A registration is a settings row; it does not open Chrome. Sixteen rows
     * and two running browsers used to produce a batch sixteen wide and a queue
     * fourteen deep, and since one deadline covers both the queue wait and the
     * answer, the tail of that queue reached the composer with nothing left and
     * failed as "still writing when the deadline passed" - blaming the model for
     * time the queue had spent.
     *
     * When the probe cannot answer at all, the registered count is used, the way
     * it always was: not knowing is not the same as knowing nothing is up.
     */
    const live = await readLive(endpoints);
    const counted = sites.map((site) => ({
      site,
      browsers: live?.get(site) ?? countBrowsers(endpoints, site),
      registered: countBrowsers(endpoints, site),
    }));
    const total = counted.reduce((sum, entry) => sum + entry.browsers, 0);

    // One, not zero, when nothing is registered. A batch that refuses to run
    // because no browser is configured would report a capacity problem where
    // the real one is "there is no browser" - which the first call says far
    // better, and says once rather than per item.
    const limit = Math.min(MAX_BATCH_CONCURRENCY, Math.max(1, total));
    // Says "2 of 16" rather than "2" when some are registered but down, so the
    // log line explains a narrow batch instead of just reporting one.
    const described = counted
      .map((entry) =>
        entry.browsers === entry.registered
          ? `${entry.browsers} ${entry.site}`
          : `${entry.browsers} of ${entry.registered} ${entry.site}`
      )
      .join(' + ');
    return { limit, reason: `${described} browser${total === 1 ? '' : 's'} running` };
  }

  return {
    limit: DEFAULT_BATCH_CONCURRENCY,
    reason: `${DEFAULT_BATCH_CONCURRENCY} by default for ${choice.provider}`,
  };
}

/**
 * Never throws.
 *
 * Reading the endpoints touches the settings database, and a batch must not
 * fail over a number it only needs in order to go faster. An unreadable
 * settings row means one at a time, which is what this app did before any of
 * this existed.
 */
async function readEndpoints(): Promise<BrowserChatEndpoint[]> {
  try {
    return await getBrowserChatEndpoints();
  } catch {
    return [];
  }
}
