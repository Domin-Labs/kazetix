# Installing Kazetix (guide for people and AI assistants)

This file is written so an AI assistant (Claude, ChatGPT) can walk you through the setup after one prompt:

> Install Kazetix for me by following https://github.com/Domin-Labs/kazetix/blob/main/INSTALL.md. Ask me before each step that needs my keys or my server.

Kazetix is a **Windows app**. By default it keeps your calls on your PC (database and audio in
`%APPDATA%\cz.dpstudio.kazetix`) and has its own MCP server for Claude. A **self-hosted server** (steps 5 and 6) is
optional: use it if you want the archive on a machine you control or reachable from claude.ai.

## 0. What you need

- Windows 10 (version 2004 or newer) or Windows 11. The app uses the WebView2 runtime (built into Windows 11; a free download from Microsoft on Windows 10).
- An OpenRouter API key (https://openrouter.ai/keys), ideally with a credit limit. All AI goes through it.

## 1. Install the app

Download https://github.com/Domin-Labs/kazetix/releases/latest/download/Kazetix-Setup-x64.exe and run it
(per-user install, no admin rights). PowerShell:

```powershell
Invoke-WebRequest https://github.com/Domin-Labs/kazetix/releases/latest/download/Kazetix-Setup-x64.exe -OutFile $env:TEMP\Kazetix-Setup-x64.exe
Start-Process $env:TEMP\Kazetix-Setup-x64.exe
```

To build it yourself instead, see "Build from source" in README.md.

## 2. First start

Kazetix opens Settings. Under **Storage & AI** paste the OpenRouter key into **API key** (it is stored in Windows
Credential Manager) and keep **On this PC**. Choose the microphone and output device under **Audio & transcription**.
Start and stop a call with `Ctrl+Alt+Shift+R` (other shortcuts are under **Keyboard shortcuts**).

## 3. Connect Claude to your local archive (MCP)

- **Claude Desktop:** Settings, Storage & AI, **Add to Claude Desktop**, then restart Claude Desktop.
- **Claude Code:** `claude mcp add kazetix -- "<path to Kazetix.exe>" --mcp` (Settings shows the exact command).

Tools: `list_meetings`, `get_meeting`, `read_transcript`, `search`, `get_action_items`, `get_live_meeting`, `mark_exported`, `status`.

## 4. Bring your prep to a call

Prepare in Claude or ChatGPT, ask it to export the prep as a Markdown file, and attach the `.md` in Kazetix: ahead of
time under Settings, Home, **Prep for the next call**, or in the start panel when the call begins. During the call
Kazetix uses it for suggested answers and keeps a checklist of what you planned to cover.

## 5. Optional: run the server

Requires Node 24 and ffmpeg on PATH (local mode) or Docker (server mode). Generate two secrets (`openssl rand -base64 32`, or in PowerShell
`[Convert]::ToBase64String((1..32 | % {Get-Random -Max 256}))`):

- `KAZETIX_API_TOKEN`: used by the app and by headless MCP clients.
- `KAZETIX_MCP_PASSWORD`: sign-in password for claude.ai and Claude Code connectors.

```bash
git clone https://github.com/Domin-Labs/kazetix.git && cd kazetix
cp .env.example .env       # fill in the two secrets, OPENROUTER_API_KEY and PUBLIC_BASE_URL
```

**Local (no Docker):** set `PUBLIC_BASE_URL=http://localhost:8767` in `.env`, then

```bash
corepack enable && pnpm install
DATA_DIR=./data node --env-file=.env apps/server/src/main.ts
```

PowerShell: `$env:DATA_DIR="./data"; node --env-file=.env apps/server/src/main.ts`.
Claude Code and Claude Desktop can reach it on localhost; claude.ai needs a public HTTPS address, so use Docker for that.

**Docker (a server you control):** set `PUBLIC_BASE_URL` to the HTTPS address, then

```bash
mkdir -p data && chown -R 1000:1000 data
docker compose -f docker/docker-compose.yml up -d --build
```

Put an HTTPS reverse proxy in front of `127.0.0.1:8767` (no buffering, long read timeout, body size of at least 80 MB).

Check: `curl -H "Authorization: Bearer <KAZETIX_API_TOKEN>" <PUBLIC_BASE_URL>/api/health` returns `"ok":true`.

## 6. Use the server

- **App:** Settings, Storage & AI, choose **Own server**, enter **Server address** and **API token**, press **Verify**.
- **Claude Code:** `claude mcp add --transport http kazetix <PUBLIC_BASE_URL>/mcp --header "Authorization: Bearer <KAZETIX_API_TOKEN>"`
- **claude.ai:** Settings, Connectors, Add custom connector, `<PUBLIC_BASE_URL>/mcp`, sign in with `KAZETIX_MCP_PASSWORD`.
