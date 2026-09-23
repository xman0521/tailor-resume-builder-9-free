import type { Page } from 'puppeteer';
import type { ChatSiteId } from './sites';

/**
 * Clearing an account browser's chat list, when the operator asks.
 *
 * WHY IT IS NEEDED. Every call starts a fresh conversation - that is what makes
 * the reply latch sound - so a batch of 500 resumes leaves 500 chats in the
 * account. Across fifty registered browsers that is a list nobody can use.
 * Run from a button on the Settings page, never by itself.
 *
 * WHY THROUGH THE PAGE. The work runs as a script inside the tab that is
 * already signed in, so it acts as the account the operator signed in with and
 * needs no key, no password and no cookie handling here. Driving the site's own
 * menus instead would mean hundreds of clicks per browser against markup that
 * changes; one request per conversation is both faster and steadier.
 *
 * WHAT IT DELETES. Everything in the account, which is what was asked for.
 * These browsers are registered as accounts this app drives, but the rule is
 * worth stating plainly: a conversation somebody started themselves in one of
 * these windows is deleted too, and deletion is not reversible.
 *
 * Both scripts are SELF-CONTAINED. Puppeteer serialises the function and runs
 * it in the browser, so it cannot reach anything in this module - no imports,
 * no helpers from outside its own body. They are exported so the tests can call
 * them directly against a stubbed `fetch`, which is the only way to check them
 * without an account.
 */

export type HistoryClearResult = {
  /** Conversations the site confirmed gone. */
  deleted: number;
  /** Conversations it refused to delete. */
  failed: number;
  /** Why nothing happened, when nothing did. */
  note?: string;
};

export async function clearClaudeHistory(): Promise<HistoryClearResult> {
  // Declared INSIDE the function, like everything else these two use: the body
  // is serialised and run in the browser, where this module does not exist.
  const MAX_PAGES = 400;
  const PAGE_SIZE = 50;
  // Deletes in flight at once. The site answers one at a time slowly enough
  // that 500 in a row is most of a minute; a handful together is not a burst.
  const PARALLEL = 6;

  const read = async (url: string): Promise<{ ok: boolean; status: number; body: unknown }> => {
    const response = await fetch(url, { credentials: 'include' });
    const body = response.ok ? await response.json().catch(() => null) : null;
    return { ok: response.ok, status: response.status, body };
  };

  // Which organisation a conversation belongs to is part of its address, and a
  // free account can still have more than one.
  const organizations = await read('/api/organizations');
  const orgs = Array.isArray(organizations.body) ? (organizations.body as Array<{ uuid?: string }>) : [];
  if (!organizations.ok || orgs.length === 0) {
    return { deleted: 0, failed: 0, note: `could not list organizations (HTTP ${organizations.status})` };
  }

  let deleted = 0;
  let failed = 0;
  for (const org of orgs) {
    const uuid = typeof org?.uuid === 'string' ? org.uuid : '';
    if (!uuid) continue;

    for (let round = 0; round < MAX_PAGES; round += 1) {
      // Always from the start: the list shrinks as this goes, so an advancing
      // offset would step over the conversations that moved up behind it.
      const list = await read(`/api/organizations/${uuid}/chat_conversations?limit=${PAGE_SIZE}&offset=0`);
      const conversations = Array.isArray(list.body) ? (list.body as Array<{ uuid?: string }>) : [];
      if (!list.ok || conversations.length === 0) break;

      const ids = conversations
        .map((conversation) => (typeof conversation?.uuid === 'string' ? conversation.uuid : ''))
        .filter(Boolean);

      let removedThisRound = 0;
      for (let at = 0; at < ids.length; at += PARALLEL) {
        const outcomes = await Promise.all(
          ids.slice(at, at + PARALLEL).map((id) =>
            fetch(`/api/organizations/${uuid}/chat_conversations/${id}`, {
              method: 'DELETE',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
            })
              .then((response) => response.ok)
              .catch(() => false)
          )
        );
        for (const ok of outcomes) {
          if (ok) {
            deleted += 1;
            removedThisRound += 1;
          } else {
            failed += 1;
          }
        }
      }

      // The same page came back and none of it could be deleted. Asking again
      // would return the same page forever.
      if (removedThisRound === 0) break;
    }
  }

  return { deleted, failed };
}

export async function clearChatGptHistory(): Promise<HistoryClearResult> {
  const MAX_PAGES = 400;
  const PAGE_SIZE = 50;

  const session = await fetch('/api/auth/session', { credentials: 'include' });
  const credentials = session.ok
    ? ((await session.json().catch(() => null)) as { accessToken?: string } | null)
    : null;
  const token = credentials?.accessToken;
  if (!token) {
    return { deleted: 0, failed: 0, note: `no signed-in session (HTTP ${session.status})` };
  }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const count = async (): Promise<number> => {
    const response = await fetch('/backend-api/conversations?offset=0&limit=1&order=updated', {
      credentials: 'include',
      headers,
    });
    if (!response.ok) return 0;
    const body = (await response.json().catch(() => null)) as { total?: number } | null;
    return typeof body?.total === 'number' ? body.total : 0;
  };

  const total = await count();
  if (total === 0) return { deleted: 0, failed: 0 };

  // The site's own "delete all": one request for the whole list. Tried first
  // because a 500-chat account is 500 requests otherwise.
  const bulk = await fetch('/backend-api/conversations', {
    method: 'PATCH',
    credentials: 'include',
    headers,
    body: JSON.stringify({ is_visible: false }),
  });
  if (bulk.ok) return { deleted: total - (await count()), failed: 0 };

  let deleted = 0;
  let failed = 0;
  for (let round = 0; round < MAX_PAGES; round += 1) {
    const response = await fetch(`/backend-api/conversations?offset=0&limit=${PAGE_SIZE}&order=updated`, {
      credentials: 'include',
      headers,
    });
    if (!response.ok) break;
    const body = (await response.json().catch(() => null)) as { items?: Array<{ id?: string }> } | null;
    const items = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0) break;

    let removedThisRound = 0;
    for (const item of items) {
      const id = typeof item?.id === 'string' ? item.id : '';
      if (!id) continue;
      // Hiding a conversation IS deleting it here; the site has no other verb.
      const hidden = await fetch(`/backend-api/conversation/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers,
        body: JSON.stringify({ is_visible: false }),
      });
      if (hidden.ok) {
        deleted += 1;
        removedThisRound += 1;
      } else {
        failed += 1;
      }
    }
    if (removedThisRound === 0) break;
  }

  return { deleted, failed };
}

export function historyScriptFor(id: ChatSiteId): () => Promise<HistoryClearResult> {
  return id === 'claude-web' ? clearClaudeHistory : clearChatGptHistory;
}

/**
 * Runs the site's script in a tab that is already on that site.
 *
 * The caller supplies the page, because it is the caller that knows the tab is
 * signed in and is not in the middle of answering something.
 */
export async function clearSiteHistory(id: ChatSiteId, page: Page): Promise<HistoryClearResult> {
  return page.evaluate(historyScriptFor(id)) as Promise<HistoryClearResult>;
}
