//! Pure transcript logic ported from apps/server/src/worker.ts: piece planning, words → speaker turns,
//! per-piece speaker-label merge, transcript text for the LLM, and the live pause tracker.
//! No I/O here, so it is unit-tested without Tauri (see the tests at the bottom).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Word {
    pub text: String,
    pub start: Option<f64>,
    pub end: Option<f64>,
    /// "word" | "spacing" | "audio_event"
    #[serde(rename = "type")]
    pub kind: String,
    pub speaker_id: Option<String>,
}

/// `sid`: raw diarization id ("p2_speaker_1" when the channel was sent in pieces); `name`: stated in the call.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Turn {
    pub speaker: String,
    pub channel: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub sid: Option<String>,
    pub name: Option<String>,
}

pub fn mmss(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    let (h, mm, ss) = (s / 3600, (s % 3600) / 60, s % 60);
    if h > 0 { format!("{h}:{mm:02}:{ss:02}") } else { format!("{mm:02}:{ss:02}") }
}

/// Piece start times, at most `chunk` s apart, each moved back to the middle of the last pause in its final 2 min.
pub fn cut_points(pauses: &[f64], secs: f64, chunk: f64) -> Vec<f64> {
    let mut cuts = vec![0.0];
    while secs - cuts[cuts.len() - 1] > chunk {
        let target = cuts[cuts.len() - 1] + chunk;
        let lo = target - 120f64.min(chunk / 2.0);
        cuts.push(pauses.iter().copied().filter(|p| *p > lo && *p <= target).last().unwrap_or(target));
    }
    cuts
}

/// Words → speaker turns. Stereo: channel 0 (L) is the user, channel 1 (R) are the others, diarized.
pub fn build_turns(transcripts: &[(usize, Vec<Word>)], channels: u8) -> Vec<Turn> {
    let mut turns: Vec<Turn> = vec![];
    for (ch, words) in transcripts {
        let words: Vec<&Word> = words.iter().filter(|w| w.kind != "audio_event").collect();
        let mut ids: Vec<&str> = vec![];
        for w in words.iter().filter(|w| w.kind != "spacing") {
            let id = w.speaker_id.as_deref().unwrap_or("x");
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        let label = |w: &Word| -> String {
            if channels == 2 && *ch == 0 {
                "Me".into()
            } else if channels == 2 && ids.len() <= 1 {
                "Others".into()
            } else {
                format!("Speaker {}", ids.iter().position(|i| *i == w.speaker_id.as_deref().unwrap_or("x")).unwrap_or(0) + 1)
            }
        };
        let channel = if channels == 2 { if *ch == 0 { "me" } else { "them" } } else { "mixed" };
        let mut cur: Option<Turn> = None;
        for w in words {
            if w.kind == "spacing" {
                if let Some(c) = cur.as_mut() {
                    c.text.push_str(&w.text);
                }
                continue;
            }
            let sp = label(w);
            let start = (w.start.unwrap_or(0.0) * 1000.0).round() as i64;
            let end = (w.end.or(w.start).unwrap_or(0.0) * 1000.0).round() as i64;
            match cur.as_mut() {
                Some(c) if c.speaker == sp && start - c.end_ms <= 1500 => {
                    c.text.push_str(&w.text);
                    c.end_ms = end;
                }
                _ => {
                    if let Some(c) = cur.take() {
                        turns.push(c);
                    }
                    let sid = if *ch == 0 && channels == 2 { None } else { w.speaker_id.clone() };
                    cur = Some(Turn { speaker: sp, channel: channel.into(), start_ms: start, end_ms: end, text: w.text.clone(), sid, name: None });
                }
            }
        }
        turns.extend(cur);
    }
    let mut out: Vec<Turn> = turns
        .into_iter()
        .map(|mut t| {
            t.text = t.text.split_whitespace().collect::<Vec<_>>().join(" ");
            t
        })
        .filter(|t| !t.text.is_empty())
        .collect();
    out.sort_by_key(|t| t.start_ms);
    out
}

#[derive(Deserialize, Clone, Debug)]
pub struct Person {
    pub labels: Vec<String>,
    pub name: Option<String>,
}

/// Applies the model's grouping. Guards: labels from the same piece are always different people, unknown or repeated
/// labels are ignored, unmentioned labels stay separate. Renumbers by first appearance; a two-channel call whose
/// others turn out to be one person reads "Others" again.
pub fn merge_speakers(turns: Vec<Turn>, people: &[Person], channels: u8) -> Vec<Turn> {
    let mut piece: HashMap<String, String> = HashMap::new();
    for t in &turns {
        if let Some(sid) = t.sid.as_deref().filter(|s| s.starts_with('p')) {
            piece.entry(t.speaker.clone()).or_insert_with(|| sid.split('_').next().unwrap_or("").to_string());
        }
    }
    let mut person: HashMap<String, (usize, Option<String>)> = HashMap::new();
    for (id, g) in people.iter().enumerate() {
        let mut used: Vec<&String> = vec![];
        for l in &g.labels {
            let Some(p) = piece.get(l) else { continue };
            if person.contains_key(l) || used.contains(&p) {
                continue;
            }
            used.push(p);
            let name = g.name.as_deref().map(|n| n.trim().chars().take(60).collect::<String>()).filter(|n| !n.is_empty());
            person.insert(l.clone(), (id, name));
        }
    }
    // key = person id (or the raw label when ungrouped), numbered by first appearance
    let mut keys: Vec<String> = vec![];
    let key_of = |t: &Turn| person.get(&t.speaker).map_or_else(|| t.speaker.clone(), |p| format!("#{}", p.0));
    for t in &turns {
        if piece.contains_key(&t.speaker) {
            let k = key_of(t);
            if !keys.contains(&k) {
                keys.push(k);
            }
        }
    }
    let single = channels == 2 && keys.len() == 1;
    turns
        .iter()
        .map(|t| {
            if !piece.contains_key(&t.speaker) {
                return t.clone();
            }
            let n = keys.iter().position(|k| *k == key_of(t)).unwrap_or(0) + 1;
            Turn { speaker: if single { "Others".into() } else { format!("Speaker {n}") }, name: person.get(&t.speaker).and_then(|p| p.1.clone()), ..t.clone() }
        })
        .collect()
}

/// "[mm:ss] Speaker: text" lines; very long calls keep head and tail.
pub fn transcript_text(rows: &[(String, i64, String)]) -> String {
    let t = rows.iter().map(|(sp, ms, text)| format!("[{}] {sp}: {text}", mmss(*ms))).collect::<Vec<_>>().join("\n");
    let chars: Vec<char> = t.chars().collect();
    if chars.len() > 300_000 {
        format!("{}\n[… middle of the meeting omitted …]\n{}", chars[..150_000].iter().collect::<String>(), chars[chars.len() - 150_000..].iter().collect::<String>())
    } else {
        t
    }
}

/// Live pause detector on 20 ms frames: a run of ≥ 0.3 s below -40 dBFS yields its midpoint (seconds).
/// The recorder writes these next to each channel file, so long channels can be cut in pauses without decoding Opus.
#[derive(Default)]
pub struct Pauses {
    quiet: u32,
    start: u64,
}

impl Pauses {
    const FLOOR: f32 = 328.0; // -40 dBFS of i16 full scale
    pub fn push(&mut self, rms: f32, frame: u64) -> Option<f64> {
        if rms < Self::FLOOR {
            if self.quiet == 0 {
                self.start = frame;
            }
            self.quiet += 1;
            return None;
        }
        let run = std::mem::take(&mut self.quiet);
        (run >= 15).then(|| (self.start + frame) as f64 / 2.0 * 0.02)
    }
}

pub fn parse_pauses(text: &str) -> Vec<f64> {
    let mut v: Vec<f64> = text.lines().filter_map(|l| l.trim().parse().ok()).collect();
    v.sort_by(|a, b| a.total_cmp(b));
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(text: &str, start: f64, end: f64, sp: Option<&str>) -> Word {
        Word { text: text.into(), start: Some(start), end: Some(end), kind: "word".into(), speaker_id: sp.map(String::from) }
    }

    #[test]
    fn pieces_are_cut_in_pauses() {
        assert_eq!(cut_points(&[], 100.0, 2400.0), vec![0.0]);
        assert_eq!(cut_points(&[], 5000.0, 2400.0), vec![0.0, 2400.0, 4800.0]);
        // last pause inside the final 2 min before the target wins; one outside is ignored
        assert_eq!(cut_points(&[100.0, 2300.0, 2390.5], 3000.0, 2400.0), vec![0.0, 2390.5]);
        assert_eq!(cut_points(&[100.0], 3000.0, 2400.0), vec![0.0, 2400.0]);
    }

    #[test]
    fn turns_stereo_me_and_diarized_others() {
        let me = vec![w(" Ahoj", 0.0, 0.4, None), w(" světe", 0.5, 0.9, None)];
        let them = vec![w(" Dobrý", 1.0, 1.3, Some("speaker_0")), w(" den", 1.4, 1.6, Some("speaker_0")), w(" Hello", 10.0, 10.3, Some("speaker_1"))];
        let t = build_turns(&[(0, me), (1, them)], 2);
        let got: Vec<_> = t.iter().map(|t| (t.speaker.as_str(), t.channel.as_str(), t.text.as_str())).collect();
        assert_eq!(got, [("Me", "me", "Ahoj světe"), ("Speaker 1", "them", "Dobrý den"), ("Speaker 2", "them", "Hello")]);
        // one other person reads "Others"; a gap > 1.5 s starts a new turn
        let t = build_turns(&[(1, vec![w(" a", 0.0, 0.1, Some("s")), w(" b", 5.0, 5.1, Some("s"))])], 2);
        assert_eq!(t.iter().map(|t| t.speaker.as_str()).collect::<Vec<_>>(), ["Others", "Others"]);
        assert!(build_turns(&[(0, vec![w("  ", 0.0, 0.1, None)])], 1).is_empty());
    }

    #[test]
    fn merges_piece_labels() {
        let mk = |sp: &str, sid: &str, at: i64| Turn { speaker: sp.into(), channel: "them".into(), start_ms: at, end_ms: at + 10, text: "x".into(), sid: Some(sid.into()), name: None };
        let turns = vec![mk("Speaker 1", "p0_speaker_0", 0), mk("Speaker 2", "p0_speaker_1", 20), mk("Speaker 3", "p1_speaker_1", 40)];
        // Speaker 1 (piece 0) and Speaker 3 (piece 1) are one person: merged, named, renumbered by first appearance
        let people = vec![Person { labels: vec!["Speaker 1".into(), "Speaker 3".into()], name: Some("Eva".into()) }];
        let out = merge_speakers(turns.clone(), &people, 2);
        assert_eq!(out.iter().map(|t| t.speaker.as_str()).collect::<Vec<_>>(), ["Speaker 1", "Speaker 2", "Speaker 1"]);
        assert_eq!(out.iter().map(|t| t.name.as_deref()).collect::<Vec<_>>(), [Some("Eva"), None, Some("Eva")]);
        // two labels of the same piece are never one person
        let bad = vec![Person { labels: vec!["Speaker 1".into(), "Speaker 2".into()], name: None }];
        assert_eq!(merge_speakers(turns, &bad, 2).iter().map(|t| t.speaker.as_str()).collect::<Vec<_>>(), ["Speaker 1", "Speaker 2", "Speaker 3"]);
        // single person in a stereo call becomes "Others"; non-piece turns are untouched
        let one = merge_speakers(vec![mk("Speaker 1", "p0_a", 0), mk("Speaker 1", "p0_a", 5)], &[], 2);
        assert!(one.iter().all(|t| t.speaker == "Others"));
        let me = Turn { speaker: "Me".into(), sid: None, ..mk("Me", "", 0) };
        assert_eq!(merge_speakers(vec![me.clone()], &people, 2), vec![me]);
    }

    #[test]
    fn pause_tracker_reports_midpoints() {
        let mut p = Pauses::default();
        let mut got = vec![];
        for f in 0..200u64 {
            let rms = if (50..100).contains(&f) || (150..160).contains(&f) { 10.0 } else { 3000.0 };
            got.extend(p.push(rms, f));
        }
        assert_eq!(got, vec![(50.0 + 100.0) / 2.0 * 0.02]); // the 10-frame gap is too short
        assert_eq!(parse_pauses("3.5\nx\n1.0\n"), vec![1.0, 3.5]);
    }

    #[test]
    fn formats_time_and_text() {
        assert_eq!(mmss(65_000), "01:05");
        assert_eq!(mmss(3_725_000), "1:02:05");
        assert_eq!(transcript_text(&[("Me".into(), 1000, "hi".into())]), "[00:01] Me: hi");
    }
}
