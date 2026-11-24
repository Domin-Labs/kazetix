//! Kazetix server REST client + a persistent outbox, so nothing is lost while offline:
//! meeting creation, live segments, hints, marks, the resumable audio upload and `finish` are queued in a JSON file
//! and replayed in order. ponytail: JSON file instead of SQLite; the queue is tiny and single-writer.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tokio::sync::Notify;

pub enum ApiError {
    /// Transient (network, 5xx, bad token): keep the job and retry later.
    Retry(String),
    /// Permanent (4xx): the job can never succeed.
    Drop(String),
    Conflict(Value),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Retry(s) | ApiError::Drop(s) => f.write_str(s),
            ApiError::Conflict(v) => write!(f, "conflict: {v}"),
        }
    }
}

#[derive(Clone)]
pub struct Server {
    http: reqwest::Client,
    conf: Arc<RwLock<(String, String)>>, // (base url, api token)
}

impl Server {
    pub fn new() -> Self {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(120)).build().expect("http client");
        Self { http, conf: Arc::new(RwLock::new((String::new(), String::new()))) }
    }

    pub fn configure(&self, url: &str, token: &str) {
        *self.conf.write().unwrap() = (url.trim().trim_end_matches('/').to_string(), token.trim().to_string());
    }

    fn target(&self, path: &str) -> Result<(String, String), ApiError> {
        let (base, token) = self.conf.read().unwrap().clone();
        if base.is_empty() || token.is_empty() {
            return Err(ApiError::Retry("Server address or API token is not set".into()));
        }
        Ok((format!("{base}{path}"), token))
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<Value, ApiError> {
        let res = req.send().await.map_err(|e| ApiError::Retry(format!("Server unreachable ({})", short(&e))))?;
        let status = res.status().as_u16();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        match status {
            200..=299 => Ok(body),
            401 => Err(ApiError::Retry("Server rejected the API token".into())),
            409 => Err(ApiError::Conflict(body)),
            408 | 413 | 429 => Err(ApiError::Retry(format!("Server answered {status}, retrying"))),
            400..=499 => Err(ApiError::Drop(format!("HTTP {status}: {body}"))),
            _ => Err(ApiError::Retry(format!("Server error {status}: {}", body["error"].as_str().unwrap_or("")))),
        }
    }

    pub async fn get(&self, path: &str) -> Result<Value, ApiError> {
        let (url, token) = self.target(path)?;
        self.send(self.http.get(url).bearer_auth(token)).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> Result<Value, ApiError> {
        let (url, token) = self.target(path)?;
        self.send(self.http.post(url).bearer_auth(token).json(body)).await
    }

    /// Resumable upload in 4 MB chunks; continues from what the server already has.
    pub async fn upload(&self, meeting_id: &str, path: &PathBuf, progress: &(dyn Fn(u64, u64) + Send + Sync)) -> Result<(), ApiError> {
        const CHUNK: u64 = 1024 * 1024;
        let mut file = std::fs::File::open(path).map_err(|e| ApiError::Drop(format!("recording missing: {e}")))?;
        let total = file.metadata().map(|m| m.len()).unwrap_or(0);
        if total == 0 {
            return Ok(());
        }
        let mut offset = self.get(&format!("/api/meetings/{meeting_id}")).await?["audio_bytes"].as_u64().unwrap_or(0);
        if offset > total {
            offset = 0;
        }
        progress(offset, total);
        while offset < total {
            let len = CHUNK.min(total - offset);
            let mut buf = vec![0u8; len as usize];
            file.seek(SeekFrom::Start(offset)).and_then(|_| file.read_exact(&mut buf)).map_err(|e| ApiError::Drop(e.to_string()))?;
            let (url, token) = self.target(&format!("/api/meetings/{meeting_id}/audio"))?;
            let req = self
                .http
                .put(url)
                .bearer_auth(token)
                .header("Content-Range", format!("bytes {}-{}/{}", offset, offset + len - 1, total))
                .header("Content-Type", "application/octet-stream")
                .body(buf);
            offset = match self.send(req).await {
                Ok(v) if v["complete"].as_bool() == Some(true) => total,
                Ok(v) => v["received"].as_u64().unwrap_or(offset + len),
                Err(ApiError::Conflict(v)) => match v["received"].as_u64() {
                    Some(r) if r <= total => r,
                    Some(_) => 0, // server holds more than this file: start over (offset 0 resets its part file)
                    None => return Err(ApiError::Retry("upload offset unknown".into())),
                },
                Err(e) => return Err(e),
            };
            progress(offset, total);
        }
        Ok(())
    }
}

fn short(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "timeout".into()
    } else if e.is_connect() {
        "connection failed".into()
    } else {
        e.to_string().chars().take(120).collect()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Job {
    Create { body: Value },
    Segments { meeting_id: String, segments: Vec<Value> },
    Post { path: String, body: Value },
    Upload { meeting_id: String, path: PathBuf },
    Finish { meeting_id: String, body: Value },
}

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct ServerStatus {
    pub ok: bool,
    pub error: Option<String>,
    pub pending: usize,
    pub pending_uploads: usize,
}

pub struct Outbox {
    jobs: Mutex<VecDeque<Job>>,
    file: PathBuf,
    notify: Notify,
    kick: Notify,
}

impl Outbox {
    pub fn load(file: PathBuf) -> Arc<Self> {
        let jobs = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Arc::new(Self { jobs: Mutex::new(jobs), file, notify: Notify::new(), kick: Notify::new() })
    }

    pub fn push(&self, job: Job) {
        let mut q = self.jobs.lock().unwrap();
        let before = match &job {
            Job::Segments { meeting_id, .. } => q.iter().skip(1).position(|j| matches!(j, Job::Finish { meeting_id: m, .. } if m == meeting_id)).map(|i| i + 1),
            _ => None,
        };
        match before {
            Some(i) => q.insert(i, job),
            None => q.push_back(job),
        }
        self.save(&q);
        drop(q);
        self.notify.notify_one();
    }

    /// Retry now (e.g. after the user fixed the server settings).
    pub fn kick(&self) {
        self.kick.notify_one();
        self.notify.notify_one();
    }

    fn save(&self, q: &VecDeque<Job>) {
        let tmp = self.file.with_extension("tmp");
        if std::fs::write(&tmp, serde_json::to_vec(q).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, &self.file);
        }
    }

    pub fn status(&self, ok: bool, error: Option<String>) -> ServerStatus {
        let q = self.jobs.lock().unwrap();
        let pending_uploads = q.iter().filter(|j| matches!(j, Job::Upload { .. })).count();
        ServerStatus { ok, error, pending: q.len(), pending_uploads }
    }

    /// Takes the head job; consecutive segment batches of one meeting are merged into one request.
    fn head(&self) -> Option<(Job, usize)> {
        let q = self.jobs.lock().unwrap();
        let first = q.front()?.clone();
        if let Job::Segments { meeting_id, .. } = &first {
            let mut all = vec![];
            let mut n = 0;
            for j in q.iter() {
                match j {
                    Job::Segments { meeting_id: m, segments } if m == meeting_id && all.len() < 500 => {
                        all.extend(segments.iter().cloned());
                        n += 1;
                    }
                    _ => break,
                }
            }
            return Some((Job::Segments { meeting_id: meeting_id.clone(), segments: all }, n));
        }
        Some((first, 1))
    }

    fn pop(&self, n: usize) {
        let mut q = self.jobs.lock().unwrap();
        let k = n.min(q.len());
        q.drain(..k);
        self.save(&q);
    }

    pub fn spawn<E, U>(self: Arc<Self>, server: Server, emit: E, on_upload: U)
    where
        E: Fn(ServerStatus) + Send + Sync + 'static,
        U: Fn(&str, u64, u64) + Send + Sync + 'static,
    {
        tauri::async_runtime::spawn(async move {
            let mut last: Option<ServerStatus> = None;
            let mut backoff = 2u64;
            let report = |last: &mut Option<ServerStatus>, s: ServerStatus| {
                if last.as_ref() != Some(&s) {
                    emit(s.clone());
                    *last = Some(s);
                }
            };
            loop {
                let Some((job, n)) = self.head() else {
                    let (ok, err) = last.as_ref().map_or((true, None), |s| (s.ok, s.error.clone()));
                    report(&mut last, self.status(ok, err));
                    self.notify.notified().await;
                    continue;
                };
                let res = match &job {
                    Job::Create { body } => server.post("/api/meetings", body).await.map(|_| ()),
                    Job::Segments { meeting_id, segments } => server.post(&format!("/api/meetings/{meeting_id}/segments"), &json!({ "segments": segments })).await.map(|_| ()),
                    Job::Post { path, body } => server.post(path, body).await.map(|_| ()),
                    Job::Upload { meeting_id, path } => server.upload(meeting_id, path, &|s, t| on_upload(meeting_id, s, t)).await,
                    Job::Finish { meeting_id, body } => server.post(&format!("/api/meetings/{meeting_id}/finish"), body).await.map(|_| ()),
                };
                match res {
                    Ok(()) => {
                        self.pop(n);
                        backoff = 2;
                        report(&mut last, self.status(true, None));
                    }
                    Err(ApiError::Drop(e)) => {
                        let kind = match &job { Job::Create { .. } => "create", Job::Segments { .. } => "segments", Job::Post { path, .. } => path.as_str(), Job::Upload { .. } => "upload", Job::Finish { .. } => "finish" };
                        crate::log(&format!("outbox: dropping {kind} job: {e}")); // never log transcript content
                        self.pop(n);
                        report(&mut last, self.status(true, None));
                    }
                    Err(e) => {
                        report(&mut last, self.status(false, Some(e.to_string())));
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_secs(backoff)) => {}
                            _ = self.kick.notified() => {}
                        }
                        backoff = (backoff * 2).min(30);
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn late_segments_go_before_queued_finish() {
        let file = std::env::temp_dir().join(format!("hw-outbox-{}.json", std::process::id()));
        let kinds = |o: &Outbox| -> Vec<String> {
            o.jobs.lock().unwrap().iter().map(|j| match j {
                Job::Upload { .. } => "up".into(),
                Job::Finish { .. } => "fin".into(),
                Job::Segments { meeting_id, .. } => format!("seg-{meeting_id}"),
                _ => "?".into(),
            }).collect()
        };
        let seg = |id: &str| Job::Segments { meeting_id: id.into(), segments: vec![] };
        let o = Outbox::load(file.clone());
        o.push(Job::Upload { meeting_id: "a".into(), path: PathBuf::new() });
        o.push(Job::Finish { meeting_id: "a".into(), body: Value::Null });
        o.push(seg("a"));
        o.push(seg("b"));
        assert_eq!(kinds(&o), ["up", "seg-a", "fin", "seg-b"]);
        // Finish at the head may be in flight: never insert in front of it.
        o.pop(3);
        o.push(Job::Finish { meeting_id: "c".into(), body: Value::Null });
        o.pop(1);
        assert_eq!(kinds(&o), ["fin"]);
        o.push(seg("c"));
        assert_eq!(kinds(&o), ["fin", "seg-c"]);
        let _ = std::fs::remove_file(file);
    }
}
