import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migrations = [
  `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS photo_assets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'self',
    content_hash TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    master_path TEXT,
    thumbnail_path TEXT,
    byte_size INTEGER NOT NULL,
    status TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_key TEXT,
    discovered_timezone TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    trashed_at TEXT,
    trash_expires_at TEXT
  );
  CREATE TABLE IF NOT EXISTS metadata_records (
    asset_id TEXT PRIMARY KEY REFERENCES photo_assets(id) ON DELETE CASCADE,
    facts_json TEXT NOT NULL,
    date_taken TEXT,
    date_basis TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    camera TEXT
  );
  CREATE TABLE IF NOT EXISTS photo_sources (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES photo_assets(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL,
    source_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(source_kind, source_key)
  );
  CREATE TABLE IF NOT EXISTS ignored_sources (
    source_kind TEXT NOT NULL,
    source_key TEXT NOT NULL,
    ignored_at TEXT NOT NULL,
    PRIMARY KEY(source_kind, source_key)
  );
  CREATE TABLE IF NOT EXISTS photo_logs (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL UNIQUE REFERENCES photo_assets(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    model_json TEXT NOT NULL DEFAULT '{}',
    overrides_json TEXT NOT NULL DEFAULT '{}',
    locked INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    provider TEXT,
    model_id TEXT,
    schema_version TEXT,
    prompt_version TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS processing_jobs (
    id TEXT PRIMARY KEY,
    asset_id TEXT REFERENCES photo_assets(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    step TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recognition_results (
    id TEXT PRIMARY KEY,
    photo_log_id TEXT NOT NULL REFERENCES photo_logs(id) ON DELETE CASCADE,
    structured_json TEXT NOT NULL,
    raw_json TEXT,
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    raw_expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    status TEXT NOT NULL DEFAULT 'active',
    auto_created INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS topic_photos (
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    photo_log_id TEXT NOT NULL REFERENCES photo_logs(id) ON DELETE CASCADE,
    confidence REAL,
    confirmed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(topic_id, photo_log_id)
  );
  CREATE TABLE IF NOT EXISTS plogs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    rule_json TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'draft',
    current_version INTEGER NOT NULL DEFAULT 1,
    pending_version INTEGER,
    update_available INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    trashed_at TEXT,
    trash_expires_at TEXT,
    feedback TEXT,
    feedback_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS plog_versions (
    plog_id TEXT NOT NULL REFERENCES plogs(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    opening TEXT NOT NULL,
    body_json TEXT NOT NULL,
    member_ids_json TEXT NOT NULL,
    cover_photo_log_id TEXT,
    incomplete INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY(plog_id, version)
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_assets_status_date ON photo_assets(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_photo_sources_asset ON photo_sources(asset_id);
  CREATE INDEX IF NOT EXISTS idx_assets_trash ON photo_assets(trashed_at, trash_expires_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_status_priority ON processing_jobs(status, priority DESC, created_at);
  CREATE INDEX IF NOT EXISTS idx_plogs_status_date ON plogs(status, created_at DESC);
  `,
];

export function openDatabase(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(config.dbPath);
  // node:sqlite intentionally exposes primitives only; keep transaction
  // orchestration here so domain callers cannot forget rollback handling.
  db.transaction = fn => (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(...args); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  for (const sql of migrations) db.exec(sql);
  ensureColumn(db, 'plogs', 'pending_version', 'INTEGER');
  ensureColumn(db, 'plogs', 'update_available', 'INTEGER NOT NULL DEFAULT 0');
  seedSetting(db, 'timezone', config.timezone);
  seedSetting(db, 'plog_hour', String(config.plogHour));
  seedSetting(db, 'sensitive_blur', 'true');
  seedSetting(db, 'provider_consent', config.geminiConsented ? 'true' : 'false');
  seedSetting(db, 'provider_tier', config.geminiTier);
  return db;
}

function ensureColumn(db, table, column, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function seedSetting(db, key, value) {
  db.prepare('INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES(?,?,?)')
    .run(key, value, new Date().toISOString());
}

export function getSettings(db) {
  return Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(row => [row.key, row.value]));
}

export function setSetting(db, key, value) {
  db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(key, String(value), new Date().toISOString());
}

export function json(value, fallback = {}) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
