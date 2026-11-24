//! Local archive: one SQLite file (WAL, FTS5) in the app data dir, shared by the GUI (writer) and the
//! `--mcp` process (reader, plus mark_exported). Schema ported from apps/server/src/db.ts.

use rusqlite::{params, Connection, OptionalExtension, Result};
use serde_json::{json, Value};
use std::path::Path;

use crate::transcript::{Turn, mmss};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meetings(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, duration_s INTEGER, platform TEXT,
  channels INTEGER NOT NULL DEFAULT 2, status TEXT NOT NULL DEFAULT 'live', progress INTEGER NOT NULL DEFAULT 0,
  audio_path TEXT, audio_bytes INTEGER NOT NULL DEFAULT 0, error TEXT, language TEXT,
  final_transcript INTEGER NOT NULL DEFAULT 1, cost_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS meetings_started ON meetings(started_at);
CREATE TABLE IF NOT EXISTS live_segments(
  id TEXT NOT NULL, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(meeting_id, id)
);
CREATE TABLE IF NOT EXISTS turns(
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
  speaker_label TEXT, speaker_name TEXT, channel TEXT, start_ms INTEGER, end_ms INTEGER, text TEXT NOT NULL, PRIMARY KEY(meeting_id, idx)
);
CREATE TABLE IF NOT EXISTS raw_transcripts(
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, channel INTEGER NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(meeting_id, channel)
);
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
CREATE VIRTUAL TABLE IF NOT EXISTS fts_turns USING fts5(text, meeting_id UNINDEXED, start_ms UNINDEXED, speaker UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE IF NOT EXISTS fts_summaries USING fts5(text, meeting_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
";

/// Same folder Tauri uses for `app_data_dir()` (identifier from tauri.conf.json), so the `--mcp` process finds the GUI's data.
pub fn data_dir() -> std::path::PathBuf {
    std::env::var_os("KAZETIX_DATA_DIR").map(Into::into).unwrap_or_else(|| dirs::data_dir().unwrap_or_default().join("cz.dpstudio.kazetix"))
}

pub fn open(dir: &Path) -> Result<Connection> {
    let _ = std::fs::create_dir_all(dir);
    let conn = Connection::open(dir.join("kazetix.db"))?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    init(&conn)?;
    Ok(conn)
}

pub fn init(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.execute_batch(SCHEMA)
}

pub type Db = std::sync::Arc<std::sync::Mutex<Connection>>;

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn kv_get(c: &Connection, k: &str) -> Option<String> {
    c.query_row("SELECT v FROM kv WHERE k = ?", [k], |r| r.get(0)).optional().ok().flatten()
}

pub fn kv_set(c: &Connection, k: &str, v: &str) {
    let _ = c.execute("INSERT INTO kv(k, v) VALUES(?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v", params![k, v]);
}

pub struct MeetingRow {
    pub title: String,
    pub started_at: String,
    pub duration_s: Option<i64>,
    pub channels: u8,
    pub language: Option<String>,
    pub final_transcript: bool,
}

pub fn get_meeting(c: &Connection, id: &str) -> Result<Option<MeetingRow>> {
    c.query_row("SELECT title, started_at, duration_s, channels, language, final_transcript FROM meetings WHERE id = ?", [id], |r| {
        Ok(MeetingRow { title: r.get(0)?, started_at: r.get(1)?, duration_s: r.get(2)?, channels: r.get(3)?, language: r.get(4)?, final_transcript: r.get::<_, i64>(5)? != 0 })
    })
    .optional()
}

pub fn create_meeting(c: &Connection, id: &str, title: &str, platform: Option<&str>, channels: u8, started_at: &str, language: &str, final_transcript: bool) -> Result<()> {
    let t = now();
    c.execute(
        "INSERT INTO meetings(id, title, started_at, platform, channels, language, final_transcript, created_at, updated_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8) ON CONFLICT(id) DO NOTHING",
        params![id, title, started_at, platform, channels, language, final_transcript, t],
    )?;
    Ok(())
}

pub fn set_status(c: &Connection, id: &str, status: &str, progress: i64, error: Option<&str>) {
    let _ = c.execute("UPDATE meetings SET status = ?, progress = ?, error = ?, updated_at = ? WHERE id = ?", params![status, progress, error, now(), id]);
}

/// Live segments as the desktop produces them: `{id, channel, start_ms, end_ms, text}`.
pub fn add_segments(c: &Connection, id: &str, segs: &[Value]) -> Result<()> {
    let final_done = c.query_row("SELECT 1 FROM turns WHERE meeting_id = ? LIMIT 1", [id], |_| Ok(())).optional()?.is_some();
    for s in segs {
        let (sid, ch, text) = (s["id"].as_str().unwrap_or_default(), s["channel"].as_str().unwrap_or("mixed"), s["text"].as_str().unwrap_or_default());
        let (a, b) = (s["start_ms"].as_i64().unwrap_or(0), s["end_ms"].as_i64().unwrap_or(0));
        let n = c.execute("INSERT OR IGNORE INTO live_segments(id, meeting_id, channel, start_ms, end_ms, text) VALUES(?1, ?2, ?3, ?4, ?5, ?6)", params![sid, id, ch, a, b, text])?;
        if n > 0 && !final_done {
            c.execute("INSERT INTO fts_turns(text, meeting_id, start_ms, speaker) VALUES(?1, ?2, ?3, ?4)", params![text, id, a, channel_label(ch)])?;
        }
    }
    Ok(())
}

pub fn add_hint(c: &Connection, meeting: &str, id: &str, at_ms: i64, payload: &Value) -> Result<()> {
    c.execute("INSERT OR IGNORE INTO hints(id, meeting_id, at_ms, payload_json) VALUES(?1, ?2, ?3, ?4)", params![id, meeting, at_ms, payload.to_string()])?;
    Ok(())
}

pub fn add_mark(c: &Connection, meeting: &str, id: &str, at_ms: i64, label: Option<&str>) -> Result<()> {
    c.execute("INSERT OR IGNORE INTO marks(id, meeting_id, at_ms, label) VALUES(?1, ?2, ?3, ?4)", params![id, meeting, at_ms, label])?;
    Ok(())
}

/// Call ended: store the end, queue the job. Without audio (or without exact transcript) the summary is built from live
/// segments after `delay_ms`, so the last live STT requests can still land.
pub fn finish_meeting(c: &Connection, id: &str, ended_at: &str, duration_s: i64, audio: Option<(&str, u64)>, delay_ms: i64) -> Result<()> {
    let m = get_meeting(c, id)?;
    let exact = m.is_some_and(|m| m.final_transcript) && audio.is_some();
    let (path, bytes) = audio.map_or((None, 0), |(p, b)| (Some(p), b as i64));
    c.execute("UPDATE meetings SET ended_at = ?, duration_s = ?, audio_path = ?, audio_bytes = ?, updated_at = ? WHERE id = ?", params![ended_at, duration_s, path, bytes, now(), id])?;
    set_status(c, id, if exact { "transcribing" } else { "summarizing" }, 0, None);
    enqueue(c, id, false, if exact { 0 } else { delay_ms })
}

pub fn enqueue(c: &Connection, id: &str, force: bool, delay_ms: i64) -> Result<()> {
    c.execute(
        "INSERT INTO jobs(meeting_id, attempts, run_after, force) VALUES(?1, 0, ?2, ?3) ON CONFLICT(meeting_id) DO UPDATE SET attempts = 0, run_after = excluded.run_after, force = excluded.force",
        params![id, if delay_ms > 0 { chrono::Utc::now().timestamp_millis() + delay_ms } else { 0 }, force],
    )?;
    Ok(())
}

/// A job that gave up (attempts ≥ 4) waits for the next app start; this makes every job due again.
pub const MAX_ATTEMPTS: i64 = 4;
pub fn revive_jobs(c: &Connection) -> Result<()> {
    c.execute("UPDATE jobs SET attempts = 0, run_after = 0", [])?;
    c.execute("UPDATE meetings SET status = 'transcribing', error = NULL WHERE status = 'error' AND id IN (SELECT meeting_id FROM jobs)", [])?;
    Ok(())
}

/// (meeting id, attempts) of the oldest due job.
pub fn next_job(c: &Connection) -> Result<Option<(String, i64)>> {
    c.query_row(
        "SELECT meeting_id, attempts FROM jobs WHERE run_after <= ?1 AND attempts < ?2 ORDER BY run_after LIMIT 1",
        params![chrono::Utc::now().timestamp_millis(), MAX_ATTEMPTS],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

pub fn job_done(c: &Connection, id: &str) {
    let _ = c.execute("DELETE FROM jobs WHERE meeting_id = ?", [id]);
}

/// Failed attempt: back off 30 s · 2^attempts; after the last one the meeting shows the error (the job is kept for the next start).
pub fn job_failed(c: &Connection, id: &str, attempts: i64, msg: &str) {
    let attempts = attempts + 1;
    kv_set(c, "last_error", &json!({ "at": now(), "meeting_id": id, "error": msg }).to_string());
    let _ = c.execute("UPDATE jobs SET attempts = ?, run_after = ? WHERE meeting_id = ?", params![attempts, chrono::Utc::now().timestamp_millis() + 30_000 * (1i64 << attempts.min(10)), id]);
    if attempts >= MAX_ATTEMPTS {
        set_status(c, id, "error", 0, Some(msg));
    } else {
        let _ = c.execute("UPDATE meetings SET error = ?, updated_at = ? WHERE id = ?", params![format!("retrying: {msg}"), now(), id]);
    }
}

pub fn raw_get(c: &Connection, id: &str, ch: usize) -> Option<String> {
    c.query_row("SELECT json FROM raw_transcripts WHERE meeting_id = ? AND channel = ?", params![id, ch as i64], |r| r.get(0)).optional().ok().flatten()
}

pub fn raw_put(c: &Connection, id: &str, ch: usize, json: &str, cost: f64) -> Result<()> {
    c.execute("INSERT INTO raw_transcripts(meeting_id, channel, json, created_at) VALUES(?1, ?2, ?3, ?4) ON CONFLICT(meeting_id, channel) DO UPDATE SET json = excluded.json, created_at = excluded.created_at", params![id, ch as i64, json, now()])?;
    add_cost(c, id, cost)
}

pub fn add_cost(c: &Connection, id: &str, cost: f64) -> Result<()> {
    if cost > 0.0 {
        c.execute("UPDATE meetings SET cost_usd = cost_usd + ? WHERE id = ?", params![cost, id])?;
    }
    Ok(())
}

pub fn write_turns(c: &mut Connection, id: &str, turns: &[Turn]) -> Result<()> {
    let tx = c.transaction()?;
    tx.execute("DELETE FROM turns WHERE meeting_id = ?", [id])?;
    tx.execute("DELETE FROM fts_turns WHERE meeting_id = ?", [id])?;
    for (i, t) in turns.iter().enumerate() {
        tx.execute("INSERT INTO turns(meeting_id, idx, speaker_label, speaker_name, channel, start_ms, end_ms, text) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)", params![id, i as i64, t.speaker, t.name, t.channel, t.start_ms, t.end_ms, t.text])?;
        tx.execute("INSERT INTO fts_turns(text, meeting_id, start_ms, speaker) VALUES(?1, ?2, ?3, ?4)", params![t.text, id, t.start_ms, t.name.as_deref().unwrap_or(&t.speaker)])?;
    }
    tx.commit()
}

pub struct Summary {
    pub markdown: String,
    pub key_points: Vec<String>,
    pub decisions: Vec<String>,
    pub action_items: Vec<(String, Option<String>, Option<String>)>,
}

pub fn write_summary(c: &mut Connection, id: &str, s: &Summary, model: &str, cost: f64) -> Result<()> {
    let tx = c.transaction()?;
    tx.execute(
        "INSERT INTO summaries(meeting_id, markdown, decisions_json, model, created_at) VALUES(?1, ?2, ?3, ?4, ?5) ON CONFLICT(meeting_id) DO UPDATE SET markdown = excluded.markdown, decisions_json = excluded.decisions_json, model = excluded.model, created_at = excluded.created_at",
        params![id, s.markdown, json!({ "key_points": s.key_points, "decisions": s.decisions }).to_string(), model, now()],
    )?;
    tx.execute("DELETE FROM action_items WHERE meeting_id = ? AND source = 'llm'", [id])?;
    for (text, owner, due) in &s.action_items {
        tx.execute("INSERT INTO action_items(meeting_id, text, owner, due_date, source) VALUES(?1, ?2, ?3, ?4, 'llm')", params![id, text, owner, due])?;
    }
    tx.execute("DELETE FROM fts_summaries WHERE meeting_id = ?", [id])?;
    let text = std::iter::once(&s.markdown).chain(&s.key_points).chain(&s.decisions).cloned().collect::<Vec<_>>().join("\n");
    tx.execute("INSERT INTO fts_summaries(text, meeting_id) VALUES(?1, ?2)", params![text, id])?;
    tx.execute("UPDATE meetings SET cost_usd = cost_usd + ? WHERE id = ?", params![cost, id])?;
    tx.commit()
}

pub fn channel_label(c: &str) -> &'static str {
    match c {
        "me" => "Me",
        "them" => "Others",
        _ => "Speaker",
    }
}

pub struct Row {
    pub speaker: String,
    pub start_ms: i64,
    pub text: String,
}

/// Speaker-labelled transcript lines: final turns if present, otherwise live segments. Returns (source, rows).
pub fn transcript_rows(c: &Connection, id: &str) -> Result<(&'static str, Vec<Row>)> {
    let map = |r: &rusqlite::Row| Ok(Row { speaker: r.get(0)?, start_ms: r.get(1)?, text: r.get(3)? });
    let turns = c.prepare("SELECT COALESCE(speaker_name, speaker_label), start_ms, end_ms, text FROM turns WHERE meeting_id = ? ORDER BY idx")?.query_map([id], map)?.collect::<Result<Vec<_>>>()?;
    if !turns.is_empty() {
        return Ok(("final", turns));
    }
    let live = c
        .prepare("SELECT channel, start_ms, end_ms, text FROM live_segments WHERE meeting_id = ? ORDER BY start_ms, rowid")?
        .query_map([id], |r| Ok(Row { speaker: channel_label(&r.get::<_, String>(0)?).into(), start_ms: r.get(1)?, text: r.get(3)? }))?
        .collect::<Result<Vec<_>>>()?;
    Ok(("live", live))
}

pub fn lines(rows: &[Row]) -> Vec<String> {
    rows.iter().map(|r| format!("[{}] {}: {}", mmss(r.start_ms), r.speaker, r.text)).collect()
}

/// Full view used by the Processing toast (`meeting_status`) and MCP get_meeting; same shape as the server's `MeetingView`.
pub fn meeting_view(c: &Connection, id: &str) -> Result<Option<Value>> {
    let m = c
        .query_row(
            "SELECT id, title, started_at, ended_at, duration_s, platform, channels, status, progress, audio_bytes, error, audio_path FROM meetings WHERE id = ?",
            [id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "started_at": r.get::<_, String>(2)?, "ended_at": r.get::<_, Option<String>>(3)?,
                    "duration_s": r.get::<_, Option<i64>>(4)?, "platform": r.get::<_, Option<String>>(5)?, "channels": r.get::<_, i64>(6)?, "status": r.get::<_, String>(7)?,
                    "progress": r.get::<_, i64>(8)?, "audio_bytes": r.get::<_, i64>(9)?, "error": r.get::<_, Option<String>>(10)?, "audio_path": r.get::<_, Option<String>>(11)?,
                }))
            },
        )
        .optional()?;
    let Some(mut m) = m else { return Ok(None) };
    let s: Option<(String, String)> = c.query_row("SELECT markdown, decisions_json FROM summaries WHERE meeting_id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    m["summary"] = s.map_or(Value::Null, |(md, d)| {
        let d: Value = serde_json::from_str(&d).unwrap_or(Value::Null);
        json!({ "markdown": md, "key_points": d["key_points"].as_array().cloned().unwrap_or_default(), "decisions": d["decisions"].as_array().cloned().unwrap_or_default() })
    });
    m["action_items"] = Value::Array(
        c.prepare("SELECT id, text, owner, due_date, done FROM action_items WHERE meeting_id = ? ORDER BY id")?
            .query_map([id], |r| Ok(json!({ "id": r.get::<_, i64>(0)?, "text": r.get::<_, String>(1)?, "owner": r.get::<_, Option<String>>(2)?, "due_date": r.get::<_, Option<String>>(3)?, "done": r.get::<_, i64>(4)? != 0 })))?
            .collect::<Result<Vec<_>>>()?,
    );
    m["speakers"] = json!(c.query_row("SELECT COUNT(DISTINCT speaker_label) FROM turns WHERE meeting_id = ?", [id], |r| r.get::<_, i64>(0))?);
    Ok(Some(m))
}

/// Home page of the settings window: stats, calls per day for the last 35 days, calls per platform and the 50 latest calls
/// (as `meeting_view`). `today` is the local YYYY-MM-DD; a call's day is the date part of its stored `started_at`.
pub fn home_overview(c: &Connection, today: &str) -> Result<Value> {
    let end = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d").unwrap_or_default();
    let mut per_day = std::collections::HashMap::<String, i64>::new();
    let (mut month, mut secs, mut words) = (0, 0i64, 0usize);
    let mut platforms = std::collections::BTreeMap::<String, i64>::new();
    let mut recent = vec![];
    let all = c.prepare("SELECT id, started_at, COALESCE(duration_s, 0), platform FROM meetings ORDER BY started_at DESC")?.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, Option<String>>(3)?)))?.collect::<Result<Vec<_>>>()?;
    for (id, started, dur, platform) in &all {
        *per_day.entry(started.chars().take(10).collect()).or_default() += 1;
        month += started.starts_with(&today[..7.min(today.len())]) as i64;
        secs += dur;
        words += transcript_rows(c, id)?.1.iter().map(|r| r.text.split_whitespace().count()).sum::<usize>();
        let p = platform.as_deref().filter(|p| ["teams", "meet", "zoom"].contains(p)).unwrap_or("other");
        *platforms.entry(p.into()).or_default() += 1;
        if recent.len() < 50 {
            recent.extend(meeting_view(c, id)?);
        }
    }
    let activity: Vec<Value> = (0..35).rev().map(|i| end - chrono::Duration::days(i)).map(|d| { let d = d.to_string(); json!({ "count": per_day.get(&d).copied().unwrap_or(0), "day": d }) }).collect();
    let open: i64 = c.query_row("SELECT COUNT(*) FROM action_items WHERE done = 0", [], |r| r.get(0))?;
    Ok(json!({ "source": "local", "stats": { "calls": all.len(), "calls_month": month, "hours": secs as f64 / 3600.0, "words": words, "open_items": open }, "activity": activity, "platforms": platforms, "recent": recent }))
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        c
    }

    #[test]
    fn call_lifecycle_and_search() {
        let mut c = mem();
        create_meeting(&c, "m1", "Sync", Some("teams"), 2, "2026-11-24T10:00:00+01:00", "cs", true).unwrap();
        add_segments(&c, "m1", &[json!({ "id": "a", "channel": "me", "start_ms": 0, "end_ms": 900, "text": "Ahoj" }), json!({ "id": "a", "channel": "me", "start_ms": 0, "end_ms": 900, "text": "Ahoj" })]).unwrap();
        assert_eq!(c.query_row("SELECT COUNT(*) FROM fts_turns", [], |r| r.get::<_, i64>(0)).unwrap(), 1); // duplicate ignored
        add_mark(&c, "m1", "k", 1500, Some("důležité")).unwrap();
        finish_meeting(&c, "m1", "2026-11-24T10:30:00+01:00", 1800, Some(("/tmp/m1.ogg", 10)), 20_000).unwrap();
        let v = meeting_view(&c, "m1").unwrap().unwrap();
        assert_eq!((v["status"].as_str(), v["duration_s"].as_i64(), v["summary"].is_null()), (Some("transcribing"), Some(1800), true));
        assert_eq!(next_job(&c).unwrap().map(|j| j.0), Some("m1".into()));

        write_turns(&mut c, "m1", &[Turn { speaker: "Me".into(), channel: "me".into(), start_ms: 0, end_ms: 900, text: "Ahoj, smlouva je hotová".into(), sid: None, name: None }]).unwrap();
        assert_eq!(transcript_rows(&c, "m1").unwrap().0, "final");
        write_summary(&mut c, "m1", &Summary { markdown: "Shrnutí".into(), key_points: vec!["bod".into()], decisions: vec![], action_items: vec![("Poslat smlouvu".into(), Some("Me".into()), None)] }, "m", 0.01).unwrap();
        let v = meeting_view(&c, "m1").unwrap().unwrap();
        assert_eq!((v["speakers"].as_i64(), v["action_items"][0]["text"].as_str(), v["summary"]["key_points"][0].as_str()), (Some(1), Some("Poslat smlouvu"), Some("bod")));
        let hits: i64 = c.query_row("SELECT COUNT(*) FROM fts_turns WHERE fts_turns MATCH 'smlouv*'", [], |r| r.get(0)).unwrap();
        assert_eq!(hits, 1);
        set_status(&c, "m1", "done", 100, None);
        job_done(&c, "m1");
        assert!(next_job(&c).unwrap().is_none());
    }

    #[test]
    fn jobs_back_off_then_wait_for_restart() {
        let c = mem();
        create_meeting(&c, "m", "t", None, 2, "2026-01-01T00:00:00Z", "", false).unwrap();
        finish_meeting(&c, "m", "2026-01-01T00:10:00Z", 600, None, 20_000).unwrap();
        assert!(next_job(&c).unwrap().is_none(), "no audio: summary waits 20 s for late live segments");
        enqueue(&c, "m", false, 0).unwrap();
        job_failed(&c, "m", 0, "boom");
        assert!(next_job(&c).unwrap().is_none(), "backing off");
        assert_eq!(meeting_view(&c, "m").unwrap().unwrap()["error"], "retrying: boom");
        job_failed(&c, "m", 3, "boom");
        assert_eq!(meeting_view(&c, "m").unwrap().unwrap()["status"], "error");
        revive_jobs(&c).unwrap();
        assert_eq!(meeting_view(&c, "m").unwrap().unwrap()["status"], "transcribing");
        assert!(next_job(&c).unwrap().is_some());
    }

    #[test]
    fn home_overview_counts() {
        let mut c = mem();
        for (id, at, plat, dur) in [("a", "2026-11-24T10:00:00+01:00", Some("teams"), 3600), ("b", "2026-11-24T15:00:00+01:00", None, 1800), ("c", "2026-10-01T09:00:00+02:00", Some("zoom"), 900)] {
            create_meeting(&c, id, id, plat, 2, at, "cs", true).unwrap();
            finish_meeting(&c, id, at, dur, None, 0).unwrap();
        }
        write_turns(&mut c, "a", &[Turn { speaker: "Me".into(), channel: "me".into(), start_ms: 0, end_ms: 1, text: "jedna dva tri".into(), sid: None, name: None }]).unwrap();
        add_segments(&c, "b", &[json!({ "id": "x", "channel": "me", "start_ms": 0, "end_ms": 1, "text": "ahoj svete" })]).unwrap();
        write_summary(&mut c, "a", &Summary { markdown: "".into(), key_points: vec!["bod".into()], decisions: vec![], action_items: vec![("x".into(), None, None), ("y".into(), None, None)] }, "m", 0.0).unwrap();
        c.execute("UPDATE action_items SET done = 1 WHERE text = 'y'", []).unwrap();
        let v = home_overview(&c, "2026-11-24").unwrap();
        assert_eq!((v["stats"]["calls"].as_i64(), v["stats"]["calls_month"].as_i64(), v["stats"]["words"].as_i64(), v["stats"]["open_items"].as_i64()), (Some(3), Some(2), Some(5), Some(1)));
        assert_eq!(v["stats"]["hours"].as_f64(), Some(1.75));
        assert_eq!((v["platforms"]["teams"].as_i64(), v["platforms"]["zoom"].as_i64(), v["platforms"]["other"].as_i64()), (Some(1), Some(1), Some(1)));
        assert_eq!((v["activity"].as_array().unwrap().len(), v["activity"][34]["count"].as_i64(), v["activity"][33]["count"].as_i64()), (35, Some(2), Some(0)));
        assert_eq!((v["recent"].as_array().unwrap().len(), v["recent"][0]["id"].as_str()), (3, Some("b")));
    }
}
