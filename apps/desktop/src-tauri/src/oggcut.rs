//! Cuts Ogg/Opus files at packet boundaries without decoding (every packet our recorder writes is 20 ms),
//! so a long channel can be re-sent to STT in pieces. Cuts are made in pauses, so the missing decoder history
//! at a piece start only affects silence.

use ogg::reading::PacketReader;
use ogg::writing::{PacketWriteEndInfo, PacketWriter};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, Write};
use std::path::Path;

const FRAME_MS: u64 = 20;
const FRAME_48K: u64 = 960;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Duration of an Ogg/Opus file written by our recorder.
pub fn duration_ms(path: &Path) -> Result<u64, String> {
    let mut r = PacketReader::new(BufReader::new(File::open(path).map_err(err)?));
    let mut n = 0u64;
    while let Ok(Some(_)) = r.read_packet() {
        n += 1; // a file cut short by a crash simply ends early
    }
    Ok(n.saturating_sub(2) * FRAME_MS)
}

/// Copies the audio between `from_ms` and `to_ms` into a new Ogg/Opus file.
pub fn slice(src: &Path, from_ms: u64, to_ms: u64, dst: &Path) -> Result<(), String> {
    slice_io(BufReader::new(File::open(src).map_err(err)?), BufWriter::new(File::create(dst).map_err(err)?), from_ms, to_ms)
}

fn slice_io<R: Read + Seek, W: Write>(src: R, dst: W, from_ms: u64, to_ms: u64) -> Result<(), String> {
    let mut r = PacketReader::new(src);
    let mut w = PacketWriter::new(dst);
    let (first, last) = (from_ms / FRAME_MS, to_ms / FRAME_MS);
    let (mut idx, mut written, mut serial) = (0u64, 0u64, 0u32);
    let mut pending: Option<Vec<u8>> = None;
    while let Some(p) = r.read_packet().map_err(err)? {
        if idx < 2 {
            serial = p.stream_serial();
            w.write_packet(p.data, serial, PacketWriteEndInfo::EndPage, 0).map_err(err)?;
        } else {
            let frame = idx - 2;
            if frame >= last {
                break;
            }
            if frame >= first {
                // hold one packet back so the real last one can carry the end-of-stream flag
                if let Some(prev) = pending.replace(p.data) {
                    written += 1;
                    let end = if written % 50 == 0 { PacketWriteEndInfo::EndPage } else { PacketWriteEndInfo::NormalPacket };
                    w.write_packet(prev, serial, end, written * FRAME_48K).map_err(err)?;
                }
            }
        }
        idx += 1;
    }
    if let Some(prev) = pending {
        w.write_packet(prev, serial, PacketWriteEndInfo::EndStream, (written + 1) * FRAME_48K).map_err(err)?;
    } else if idx >= 2 {
        // empty slice: close the stream with the header page only
        w.inner_mut().flush().map_err(err)?;
    }
    w.inner_mut().flush().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn fake(frames: u64) -> Vec<u8> {
        let mut w = PacketWriter::new(Cursor::new(vec![]));
        w.write_packet(b"OpusHead".to_vec(), 7, PacketWriteEndInfo::EndPage, 0).unwrap();
        w.write_packet(b"OpusTags".to_vec(), 7, PacketWriteEndInfo::EndPage, 0).unwrap();
        for i in 0..frames {
            let end = if i + 1 == frames { PacketWriteEndInfo::EndStream } else { PacketWriteEndInfo::NormalPacket };
            w.write_packet((i as u32).to_le_bytes().to_vec(), 7, end, (i + 1) * FRAME_48K).unwrap();
        }
        w.into_inner().into_inner()
    }

    fn payloads(bytes: Vec<u8>) -> Vec<u32> {
        let mut r = PacketReader::new(Cursor::new(bytes));
        let mut v = vec![];
        while let Some(p) = r.read_packet().unwrap() {
            if p.data.len() == 4 {
                v.push(u32::from_le_bytes(p.data[..4].try_into().unwrap()));
            }
        }
        v
    }

    #[test]
    fn slices_by_time_and_keeps_headers() {
        let src = fake(500); // 10 s
        let mut out = Cursor::new(vec![]);
        slice_io(Cursor::new(src.clone()), &mut out, 2000, 3000).unwrap();
        let got = payloads(out.into_inner());
        assert_eq!((got.first(), got.last(), got.len()), (Some(&100), Some(&149), 50));
        // slice past the end is clamped; the whole file round-trips
        let mut all = Cursor::new(vec![]);
        slice_io(Cursor::new(src.clone()), &mut all, 0, 99_000).unwrap();
        assert_eq!(payloads(all.into_inner()).len(), 500);
        let mut tail = Cursor::new(vec![]);
        slice_io(Cursor::new(src), &mut tail, 9_000, 99_000).unwrap();
        assert_eq!(payloads(tail.into_inner()).len(), 50);
    }

    #[test]
    fn measures_duration() {
        let p = std::env::temp_dir().join(format!("hw-ogg-{}.ogg", std::process::id()));
        std::fs::write(&p, fake(250)).unwrap();
        assert_eq!(duration_ms(&p).unwrap(), 5000);
        let _ = std::fs::remove_file(p);
    }
}
