# Installing Kazetix (guide for people and AI assistants)

This file is written so an AI assistant (Claude, ChatGPT) can walk you through the whole setup after one prompt:

> Install Kazetix for me by following https://github.com/Domin-Labs/kazetix/blob/main/INSTALL.md. Ask me before each step that needs my keys or my server.

Kazetix has two parts: the **Windows app** (records the call, live transcript, hints, chat) and **your server**
(exact transcript, summary, action items, archive over MCP). The server runs either **locally on your PC** with Node, or
in **Docker** on a machine you control.

## 0. What you need

- Windows 10 (version 2004 or newer) or Windows 11. The app uses the WebView2 runtime (built into Windows 11; a free download from Microsoft on Windows 10).
- An OpenRouter API key (https://openrouter.ai/keys) with a credit limit. All AI goes through it.
- For the server: Node 24 and ffmpeg on PATH (local mode), or Docker (server mode).

## 1. The Windows app

Download the latest build from https://github.com/Domin-Labs/kazetix/releases/latest and run it.
If there is no release yet, build it yourself from WSL: see "Build from source" in README.md.

## 2. The server

Generate two secrets first (any machine with OpenSSL, or PowerShell
`[Convert]::ToBase64String((1..32 | % {Get-Random -Max 256}))`):

- `KAZETIX_API_TOKEN`: the app and MCP clients use it.
- `KAZETIX_MCP_PASSWORD`: sign-in password for claude.ai / Claude Code connectors.

```bash
git clone https://github.com/Domin-Labs/kazetix.git && cd kazetix
cp .env.example .env       # fill in the two secrets, OPENROUTER_API_KEY and PUBLIC_BASE_URL
```

**Local (your PC, no Docker):** set `PUBLIC_BASE_URL=http://localhost:8767`, then

```bash
corepack enable && pnpm install
DATA_DIR=./data node --env-file=.env apps/server/src/main.ts
```

On Windows PowerShell: `$env:DATA_DIR="./data"; node --env-file=.env apps/server/src/main.ts`.
Claude Code and Claude Desktop reach it on localhost; claude.ai needs a public HTTPS address, so use Docker for that.

**Docker (your server):** set `PUBLIC_BASE_URL` to the HTTPS address, then

```bash
mkdir -p data && chown -R 1000:1000 data
docker compose -f docker/docker-compose.yml up -d --build
```

Put an HTTPS reverse proxy in front of `127.0.0.1:8767` (no buffering, long read timeout, body size ≥ 80 MB).

Check: `curl -H "Authorization: Bearer <KAZETIX_API_TOKEN>" <PUBLIC_BASE_URL>/api/health` returns `ok: true`.

## 3. Connect the app

Kazetix opens Settings on first start. Under **Server & AI** enter the server address, the API token and the OpenRouter
key (stored in Windows Credential Manager), then press **Verify**.

## 4. Connect Claude to your archive (MCP)

- **Claude Code:** `claude mcp add --transport http kazetix <PUBLIC_BASE_URL>/mcp --header "Authorization: Bearer <KAZETIX_API_TOKEN>"`
- **claude.ai:** Settings → Connectors → Add custom connector → `<PUBLIC_BASE_URL>/mcp`, sign in with `KAZETIX_MCP_PASSWORD`.

Tools: `list_meetings`, `get_meeting`, `read_transcript`, `search`, `get_action_items`, `get_live_meeting`, `mark_exported`, `status`.

## 5. Bring your prep to a call

Prepare for the call in Claude or ChatGPT, ask it to export the prep as a Markdown file, and attach the `.md` in Kazetix:
ahead of time (overlay or Settings → General → Prep for the next call) or in the start panel when the call begins.
During the call Kazetix uses it for suggested answers and keeps a checklist of what you planned to cover.
