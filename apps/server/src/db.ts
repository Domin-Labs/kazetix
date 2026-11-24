import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// ponytail: single SQLite file + FTS5 (node:sqlite, no native deps). Postgres only if multi-user is ever needed.
export type DB = DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meetings(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_s INTEGER,
  platform TEXT,
  channels INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'live',
  progress INTEGER NOT NULL DEFAULT 0,
  audio_path TEXT,
  audio_bytes INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  language TEXT,
  final_transcript INTEGER NOT NULL DEFAULT 1,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS meetings_started ON meetings(started_at);
CREATE TABLE IF NOT EXISTS live_segments(
  id TEXT NOT NULL, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, text TEXT NOT NULL,
  PRIMARY KEY(meeting_id, id)
);
CREATE TABLE IF NOT EXISTS turns(
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
  speaker_label TEXT, speaker_name TEXT, channel TEXT, start_ms INTEGER, end_ms INTEGER, text TEXT NOT NULL,
  PRIMARY KEY(meeting_id, idx)
);
CREATE TABLE IF NOT EXISTS raw_transcripts(meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE, json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS summaries(meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE, markdown TEXT NOT NULL, decisions_json TEXT NOT NULL, model TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS action_items(
  id INTEGER PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  text TEXT NOT NULL, owner TEXT, due_date TEXT, done INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'llm'
);
CREATE TABLE IF NOT EXISTS marks(id TEXT NOT NULL, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, at_ms INTEGER NOT NULL, label TEXT, PRIMARY KEY(meeting_id, id));
CREATE TABLE IF NOT EXISTS hints(id TEXT NOT NULL, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, at_ms INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(meeting_id, id));
CREATE TABLE IF NOT EXISTS exports(meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, target TEXT NOT NULL, external_id TEXT, url TEXT, exported_at TEXT NOT NULL, PRIMARY KEY(meeting_id, target));
CREATE TABLE IF NOT EXISTS jobs(meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE, attempts INTEGER NOT NULL DEFAULT 0, run_after INTEGER NOT NULL DEFAULT 0, force INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS oauth_clients(client_id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_tokens(token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, scopes TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_turns USING fts5(text, meeting_id UNINDEXED, start_ms UNINDEXED, speaker UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE IF NOT EXISTS fts_summaries USING fts5(text, meeting_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
`;

export function openDb(dataDir: string): DB {
  mkdirSync(join(dataDir, 'audio'), { recursive: true });
  // One-time migration from the app's former name: keep an existing database.
  const old = join(dataDir, 'kazetix.db');
  if (existsSync(old) && !existsSync(join(dataDir, 'kazetix.db'))) {
    for (const x of ['', '-wal', '-shm']) if (existsSync(old + x)) renameSync(old + x, join(dataDir, 'kazetix.db' + x));
  }
  const db = new DatabaseSync(join(dataDir, 'kazetix.db'));
  db.exec(SCHEMA);
  return db;
}

export const now = () => new Date().toISOString();

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function kvGet(db: DB, k: string): string | undefined {
  return (db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined)?.v;
}
export function kvSet(db: DB, k: string, v: string) {
  db.prepare('INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
}

export type MeetingRow = {
  id: string; title: string; started_at: string; ended_at: string | null; duration_s: number | null;
  platform: string | null; channels: number; status: string; progress: number; audio_path: string | null;
  audio_bytes: number; error: string | null; language: string | null;
  final_transcript: number; cost_usd: number; created_at: string; updated_at: string;
};

export function getMeeting(db: DB, id: string): MeetingRow | undefined {
  return db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as MeetingRow | undefined;
}

export function setStatus(db: DB, id: string, status: string, progress = 0, error: string | null = null) {
  db.prepare('UPDATE meetings SET status = ?, progress = ?, error = ?, updated_at = ? WHERE id = ?').run(status, progress, error, now(), id);
}

/** Full view used by REST GET and MCP get_meeting. */
export function meetingView(db: DB, id: string) {
  const m = getMeeting(db, id);
  if (!m) return undefined;
  const s = db.prepare('SELECT markdown, decisions_json FROM summaries WHERE meeting_id = ?').get(id) as { markdown: string; decisions_json: string } | undefined;
  const d = s ? (JSON.parse(s.decisions_json) as { key_points?: string[]; decisions?: string[] }) : null;
  const items = db.prepare('SELECT id, text, owner, due_date, done FROM action_items WHERE meeting_id = ? ORDER BY id').all(id) as { id: number; text: string; owner: string | null; due_date: string | null; done: number }[];
  const speakers = (db.prepare('SELECT COUNT(DISTINCT speaker_label) AS n FROM turns WHERE meeting_id = ?').get(id) as { n: number }).n;
  return {
    id: m.id, title: m.title, started_at: m.started_at, ended_at: m.ended_at, duration_s: m.duration_s,
    platform: m.platform, channels: m.channels, status: m.status, progress: m.progress, audio_bytes: m.audio_bytes,
    error: m.error, speakers,
    summary: s ? { markdown: s.markdown, key_points: d?.key_points ?? [], decisions: d?.decisions ?? [] } : null,
    action_items: items.map((i) => ({ ...i, done: !!i.done })),
  };
}

/** Speaker-labelled transcript lines: final turns if present, otherwise live segments. */
export function transcriptRows(db: DB, id: string): { source: 'final' | 'live'; rows: { speaker: string; start_ms: number; end_ms: number; text: string }[] } {
  const turns = db.prepare('SELECT COALESCE(speaker_name, speaker_label) AS speaker, start_ms, end_ms, text FROM turns WHERE meeting_id = ? ORDER BY idx').all(id) as any[];
  if (turns.length) return { source: 'final', rows: turns };
  const live = db.prepare('SELECT channel, start_ms, end_ms, text FROM live_segments WHERE meeting_id = ? ORDER BY start_ms, rowid').all(id) as any[];
  return { source: 'live', rows: live.map((r) => ({ speaker: channelLabel(r.channel), start_ms: r.start_ms, end_ms: r.end_ms, text: r.text })) };
}

export const channelLabel = (c: string) => (c === 'me' ? 'Me' : c === 'them' ? 'Others' : 'Speaker');

export function mmss(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
