//! Live transcription through OpenRouter (default model: ElevenLabs Scribe v2). Each channel is cut into utterances by
//! an energy VAD (pause ≥ 600 ms, at most 14 s) and every utterance is posted as a WAV to /audio/transcriptions.
//! Text appears ~1–3 s after a sentence; up to 3 requests run in parallel, results carry their own timestamps.
//! ponytail: energy VAD with an adaptive noise floor; swap in Silero/WebRTC VAD if it misfires in practice.

use crate::audio::{rms, FRAME};
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::sync::Semaphore;

const URL: &str = "https://openrouter.ai/api/v1/audio/transcriptions";
const PRE_ROLL: usize = 15 * FRAME; // 300 ms kept before speech onset
const END_SILENCE: u32 = 30; // frames (600 ms)
const MAX_MS: u64 = 14_000;
const MIN_VOICED: u32 = 15; // < 300 ms of voice = click/noise, dropped

pub enum LiveEvent {
    Speaking { channel: &'static str },
    Idle { channel: &'static str },
    Committed { channel: &'static str, text: String, start_ms: u64, end_ms: u64 },
    Status { channel: &'static str, ok: bool, detail: Option<String> },
}

pub type Emit = Arc<dyn Fn(LiveEvent) + Send + Sync>;

pub struct Utterance {
    channel: &'static str,
    start_ms: u64,
    end_ms: u64,
    pcm: Vec<i16>,
}

pub struct Vad {
    noise: f32,
    run: u32,
    silence: u32,
    voiced: u32,
    active: bool,
    pre: VecDeque<i16>,
    buf: Vec<i16>,
    start_ms: u64,
}

impl Default for Vad {
    fn default() -> Self {
        Self { noise: 150.0, run: 0, silence: 0, voiced: 0, active: false, pre: VecDeque::new(), buf: vec![], start_ms: 0 }
    }
}

impl Vad {
    /// Feed one 20 ms frame starting at `at_ms`. Returns (speech just started, finished utterance).
    pub fn push(&mut self, frame: &[i16], at_ms: u64) -> (bool, Option<(u64, u64, Vec<i16>)>) {
        let e = rms(frame);
        let voiced = e > (self.noise * 3.0).max(250.0);
        // Noise floor follows quiet frames quickly and loud ones very slowly (so long speech doesn't raise it).
        self.noise = if !voiced { 0.95 * self.noise + 0.05 * e } else { 0.9995 * self.noise + 0.0005 * e };
        if !self.active {
            self.pre.extend(frame.iter().copied());
            let excess = self.pre.len().saturating_sub(PRE_ROLL);
            self.pre.drain(..excess);
            self.run = if voiced { self.run + 1 } else { 0 };
            if self.run < 3 {
                return (false, None);
            }
            self.active = true;
            self.buf = self.pre.drain(..).collect();
            self.start_ms = (at_ms + 20).saturating_sub(self.buf.len() as u64 / 16);
            self.silence = 0;
            self.voiced = 3;
            return (true, None);
        }
        self.buf.extend_from_slice(frame);
        if voiced {
            self.voiced += 1;
            self.silence = 0;
        } else {
            self.silence += 1;
        }
        if self.silence >= END_SILENCE || self.buf.len() as u64 / 16 >= MAX_MS {
            return (false, self.cut());
        }
        (false, None)
    }

    fn cut(&mut self) -> Option<(u64, u64, Vec<i16>)> {
        self.active = false;
        self.run = 0;
        let buf = std::mem::take(&mut self.buf);
        let end = self.start_ms + buf.len() as u64 / 16;
        (self.voiced >= MIN_VOICED).then_some((self.start_ms, end, buf))
    }

    pub fn flush(&mut self) -> Option<(u64, u64, Vec<i16>)> {
        if self.active {
            self.cut()
        } else {
            None
        }
    }
}

/// Lives inside the capture callback. Dropping it (capture stopped) flushes the last utterance and closes the queue.
pub struct Sink {
    mixed: bool,
    vads: Vec<(&'static str, Vad)>,
    tx: UnboundedSender<Utterance>,
    emit: Emit,
}

impl Sink {
    pub fn push(&mut self, mic: &[i16], sys: &[i16], at_ms: u64) {
        if self.mixed {
            let m: Vec<i16> = mic.iter().zip(sys).map(|(&a, &b)| (a as i32 + b as i32).clamp(i16::MIN as i32, i16::MAX as i32) as i16).collect();
            self.feed(0, &m, at_ms);
        } else {
            self.feed(0, mic, at_ms);
            self.feed(1, sys, at_ms);
        }
    }

    fn feed(&mut self, i: usize, frame: &[i16], at_ms: u64) {
        let (channel, vad) = &mut self.vads[i];
        let (started, done) = vad.push(frame, at_ms);
        if started {
            (self.emit)(LiveEvent::Speaking { channel })
        }
        if let Some((start_ms, end_ms, pcm)) = done {
            (self.emit)(LiveEvent::Idle { channel });
            let _ = self.tx.send(Utterance { channel, start_ms, end_ms, pcm });
        }
    }
}

impl Drop for Sink {
    fn drop(&mut self) {
        for (channel, vad) in &mut self.vads {
            if let Some((start_ms, end_ms, pcm)) = vad.flush() {
                let _ = self.tx.send(Utterance { channel, start_ms, end_ms, pcm });
            }
        }
    }
}

#[derive(Clone)]
pub struct LiveConfig {
    pub key: String,
    pub model: String,
    pub language: String,
}

/// Returns the sink for the capture callback and the worker handle (finishes once the sink is dropped and the queue drained).
pub fn start(cfg: LiveConfig, channels: u8, emit: Emit) -> (Sink, tauri::async_runtime::JoinHandle<()>) {
    let (tx, mut rx) = unbounded_channel::<Utterance>();
    let names: Vec<&'static str> = if channels == 1 { vec!["mixed"] } else { vec!["me", "them"] };
    for &channel in &names {
        emit(LiveEvent::Status { channel, ok: true, detail: None });
    }
    let sink = Sink { mixed: channels == 1, vads: names.into_iter().map(|n| (n, Vad::default())).collect(), tx, emit: emit.clone() };
    let handle = tauri::async_runtime::spawn(async move {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(60)).build().expect("http client");
        let sem = Arc::new(Semaphore::new(3));
        let down: Arc<[AtomicBool; 2]> = Arc::new([AtomicBool::new(false), AtomicBool::new(false)]);
        let mut tasks = tokio::task::JoinSet::new();
        while let Some(u) = rx.recv().await {
            let permit = sem.clone().acquire_owned().await.expect("semaphore");
            let (http, cfg, emit, down) = (http.clone(), cfg.clone(), emit.clone(), down.clone());
            tasks.spawn(async move {
                let _permit = permit;
                let channel = u.channel;
                let down = &down[(channel == "them") as usize];
                match transcribe(&http, &cfg, &u).await {
                    Ok(text) => {
                        if down.swap(false, Relaxed) {
                            emit(LiveEvent::Status { channel, ok: true, detail: None });
                        }
                        if text.is_empty() {
                            emit(LiveEvent::Idle { channel });
                        } else {
                            emit(LiveEvent::Committed { channel, text, start_ms: u.start_ms, end_ms: u.end_ms });
                        }
                    }
                    Err(e) => {
                        crate::log(&format!("live stt [{channel}]: {e}"));
                        down.store(true, Relaxed);
                        emit(LiveEvent::Idle { channel });
                        emit(LiveEvent::Status { channel, ok: false, detail: Some(e) });
                    }
                }
            });
            while tasks.try_join_next().is_some() {}
        }
        while tasks.join_next().await.is_some() {}
    });
    (sink, handle)
}

async fn transcribe(http: &reqwest::Client, cfg: &LiveConfig, u: &Utterance) -> Result<String, String> {
    let wav = wav(&u.pcm);
    let mut last = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(attempt * 2)).await;
        }
        let part = reqwest::multipart::Part::bytes(wav.clone()).file_name("utterance.wav").mime_str("audio/wav").map_err(|e| e.to_string())?;
        let mut form = reqwest::multipart::Form::new().text("model", cfg.model.clone()).part("file", part);
        if !cfg.language.is_empty() {
            form = form.text("language", cfg.language.clone());
        }
        let res = match http.post(URL).bearer_auth(&cfg.key).header("X-Title", "Kazetix").multipart(form).send().await {
            Ok(r) => r,
            Err(e) => {
                last = format!("OpenRouter unreachable: {e}");
                continue;
            }
        };
        let status = res.status().as_u16();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        match status {
            200..=299 => return Ok(clean(body["text"].as_str().unwrap_or(""))),
            429 | 500..=599 => last = format!("OpenRouter {status}"),
            _ => return Err(format!("OpenRouter {status}: {}", body["error"]["message"].as_str().unwrap_or(""))),
        }
    }
    Err(last)
}

/// Drops audio-event tags like "(smích)" / "[music]" and normalises whitespace.
fn clean(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find(|c| c == '(' || c == '[') {
        let close = if rest[i..].starts_with('(') { ')' } else { ']' };
        let Some(j) = rest[i..].find(close) else { break };
        out.push_str(&rest[..i]);
        rest = &rest[i + j + 1..];
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn wav(pcm: &[i16]) -> Vec<u8> {
    let data = (pcm.len() * 2) as u32;
    let mut v = Vec::with_capacity(44 + data as usize);
    v.extend_from_slice(b"RIFF");
    v.extend_from_slice(&(36 + data).to_le_bytes());
    v.extend_from_slice(b"WAVEfmt ");
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes()); // PCM
    v.extend_from_slice(&1u16.to_le_bytes()); // mono
    v.extend_from_slice(&16_000u32.to_le_bytes());
    v.extend_from_slice(&32_000u32.to_le_bytes());
    v.extend_from_slice(&2u16.to_le_bytes());
    v.extend_from_slice(&16u16.to_le_bytes());
    v.extend_from_slice(b"data");
    v.extend_from_slice(&data.to_le_bytes());
    v.extend(pcm.iter().flat_map(|s| s.to_le_bytes()));
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vad_cuts_utterances_on_pauses() {
        let mut v = Vad::default();
        let quiet = [20i16; FRAME];
        let loud: Vec<i16> = (0..FRAME).map(|i| if i % 2 == 0 { 3000 } else { -3000 }).collect();
        let mut out = vec![];
        let mut t = 0;
        let mut feed = |f: &[i16], n: usize, out: &mut Vec<(u64, u64, Vec<i16>)>| {
            for _ in 0..n {
                if let (_, Some(u)) = v.push(f, t) {
                    out.push(u);
                }
                t += 20;
            }
        };
        feed(&quiet, 50, &mut out); // 1 s silence
        feed(&loud, 50, &mut out); // 1 s speech
        feed(&quiet, 40, &mut out); // pause → cut
        feed(&loud, 5, &mut out); // 100 ms click → dropped
        feed(&quiet, 40, &mut out);
        assert_eq!(out.len(), 1);
        let (s, e, _) = &out[0];
        assert!((680..=1000).contains(s), "start {s}");
        assert!((2500..=2700).contains(e), "end {e}");
        assert_eq!(clean(" (smích) Ahoj  [music] světe "), "Ahoj světe");
        assert_eq!(clean("Cena 5000 (bez DPH, do pátku"), "Cena 5000 (bez DPH, do pátku");
    }
}
