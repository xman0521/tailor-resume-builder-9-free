import type Database from 'better-sqlite3';

/**
 * Gives an existing install the OpenRouter models it never got.
 *
 * The same shape of gap migration 002 was written for, and for the same
 * reason: a seed list is only ever read by a FRESH install, because
 * `writeSettings` persists the whole settings object, so any install that had
 * once saved anything carries an explicit `aiModels` array the new seeds
 * cannot reach. The provider was registered, its adapter was wired, its key
 * was read from the environment, `providersEnabled` even listed it - and no
 * model in the picker named it, so there was no way to run one.
 *
 * Raw JSON and raw SQL, for the same reason as 001 and 002: a migration that
 * runs through the validators only works on rows that did not need migrating.
 */

export const OPENROUTER_SCHEMA_VERSION = 3;
export const SETTINGS_KEY = 'app-settings';

type Json = Record<string, unknown>;

/**
 * Two, not a catalogue.
 *
 * OpenRouter fronts hundreds of models and the list moves weekly, so a long
 * seed list is one that goes stale inside somebody's database. These are the
 * two ends of the range this app actually uses - a cheap one for analysing a
 * posting, a stronger one for tailoring - and any other id can be added under
 * Admin > Models.
 *
 * THE VENDOR PREFIX IS PART OF THE ID. "gpt-4o-mini" is a 404 on OpenRouter;
 * "openai/gpt-4o-mini" is the model. A seed without one would hand every
 * upgraded install a model that cannot answer.
 */
const OPENROUTER_SEED_MODELS = [
  {
    id: 'openrouter-gpt-4o-mini',
    name: 'GPT-4o mini (OpenRouter)',
    provider: 'openrouter',
    modelName: 'openai/gpt-4o-mini',
    description: 'Cheap, and fine for job analysis. Billed per token through OpenRouter.',
  },
  {
    id: 'openrouter-claude-sonnet-4',
    name: 'Claude Sonnet 4 (OpenRouter)',
    provider: 'openrouter',
    modelName: 'anthropic/claude-sonnet-4',
    description: 'Anthropic Sonnet through OpenRouter, for resume tailoring and cover letters.',
  },
];

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type OpenRouterMigrationReport = {
  ran: boolean;
  settingsRewritten: boolean;
  seededModels: number;
  notes: string[];
};

export function migrate003(db: Database.Database): OpenRouterMigrationReport {
  const report: OpenRouterMigrationReport = {
    ran: true,
    settingsRewritten: false,
    seededModels: 0,
    notes: [],
  };

  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTINGS_KEY) as
    | { value?: string }
    | undefined;

  if (!row?.value) {
    // Fresh install: the seed list already carries both models.
    return report;
  }

  let settings: unknown;
  try {
    settings = JSON.parse(row.value);
  } catch (error) {
    report.notes.push(
      `Left the settings row untouched because it is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return report;
  }

  if (!isObject(settings)) {
    report.notes.push('Left the settings row untouched because it is not a JSON object.');
    return report;
  }

  // Only where the row pins an explicit list: a row without one inherits the
  // seed list at read time and already has these, and writing a list here
  // would freeze that inheritance for good.
  if (!Array.isArray(settings.aiModels)) {
    return report;
  }

  const models = settings.aiModels as unknown[];
  // Keyed on the PROVIDER, not the seed id. An operator who has already added
  // an OpenRouter model of their own has it covered, and a second row would be
  // a duplicate in their picker.
  const alreadyHasOpenRouter = models
    .filter(isObject)
    .some((model) => model.provider === 'openrouter');

  if (alreadyHasOpenRouter) {
    return report;
  }

  const now = new Date().toISOString();
  // Appended, not prepended: this is the operator's own model list, and
  // whatever is first is what an unset default falls back to. A metered
  // provider must never become that by being inserted at the top.
  settings.aiModels = [
    ...models,
    ...OPENROUTER_SEED_MODELS.map((seed) => ({
      ...seed,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })),
  ];
  report.seededModels = OPENROUTER_SEED_MODELS.length;

  /*
   * `providersEnabled` and `defaultModelId` are deliberately NOT touched.
   *
   * A provider missing from the enable map is defaulted to enabled when the
   * settings are normalised on read, so there is nothing to add - and
   * OpenRouter is metered, so it must never be promoted to the default model
   * by a migration. An install whose default costs nothing today still costs
   * nothing after this runs.
   */

  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(SETTINGS_KEY, JSON.stringify(settings), now);
  report.settingsRewritten = true;

  return report;
}
