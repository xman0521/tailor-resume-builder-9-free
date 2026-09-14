const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveAiChoice } = require('../dist/config/aiPreferences');
const { getAdminAppSettings, updateAppSettings } = require('../dist/config/aiModelConfig');
const { resolveBatchCapacity } = require('../dist/services/ai/batchCapacity');
const { HYBRID_MODEL_ID } = require('../dist/config/providerCatalog');

/**
 * Two failures, both of which made choosing hybrid a no-op.
 *
 * 1. The "Default AI model" dropdown was built from `aiModels`, the stored rows
 *    the Models editor edits. Hybrid is not a row - it is synthesized whenever
 *    both free chat providers have a runnable model - so the only control for
 *    the app default could not offer the one option the router understands.
 *
 * 2. `resolveAiChoice` read the hybrid flag from the PREFERENCE alone. With no
 *    run override and no profile preference, the app default decides - and an
 *    app default of hybrid produced a record from one site with no route on the
 *    choice. Calls went to whichever site ranked first, the other account's
 *    browsers stayed idle, and the batch width was counted from one site.
 */

async function withDefaultModel(modelId, run) {
  const before = await getAdminAppSettings();
  const original = before.defaultModelId;
  await updateAppSettings({ defaultModelId: modelId });
  try {
    return await run();
  } finally {
    await updateAppSettings({ defaultModelId: original });
  }
}

test('the admin payload separates what may be edited from what may be chosen', async () => {
  const settings = await getAdminAppSettings();

  assert.ok(Array.isArray(settings.pickableModels), 'pickableModels should be served');
  assert.equal(
    settings.aiModels.some((model) => model.id === HYBRID_MODEL_ID),
    false,
    'hybrid is not a stored row and must not appear in the editor list'
  );
  assert.equal(
    settings.pickableModels.some((model) => model.id === HYBRID_MODEL_ID),
    true,
    'hybrid must appear in the list the default-model picker is built from'
  );
});

test('an app default of hybrid sticks instead of being rewritten', async () => {
  await withDefaultModel(HYBRID_MODEL_ID, async () => {
    const settings = await getAdminAppSettings();
    assert.equal(settings.defaultModelId, HYBRID_MODEL_ID);
  });
});

test('an app default of hybrid puts the hybrid route on the choice', async () => {
  await withDefaultModel(HYBRID_MODEL_ID, async () => {
    // No run override and no profile preference: the app default decides.
    const choice = await resolveAiChoice(undefined, null);
    assert.equal(choice.route, 'hybrid', 'the route was dropped, so only one site would be used');
    assert.match(choice.modelLabel, /hybrid/i);
  });
});

test('hybrid width counts both sites, a single-site default counts one', async () => {
  const both = await withDefaultModel(HYBRID_MODEL_ID, async () =>
    resolveBatchCapacity(await resolveAiChoice(undefined, null))
  );
  const one = await withDefaultModel('chatgpt-web-chat', async () =>
    resolveBatchCapacity(await resolveAiChoice(undefined, null))
  );

  assert.ok(
    both.limit >= one.limit,
    `hybrid width ${both.limit} should not be below single-site width ${one.limit}`
  );
  assert.match(both.reason, /claude-web \+ .*chatgpt-web/, `hybrid reason was "${both.reason}"`);
});

test('a run override still wins over the app default', async () => {
  await withDefaultModel('chatgpt-web-chat', async () => {
    const choice = await resolveAiChoice({ modelId: HYBRID_MODEL_ID }, null);
    assert.equal(choice.route, 'hybrid');
  });
});

test('a non-hybrid default carries no route', async () => {
  await withDefaultModel('chatgpt-web-chat', async () => {
    const choice = await resolveAiChoice(undefined, null);
    assert.equal(choice.route, undefined, 'only hybrid should set a route');
  });
});
