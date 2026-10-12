const assert = require('node:assert/strict');
const test = require('node:test');

const { launchBrowser, closeBrowser } = require('../dist/config/browser');
const { readChatSite } = require('../dist/services/ai/providers/browserChat/sites');
const { wrapPuppeteerPage } = require('../dist/services/ai/providers/browserChat/page');

/**
 * ChatGPT serves two conversation markups, and this app has to read both.
 *
 * WHAT WAS REPORTED: "chatgpt account responded with resume json file but our
 * project didn't get the json result." The answer was on the screen and this
 * app read an empty transcript, waited out its whole deadline, and failed.
 *
 * MEASURED ON TWO SIGNED-IN BROWSERS AT THE SAME MINUTE, which is what settles
 * it - this is a rollout, not a version change, so "it works on mine" proves
 * nothing:
 *
 *   port 9222   [data-message-author-role="assistant"]        1 node, 10162 chars
 *               [data-markdown-text-style="assistant-message"]  0 nodes
 *   port 9223   [data-message-author-role="assistant"]        0 nodes
 *               [data-markdown-text-style="assistant-message"]  1 node, 8295 chars
 *
 * Neither page had a single `article` or `data-message-author-role` between
 * them in the new case. The shapes below are cut down from those two pages, and
 * the selectors come from the real site definition, so narrowing that list is
 * what fails here.
 */

const site = readChatSite('chatgpt-web', {});
const ANSWER = '@@BEGIN_JSON@@\n{\n"title": "Software Engineer"\n}\n@@END_JSON@@';

/** The markup ChatGPT served before the rebuild. */
const OLD_MARKUP = `<!DOCTYPE html><html><body>
<article data-testid="conversation-turn-1">
  <div data-message-author-role="user" data-message-id="u1">tailor this resume</div>
</article>
<article data-testid="conversation-turn-2">
  <div data-message-author-role="assistant" data-message-id="a1" class="agent-turn">${ANSWER}</div>
</article>
</body></html>`;

/**
 * ...and the rebuilt one. No `article`, no `data-message-author-role` anywhere -
 * the role is carried by `data-markdown-text-style` instead, and the turn by a
 * search-unit key ending in ":assistant".
 */
const NEW_MARKUP = `<!DOCTYPE html><html><body>
<div class="w-full">
  <div data-markdown-text-style="user-message"><p>tailor this resume</p></div>
</div>
<div data-content-search-unit-key="fallback-turn-0:1:assistant"
     data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">
  <div class="block">
    <div data-chatgpt-selection-message-id="8f507057" class="group flex min-w-0 flex-col">
      <div data-markdown-text-style="assistant-message" class="MarkdownRoot">
        <div data-dil-message-id="8f507057"><p>${ANSWER}</p></div>
      </div>
    </div>
  </div>
</div>
</body></html>`;

/** What the driver does: the first candidate that matches wins. */
async function readAnswer(page) {
  const chat = wrapPuppeteerPage(page);
  for (const candidate of site.assistant) {
    if ((await chat.count(candidate)) > 0) {
      const messages = await chat.messages(candidate);
      return { candidate, messages };
    }
  }
  return { candidate: null, messages: [] };
}

test('the answer is read from both of ChatGPT\'s markups', async (t) => {
  const browser = await launchBrowser();
  t.after(() => closeBrowser(browser));
  const page = await browser.newPage();

  for (const [name, markup, expected] of [
    ['the old markup', OLD_MARKUP, '[data-message-author-role="assistant"]'],
    ['the rebuilt markup', NEW_MARKUP, '[data-markdown-text-style="assistant-message"]'],
  ]) {
    await page.setContent(markup, { waitUntil: 'load' });
    const { candidate, messages } = await readAnswer(page);

    assert.equal(candidate, expected, `${name}: matched the wrong candidate`);
    assert.equal(messages.length, 1, `${name}: expected exactly the assistant's message`);
    const text = (messages[0].text || '').trim();
    assert.ok(text.startsWith('@@BEGIN_JSON@@'), `${name}: ${JSON.stringify(text.slice(0, 60))}`);
    assert.ok(text.endsWith('@@END_JSON@@'), `${name}: the answer was cut short`);
    // The prompt must not come back as the answer: an assistant selector that
    // also matches the user's turn hands the prompt straight back, which the
    // driver reports as an echo and the operator sees as nonsense.
    assert.ok(!text.includes('tailor this resume'), `${name}: the user's own message was included`);
  }
});

test('the old candidates are still tried first, so old tabs are untouched', () => {
  /*
   * Order is the whole compatibility story. The two lists do not overlap, so
   * putting the new ones last means a tab on the old markup resolves to exactly
   * the selector it always did - and the new ones are only ever reached on a
   * page where nothing else matched.
   */
  const order = site.assistant;
  assert.equal(order[0], '[data-message-author-role="assistant"]');
  assert.ok(
    order.indexOf('[data-markdown-text-style="assistant-message"]') > order.indexOf('.agent-turn'),
    'the rebuilt-markup selectors belong after the ones that predate them'
  );
  // The search-unit key carries a "ChatGPT said:" preamble, so it is a fallback
  // for the cleaner one rather than a peer of it.
  assert.ok(
    order.indexOf('[data-chatgpt-search-unit-key$=":assistant"]')
      > order.indexOf('[data-markdown-text-style="assistant-message"]'),
    'the preamble-carrying selector is the last resort'
  );
});
