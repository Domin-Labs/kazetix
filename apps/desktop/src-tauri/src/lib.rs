mod audio;
mod claude_cfg;
mod livestt;
mod mcp;
mod oggcut;
mod pipeline;
mod recorder;
mod server;
mod settings;
mod store;
mod transcript;

use serde_json::{json, Value};
use server::{Job, Outbox, Server, ServerStatus};
use settings::Settings;
use store::Db;
use std::io::Write;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use livestt::LiveEvent;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

static LOG: OnceLock<PathBuf> = OnceLock::new();

/// Operational log (kazetix.log in the app data dir). Never pass transcript content here.
pub fn log(msg: &str) {
    let line = format!("{} {msg}\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
    eprint!("{line}");
    if let Some(p) = LOG.get() {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

struct Session {
    id: String,
    title: String,
    platform: Option<String>,
    started_at: String,
    started: Instant,
    channels: u8,
    language: String,
    upload: bool,
    alive: Arc<AtomicBool>,
    capture: Option<audio::Capture>,
    live: Option<tauri::async_runtime::JoinHandle<()>>,
    recorder: Arc<Mutex<Option<recorder::OggOpusWriter>>>,
    /// local storage only: per-channel mono files for the exact transcript
    chans: Arc<Mutex<Option<recorder::ChannelRecorders>>>,
    local: bool,
    path: PathBuf,
    segments: Arc<Mutex<Vec<Value>>>,
    frames: Arc<AtomicU64>,
}

impl Session {
    fn elapsed_ms(&self) -> u64 {
        self.frames.load(Relaxed) * 20
    }
}

struct App {
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    data_dir: PathBuf,
    server: Server,
    outbox: Arc<Outbox>,
    db: Db,
    wake: Arc<tokio::sync::Notify>,
    status: Mutex<ServerStatus>,
    session: Mutex<Option<Session>>,
    monitor: Mutex<Option<audio::Capture>>,
    toast: Mutex<Value>,
    shortcuts: Mutex<Vec<(Shortcut, &'static str)>>,
    record_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    overlay_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    hints_item: Mutex<Option<CheckMenuItem<tauri::Wry>>>,
    shortcut_errors: Mutex<Vec<&'static str>>,
}

type S<'a> = State<'a, App>;

// ------------------------------------------------------------------ settings & secrets

#[tauri::command]
fn get_settings(st: S) -> Settings {
    st.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(app: AppHandle, st: S, settings: Settings) -> Result<(), String> {
    settings.save(&st.settings_path).map_err(|e| e.to_string())?;
    let old = std::mem::replace(&mut *st.settings.lock().unwrap(), settings.clone());
    if old.server_url != settings.server_url || old.shortcuts != settings.shortcuts || old.autostart != settings.autostart || old.hints_enabled != settings.hints_enabled || old.allow_capture != settings.allow_capture {
        apply_settings(&app, &settings);
    }
    let _ = app.emit("settings", &settings);
    Ok(())
}

fn apply_settings(app: &AppHandle, s: &Settings) {
    let st = app.state::<App>();
    let capture = s.allow_capture || std::env::var_os("KAZETIX_ALLOW_CAPTURE").is_some();
    for l in ["overlay", "toast"] {
        if let Some(w) = app.get_webview_window(l) {
            let _ = w.set_content_protected(!capture);
        }
    }
    st.server.configure(&s.server_url, &settings::secret_get("server_token").unwrap_or_default());
    st.outbox.kick();
    register_shortcuts(app, s);
    set_record_label(app, st.session.lock().unwrap().is_some());
    if let Some(i) = st.overlay_item.lock().unwrap().as_ref() {
        let _ = i.set_text(format!("Show overlay\t{}", s.shortcuts.overlay));
    }
    let al = app.autolaunch();
    let _ = if s.autostart { al.enable() } else { al.disable() };
    if let Some(i) = st.hints_item.lock().unwrap().as_ref() {
        let _ = i.set_checked(s.hints_enabled);
    };
}

#[tauri::command]
fn secret_status() -> Value {
    json!({ "server_token": settings::secret_get("server_token").is_some(), "openrouter_key": settings::secret_get("openrouter_key").is_some() })
}

#[tauri::command]
fn set_secret(app: AppHandle, name: String, value: String) -> Result<(), String> {
    if name != "server_token" && name != "openrouter_key" {
        return Err("unknown secret".into());
    }
    settings::secret_set(&name, value.trim())?;
    let s = app.state::<App>().settings.lock().unwrap().clone();
    apply_settings(&app, &s);
    let _ = app.emit("settings", &s);
    Ok(())
}

/// The OpenRouter key is needed by the UI for live chat/hints (it calls OpenRouter directly).
#[tauri::command]
fn openrouter_key() -> Option<String> {
    settings::secret_get("openrouter_key")
}

#[tauri::command]
async fn verify_server(url: String, token: Option<String>) -> Result<Value, String> {
    let s = Server::new();
    let token = token.filter(|t| !t.is_empty()).or_else(|| settings::secret_get("server_token")).unwrap_or_default();
    s.configure(&url, &token);
    s.get("/api/health").await.map_err(|e| e.to_string())
}

/// Path of this executable: what Claude must launch (with `--mcp`).
#[tauri::command]
fn mcp_exe() -> Result<String, String> {
    std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).map_err(|e| e.to_string())
}

/// "Add to Claude Desktop": returns the config file that was changed.
#[tauri::command]
fn connect_claude_desktop() -> Result<String, String> {
    claude_cfg::install(&mcp_exe()?).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn server_status(st: S) -> ServerStatus {
    st.status.lock().unwrap().clone()
}

#[tauri::command]
fn list_devices() -> Value {
    let (inputs, outputs) = audio::list_devices();
    json!({ "inputs": inputs, "outputs": outputs })
}

#[tauri::command]
fn log_path(st: S) -> String {
    st.data_dir.join("kazetix.log").to_string_lossy().into()
}

// ------------------------------------------------------------------ session

#[tauri::command]
fn detect_call() -> Value {
    let (title, platform) = detect::detect(&detect::window_titles());
    json!({ "title": title, "platform": platform })
}

#[tauri::command]
fn start_session(app: AppHandle, title: String, platform: Option<String>) -> Result<Value, String> {
    start(&app, title, platform)
}

fn start(app: &AppHandle, title: String, platform: Option<String>) -> Result<Value, String> {
    let st = app.state::<App>();
    if let Some(m) = st.monitor.lock().unwrap().take() {
        m.stop();
    }
    let mut guard = st.session.lock().unwrap();
    if guard.is_some() {
        return Err("A recording is already running".into());
    }
    let cfg = st.settings.lock().unwrap().clone();
    let key = settings::secret_get("openrouter_key").ok_or("Set the OpenRouter API key first (Settings → Server & AI)")?;
    let id = uuid::Uuid::new_v4().to_string();
    let started_at = chrono::Local::now().to_rfc3339();
    let title = if title.trim().is_empty() { format!("Meeting {}", chrono::Local::now().format("%Y-%m-%d %H:%M")) } else { title.trim().to_string() };
    let rec_dir = st.data_dir.join("recordings");
    std::fs::create_dir_all(&rec_dir).map_err(|e| e.to_string())?;
    let path = rec_dir.join(format!("{id}.ogg"));
    let recorder = Arc::new(Mutex::new(Some(recorder::OggOpusWriter::create(&path)?)));
    let local = cfg.storage != "server";
    let chans = Arc::new(Mutex::new(None));
    if local {
        *chans.lock().unwrap() = Some(recorder::ChannelRecorders::create(&rec_dir, &id, cfg.channels)?);
        store::create_meeting(&st.db.lock().unwrap(), &id, &title, platform.as_deref(), cfg.channels, &started_at, &cfg.language, cfg.final_transcript).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::write(path.with_extension("open"), if cfg.final_transcript { "1" } else { "0" });

    if !local {
        st.outbox.push(Job::Create {
            body: json!({
                "id": id, "title": title, "platform": platform, "channels": cfg.channels, "started_at": started_at,
                "language": cfg.language, "final_transcript": cfg.final_transcript,
            }),
        });
    }

    // Committed text → UI, local JSONL backup, server (via outbox).
    let segments = Arc::new(Mutex::new(Vec::<Value>::new()));
    let jsonl = rec_dir.join(format!("{id}.segments.jsonl"));
    let alive = Arc::new(AtomicBool::new(true));
    let emit: livestt::Emit = {
        let (app, outbox, segments, id, store_live, alive, db) = (app.clone(), st.outbox.clone(), segments.clone(), id.clone(), cfg.store_live, alive.clone(), st.db.clone());
        Arc::new(move |ev| match ev {
            _ if !alive.load(Relaxed) && !matches!(ev, LiveEvent::Committed { .. }) => {}
            LiveEvent::Speaking { channel } | LiveEvent::Idle { channel } => {
                let text = if matches!(ev, LiveEvent::Speaking { .. }) { "…" } else { "" };
                let _ = app.emit("transcript", json!({ "id": format!("partial-{channel}"), "channel": channel, "final": false, "text": text }));
            }
            LiveEvent::Committed { channel, text, start_ms, end_ms } => {
                let seg = json!({ "id": uuid::Uuid::new_v4().to_string(), "channel": channel, "start_ms": start_ms, "end_ms": end_ms, "text": text });
                segments.lock().unwrap().push(seg.clone());
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&jsonl) {
                    let _ = writeln!(f, "{seg}");
                }
                if local {
                    if let Err(e) = store::add_segments(&db.lock().unwrap(), &id, std::slice::from_ref(&seg)) {
                        log(&format!("local store: {e}"));
                    }
                } else if store_live {
                    outbox.push(Job::Segments { meeting_id: id.clone(), segments: vec![seg.clone()] });
                }
                if alive.load(Relaxed) {
                    let mut ui = seg;
                    ui["final"] = json!(true);
                    let _ = app.emit("transcript", ui);
                }
            }
            LiveEvent::Status { channel, ok, detail } => {
                let _ = app.emit("stt-status", json!({ "channel": channel, "state": if ok { "live" } else { "down" }, "detail": detail }));
            }
        })
    };
    let (mut sink, live) = livestt::start(livestt::LiveConfig { key, model: cfg.live_model.clone(), language: cfg.language.clone() }, cfg.channels, emit);

    let frames = Arc::new(AtomicU64::new(0));
    let capture = {
        let (rec, chans, frames, app2, app3) = (recorder.clone(), chans.clone(), frames.clone(), app.clone(), app.clone());
        let (mut echo, mut lv, mut n, mut rec_err) = (audio::EchoDetector::default(), (0f32, 0f32), 0u32, false);
        audio::Capture::start(
            cfg.mic_device.clone(),
            cfg.output_device.clone(),
            move |mic, sys| {
                let i = frames.fetch_add(1, Relaxed);
                if let Some(r) = rec.lock().unwrap().as_mut() {
                    if let Err(e) = r.write(mic, sys) {
                        if !rec_err {
                            log(&format!("recorder: {e}"));
                            rec_err = true;
                        }
                    }
                }
                if let Some(c) = chans.lock().unwrap().as_mut() {
                    if let Err(e) = c.write(mic, sys) {
                        if !rec_err {
                            log(&format!("channel recorder: {e}"));
                            rec_err = true;
                        }
                    }
                }
                sink.push(mic, sys, i * 20);
                let (rm, rs) = (audio::rms(mic), audio::rms(sys));
                lv = (lv.0.max(audio::level(rm)), lv.1.max(audio::level(rs)));
                if let Some(e) = echo.push(rm, rs) {
                    let _ = app2.emit("echo", json!({ "detected": e }));
                }
                n += 1;
                if n % 5 == 0 {
                    let _ = app2.emit("levels", json!({ "me": lv.0, "them": lv.1 }));
                    lv = (0.0, 0.0);
                }
            },
            move |err| {
                let _ = app3.emit("audio-status", json!({ "error": err }));
            },
        )
    };

    let s = Session {
        id: id.clone(),
        title: title.clone(),
        platform: platform.clone(),
        started_at: started_at.clone(),
        started: Instant::now(),
        channels: cfg.channels,
        language: cfg.language.clone(),
        upload: cfg.final_transcript, // local mode: "has an exact-transcript step"
        alive,
        capture: Some(capture),
        live: Some(live),
        recorder,
        chans,
        local,
        path,
        segments,
        frames,
    };
    let snap = snapshot(Some(&s));
    *guard = Some(s);
    drop(guard);
    log(&format!("session {id} started"));
    let _ = app.emit("session", &snap);
    set_record_label(app, true);
    if let Some(t) = app.get_webview_window("toast") {
        let _ = t.hide();
    }
    show_overlay(app, false);
    Ok(snap)
}

fn snapshot(s: Option<&Session>) -> Value {
    match s {
        None => json!({ "active": false }),
        Some(s) => json!({
            "active": true, "meeting_id": s.id, "title": s.title, "platform": s.platform, "started_at": s.started_at,
            "elapsed_ms": s.elapsed_ms(), "channels": s.channels, "language": s.language, "segments": *s.segments.lock().unwrap(),
        }),
    }
}

#[tauri::command]
fn session_snapshot(st: S) -> Value {
    snapshot(st.session.lock().unwrap().as_ref())
}

#[tauri::command]
fn stop_session(app: AppHandle) {
    stop(&app);
}

/// Returns the task that queues Upload + Finish (it waits for in-flight live STT first); await it before exiting.
fn stop(app: &AppHandle) -> Option<tauri::async_runtime::JoinHandle<()>> {
    let st = app.state::<App>();
    let mut s = st.session.lock().unwrap().take()?;
    if let Some(c) = s.capture.take() {
        c.stop();
    }
    if let Some(r) = s.recorder.lock().unwrap().take() {
        if let Err(e) = r.finish() {
            log(&format!("recorder finish: {e}"));
        }
    }
    if let Some(c) = s.chans.lock().unwrap().take() {
        if let Err(e) = c.finish() {
            log(&format!("channel recorder finish: {e}"));
        }
    }
    let duration_s = s.started.elapsed().as_secs();
    let ended_at = chrono::Local::now().to_rfc3339();
    let upload = s.upload;
    log(&format!("session {} stopped after {duration_s} s", s.id));

    // Capture is stopped, so the live sink has flushed its last utterance; let those requests finish before the
    // server is told to finish (so the last live segment is not lost).
    // Late live segments are inserted before the queued Finish (Outbox::push); the server also waits a moment before
    // summarizing a meeting without audio.
    s.alive.store(false, Relaxed);
    if s.local {
        finish_local(&st, &s.id, &s.path, &ended_at, duration_s as i64);
    } else {
        queue_finish(&st.outbox, &s.id, &s.path, upload, json!({ "ended_at": ended_at, "duration_s": duration_s }));
    }
    let live = s.live.take();
    let queued = tauri::async_runtime::spawn(async move {
        if let Some(h) = live {
            let _ = tokio::time::timeout(Duration::from_secs(20), h).await;
        }
    });

    let _ = app.emit("session", json!({ "active": false }));
    set_record_label(app, false);
    if let Some(o) = app.get_webview_window("overlay") {
        let _ = o.hide();
    }
    show_toast(app, json!({ "kind": "processing", "meeting_id": s.id, "title": s.title, "platform": s.platform, "duration_s": duration_s, "upload": upload, "local": s.local, "segments": *s.segments.lock().unwrap() }));
    Some(queued)
}

/// Local storage: the call ends in the database, which also queues the post-call job (it survives a restart).
fn finish_local(st: &App, id: &str, path: &std::path::Path, ended_at: &str, duration_s: i64) {
    let audio = std::fs::metadata(path).ok().filter(|m| m.len() > 0).map(|m| (path.to_string_lossy().into_owned(), m.len()));
    match store::finish_meeting(&st.db.lock().unwrap(), id, ended_at, duration_s, audio.as_ref().map(|(p, n)| (p.as_str(), *n)), 20_000) {
        Ok(()) => {
            let _ = std::fs::remove_file(path.with_extension("open"));
            st.wake.notify_one();
        }
        Err(e) => log(&format!("finish {id}: {e}")), // the .open marker stays: finished on the next start
    }
}

/// Local-storage sessions that never reached stop(): finish them in the database (the others are left to `recover_sessions`).
fn recover_local(st: &App, rec_dir: &std::path::Path) {
    let Ok(dir) = std::fs::read_dir(rec_dir) else { return };
    for marker in dir.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "open")) {
        let Some(id) = marker.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
        let path = marker.with_extension("ogg");
        let started = store::get_meeting(&st.db.lock().unwrap(), &id).ok().flatten().map(|m| m.started_at);
        let Some(started) = started else { continue };
        log(&format!("recovering unfinished local session {id}"));
        let ended = std::fs::metadata(&path).and_then(|m| m.modified()).map(chrono::DateTime::<chrono::Local>::from).unwrap_or_else(|_| chrono::Local::now());
        let secs = chrono::DateTime::parse_from_rfc3339(&started).map_or(0, |s| (ended.fixed_offset() - s).num_seconds().max(0));
        finish_local(st, &id, &path, &ended.to_rfc3339(), secs);
    }
}

fn queue_finish(outbox: &Outbox, id: &str, path: &PathBuf, upload: bool, body: Value) {
    if upload {
        outbox.push(Job::Upload { meeting_id: id.to_string(), path: path.clone() });
    }
    outbox.push(Job::Finish { meeting_id: id.to_string(), body });
    let _ = std::fs::remove_file(path.with_extension("open"));
}

/// Sessions that never reached stop() (Windows shutdown, crash, a second Quit): finish them now.
fn recover_sessions(outbox: &Outbox, rec_dir: &std::path::Path) {
    let Ok(dir) = std::fs::read_dir(rec_dir) else { return };
    for marker in dir.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "open")) {
        let (Some(id), path) = (marker.file_stem().and_then(|s| s.to_str()).map(str::to_string), marker.with_extension("ogg")) else { continue };
        let upload = std::fs::read_to_string(&marker).is_ok_and(|v| v.trim() == "1") && path.exists();
        let ended = std::fs::metadata(&path).and_then(|m| m.modified()).map(chrono::DateTime::<chrono::Local>::from).unwrap_or_else(|_| chrono::Local::now());
        log(&format!("recovering unfinished session {id}"));
        queue_finish(outbox, &id, &path, upload, json!({ "ended_at": ended.to_rfc3339() }));
    }
}

#[tauri::command]
fn save_hint(st: S, id: String, at_ms: u64, payload: Value) {
    if let Some(s) = st.session.lock().unwrap().as_ref() {
        if s.local {
            let _ = store::add_hint(&st.db.lock().unwrap(), &s.id, &id, at_ms as i64, &payload);
        } else {
            st.outbox.push(Job::Post { path: format!("/api/meetings/{}/hints", s.id), body: json!({ "id": id, "at_ms": at_ms, "payload": payload }) });
        }
    }
}

#[tauri::command]
fn add_mark(app: AppHandle, label: Option<String>) {
    mark(&app, label)
}

fn mark(app: &AppHandle, label: Option<String>) {
    let st = app.state::<App>();
    if let Some(s) = st.session.lock().unwrap().as_ref() {
        let at = s.elapsed_ms();
        let mark_id = uuid::Uuid::new_v4().to_string();
        if s.local {
            let _ = store::add_mark(&st.db.lock().unwrap(), &s.id, &mark_id, at as i64, label.as_deref());
        } else {
            st.outbox.push(Job::Post { path: format!("/api/meetings/{}/marks", s.id), body: json!({ "id": mark_id, "at_ms": at, "label": label }) });
        }
        let _ = app.emit("mark", json!({ "at_ms": at, "label": label }));
    };
}

#[tauri::command]
async fn meeting_status(st: S<'_>, id: String) -> Result<Value, String> {
    // Local archive first (ids are UUIDs); a meeting that is not there lives on the server.
    if let Some(v) = store::meeting_view(&st.db.lock().unwrap(), &id).map_err(|e| e.to_string())? {
        return Ok(v);
    }
    st.server.get(&format!("/api/meetings/{id}")).await.map_err(|e| e.to_string())
}

/// Full transcript as "[mm:ss] Speaker: text" lines: local archive first, else the server's `GET /api/meetings/:id/transcript`.
#[tauri::command]
async fn meeting_transcript(st: S<'_>, id: String) -> Result<String, String> {
    if let Some(_) = store::get_meeting(&st.db.lock().unwrap(), &id).map_err(|e| e.to_string())? {
        let (_, rows) = store::transcript_rows(&st.db.lock().unwrap(), &id).map_err(|e| e.to_string())?;
        return Ok(transcript::transcript_text(&rows.into_iter().map(|r| (r.speaker, r.start_ms, r.text)).collect::<Vec<_>>()));
    }
    let v = st.server.get(&format!("/api/meetings/{id}/transcript")).await.map_err(|e| e.to_string())?;
    Ok(v["text"].as_str().unwrap_or_default().to_string())
}

/// Home page of the settings window: local archive, or the server's `GET /api/meetings` in server mode (offline: empty + `error`).
#[tauri::command]
async fn home_overview(st: S<'_>) -> Result<Value, String> {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let server_mode = st.settings.lock().unwrap().storage == "server";
    if server_mode {
        return Ok(match st.server.get(&format!("/api/meetings?limit=50&today={today}")).await {
            Ok(v) => v,
            Err(e) => serde_json::json!({ "source": "server", "stats": null, "activity": [], "platforms": {}, "recent": [], "error": e.to_string() }),
        });
    }
    store::home_overview(&st.db.lock().unwrap(), &today).map_err(|e| e.to_string())
}

/// Level meters for the settings page while not recording.
#[tauri::command]
fn monitor_levels(app: AppHandle, on: bool) {
    let st = app.state::<App>();
    let mut m = st.monitor.lock().unwrap();
    if let Some(c) = m.take() {
        c.stop();
    }
    if !on || st.session.lock().unwrap().is_some() {
        return;
    }
    let cfg = st.settings.lock().unwrap().clone();
    let (app2, app3) = (app.clone(), app.clone());
    let (mut lv, mut n) = ((0f32, 0f32), 0u32);
    *m = Some(audio::Capture::start(
        cfg.mic_device,
        cfg.output_device,
        move |mic, sys| {
            lv = (lv.0.max(audio::level(audio::rms(mic))), lv.1.max(audio::level(audio::rms(sys))));
            n += 1;
            if n % 5 == 0 {
                let _ = app2.emit("levels", json!({ "me": lv.0, "them": lv.1 }));
                lv = (0.0, 0.0);
            }
        },
        move |err| {
            let _ = app3.emit("audio-status", json!({ "error": err }));
        },
    ));
}

// ------------------------------------------------------------------ windows, toast, tray, shortcuts

fn show_overlay(app: &AppHandle, focus: bool) {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.show();
        if focus {
            let _ = w.set_focus();
        }
        let _ = app.emit_to("overlay", "overlay-shown", ());
    }
}

fn toggle_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show_overlay(app, false);
        }
    }
}

fn show_toast(app: &AppHandle, payload: Value) {
    *app.state::<App>().toast.lock().unwrap() = payload.clone();
    let _ = app.emit_to("toast", "toast", payload.clone());
    if let Some(w) = app.get_webview_window("toast") {
        let _ = w.show();
        if payload["kind"] == "start" {
            let _ = w.set_focus();
        }
    }
}

#[tauri::command]
fn toast_state(st: S) -> Value {
    st.toast.lock().unwrap().clone()
}

/// A1: ask for a title before recording (manual start in the MVP).
#[tauri::command]
fn show_start(app: AppHandle) {
    open_start(&app)
}

/// A1 after automatic call detection: another app took the microphone.
fn open_auto_start(app: &AppHandle, mic_app: &str) {
    let (title, platform) = detect::detect(&detect::window_titles());
    let countdown = app.state::<App>().settings.lock().unwrap().call_autostart_s;
    log(&format!("call detected: {mic_app} uses the microphone"));
    show_toast(app, json!({ "kind": "start", "title": title, "platform": platform, "auto": true, "mic_app": mic_app, "countdown_s": countdown }));
}

/// Polls the Windows microphone consent store; a rising edge (some other app starts using the mic) offers to record.
fn watch_calls(app: AppHandle) {
    std::thread::spawn(move || {
        let mut busy = false;
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let st = app.state::<App>();
            if st.session.lock().unwrap().is_some() {
                busy = true; // the call that is being recorded must not re-prompt after Stop
                continue;
            }
            if !st.settings.lock().unwrap().call_detect {
                busy = false;
                continue;
            }
            let users = micwatch::mic_users();
            if !users.is_empty() && !busy {
                open_auto_start(&app, &users[0]);
            }
            if users.is_empty() && busy {
                // the call ended before anyone answered the prompt: take it away again
                let auto = { let t = st.toast.lock().unwrap(); t["kind"] == "start" && t["auto"] == true };
                if auto {
                    *st.toast.lock().unwrap() = json!({});
                    if let Some(w) = app.get_webview_window("toast") {
                        let _ = w.hide();
                    }
                }
            }
            busy = !users.is_empty();
        }
    });
}

fn open_start(app: &AppHandle) {
    if app.state::<App>().session.lock().unwrap().is_some() {
        show_overlay(app, true);
        return;
    }
    let (title, platform) = detect::detect(&detect::window_titles());
    show_toast(app, json!({ "kind": "start", "title": title, "platform": platform }));
}

#[tauri::command]
fn open_settings(app: AppHandle, page: Option<String>) {
    open_settings_window(&app, page)
}

fn open_settings_window(app: &AppHandle, page: Option<String>) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        if let Some(p) = page {
            let _ = app.emit_to("settings", "settings-page", p);
        }
    }
}

#[tauri::command]
fn focus_chat(app: AppHandle) {
    show_overlay(&app, true);
    let _ = app.emit_to("overlay", "focus-chat", ());
}

fn set_record_label(app: &AppHandle, recording: bool) {
    let st = app.state::<App>();
    let key = st.settings.lock().unwrap().shortcuts.record.clone();
    if let Some(i) = st.record_item.lock().unwrap().as_ref() {
        let _ = i.set_text(format!("{}\t{key}", if recording { "Stop recording" } else { "Start recording" }));
    };
}

fn register_shortcuts(app: &AppHandle, s: &Settings) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let (mut list, mut failed) = (vec![], vec![]);
    for (key, action) in [(&s.shortcuts.record, "record"), (&s.shortcuts.overlay, "overlay"), (&s.shortcuts.chat, "chat"), (&s.shortcuts.mark, "mark")] {
        match Shortcut::from_str(key).map_err(|e| e.to_string()).and_then(|sc| gs.register(sc).map(|_| sc).map_err(|e| e.to_string())) {
            Ok(sc) => list.push((sc, action)),
            Err(e) => {
                log(&format!("shortcut {key}: {e}"));
                failed.push(action);
            }
        }
    }
    let st = app.state::<App>();
    *st.shortcuts.lock().unwrap() = list;
    *st.shortcut_errors.lock().unwrap() = failed;
}

#[tauri::command]
fn shortcut_errors(st: S) -> Vec<&'static str> {
    st.shortcut_errors.lock().unwrap().clone()
}

fn on_shortcut(app: &AppHandle, sc: &Shortcut) {
    let action = app.state::<App>().shortcuts.lock().unwrap().iter().find(|(s, _)| s == sc).map(|(_, a)| *a);
    match action {
        Some("record") => toggle_record(app),
        Some("overlay") => toggle_overlay(app),
        Some("chat") => focus_chat(app.clone()),
        Some("mark") => mark(app, None),
        _ => {}
    }
}

fn toggle_record(app: &AppHandle) {
    let active = app.state::<App>().session.lock().unwrap().is_some();
    if active {
        stop(app);
    } else {
        open_start(app);
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let s = app.state::<App>().settings.lock().unwrap().clone();
    let record = MenuItem::with_id(app, "record", format!("Start recording\t{}", s.shortcuts.record), true, None::<&str>)?;
    let overlay = MenuItem::with_id(app, "overlay", format!("Show overlay\t{}", s.shortcuts.overlay), true, None::<&str>)?;
    let hints = CheckMenuItem::with_id(app, "hints", "Automatic hints", true, s.hints_enabled, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Kazetix", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&record, &overlay, &sep, &hints, &settings, &sep2, &quit])?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("icon"))
        .tooltip("Kazetix")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "record" => toggle_record(app),
            "overlay" => toggle_overlay(app),
            "hints" => {
                let st = app.state::<App>();
                let mut s = st.settings.lock().unwrap().clone();
                s.hints_enabled = !s.hints_enabled;
                let _ = save_settings(app.clone(), st, s);
            }
            "settings" => open_settings_window(app, None),
            "quit" => match stop(app) {
                Some(queued) => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = queued.await;
                        app.exit(0);
                    });
                }
                None => app.exit(0),
            },
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = e {
                let app = tray.app_handle();
                if app.state::<App>().session.lock().unwrap().is_some() {
                    toggle_overlay(app);
                } else {
                    open_settings_window(app, None);
                }
            }
        })
        .build(app)?;
    *app.state::<App>().record_item.lock().unwrap() = Some(record);
    *app.state::<App>().overlay_item.lock().unwrap() = Some(overlay);
    *app.state::<App>().hints_item.lock().unwrap() = Some(hints);
    Ok(())
}

/// `Kazetix --mcp`: serve the local archive to Claude over stdio. No window, no Tauri.
pub fn run_mcp() {
    let dir = store::data_dir();
    let conn = match store::open(&dir) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("kazetix --mcp: cannot open {}: {e}", dir.display());
            std::process::exit(1);
        }
    };
    let s = Settings::load(&dir.join("settings.json"));
    let ctx = mcp::Ctx { version: env!("CARGO_PKG_VERSION").into(), stt_model: "elevenlabs/scribe-v2".into(), summary_model: s.summary_model, openrouter: settings::secret_get("openrouter_key").is_some() };
    if let Err(e) = mcp::serve_stdio(&conn, &ctx) {
        eprintln!("kazetix --mcp: {e}");
        std::process::exit(1);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| open_settings_window(app, None)))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, sc, ev| {
                    if ev.state() == ShortcutState::Pressed {
                        on_shortcut(app, sc);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            settings::migrate_legacy_data(&data_dir);
            let _ = LOG.set(data_dir.join("kazetix.log"));
            log(&format!("Kazetix {} starting", app.package_info().version));
            let settings_path = data_dir.join("settings.json");
            let first_run = !settings_path.exists();
            let settings = Settings::load(&settings_path);
            let server = Server::new();
            let outbox = Outbox::load(data_dir.join("outbox.json"));
            let db: Db = Arc::new(Mutex::new(store::open(&data_dir)?));
            let _ = store::revive_jobs(&db.lock().unwrap()); // jobs that gave up in an earlier run get another go
            let wake = Arc::new(tokio::sync::Notify::new());
            let status = outbox.status(true, None);
            app.manage(App {
                settings: Mutex::new(settings.clone()),
                settings_path,
                data_dir,
                server: server.clone(),
                outbox: outbox.clone(),
                db: db.clone(),
                wake: wake.clone(),
                status: Mutex::new(status),
                session: Mutex::new(None),
                monitor: Mutex::new(None),
                toast: Mutex::new(json!({})),
                shortcuts: Mutex::new(vec![]),
                record_item: Mutex::new(None),
                overlay_item: Mutex::new(None),
                hints_item: Mutex::new(None),
                shortcut_errors: Mutex::new(vec![]),
            });
            let handle = app.handle().clone();
            let rec_dir = handle.state::<App>().data_dir.join("recordings");
            recover_local(&handle.state::<App>(), &rec_dir);
            recover_sessions(&outbox, &rec_dir);
            let h3 = handle.clone();
            pipeline::spawn(
                db,
                Arc::new(move || {
                    let s = h3.state::<App>().settings.lock().unwrap().clone();
                    pipeline::JobCfg { key: settings::secret_get("openrouter_key"), summary_model: s.summary_model, default_language: s.language }
                }),
                rec_dir,
                wake,
            );
            let (h1, h2) = (handle.clone(), handle.clone());
            outbox.spawn(
                server,
                move |s| {
                    *h1.state::<App>().status.lock().unwrap() = s.clone();
                    let _ = h1.emit("server-status", s);
                },
                move |id, sent, total| {
                    let _ = h2.emit("upload", json!({ "meeting_id": id, "sent": sent, "total": total }));
                },
            );
            build_tray(&handle)?;
            apply_settings(&handle, &settings);
            watch_calls(handle.clone());
            if first_run || (settings.storage == "server" && settings.server_url.is_empty()) {
                open_settings_window(&handle, Some("server".into()));
            }
            Ok(())
        })
        .on_window_event(|w, e| {
            // Windows are hidden, not destroyed: the app lives in the tray.
            if let WindowEvent::CloseRequested { api, .. } = e {
                api.prevent_close();
                let _ = w.hide();
                if w.label() == "settings" {
                    monitor_levels(w.app_handle().clone(), false);
                    let _ = w.emit_to("settings", "settings-page", "general");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            secret_status,
            set_secret,
            openrouter_key,
            verify_server,
            server_status,
            list_devices,
            log_path,
            detect_call,
            shortcut_errors,
            start_session,
            stop_session,
            session_snapshot,
            save_hint,
            add_mark,
            meeting_status,
            meeting_transcript,
            home_overview,
            monitor_levels,
            toast_state,
            show_start,
            open_settings,
            focus_chat,
            mcp_exe,
            connect_claude_desktop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kazetix");
}

/// Which other apps are using the microphone right now, from the consent store Windows keeps for the privacy indicator:
/// HKCU\\...\\CapabilityAccessManager\\ConsentStore\\microphone\\<app> (packaged) and \\NonPackaged\\<exe path with # for \\>.
/// An app is using it while LastUsedTimeStart is set and LastUsedTimeStop is 0.
mod micwatch {
    /// `entries`: (key name, LastUsedTimeStart, LastUsedTimeStop). Returns display names of current users, our own exe excluded.
    pub fn in_use(entries: &[(String, u64, u64)], self_key: &str) -> Vec<String> {
        entries
            .iter()
            .filter(|(k, start, stop)| *start > 0 && *stop == 0 && !k.eq_ignore_ascii_case(self_key))
            .map(|(k, _, _)| label(k))
            .collect()
    }

    pub fn label(key: &str) -> String {
        let l = key.to_ascii_lowercase();
        for (needle, name) in [("msteams", "Microsoft Teams"), ("teams.exe", "Microsoft Teams"), ("zoom", "Zoom"), ("chrome.exe", "Google Chrome"), ("msedge.exe", "Microsoft Edge"),
            ("firefox.exe", "Firefox"), ("brave.exe", "Brave"), ("slack", "Slack"), ("discord", "Discord"), ("webex", "Webex"), ("skype", "Skype"), ("whatsapp", "WhatsApp"), ("telegram", "Telegram")] {
            if l.contains(needle) {
                return name.into();
            }
        }
        // NonPackaged: "C:#Program Files#Foo#foo.exe" -> "foo"; packaged: "Vendor.App_hash" -> "Vendor.App"
        let last = key.rsplit('#').next().unwrap_or(key);
        last.trim_end_matches(".exe").split('_').next().unwrap_or(last).to_string()
    }

    #[cfg(windows)]
    pub fn mic_users() -> Vec<String> {
        const BASE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
        let self_key = std::env::current_exe().map(|p| p.to_string_lossy().replace('\\', "#")).unwrap_or_default();
        let mut entries = vec![];
        for base in [BASE.to_string(), format!(r"{BASE}\NonPackaged")] {
            for name in reg::subkeys(&base) {
                if name == "NonPackaged" {
                    continue;
                }
                let path = format!(r"{base}\{name}");
                entries.push((name, reg::qword(&path, "LastUsedTimeStart"), reg::qword(&path, "LastUsedTimeStop")));
            }
        }
        in_use(&entries, &self_key)
    }

    #[cfg(not(windows))]
    pub fn mic_users() -> Vec<String> {
        vec![]
    }

    #[cfg(windows)]
    mod reg {
        use windows::core::{HSTRING, PWSTR};
        use windows::Win32::System::Registry::{RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ, RRF_RT_REG_QWORD};

        pub fn subkeys(path: &str) -> Vec<String> {
            let mut out = vec![];
            unsafe {
                let mut hk = HKEY::default();
                if RegOpenKeyExW(HKEY_CURRENT_USER, &HSTRING::from(path), Some(0), KEY_READ, &mut hk).is_err() {
                    return out;
                }
                for i in 0.. {
                    let mut buf = [0u16; 512];
                    let mut len = buf.len() as u32;
                    if RegEnumKeyExW(hk, i, Some(PWSTR(buf.as_mut_ptr())), &mut len, None, None, None, None).is_err() {
                        break;
                    }
                    out.push(String::from_utf16_lossy(&buf[..len as usize]));
                }
                let _ = RegCloseKey(hk);
            }
            out
        }

        pub fn qword(path: &str, name: &str) -> u64 {
            let mut data = 0u64;
            let mut size = 8u32;
            let r = unsafe {
                RegGetValueW(HKEY_CURRENT_USER, &HSTRING::from(path), &HSTRING::from(name), RRF_RT_REG_QWORD, None, Some(&mut data as *mut u64 as *mut _), Some(&mut size))
            };
            if r.is_ok() { data } else { 0 }
        }
    }

    #[cfg(test)]
    #[test]
    fn picks_current_users_only() {
        let e = |k: &str, a: u64, b: u64| (k.to_string(), a, b);
        let entries = [
            e("MSTeams_8wekyb3d8bbwe", 133, 0),
            e("C:#Program Files#Google#Chrome#Application#chrome.exe", 120, 121),
            e("C:#Users#me#AppData#Local#Programs#Kazetix#Kazetix.exe", 140, 0),
            e("C:#Program Files#Foo#Recorder.exe", 150, 0),
        ];
        assert_eq!(in_use(&entries, "C:#Users#me#AppData#Local#Programs#Kazetix#Kazetix.exe"), vec!["Microsoft Teams".to_string(), "Recorder".to_string()]);
    }
}

/// Meeting title / platform guess from visible window titles (prefills A1).
mod detect {
    pub fn detect(titles: &[String]) -> (String, Option<&'static str>) {
        const TEAMS_NAV: &[&str] = &["Chat", "Activity", "Calendar", "Teams", "Calls", "Files", "Apps", "Aktivita", "Kalendář", "Hovory", "Soubory"];
        for t in titles {
            if let Some(name) = t.split(" | ").next().filter(|_| t.contains("Microsoft Teams")) {
                let name = name.trim();
                if !name.is_empty() && name != "Microsoft Teams" && !TEAMS_NAV.contains(&name) {
                    return (name.to_string(), Some("teams"));
                }
            }
        }
        for t in titles {
            if let Some(rest) = t.strip_prefix("Meet - ").or_else(|| t.strip_prefix("Meet – ")) {
                let name = rest.rsplit_once(" - ").or_else(|| rest.rsplit_once(" – ")).map_or(rest, |(n, _)| n).trim();
                let is_code = name.len() == 12 && name.chars().filter(|c| *c == '-').count() == 2;
                return (if is_code || name.is_empty() { "Google Meet".into() } else { name.to_string() }, Some("meet"));
            }
        }
        if titles.iter().any(|t| t.starts_with("Zoom Meeting") || t == "Zoom Workplace" || t.contains("Zoom Meeting")) {
            return ("Zoom meeting".into(), Some("zoom"));
        }
        (String::new(), None)
    }

    #[cfg(windows)]
    pub fn window_titles() -> Vec<String> {
        use windows::core::BOOL;
        use windows::Win32::Foundation::{HWND, LPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, IsWindowVisible};
        unsafe extern "system" fn cb(hwnd: HWND, lp: LPARAM) -> BOOL {
            let v = &mut *(lp.0 as *mut Vec<String>);
            if IsWindowVisible(hwnd).as_bool() {
                let mut buf = [0u16; 512];
                let n = GetWindowTextW(hwnd, &mut buf);
                if n > 0 {
                    v.push(String::from_utf16_lossy(&buf[..n as usize]));
                }
            }
            BOOL(1)
        }
        let mut v: Vec<String> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(cb), LPARAM(&mut v as *mut _ as isize));
        }
        v
    }

    #[cfg(not(windows))]
    pub fn window_titles() -> Vec<String> {
        vec![]
    }

    #[cfg(test)]
    #[test]
    fn detects_platforms() {
        let t = |v: &[&str]| detect(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(t(&["Chat | Microsoft Teams", "Sync rezervací | Microsoft Teams"]), ("Sync rezervací".into(), Some("teams")));
        assert_eq!(t(&["Meet - abc-defg-hij - Google Chrome"]), ("Google Meet".into(), Some("meet")));
        assert_eq!(t(&["Meet – Weekly sync – Microsoft Edge"]), ("Weekly sync".into(), Some("meet")));
        assert_eq!(t(&["Zoom Meeting"]).1, Some("zoom"));
        assert_eq!(t(&["Spotify"]), (String::new(), None));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn unfinished_sessions_are_finished_on_start() {
        let dir = std::env::temp_dir().join(format!("hw-rec-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("m1.ogg"), b"OggS").unwrap();
        std::fs::write(dir.join("m1.open"), "1").unwrap();
        let outbox = super::Outbox::load(dir.join("outbox.json"));
        super::recover_sessions(&outbox, &dir);
        let s = outbox.status(true, None);
        assert_eq!((s.pending, s.pending_uploads), (2, 1));
        assert!(!dir.join("m1.open").exists());
        super::recover_sessions(&outbox, &dir); // nothing left to recover
        assert_eq!(outbox.status(true, None).pending, 2);
        let _ = std::fs::remove_dir_all(dir);
    }
}
