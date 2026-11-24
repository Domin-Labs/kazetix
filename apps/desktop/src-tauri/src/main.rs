// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `Kazetix --mcp`: MCP server over stdio for Claude, decided before anything GUI starts.
    if std::env::args().skip(1).any(|a| a == "--mcp") {
        return kazetix_lib::run_mcp();
    }
    kazetix_lib::run()
}
