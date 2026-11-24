//! "Add to Claude Desktop": merges `mcpServers.kazetix = { command: <this exe>, args: ["--mcp"] }` into
//! claude_desktop_config.json, keeping every other key. Windows: %APPDATA%\Claude, macOS: ~/Library/Application Support/Claude
//! (both are `dirs::config_dir()/Claude`).

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("Claude").join("claude_desktop_config.json"))
}

/// New file content from the existing one (None = file missing). Refuses to touch a file that is not a JSON object.
pub fn merge(existing: Option<&str>, exe: &str) -> Result<String, String> {
    let mut root: Value = match existing.map(str::trim).filter(|s| !s.is_empty()) {
        None => json!({}),
        Some(s) => serde_json::from_str(s).map_err(|e| format!("claude_desktop_config.json is not valid JSON ({e}); not changed"))?,
    };
    let obj = root.as_object_mut().ok_or("claude_desktop_config.json is not a JSON object; not changed")?;
    let servers = obj.entry("mcpServers").or_insert_with(|| Value::Object(Map::new()));
    let servers = servers.as_object_mut().ok_or("\"mcpServers\" in claude_desktop_config.json is not an object; not changed")?;
    servers.insert("kazetix".into(), json!({ "command": exe, "args": ["--mcp"] }));
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Writes the merged file (backup `.bak` of the previous one first). Returns the config path.
pub fn install_at(path: &Path, exe: &str) -> Result<PathBuf, String> {
    let existing = match std::fs::read_to_string(path) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let out = merge(existing.as_deref(), exe)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    if existing.is_some() {
        std::fs::copy(path, path.with_extension("json.bak")).map_err(|e| format!("cannot write backup: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, out).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(path.to_path_buf())
}

pub fn install(exe: &str) -> Result<PathBuf, String> {
    install_at(&config_path().ok_or("cannot locate the Claude Desktop config folder")?, exe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_existing_keys() {
        let old = r#"{ "theme": "dark", "mcpServers": { "other": { "command": "x", "args": ["a"] }, "kazetix": { "command": "old" } } }"#;
        let v: Value = serde_json::from_str(&merge(Some(old), r"C:\Apps\Kazetix.exe").unwrap()).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert_eq!(v["mcpServers"]["kazetix"], json!({ "command": r"C:\Apps\Kazetix.exe", "args": ["--mcp"] }));
        let fresh: Value = serde_json::from_str(&merge(None, "/k").unwrap()).unwrap();
        assert_eq!(fresh["mcpServers"]["kazetix"]["args"][0], "--mcp");
        assert!(merge(Some("{ broken"), "/k").is_err());
        assert!(merge(Some("[]"), "/k").is_err());
        assert!(merge(Some(r#"{"mcpServers": 3}"#), "/k").is_err());
    }

    #[test]
    fn writes_backup_and_survives_missing_file() {
        let dir = std::env::temp_dir().join(format!("hw-claude-{}", std::process::id()));
        let path = dir.join("Claude").join("claude_desktop_config.json");
        install_at(&path, "/k").unwrap(); // folder and file are created
        assert!(!path.with_extension("json.bak").exists());
        std::fs::write(&path, r#"{"keep": 1}"#).unwrap();
        install_at(&path, "/k2").unwrap();
        assert_eq!(std::fs::read_to_string(path.with_extension("json.bak")).unwrap(), r#"{"keep": 1}"#);
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!((v["keep"].as_i64(), v["mcpServers"]["kazetix"]["command"].as_str()), (Some(1), Some("/k2")));
        let _ = std::fs::remove_dir_all(dir);
    }
}
