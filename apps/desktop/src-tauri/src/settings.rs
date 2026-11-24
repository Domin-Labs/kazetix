use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Shortcuts {
    pub record: String,
    pub overlay: String,
    pub chat: String,
    pub mark: String,
}

impl Shortcuts {
    /// The first defaults (Ctrl+Shift+R/O/K/M) collide with browsers (hard reload, devtools, profiles):
    /// move anyone still on them to the new defaults; custom shortcuts stay untouched.
    pub fn migrate(&mut self) {
        let d = Self::default();
        for (cur, old, new) in [(&mut self.record, "Ctrl+Shift+R", d.record), (&mut self.overlay, "Ctrl+Shift+O", d.overlay), (&mut self.chat, "Ctrl+Shift+K", d.chat), (&mut self.mark, "Ctrl+Shift+M", d.mark)] {
            if cur.eq_ignore_ascii_case(old) {
                *cur = new;
            }
        }
    }
}

impl Default for Shortcuts {
    fn default() -> Self {
        Self {
            record: "Ctrl+Alt+Shift+R".into(),
            overlay: "Ctrl+Alt+Shift+O".into(),
            chat: "Ctrl+Alt+Shift+K".into(),
            mark: "Ctrl+Alt+Shift+M".into(),
        }
    }
}

/// Everything user-configurable. Secrets are NOT here — they live in Windows Credential Manager.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    pub ui_language: String,
    pub mic_device: Option<String>,
    pub output_device: Option<String>,
    pub live_model: String,
    pub channels: u8,
    pub final_transcript: bool,
    pub store_live: bool,
    pub language: String,
    /// "local" (archive and MCP inside the app) or "server" (own Kazetix server).
    pub storage: String,
    pub server_url: String,
    /// Model for the summary, action items and speaker clean-up after a call (local storage).
    pub summary_model: String,
    pub chat_model: String,
    pub hints_model: String,
    pub hints_enabled: bool,
    pub hints_interval_s: u32,
    pub hints_on_question: bool,
    pub autostart: bool,
    pub overlay_default: String,
    pub shortcuts: Shortcuts,
    pub overlay_pos: Option<(i32, i32)>,
    /// Offer to record when another app starts using the microphone.
    pub call_detect: bool,
    /// 0 = only ask; otherwise start recording after this many seconds unless the user says "Not now".
    pub call_autostart_s: u32,
    /// Let screenshots and screen sharing see the overlay and toast (off: hidden from capture).
    pub allow_capture: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ui_language: "en".into(),
            mic_device: None,
            output_device: None,
            live_model: "elevenlabs/scribe-v2".into(),
            channels: 2,
            final_transcript: true,
            store_live: true,
            language: "cs".into(),
            storage: "local".into(),
            server_url: String::new(),
            summary_model: "anthropic/claude-sonnet-5.5".into(),
            chat_model: "anthropic/claude-sonnet-5.5".into(),
            hints_model: "anthropic/claude-haiku-5.5".into(),
            hints_enabled: true,
            hints_interval_s: 25,
            hints_on_question: true,
            autostart: false,
            overlay_default: "expanded".into(),
            shortcuts: Shortcuts::default(),
            overlay_pos: None,
            call_detect: true,
            call_autostart_s: 0,
            allow_capture: false,
        }
    }
}

impl Settings {
    pub fn load(path: &PathBuf) -> Self {
        let mut s = Self::parse(&std::fs::read_to_string(path).unwrap_or_default());
        s.shortcuts.migrate();
        s
    }

    /// Settings written before `storage` existed keep working as they did: with a server address they stay on "server".
    pub fn parse(json: &str) -> Self {
        let mut s: Self = serde_json::from_str(json).unwrap_or_default();
        let has_storage = serde_json::from_str::<serde_json::Value>(json).is_ok_and(|v| v.get("storage").is_some());
        if !has_storage && !s.server_url.is_empty() {
            s.storage = "server".into();
        }
        s
    }

    pub fn save(&self, path: &PathBuf) -> std::io::Result<()> {
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, path)
    }
}

const SERVICE: &str = "Kazetix";

pub fn secret_get(name: &str) -> Option<String> {
    let get = |svc: &str| keyring::Entry::new(svc, name).ok()?.get_password().ok().filter(|s| !s.is_empty());
    // One-time migration from the app's former name: adopt a secret stored under the old keyring service.
    get(SERVICE).or_else(|| {
        let v = get("Hintwell")?;
        let _ = secret_set(name, &v);
        Some(v)
    })
}

/// One-time migration from the app's former name: if the new data dir has no settings yet but the old
/// one exists, copy everything over (settings, database, recordings, outbox). The old dir is left untouched.
pub fn migrate_legacy_data(new_dir: &std::path::Path) {
    fn copy(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
        std::fs::create_dir_all(to)?;
        for e in std::fs::read_dir(from)? {
            let e = e?;
            let dst = to.join(e.file_name());
            if e.file_type()?.is_dir() { copy(&e.path(), &dst)?; } else if !dst.exists() { std::fs::copy(e.path(), dst)?; }
        }
        Ok(())
    }
    let old = new_dir.parent().map(|p| p.join("cz.dpstudio.hintwell"));
    if let Some(old) = old.filter(|o| o.is_dir() && !new_dir.join("settings.json").exists()) {
        let _ = copy(&old, new_dir);
    }
}

pub fn secret_set(name: &str, value: &str) -> Result<(), String> {
    let e = keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())?;
    if value.is_empty() {
        let _ = e.delete_credential();
        Ok(())
    } else {
        e.set_password(value).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_default_keeps_existing_server_installs() {
        assert_eq!(Settings::parse("").storage, "local"); // new install
        assert_eq!(Settings::parse(r#"{"server_url":"https://x"}"#).storage, "server"); // upgraded install
        assert_eq!(Settings::parse(r#"{"server_url":"https://x","storage":"local"}"#).storage, "local");
        assert_eq!(Settings::parse(r#"{"language":"en"}"#).storage, "local");
    }
}
