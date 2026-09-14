import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { runDataMigrations } from './migrations';

const POSIX_DEFAULT_DATABASE_DIR = '/data/db';

/**
 * Where the database lives when `DB_DIR` is not set.
 *
 * `/data/db` is the container convention this app was built around, and it
 * stays the default everywhere it means something. On Windows it means
 * nothing: `path.resolve('/data/db')` is `C:\data\db`, and creating a
 * directory at the root of the system drive needs administrator rights, so the
 * first `getDb()` fails with EPERM before the server has done anything.
 * Windows gets the platform's own answer for per-user application data
 * instead, which is writable without elevation and survives reinstalls.
 */
/**
 * Whether a directory is already there and writable by this user.
 *
 * Deliberately does NOT create anything: this is the test for "is the container
 * convention real on this machine", and creating the answer would make it
 * always true for whoever happens to be running as root.
 */
function isUsableDir(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function getDefaultDatabaseDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
  canUse: (dir: string) => boolean = isUsableDir
): string {
  if (platform !== 'win32') {
    /*
     * `/data/db` when it is really there, a per-user directory otherwise.
     *
     * It was the unconditional answer, and on a desktop that is a path at the
     * root of the filesystem that nothing creates and no ordinary user may
     * create. A fresh clone on a Mac died on the first query with ENOENT before
     * the server had done anything - the same failure Windows used to have, and
     * for the same reason, fixed there and left here.
     *
     * The check is "does it exist and can I write to it", so a deployment that
     * mounts a volume at /data/db keeps it, an install that already has data
     * there keeps it, and a laptop gets somewhere it actually owns. `DB_DIR`
     * still overrides all of this.
     */
    if (canUse(POSIX_DEFAULT_DATABASE_DIR)) {
      return POSIX_DEFAULT_DATABASE_DIR;
    }

    if (platform === 'darwin') {
      return path.posix.join(homedir(), 'Library', 'Application Support', 'free_tailor', 'db');
    }

    // The XDG base directory spec, which is what a Linux desktop expects and
    // what `~/.local/share` is the documented fallback for.
    const xdgData = env.XDG_DATA_HOME?.trim();
    return xdgData
      ? path.posix.join(xdgData, 'free_tailor', 'db')
      : path.posix.join(homedir(), '.local', 'share', 'free_tailor', 'db');
  }

  // LOCALAPPDATA is the roaming-excluded profile store and is set on every
  // supported Windows; APPDATA and the profile are only fallbacks for a
  // stripped service environment.
  const base = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim();
  if (base) {
    return path.win32.join(base, 'free_tailor', 'db');
  }
  return path.win32.join(homedir(), 'AppData', 'Local', 'free_tailor', 'db');
}

const DATABASE_FILE_NAME = 'free_tailor.db';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS profiles (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    disabled   INTEGER NOT NULL DEFAULT 0,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profile_groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS templates (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    disabled   INTEGER NOT NULL DEFAULT 0,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS template_overrides (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    disabled   INTEGER NOT NULL DEFAULT 0,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prompts (
    id          TEXT PRIMARY KEY,
    feature_key TEXT,
    is_built_in INTEGER NOT NULL DEFAULT 0,
    data        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS skills (
    type      TEXT NOT NULL,
    skill_key TEXT NOT NULL,
    skill     TEXT NOT NULL,
    priority  INTEGER,
    category  TEXT,
    PRIMARY KEY (type, skill_key)
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS schema_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT
  );
`;

const connections = new Map<string, Database.Database>();

export function getDatabaseDir(): string {
  const configured = process.env.DB_DIR?.trim();
  return configured ? path.resolve(configured) : getDefaultDatabaseDir();
}

export function getDatabasePath(): string {
  return path.join(getDatabaseDir(), DATABASE_FILE_NAME);
}

/**
 * Returns the shared SQLite connection for the configured database directory.
 * The connection is opened lazily and the schema is created on first use.
 */
export function getDb(): Database.Database {
  const filePath = getDatabasePath();
  const existing = connections.get(filePath);
  if (existing) {
    return existing;
  }

  const directory = path.dirname(filePath);
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (error) {
    // The single most common first-run failure, and the raw EACCES/EPERM says
    // nothing about what to do next. It is also where the two platforms differ
    // most: `/data/db` copied out of `.env.example` needs `sudo mkdir` on
    // Ubuntu and cannot be created at all without elevation on Windows, where
    // it means `C:\data\db`.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot create the database directory "${directory}": ${reason}. ` +
        'Set DB_DIR in the repository .env to a writable path (for example DB_DIR=./data/db), ' +
        'or create that directory and give this user write access to it.'
    );
  }

  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  // The connection is registered BEFORE the migrations run. That ordering is
  // load-bearing: a migration (or anything it logs through) that reaches for
  // getDb() would otherwise recurse into opening a second connection to the
  // same file. Do not move this line below runDataMigrations.
  connections.set(filePath, db);
  runDataMigrations(db);
  return db;
}
