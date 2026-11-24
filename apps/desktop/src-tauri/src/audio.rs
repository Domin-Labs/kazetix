//! Audio capture: microphone + WASAPI loopback of an output device, both resampled to 16 kHz mono i16
//! and delivered as aligned 20 ms frames (mic, system).
//!
//! ponytail: written directly on cpal (the same WASAPI path Meetily's audio module uses, incl. loopback by opening an
//! input stream on an output device) instead of vendoring Meetily — no copied code, no license notice needed.
//! Per-process loopback (only Teams/Chrome) is a later phase.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, SizedSample, Stream};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const RATE: u32 = 16_000;
pub const FRAME: usize = 320; // 20 ms at 16 kHz

pub fn list_devices() -> (Vec<String>, Vec<String>) {
    let host = cpal::default_host();
    let names = |r: Result<Vec<Device>, String>| -> Vec<String> {
        r.unwrap_or_default().iter().filter_map(|d| d.name().ok()).collect()
    };
    (
        names(host.input_devices().map(|i| i.collect()).map_err(|e| e.to_string())),
        names(host.output_devices().map(|i| i.collect()).map_err(|e| e.to_string())),
    )
}

pub struct Capture {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Capture {
    /// `on_frame(mic, sys)` gets aligned 20 ms frames. `on_status(None)` = devices running, `Some(msg)` = problem.
    pub fn start<F, S>(mic: Option<String>, out: Option<String>, mut on_frame: F, on_status: S) -> Self
    where
        F: FnMut(&[i16], &[i16]) + Send + 'static,
        S: Fn(Option<String>) + Send + 'static,
    {
        let stop = Arc::new(AtomicBool::new(false));
        let st = stop.clone();
        let handle = std::thread::spawn(move || {
            while !st.load(Relaxed) {
                if let Err(e) = run(&mic, &out, &st, &mut on_frame, &on_status) {
                    on_status(Some(e));
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
        });
        Self { stop, handle: Some(handle) }
    }

    pub fn stop(mut self) {
        self.stop.store(true, Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Relaxed);
    }
}

fn pick(devs: Result<Vec<Device>, String>, name: Option<&str>) -> Option<Device> {
    let name = name?;
    devs.ok()?.into_iter().find(|d| d.name().ok().as_deref() == Some(name))
}

fn build<T>(dev: &Device, cfg: &cpal::StreamConfig, tx: Sender<Vec<f32>>, err: Arc<AtomicBool>) -> Result<Stream, cpal::BuildStreamError>
where
    T: SizedSample,
    f32: cpal::FromSample<T>,
{
    let ch = cfg.channels.max(1) as usize;
    dev.build_input_stream(
        cfg,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            let mono = data.chunks(ch).map(|f| f.iter().map(|s| s.to_sample::<f32>()).sum::<f32>() / ch as f32).collect();
            let _ = tx.send(mono);
        },
        move |e| {
            crate::log(&format!("audio stream error: {e}"));
            err.store(true, Relaxed);
        },
        None,
    )
}

/// Opens a capture stream; `loopback` captures what the output device plays (WASAPI loopback).
fn open(dev: &Device, loopback: bool, tx: Sender<Vec<f32>>, err: Arc<AtomicBool>) -> Result<(Stream, u32), String> {
    let sc = if loopback { dev.default_output_config() } else { dev.default_input_config() }.map_err(|e| e.to_string())?;
    let rate = sc.sample_rate().0;
    let cfg: cpal::StreamConfig = sc.config();
    let s = match sc.sample_format() {
        SampleFormat::F32 => build::<f32>(dev, &cfg, tx, err),
        SampleFormat::I16 => build::<i16>(dev, &cfg, tx, err),
        SampleFormat::U16 => build::<u16>(dev, &cfg, tx, err),
        SampleFormat::I32 => build::<i32>(dev, &cfg, tx, err),
        SampleFormat::F64 => build::<f64>(dev, &cfg, tx, err),
        SampleFormat::U8 => build::<u8>(dev, &cfg, tx, err),
        f => return Err(format!("unsupported sample format {f}")),
    }
    .map_err(|e| e.to_string())?;
    s.play().map_err(|e| e.to_string())?;
    Ok((s, rate))
}

fn run<F, S>(mic: &Option<String>, out: &Option<String>, stop: &AtomicBool, on_frame: &mut F, on_status: &S) -> Result<(), String>
where
    F: FnMut(&[i16], &[i16]),
    S: Fn(Option<String>),
{
    let host = cpal::default_host();
    let devs = |r: Result<Vec<Device>, cpal::DevicesError>| r.map_err(|e| e.to_string());
    let mic_dev = pick(devs(host.input_devices().map(|i| i.collect())), mic.as_deref())
        .or_else(|| host.default_input_device())
        .ok_or("No microphone found")?;
    let out_dev = pick(devs(host.output_devices().map(|i| i.collect())), out.as_deref())
        .or_else(|| host.default_output_device())
        .ok_or("No output device found")?;
    let mic_name = mic_dev.name().unwrap_or_default();
    let out_name = out_dev.name().unwrap_or_default();

    let err = Arc::new(AtomicBool::new(false));
    let (mtx, mrx) = channel();
    let (stx, srx) = channel();
    let (_mic_stream, mic_rate) = open(&mic_dev, false, mtx, err.clone()).map_err(|e| format!("Microphone: {e}"))?;
    let (_sys_stream, sys_rate) = open(&out_dev, true, stx, err.clone()).map_err(|e| format!("System audio: {e}"))?;
    crate::log(&format!("capture: mic '{mic_name}' {mic_rate} Hz, loopback '{out_name}' {sys_rate} Hz"));
    on_status(None);

    let (mut mrs, mut srs) = (Resampler::new(mic_rate, RATE), Resampler::new(sys_rate, RATE));
    let (mut mf, mut sf) = (VecDeque::<i16>::new(), VecDeque::<i16>::new());
    let (mut last_mic, mut last_sys, mut last_check) = (Instant::now(), Instant::now(), Instant::now());
    let (mut mic_buf, mut sys_buf) = ([0i16; FRAME], [0i16; FRAME]);

    while !stop.load(Relaxed) {
        if err.load(Relaxed) {
            return Err("Audio device lost, reconnecting".into());
        }
        match mrx.recv_timeout(Duration::from_millis(50)) {
            Ok(v) => {
                mrs.process(&v, &mut mf);
                last_mic = Instant::now();
                while let Ok(v) = mrx.try_recv() {
                    mrs.process(&v, &mut mf);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(_) => return Err("Microphone stream closed".into()),
        }
        while let Ok(v) = srx.try_recv() {
            srs.process(&v, &mut sf);
            last_sys = Instant::now();
        }
        if last_mic.elapsed() > Duration::from_secs(3) {
            return Err("Microphone stopped delivering audio".into());
        }
        // The mic drives the timeline. WASAPI loopback delivers nothing while nothing plays, so the system channel is
        // padded with silence once it has been quiet for 150 ms; small jitter is absorbed by waiting.
        while mf.len() >= FRAME {
            if sf.len() < FRAME && last_sys.elapsed() < Duration::from_millis(150) && mf.len() < RATE as usize {
                break;
            }
            for (d, s) in mic_buf.iter_mut().zip(mf.drain(..FRAME)) {
                *d = s;
            }
            for d in sys_buf.iter_mut() {
                *d = sf.pop_front().unwrap_or(0);
            }
            on_frame(&mic_buf, &sys_buf);
        }
        // ponytail: clock drift between devices is handled by trimming the system FIFO (a tiny skip every few minutes).
        // Trim back to ~2 frames, not to a fixed backlog, so L/R stay aligned after a trim.
        if sf.len() > RATE as usize / 5 {
            let excess = sf.len() - 2 * FRAME;
            sf.drain(..excess);
        }
        // Follow Windows default-device changes when the user didn't pin a device.
        if last_check.elapsed() > Duration::from_secs(2) {
            last_check = Instant::now();
            let changed = |pinned: &Option<String>, cur: &str, d: Option<Device>| pinned.is_none() && d.and_then(|d| d.name().ok()).is_some_and(|n| n != cur);
            if changed(mic, &mic_name, host.default_input_device()) || changed(out, &out_name, host.default_output_device()) {
                crate::log("default audio device changed, switching");
                return Ok(());
            }
        }
    }
    Ok(())
}

/// Streaming windowed-sinc resampler (Hann window, precomputed polyphase table). Mono f32 in, i16 out.
pub struct Resampler {
    step: f64,
    pos: f64,
    half: usize,
    table: Vec<f32>, // PHASES+1 rows × 2*half taps
    buf: Vec<f32>,
}

const PHASES: usize = 256;

impl Resampler {
    pub fn new(from: u32, to: u32) -> Self {
        let fc = 0.5 * (to as f64 / from as f64).min(1.0) * 0.92; // cutoff, cycles per input sample
        let half = (8.0 / (2.0 * fc)).ceil() as usize;
        let h = half as f64;
        let mut table = Vec::with_capacity((PHASES + 1) * 2 * half);
        for p in 0..=PHASES {
            let frac = p as f64 / PHASES as f64;
            for t in 0..2 * half {
                // tap t corresponds to sample index c - half + 1 + t; x = pos - k
                let x = frac + half as f64 - 1.0 - t as f64;
                let w = 0.5 * (1.0 + (std::f64::consts::PI * x / h).cos());
                table.push((2.0 * fc * sinc(2.0 * fc * x) * w) as f32);
            }
        }
        Self { step: from as f64 / to as f64, pos: h, half, table, buf: vec![0.0; half] }
    }

    pub fn process(&mut self, input: &[f32], out: &mut VecDeque<i16>) {
        self.buf.extend_from_slice(input);
        let n = 2 * self.half;
        while self.pos + (self.half as f64) < self.buf.len() as f64 {
            let c = self.pos.floor() as usize;
            let phase = ((self.pos - c as f64) * PHASES as f64).round() as usize;
            let taps = &self.table[phase * n..phase * n + n];
            let src = &self.buf[c + 1 - self.half..=c + self.half];
            let acc: f32 = src.iter().zip(taps).map(|(a, b)| a * b).sum();
            out.push_back((acc.clamp(-1.0, 1.0) * 32767.0) as i16);
            self.pos += self.step;
        }
        let drop = (self.pos.floor() as usize).saturating_sub(self.half);
        if drop > 0 {
            self.buf.drain(..drop);
            self.pos -= drop as f64;
        }
    }
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-9 {
        1.0
    } else {
        (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
    }
}

pub fn rms(s: &[i16]) -> f32 {
    (s.iter().map(|&v| (v as f32) * (v as f32)).sum::<f32>() / s.len().max(1) as f32).sqrt()
}

/// 0..1 meter value from an i16 RMS (-60 dBFS .. 0 dBFS).
pub fn level(rms: f32) -> f32 {
    let db = 20.0 * (rms.max(1.0) / 32768.0).log10();
    ((db + 60.0) / 60.0).clamp(0.0, 1.0)
}

/// Echo heuristic: without headphones the mic hears the speakers, so the mic envelope follows the loopback envelope
/// (with a small delay) while the others talk. ponytail: envelope correlation, no AEC (later phase).
#[derive(Default)]
pub struct EchoDetector {
    mic: VecDeque<f32>,
    sys: VecDeque<f32>,
    n: usize,
    score: i32,
    pub detected: bool,
}

const WIN: usize = 250; // 5 s of 20 ms frames

impl EchoDetector {
    /// Feed one frame's RMS values; returns Some(state) when the verdict changes.
    pub fn push(&mut self, mic_rms: f32, sys_rms: f32) -> Option<bool> {
        self.mic.push_back(mic_rms);
        self.sys.push_back(sys_rms);
        if self.mic.len() > WIN {
            self.mic.pop_front();
            self.sys.pop_front();
        }
        self.n += 1;
        if self.n % 50 != 0 || self.mic.len() < WIN {
            return None;
        }
        let sys_mean = self.sys.iter().sum::<f32>() / WIN as f32;
        if sys_mean > 200.0 {
            let (m, s) = (self.mic.make_contiguous().to_vec(), self.sys.make_contiguous().to_vec());
            let best = (0..=10).map(|lag| pearson(&m[lag..], &s[..WIN - lag])).fold(f32::MIN, f32::max);
            if best > 0.75 {
                self.score = (self.score + 1).min(5);
            } else if best < 0.4 {
                self.score = (self.score - 1).max(-5);
            }
        }
        let next = if self.score >= 3 { true } else if self.score <= -2 { false } else { self.detected };
        (next != self.detected).then(|| {
            self.detected = next;
            next
        })
    }
}

fn pearson(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len() as f32;
    let (ma, mb) = (a.iter().sum::<f32>() / n, b.iter().sum::<f32>() / n);
    let (mut c, mut va, mut vb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        c += (x - ma) * (y - mb);
        va += (x - ma) * (x - ma);
        vb += (y - mb) * (y - mb);
    }
    if va <= 0.0 || vb <= 0.0 {
        0.0
    } else {
        c / (va.sqrt() * vb.sqrt())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, hz: f32, secs: f32) -> Vec<f32> {
        (0..(rate as f32 * secs) as usize).map(|i| 0.5 * (2.0 * std::f32::consts::PI * hz * i as f32 / rate as f32).sin()).collect()
    }

    fn resampled_rms(rate: u32, hz: f32) -> (usize, f32) {
        let mut r = Resampler::new(rate, RATE);
        let mut out = VecDeque::new();
        for chunk in tone(rate, hz, 1.0).chunks(441) {
            r.process(chunk, &mut out);
        }
        let v: Vec<i16> = out.into_iter().collect();
        (v.len(), rms(&v[400..]) / 32767.0)
    }

    #[test]
    fn resampler_keeps_speech_band_and_rejects_aliases() {
        for rate in [48_000, 44_100, 16_000, 96_000] {
            let (n, pass) = resampled_rms(rate, 1000.0);
            assert!((n as i32 - 16_000).abs() < 80, "{rate}: {n} samples");
            assert!((pass - 0.3536).abs() < 0.01, "{rate}: passband rms {pass}");
            if rate > 16_000 {
                let (_, stop) = resampled_rms(rate, 11_000.0);
                assert!(stop < 0.01, "{rate}: alias rms {stop}");
            }
        }
    }

    #[test]
    fn echo_detector_flags_correlated_channels_only() {
        let mut d = EchoDetector::default();
        let env = |i: usize| 300.0 + 2000.0 * ((i as f32 * 0.37).sin().abs());
        let mut flagged = false;
        for i in 0..1000usize {
            flagged |= d.push(0.3 * env((i as usize).saturating_sub(2)), env(i)) == Some(true);
        }
        assert!(flagged && d.detected);
        let mut d = EchoDetector::default();
        for i in 0..1000 {
            assert_eq!(d.push(500.0 + 400.0 * ((i * 7919 % 13) as f32), env(i)), None);
        }
    }
}
