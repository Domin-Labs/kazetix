//! Local backup recording: one stereo Ogg/Opus file, L = microphone ("Me"), R = system audio ("Others").
//! Pages are flushed every second, so a crash loses at most ~1 s and the file stays playable.

use ogg::writing::{PacketWriteEndInfo, PacketWriter};
use std::fs::File;
use std::io::BufWriter;
use std::path::Path;

pub struct OggOpusWriter {
    enc: opus::Encoder,
    channels: u8,
    w: PacketWriter<'static, BufWriter<File>>,
    serial: u32,
    frames: u64,
    pending: Option<Vec<u8>>,
    out: Vec<u8>,
}

const FRAME_48K: u64 = 960; // 20 ms in 48 kHz granule units

impl OggOpusWriter {
    pub fn create(path: &Path) -> Result<Self, String> {
        Self::create_with(path, 2)
    }

    /// `channels`: 2 = stereo backup (L mic, R system), 1 = one speech channel for STT.
    pub fn create_with(path: &Path, channels: u8) -> Result<Self, String> {
        let mut enc = opus::Encoder::new(16_000, if channels == 1 { opus::Channels::Mono } else { opus::Channels::Stereo }, opus::Application::Voip).map_err(|e| e.to_string())?;
        enc.set_bitrate(opus::Bitrate::Bits(32_000)).map_err(|e| e.to_string())?;
        let pre_skip = (enc.get_lookahead().map_err(|e| e.to_string())? * 3) as u16;
        let mut w = PacketWriter::new(BufWriter::new(File::create(path).map_err(|e| e.to_string())?));
        let serial = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos() & 0xffff_ffff) as u32;

        let mut head = b"OpusHead".to_vec();
        head.push(1); // version
        head.push(channels); // channels
        head.extend_from_slice(&pre_skip.to_le_bytes());
        head.extend_from_slice(&16_000u32.to_le_bytes()); // original input rate
        head.extend_from_slice(&0i16.to_le_bytes()); // output gain
        head.push(0); // mapping family 0 (mono/stereo)
        w.write_packet(head, serial, PacketWriteEndInfo::EndPage, 0).map_err(|e| e.to_string())?;

        let vendor = b"Kazetix";
        let mut tags = b"OpusTags".to_vec();
        tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
        tags.extend_from_slice(vendor);
        tags.extend_from_slice(&0u32.to_le_bytes());
        w.write_packet(tags, serial, PacketWriteEndInfo::EndPage, 0).map_err(|e| e.to_string())?;

        Ok(Self { enc, channels, w, serial, frames: 0, pending: None, out: vec![0; 4000] })
    }

    /// One 20 ms frame per channel (320 samples each).
    pub fn write(&mut self, mic: &[i16], sys: &[i16]) -> Result<(), String> {
        let interleaved: Vec<i16> = mic.iter().zip(sys).flat_map(|(&l, &r)| [l, r]).collect();
        self.write_pcm(&interleaved)
    }

    /// One 20 ms frame of a mono writer.
    pub fn write_mono(&mut self, frame: &[i16]) -> Result<(), String> {
        debug_assert_eq!(self.channels, 1);
        self.write_pcm(frame)
    }

    fn write_pcm(&mut self, pcm: &[i16]) -> Result<(), String> {
        let n = self.enc.encode(pcm, &mut self.out).map_err(|e| e.to_string())?;
        // Hold one packet back so finish() can flag the real last packet as end-of-stream.
        if let Some(p) = self.pending.replace(self.out[..n].to_vec()) {
            self.frames += 1;
            let end = if self.frames % 50 == 0 { PacketWriteEndInfo::EndPage } else { PacketWriteEndInfo::NormalPacket };
            self.w.write_packet(p, self.serial, end, self.frames * FRAME_48K).map_err(|e| e.to_string())?;
            if self.frames % 50 == 0 {
                std::io::Write::flush(self.w.inner_mut()).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    pub fn finish(mut self) -> Result<(), String> {
        use std::io::Write;
        if let Some(last) = self.pending.take() {
            self.frames += 1;
            self.w.write_packet(last, self.serial, PacketWriteEndInfo::EndStream, self.frames * FRAME_48K).map_err(|e| e.to_string())?;
        }
        self.w.inner_mut().flush().map_err(|e| e.to_string())
    }
}

/// Local mode: one mono Ogg/Opus file per speech channel next to the stereo backup (`<id>.me.ogg`, `<id>.them.ogg`, or
/// `<id>.mixed.ogg` for a 1-channel call), so STT gets each channel without decoding Opus. Next to each file, `<id>.<name>.pauses`
/// lists pause midpoints (seconds) so a long channel can be cut in pauses later (see oggcut.rs).
pub struct ChannelRecorders {
    parts: Vec<Part>,
    frame: u64,
}

struct Part {
    writer: OggOpusWriter,
    pauses: crate::transcript::Pauses,
    pause_file: File,
}

pub fn channel_names(channels: u8) -> &'static [&'static str] {
    if channels == 1 { &["mixed"] } else { &["me", "them"] }
}

pub fn channel_file(dir: &Path, id: &str, name: &str) -> std::path::PathBuf {
    dir.join(format!("{id}.{name}.ogg"))
}

pub fn pauses_file(dir: &Path, id: &str, name: &str) -> std::path::PathBuf {
    dir.join(format!("{id}.{name}.pauses"))
}

impl ChannelRecorders {
    pub fn create(dir: &Path, id: &str, channels: u8) -> Result<Self, String> {
        let parts = channel_names(channels)
            .iter()
            .map(|name| {
                Ok(Part {
                    writer: OggOpusWriter::create_with(&channel_file(dir, id, name), 1)?,
                    pauses: Default::default(),
                    pause_file: std::fs::OpenOptions::new().create(true).append(true).open(pauses_file(dir, id, name)).map_err(|e| e.to_string())?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Self { parts, frame: 0 })
    }

    pub fn write(&mut self, mic: &[i16], sys: &[i16]) -> Result<(), String> {
        let mixed: Vec<i16>;
        let frames: [&[i16]; 2] = if self.parts.len() == 1 {
            mixed = mic.iter().zip(sys).map(|(&a, &b)| (a as i32 + b as i32).clamp(i16::MIN as i32, i16::MAX as i32) as i16).collect();
            [&mixed, &[]]
        } else {
            [mic, sys]
        };
        let mut res = Ok(());
        for (p, f) in self.parts.iter_mut().zip(frames) {
            if let Some(mid) = p.pauses.push(crate::audio::rms(f), self.frame) {
                use std::io::Write;
                let _ = writeln!(p.pause_file, "{mid:.2}");
            }
            if let Err(e) = p.writer.write_mono(f) {
                res = Err(e);
            }
        }
        self.frame += 1;
        res
    }

    pub fn finish(self) -> Result<(), String> {
        let mut res = Ok(());
        for p in self.parts {
            if let Err(e) = p.writer.finish() {
                res = Err(e);
            }
        }
        res
    }
}
