const assert = require('node:assert/strict');
const test = require('node:test');

const { useTempStorage } = require('./helpers');

useTempStorage('openrouter');

const {
  getProviderDescriptor,
  coerceProviderId,
  AI_PROVIDER_IDS,
} = require('../dist/config/providerCatalog');

/**
 * OpenRouter: one API key, many vendors' models.
 *
 * THE ID HAS A HISTORY. `openrouter` was a provider here before, was removed,
 * and left behind a read-time alias mapping it to the keyless `claude-cli`
 * seat. Re-adding the provider meant reclaiming the string, which is only safe
 * because the three paths that alias was written for are each covered:
 *
 *   - a restored backup carries its own `provider_schema_version`, so the boot
 *     runner re-runs migration 001 against it;
 *   - the legacy `ai-models.json` importer calls `migrate001` itself;
 *   - a hand-edited row in a database already at version 2 is somebody naming
 *     the CURRENT provider.
 *
 * The migration is versioned, so it can never run again and convert a NEW
 * OpenRouter row into a CLI one. That is the property worth pinning here,
 * because getting it wrong would quietly reroute a metered provider onto a
 * subscription seat - or the reverse, which is the invisible-spend failure
 * this app separates those ids to avoid.
 */

test('the provider is registered, keyed from the environment, and billed', () => {
  const descriptor = getProviderDescriptor('openrouter');

  assert.equal(descriptor.label, 'OpenRouter');
  assert.equal(descriptor.envKeyVar, 'OPENROUTER_API_KEY');
  assert.equal(descriptor.requiresApiKey, true);
  assert.equal(descriptor.credentialKind, 'api-key');
  // Not locked: an API key is all it needs, and anyone can get one.
  assert.equal(descriptor.locked, false);

  // It must NOT claim the legacy enable flag. `openrouterEnabled` belongs to
  // claude-cli now - that is what the old flag meant once the provider was
  // replaced - and reclaiming it would switch the CLI seat's setting.
  assert.equal(descriptor.legacyEnabledField, null);
});

test('the id means OpenRouter again, and is no longer an alias for the CLI seat', () => {
  assert.equal(coerceProviderId('openrouter'), 'openrouter');
  assert.equal(coerceProviderId(' openrouter '), 'openrouter', 'a stored string may carry whitespace');
  assert.equal(coerceProviderId('claude-cli'), 'claude-cli', 'and the seat is untouched');
  assert.ok(AI_PROVIDER_IDS.includes('openrouter'));
});

test('adding it did not reorder the providers that were already here', () => {
  /*
   * `order` is also the order `getDefaultEnabledProvider` walks, so inserting
   * OpenRouter among the existing entries would change which provider a fresh
   * install falls back to. It goes last instead.
   */
  const order = (id) => getProviderDescriptor(id).order;
  assert.equal(order('claude-cli'), 0);
  assert.equal(order('claude'), 1);
  assert.equal(order('openai'), 2);
  assert.equal(order('deepseek'), 3);
  assert.equal(order('claude-web'), 4);
  assert.equal(order('chatgpt-web'), 5);
  assert.equal(order('openrouter'), 6, 'last, so nothing else moved');
});

test('a transport is registered, so a call reaches OpenRouter rather than throwing', () => {
  /*
   * The registry is a Map, not an exhaustive record, so a provider in the
   * catalogue with no adapter compiles perfectly and fails at the first call
   * with "No transport is registered". Only a lookup catches that.
   */
  const { getAdapter } = require('../dist/services/ai/registry');
  const adapter = getAdapter('openrouter');

  assert.equal(adapter.capabilities.id, 'openrouter');
  assert.equal(adapter.capabilities.requiresApiKey, true);
  assert.equal(adapter.capabilities.credentialKind, 'api-key');
});

test('a call with no key says which key, and does not reach the network', async () => {
  const original = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = '';
  try {
    const { getAdapter } = require('../dist/services/ai/registry');
    await assert.rejects(
      () =>
        getAdapter('openrouter').complete({
          modelName: 'openai/gpt-4o-mini',
          stableSystem: 'You are a test.',
          volatileSystem: '',
          userBody: 'hello',
          responseFormat: 'text',
        }),
      (error) => {
        assert.match(error.detail ?? error.message, /API key is not set/);
        // Names the variable to set, rather than leaving the operator to guess.
        assert.match(error.adminAction ?? '', /OPENROUTER_API_KEY/);
        return true;
      }
    );
  } finally {
    if (original === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = original;
  }
});

test('the seeded models carry the vendor prefix an OpenRouter id needs', async () => {
  /*
   * "gpt-4o-mini" is a 404 there; "openai/gpt-4o-mini" is the model. Seeding a
   * bare name would hand every new install a model that cannot answer.
   */
  const { getAdminAppSettings } = require('../dist/config/aiModelConfig');
  const settings = await getAdminAppSettings();
  const seeded = settings.aiModels.filter((model) => model.provider === 'openrouter');

  assert.ok(seeded.length >= 1, 'at least one OpenRouter model is offered out of the box');
  for (const model of seeded) {
    assert.match(
      model.modelName,
      /^[a-z0-9-]+\//,
      `${model.modelName} is missing its vendor prefix`
    );
  }
});

/*
 * ─── Reaching an install that already exists ────────────────────────────────
 *
 * A seed list is only read by a FRESH install: `writeSettings` persists the
 * whole settings object, so anyone who has ever saved anything carries an
 * explicit `aiModels` array the seeds cannot reach. Registering the provider,
 * wiring its adapter and reading its key all worked - and no model in the
 * picker named OpenRouter, so there was no way to run one. That is what
 * migration 003 fixes, and it is the same gap migration 002 was written for.
 */

const fs = require('node:fs');
const nodePath = require('node:path');
const Database = require('better-sqlite3');

const SETTINGS_KEY = 'app-settings';

function settingsWithModels(models) {
  return JSON.stringify({
    defaultMode: 'preview',
    defaultModelId: 'free-hybrid',
    providersEnabled: { 'claude-web': true, openrouter: true },
    aiModels: models,
  });
}

function withDb(name, run) {
  const dir = fs.mkdtempSync(nodePath.join(require('node:os').tmpdir(), `ft-${name}-`));
  const db = new Database(nodePath.join(dir, 'probe.db'));
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  try {
    return run(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const readSettings = (db) =>
  JSON.parse(db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTINGS_KEY).value);

test('an install with an explicit model list is given the OpenRouter models', () => {
  const { migrate003 } = require('../dist/database/migrations/003_seed_openrouter_models');

  withDb('or-seed', (db) => {
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      SETTINGS_KEY,
      settingsWithModels([
        { id: 'free-hybrid', name: 'Hybrid (free)', provider: 'claude-web', modelName: 'chat', enabled: true },
        { id: 'openai-gpt-5-1', name: 'gpt-5.1', provider: 'openai', modelName: 'gpt-5.1', enabled: true },
      ]),
      'now'
    );

    const report = migrate003(db);
    assert.equal(report.seededModels, 2);
    assert.equal(report.settingsRewritten, true);

    const settings = readSettings(db);
    const added = settings.aiModels.filter((model) => model.provider === 'openrouter');
    assert.equal(added.length, 2);
    for (const model of added) {
      assert.match(model.modelName, /^[a-z0-9-]+\//, 'the vendor prefix is part of an OpenRouter id');
      assert.equal(model.enabled, true);
    }

    // APPENDED, never prepended: whatever is first is what an unset default
    // falls back to, and a metered provider must not become that.
    assert.equal(settings.aiModels[0].id, 'free-hybrid');

    // And the default is left exactly where it was. An install whose default
    // costs nothing today still costs nothing after this runs.
    assert.equal(settings.defaultModelId, 'free-hybrid');
  });
});

test('an operator who already added an OpenRouter model is not given duplicates', () => {
  // Keyed on the PROVIDER, not the seed id: a model of their own under a name
  // they chose covers it, and a second row would be a duplicate in the picker.
  const { migrate003 } = require('../dist/database/migrations/003_seed_openrouter_models');

  withDb('or-dupe', (db) => {
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      SETTINGS_KEY,
      settingsWithModels([
        { id: 'mine', name: 'My router model', provider: 'openrouter', modelName: 'x-ai/grok-2', enabled: true },
      ]),
      'now'
    );

    const report = migrate003(db);
    assert.equal(report.seededModels, 0);
    assert.equal(report.settingsRewritten, false);
    assert.equal(readSettings(db).aiModels.length, 1);
  });
});

test('a row that never pinned a model list is left to inherit the seeds', () => {
  /*
   * Writing a list here would freeze that inheritance for good - the mistake
   * migration 002's own comment calls out, where an install that had simply
   * never touched the model library would lose every provider's models.
   */
  const { migrate003 } = require('../dist/database/migrations/003_seed_openrouter_models');

  withDb('or-implicit', (db) => {
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      SETTINGS_KEY,
      JSON.stringify({ defaultMode: 'preview', providersEnabled: { 'claude-web': true } }),
      'now'
    );

    const report = migrate003(db);
    assert.equal(report.seededModels, 0);
    assert.equal(report.settingsRewritten, false);
    assert.equal('aiModels' in readSettings(db), false, 'the row must keep inheriting');
  });
});

test('a settings row that is not usable JSON is reported, not destroyed', () => {
  const { migrate003 } = require('../dist/database/migrations/003_seed_openrouter_models');

  withDb('or-broken', (db) => {
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      SETTINGS_KEY,
      '{ not json at all',
      'now'
    );

    const report = migrate003(db);
    assert.equal(report.settingsRewritten, false);
    assert.ok(report.notes.some((note) => /not valid JSON/.test(note)));
    // Untouched, so an operator can still fix it by hand.
    assert.equal(db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTINGS_KEY).value, '{ not json at all');
  });
});

test('running it twice adds nothing the second time', () => {
  // The runner is versioned and will not call it twice, but a migration that
  // is not idempotent is one restored backup away from duplicating rows.
  const { migrate003 } = require('../dist/database/migrations/003_seed_openrouter_models');

  withDb('or-twice', (db) => {
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      SETTINGS_KEY,
      settingsWithModels([{ id: 'free-hybrid', name: 'Hybrid', provider: 'claude-web', modelName: 'chat', enabled: true }]),
      'now'
    );

    assert.equal(migrate003(db).seededModels, 2);
    assert.equal(migrate003(db).seededModels, 0, 'the second run is a no-op');
    assert.equal(readSettings(db).aiModels.filter((m) => m.provider === 'openrouter').length, 2);
  });
});
