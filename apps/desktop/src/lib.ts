import { invoke } from '@tauri-apps/api/core';
import { listen, type EventCallback } from '@tauri-apps/api/event';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Channel, MeetingView } from '@kazetix/shared';

export type Settings = {
  ui_language: 'en' | 'cs';
  mic_device: string | null;
  output_device: string | null;
  live_model: string;
  channels: 1 | 2;
  final_transcript: boolean;
  store_live: boolean;
  language: string;
  storage: 'local' | 'server';
  server_url: string;
  summary_model: string;
  chat_model: string;
  hints_model: string;
  hints_enabled: boolean;
  hints_interval_s: number;
  hints_on_question: boolean;
  autostart: boolean;
  overlay_default: 'expanded' | 'capsule';
  shortcuts: { record: string; overlay: string; chat: string; mark: string };
  overlay_pos: [number, number] | null;
  call_detect: boolean;
  call_autostart_s: number;
  allow_capture: boolean;
};

export type Segment = { id: string; channel: Channel; start_ms: number; end_ms: number; text: string };
export type TranscriptEvt = Segment & { final: boolean };
export type SessionSnap = {
  active: boolean;
  meeting_id?: string;
  title?: string;
  platform?: string | null;
  started_at?: string;
  elapsed_ms?: number;
  channels?: number;
  language?: string;
  segments?: Segment[];
};
export type SttStatus = { channel: string; state: 'connecting' | 'live' | 'down'; detail?: string | null; retry_s?: number | null };
export type ServerStatus = { ok: boolean; error: string | null; pending: number; pending_uploads: number };
export type { MeetingView };

export const api = {
  settings: () => invoke<Settings>('get_settings'),
  saveSettings: (settings: Settings) => invoke<void>('save_settings', { settings }),
  secretStatus: () => invoke<{ server_token: boolean; openrouter_key: boolean }>('secret_status'),
  setSecret: (name: 'server_token' | 'openrouter_key', value: string) => invoke<void>('set_secret', { name, value }),
  openrouterKey: () => invoke<string | null>('openrouter_key'),
  verifyServer: (url: string, token?: string) => invoke<{ ok: boolean; version: string; meetings: number; openrouter: boolean }>('verify_server', { url, token }),
  serverStatus: () => invoke<ServerStatus>('server_status'),
  devices: () => invoke<{ inputs: string[]; outputs: string[] }>('list_devices'),
  logPath: () => invoke<string>('log_path'),
  start: (title: string, platform: string | null) => invoke<SessionSnap>('start_session', { title, platform }),
  stop: () => invoke<void>('stop_session'),
  snapshot: () => invoke<SessionSnap>('session_snapshot'),
  saveHint: (id: string, at_ms: number, payload: unknown) => invoke<void>('save_hint', { id, atMs: at_ms, payload }),
  addMark: (label?: string) => invoke<void>('add_mark', { label: label ?? null }),
  homeOverview: () => invoke<any>('home_overview'),
  meeting: (id: string) => invoke<MeetingView>('meeting_status', { id }),
  meetingTranscript: (id: string) => invoke<string>('meeting_transcript', { id }),
  monitor: (on: boolean) => invoke<void>('monitor_levels', { on }),
  shortcutErrors: () => invoke<string[]>('shortcut_errors'),
  toastState: () => invoke<Record<string, any>>('toast_state'),
  showStart: () => invoke<void>('show_start'),
  mcpExe: () => invoke<string>('mcp_exe'),
  connectClaudeDesktop: () => invoke<string>('connect_claude_desktop'),
  openSettings: (page?: string) => invoke<void>('open_settings', { page: page ?? null }),
};

/** Subscribe to a backend event for the component's lifetime. */
export function useEvent<T>(name: string, cb: EventCallback<T>) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const p = listen<T>(name, (e) => ref.current(e));
    return () => void p.then((un) => un());
  }, [name]);
}

// ------------------------------------------------------------------ settings store shared by components in a window

let current: Settings | null = null;
const subs = new Set<() => void>();
const setCurrent = (s: Settings) => {
  current = s;
  subs.forEach((f) => f());
};
// Windows created at startup can call in before the backend has registered its state: retry until it answers.
const loadSettings = () => api.settings().then(setCurrent, () => setTimeout(loadSettings, 250));
loadSettings();
listen<Settings>('settings', (e) => setCurrent(e.payload));

const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export function useSettings(): Settings | null {
  return useSyncExternalStore(subscribe, () => current);
}

export async function updateSettings(patch: Partial<Settings>) {
  const s = { ...(current ?? (await api.settings())), ...patch };
  setCurrent(s);
  await api.saveSettings(s);
}

// ------------------------------------------------------------------ plastic (beige = light, black = dark), shared by all windows

export type Plastic = 'beige' | 'black' | 'system';
const PLASTIC_KEY = 'kazetix.plastic';
const dark = matchMedia('(prefers-color-scheme: dark)');
export const getPlastic = () => (localStorage.getItem(PLASTIC_KEY) as Plastic | null) ?? 'system';
const applyPlastic = () => {
  const p = getPlastic();
  document.documentElement.dataset.plastic = p === 'system' ? (dark.matches ? 'black' : 'beige') : p;
};
applyPlastic();
dark.addEventListener('change', applyPlastic);
addEventListener('storage', (e) => e.key === PLASTIC_KEY && applyPlastic()); // another window switched it
export function setPlastic(p: Plastic) {
  localStorage.setItem(PLASTIC_KEY, p);
  applyPlastic();
}

// ------------------------------------------------------------------ prep notes for the next call (.md made in Claude/ChatGPT)
// One slot in localStorage (same origin in every window): filled ahead of time or in the start toast, taken by the overlay
// when the call starts. The taken copy is kept per meeting so a reloaded overlay finds it again.

export type Prep = { name: string; text: string };
const PREP_KEY = 'kazetix.prep';
const ACTIVE_KEY = 'kazetix.prep.active';
const prepSubs = new Set<() => void>();
const read = (k: string) => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? 'null');
  } catch {
    return null;
  }
};
let slot: Prep | null = read(PREP_KEY);
addEventListener('storage', (e) => {
  if (e.key !== PREP_KEY) return;
  slot = read(PREP_KEY);
  prepSubs.forEach((f) => f());
});
export function setPrepSlot(p: Prep | null) {
  if (p) localStorage.setItem(PREP_KEY, JSON.stringify(p));
  else localStorage.removeItem(PREP_KEY);
  slot = p;
  prepSubs.forEach((f) => f());
}
export const usePrepSlot = () => useSyncExternalStore((f) => (prepSubs.add(f), () => void prepSubs.delete(f)), () => slot);
/** The overlay takes the slot when a call starts. */
export function takePrep(meetingId: string): Prep | null {
  const p = slot;
  if (p) localStorage.setItem(ACTIVE_KEY, JSON.stringify({ ...p, meeting_id: meetingId }));
  setPrepSlot(null);
  return p;
}
export function activePrep(meetingId?: string): Prep | null {
  const a = read(ACTIVE_KEY);
  return a && a.meeting_id === meetingId ? { name: a.name, text: a.text } : null;
}
export function keepActivePrep(meetingId: string | undefined, p: Prep | null) {
  if (p && meetingId) localStorage.setItem(ACTIVE_KEY, JSON.stringify({ ...p, meeting_id: meetingId }));
  else localStorage.removeItem(ACTIVE_KEY);
}
export async function readPrepFile(file: File): Promise<Prep> {
  if (file.size > 2_000_000) throw new Error(t('The file is too large (max 2 MB).'));
  return { name: file.name, text: await file.text() };
}
export const kb = (s: string) => `${Math.max(1, Math.round(new Blob([s]).size / 1024))} kB`;

// ------------------------------------------------------------------ i18n (English source strings; Czech as option)

const CS: Record<string, string> = {
  Transcript: 'Přepis', Hints: 'Nápovědy', Chat: 'Chat', End: 'Ukončit', Hidden: 'Skryto', Me: 'Vy', Others: 'Ostatní', Mixed: 'Hovor',
  'speaking': 'mluvíte', 'live': 'živě', 'Question · suggested answer →': 'Otázka · návrh odpovědi →', 'Latest': 'Nejnovější',
  'Pin on top': 'Připnout navrch', 'Collapse to capsule': 'Sbalit do kapsle', 'Expand overlay': 'Rozbalit overlay',
  'Hidden from screen sharing': 'Okno se nezobrazí při sdílení obrazovky',
  'On questions and every {n} s': 'Při otázce a každých {n} s', 'Every {n} s': 'Každých {n} s', 'Refresh': 'Obnovit', Question: 'Otázka', new: 'nové',
  Assist: 'Asistent', 'Say next': 'Řekni', Dismiss: 'Zahodit', 'Automatic hints are off': 'Automatické nápovědy jsou vypnuté',
  'Make me sound smart': 'Ať zním chytře', 'What should I ask?': 'Na co se zeptat?', Recap: 'Shrnutí', 'Fact-check': 'Ověřit fakta',
  Copy: 'Kopírovat', Hide: 'Skrýt', 'Ask next': 'Zeptej se', 'Not covered yet': 'Zatím nezaznělo', 'Thinking…': 'Přemýšlím…',
  'Hints appear when the others ask a question or every few seconds of new speech.': 'Nápovědy se objeví, když ostatní položí otázku, nebo každých pár sekund nové řeči.',
  'Ask about the call…': 'Zeptej se na hovor…', 'Context: whole call': 'Kontext: celý hovor', 'Context: last 10 min': 'Kontext: posledních 10 min', Change: 'Změnit', Send: 'Odeslat',
  'Ask anything about what was said so far.': 'Zeptej se na cokoliv, co zatím zaznělo.',
  'Live transcription interrupted': 'Živý přepis přerušen', 'Recording continues. The missing part is filled in from the exact transcript after the call.': 'Nahrávka běží dál. Chybějící úsek se doplní z přesného přepisu po hovoru.',
  'Retrying with the next sentence.': 'Zkusím to znovu s další větou.', 'Not active — invalid format or used by another app.': 'Nefunguje — špatný formát, nebo ji používá jiná aplikace.', 'Connecting…': 'Připojuji…',
  'Transcript is doubling': 'Přepis se zdvojuje', 'The microphone picks up your speakers. Put on headphones or mute the microphone channel.': 'Mikrofon zachytává zvuk z reproduktorů. Nasaď sluchátka, nebo vypni mikrofonní kanál.',
  'Got it': 'Rozumím', 'Audio settings': 'Nastavení zvuku', 'Server unavailable': 'Server nedostupný', 'Open settings': 'Otevřít nastavení',
  '{n} recordings wait on this PC and upload automatically once the connection is back.': 'Nahrávky čekající v počítači: {n}. Nahrají se samy, jakmile se spojení obnoví.',
  'Not recording': 'Nenahrává se', 'Start recording': 'Spustit nahrávání', 'Waiting for speech…': 'Čekám na řeč…', 'Audio problem': 'Problém se zvukem',
  'Call started': 'Začal hovor', 'Call started in {p}': 'Začal hovor v {p}', Title: 'Název', 'Automatic hints': 'Automatické nápovědy', 'Record and transcribe': 'Nahrávat a přepsat', 'Not now': 'Teď ne',
  now: 'teď', 'Call saved': 'Hovor uložen', 'Uploaded to server': 'Nahráno na server', 'Exact transcript': 'Přesný přepis', 'Summary and action items': 'Souhrn a úkoly',
  waiting: 'čeká', done: 'hotovo', 'You can close this, it finishes on the server.': 'Okno můžeš zavřít, dokončí se na serveru.', 'Copy live transcript': 'Kopírovat živý přepis',
  'Notes are ready': 'Zápis je hotový', '{n} speakers': '{n} mluvčí', '1 speaker': '1 mluvčí', '{n} action items': 'úkoly: {n}', '1 action item': '1 úkol', 'Saved on the server · available via MCP': 'Uloženo na server · dostupné přes MCP',
  'Copy summary': 'Kopírovat shrnutí', 'Copy action items': 'Kopírovat úkoly', 'Copy transcript': 'Kopírovat přepis', 'Processing failed': 'Zpracování selhalo', Copied: 'Zkopírováno', Close: 'Zavřít', min: 'min',
  Home: 'Přehled', 'Calls this month': 'Hovorů tento měsíc', 'Hours recorded': 'Nahraných hodin', 'Words transcribed': 'Přepsaných slov', 'Open action items': 'Otevřených úkolů',
  'Last 5 weeks': 'Posledních 5 týdnů', 'Top platforms': 'Podle platformy', Other: 'Jiné', 'Recent calls': 'Poslední hovory', Today: 'Dnes', Yesterday: 'Včera', 'en-GB': 'cs-CZ',
  Done: 'Hotovo', Error: 'Chyba', Transcribing: 'Přepisuje se', '{n} to do': '{n} úkolů', Summary: 'Shrnutí', 'Action items': 'Úkoly', 'No summary yet.': 'Zatím bez shrnutí.',
  'Could not load calls from your server: {e}': 'Hovory se nepodařilo načíst ze serveru: {e}',
  'No calls yet. Calls appear here after you record one: start from the tray icon or when Kazetix offers to record a Teams, Meet or Zoom call.': 'Zatím žádné hovory. Objeví se tu po prvním nahrání: spusťte ho z ikony v liště nebo když Kazetix nabídne nahrát hovor v Teams, Meet či Zoomu.',
  Settings: 'Nastavení', General: 'Obecné', 'Audio & transcription': 'Zvuk a přepis', 'Server & AI': 'Server a AI', 'Keyboard shortcuts': 'Klávesové zkratky',
  Devices: 'Zařízení', 'Microphone · Me': 'Mikrofon · Vy', 'System audio · Others': 'Systémový zvuk · Ostatní', 'System default': 'Výchozí zařízení systému',
  'Use headphones, otherwise the microphone picks up the speakers and the transcript doubles.': 'Používej sluchátka, jinak mikrofon chytá reproduktory a přepis se zdvojí.',
  'Live transcription': 'Živý přepis', 'Speech is cut at pauses and transcribed through OpenRouter; text appears 1–3 s after each sentence. Billed only for speech.': 'Řeč se dělí na pauzách a přepisuje přes OpenRouter; text naskočí 1–3 s po větě. Platí se jen za řeč.', 'Transcription model (OpenRouter)': 'Model pro přepis (OpenRouter)',
  '2 channels': '2 kanály', '1 channel': '1 kanál', 'Me and Others separately': 'Vy a Ostatní zvlášť', 'Mixed, no distinction': 'Smíchaný, bez rozlišení',
  'Exact transcript on the server after the call': 'Po hovoru přesný přepis na serveru', 'Also store the live transcript on the server': 'Ukládat na server i živý přepis',
  'Language': 'Jazyk', 'per channel': 'za kanál', 'OpenRouter key is not set — live transcription, hints and chat need it.': 'Klíč OpenRouter není nastaven — potřebuje ho živý přepis, nápovědy i chat.',
  'Kazetix server': 'Server Kazetix', 'Server address': 'Adresa serveru', 'API token': 'API token', 'in Credential Manager': 've Správci pověření', Verify: 'Ověřit',
  'Connected · {n} meetings': 'Připojeno · {n} schůzek', 'Not verified': 'Neověřeno', 'MCP for Claude': 'MCP pro Claude', 'API key': 'API klíč', Save: 'Uložit',
  'OpenRouter · live transcription, chat, hints': 'OpenRouter · živý přepis, chat, nápovědy', 'Chat model': 'Model pro chat', 'Hints model': 'Model pro nápovědy', 'Every': 'Každých',
  'Also whenever the others ask a question.': 'Navíc vždy, když ostatní položí otázku.',
  'Keys are stored in Windows Credential Manager.': 'Klíče jsou uložené ve Správci pověření Windows.',
  'App language': 'Jazyk aplikace', 'Start with Windows': 'Spouštět s Windows', 'Overlay when a call starts': 'Overlay při startu hovoru', Expanded: 'Rozbalený', Capsule: 'Kapsle',
  'Start / stop recording': 'Spustit / ukončit nahrávání', 'Show / hide overlay': 'Zobrazit / skrýt overlay', 'Focus chat': 'Fokus do chatu', 'Mark moment ★': 'Označit moment ★',
  'Format: Ctrl+Alt+Shift+R. Applied on save.': 'Formát: Ctrl+Alt+Shift+R. Použije se po uložení.', 'Log file': 'Soubor logu', 'set': 'nastaveno', 'not set': 'nenastaveno', 'Server error': 'Chyba serveru',
  'Marked ★': 'Označeno ★', 'Uploading': 'Nahrávám', 'Language of transcription': 'Jazyk přepisu',
  'Prep': 'Příprava', 'Attach prep (.md)': 'Přiložit přípravu (.md)', 'Replace': 'Vyměnit', 'Remove': 'Odebrat',
  'Prep for the next call': 'Příprava na příští hovor', 'From your prep': 'Z tvé přípravy', '{a} of {b} covered': 'probráno {a} z {b}',
  'Drop a .md file made in Claude or ChatGPT. Kazetix follows it during the call and tells you what has not come up yet.': 'Přetáhni sem .md z Clauda nebo ChatGPT. Kazetix podle ní hovor hlídá a připomene, co ještě nezaznělo.',
  'Reading your prep…': 'Čtu přípravu…', 'The file is too large (max 2 MB).': 'Soubor je moc velký (max 2 MB).', 'Used when the next call starts.': 'Použije se při startu dalšího hovoru.',
  'Press REC to start recording': 'Nahrávání spustíš klávesou REC',
  '{app} is using the microphone': '{app} používá mikrofon', 'Recording in {n} s': 'Nahrávám za {n} s', 'Call detection': 'Detekce hovoru',
  'Offer to record when a call app starts using the microphone': 'Nabídnout nahrávání, když aplikace pro hovory začne používat mikrofon', Then: 'Potom',
  'Ask me': 'Zeptat se', 'Start recording after {n} s': 'Začít nahrávat po {n} s', 'Pasted notes': 'Vložené poznámky', 'Paste or type your prep notes…': 'Vlož nebo napiš poznámky k přípravě…', Cancel: 'Zrušit', File: 'Soubor', Text: 'Text',
  'Drop or paste a .md file or text made in Claude or ChatGPT. Kazetix follows it during the call and tells you what has not come up yet.': 'Přetáhni nebo vlož .md soubor či text z Clauda nebo ChatGPT. Kazetix podle něj hlídá hovor a připomene, co ještě nezaznělo.',
  'Storage & AI': 'Úložiště a AI', 'Where calls are stored': 'Kde se hovory ukládají', 'On this PC': 'V tomto počítači', 'Own server': 'Vlastní server',
  'Archive, search and MCP run inside Kazetix. No server needed.': 'Archiv, hledání i MCP běží přímo v Kazetixu. Server není potřeba.',
  'Your own Kazetix server stores and processes the calls.': 'Hovory ukládá a zpracovává tvůj vlastní server Kazetix.',
  'Connect Claude': 'Připojit Claude', 'Claude reads your calls, summaries and action items from this PC. Claude Desktop starts Kazetix in the background when it needs them.': 'Claude čte hovory, shrnutí a úkoly z tohoto počítače. Claude Desktop si Kazetix spustí na pozadí, když je potřebuje.',
  'Add to Claude Desktop': 'Přidat do Claude Desktop', 'Added to {path}. Restart Claude Desktop.': 'Přidáno do {path}. Restartuj Claude Desktop.', 'Claude Code': 'Claude Code', 'Summary model': 'Model pro shrnutí',
  'Exact transcript after the call': 'Po hovoru přesný přepis', 'Saved on this PC · available via MCP': 'Uloženo v tomto počítači · dostupné přes MCP', 'You can close this, it finishes in the background.': 'Okno můžeš zavřít, dokončí se na pozadí.',
  'Plastic': 'Plast', 'Beige': 'Béžový', 'Black': 'Černý', 'System': 'Podle systému', 'Housing': 'Kryt',
};

let lang: 'en' | 'cs' = 'en';
subs.add(() => (lang = current?.ui_language ?? 'en'));

export function t(s: string, vars?: Record<string, string | number>): string {
  let out = lang === 'cs' ? (CS[s] ?? s) : s;
  for (const [k, v] of Object.entries(vars ?? {})) out = out.replace(`{${k}}`, String(v));
  return out;
}

// ------------------------------------------------------------------ helpers

export const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

export const speaker = (c: string) => (c === 'me' ? t('Me') : c === 'them' ? t('Others') : t('Mixed'));
export const platformName = (p?: string | null) => ({ teams: 'Microsoft Teams', meet: 'Google Meet', zoom: 'Zoom' } as Record<string, string>)[p ?? ''] ?? '';

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export async function copy(text: string) {
  await navigator.clipboard.writeText(text);
}

export const uid = () => crypto.randomUUID();
