import { useEffect, useState } from 'react';
import { api, copy, getPlastic, getSkin, setPlastic, setSkin, t, updateSettings, useEvent, useSettings, type Plastic, type Settings, type Skin } from './lib';
import { Meter } from './Overlay';
import { Brand } from './Prep';
import Home from './Home';

type Page = 'home' | 'general' | 'audio' | 'server' | 'shortcuts';
const STT_MODELS = ['elevenlabs/scribe-v2', 'mistralai/voxtral-small-transcribe-3-0', 'openai/gpt-transcribe', 'google/gemini-3.5-transcribe', 'assemblyai/universal-3-6-pro'];
const PAGES: [Page, string][] = [['home', 'Home'], ['general', 'General'], ['audio', 'Audio & transcription'], ['server', 'Storage & AI'], ['shortcuts', 'Keyboard shortcuts']];

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button className="toggle" role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span className="track" />
      {label}
    </button>
  );
}

/** Text field that saves on blur / Enter. */
function Field({ label, value, onSave, placeholder, list, mono }: { label: string; value: string; onSave: (v: string) => void; placeholder?: string; list?: string; mono?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="field">
      <label className="label">{label}</label>
      <input className={`input ${mono ? 'mono' : ''}`} value={v} placeholder={placeholder} list={list} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v.trim())} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
    </div>
  );
}

export default function SettingsWindow() {
  const s = useSettings();
  const [page, setPage] = useState<Page>('home');
  useEvent<string>('settings-page', (e) => setPage(e.payload as Page));
  useEffect(() => {
    api.monitor(page === 'audio');
    return () => void api.monitor(false);
  }, [page]);
  if (!s) return null;
  return (
    <div className="settings">
      <nav className="side" aria-label={t('Settings')}>
        <span className="brand"><span className="rec-dot" /><Brand /></span>
        {PAGES.map(([k, label]) => <button key={k} aria-current={page === k ? 'page' : undefined} onClick={() => setPage(k)}><span className="lamp" />{t(label)}</button>)}
        <span className="grille" aria-hidden="true" />
      </nav>
      <main className="page"><div className="sheet">
        {page === 'home' && <Home s={s} />}
        {page === 'general' && <General s={s} />}
        {page === 'audio' && <Audio s={s} />}
        {page === 'server' && <ServerPage s={s} />}
        {page === 'shortcuts' && <Shortcuts s={s} />}
      </div></main>
    </div>
  );
}

function General({ s }: { s: Settings }) {
  const [log, setLog] = useState('');
  const [plastic, setP] = useState<Plastic>(getPlastic());
  const [skin, setK] = useState<Skin>(getSkin());
  useEffect(() => void api.logPath().then(setLog), []);
  return (
    <>
      <h1>{t('General')}</h1>
      <div className="section">
        <div className="field" style={{ maxWidth: 320 }}>
          <label className="label">{t('App language')}</label>
          <select className="input" value={s.ui_language} onChange={(e) => updateSettings({ ui_language: e.target.value as Settings['ui_language'] })}>
            <option value="en">English</option>
            <option value="cs">Čeština</option>
          </select>
        </div>
        <Toggle on={s.autostart} label={t('Start with Windows')} onChange={(v) => updateSettings({ autostart: v })} />
      </div>
      <div className="section">
        <span className="label">{t('Privacy')}</span>
        <Toggle on={s.allow_capture} label={t('Allow screenshots and screen sharing of Kazetix')} onChange={(v) => updateSettings({ allow_capture: v })} />
        <p className="note">{t('Off: the overlay never shows up when you share your screen.')}</p>
      </div>
      <div className="section">
        <span className="label">{t('Call detection')}</span>
        <Toggle on={s.call_detect} label={t('Offer to record when a call app starts using the microphone')} onChange={(v) => updateSettings({ call_detect: v })} />
        <div className="field" style={{ maxWidth: 320 }}>
          <label className="label">{t('Then')}</label>
          <select className="input" value={s.call_autostart_s} disabled={!s.call_detect} onChange={(e) => updateSettings({ call_autostart_s: Number(e.target.value) })}>
            <option value={0}>{t('Ask me')}</option>
            {[5, 10, 20].map((n) => <option key={n} value={n}>{t('Start recording after {n} s', { n })}</option>)}
          </select>
        </div>
      </div>
      <div className="section">
        <span className="label">{t('Skin')}</span>
        <div className="grid2" style={{ maxWidth: 480 }}>
          {(['original', 'modern'] as const).map((k) => (
            <button key={k} className="option" aria-pressed={skin === k} onClick={() => (setSkin(k), setK(k))}><b>{t(k === 'modern' ? 'Modern' : 'Original')}</b></button>
          ))}
        </div>
        <span className="label">{t('Housing')}</span>
        <div className="grid2" style={{ gridTemplateColumns: 'repeat(3, 1fr)', maxWidth: 480 }}>
          {(['beige', 'black', 'system'] as const).map((p) => (
            <button key={p} className="option" aria-pressed={plastic === p} onClick={() => (setPlastic(p), setP(p))}><b>{t(skin === 'modern' ? (p === 'beige' ? 'Light' : p === 'black' ? 'Dark' : 'System') : p === 'beige' ? 'Beige' : p === 'black' ? 'Black' : 'System')}</b></button>
          ))}
        </div>
      </div>
      <div className="section">
        <span className="label">{t('Overlay when a call starts')}</span>
        <div className="grid2" style={{ maxWidth: 480 }}>
          {(['expanded', 'capsule'] as const).map((m) => (
            <button key={m} className="option" aria-pressed={s.overlay_default === m} onClick={() => updateSettings({ overlay_default: m })}><b>{t(m === 'expanded' ? 'Expanded' : 'Capsule')}</b></button>
          ))}
        </div>
      </div>
      <div className="section">
        <span className="label">{t('Log file')}</span>
        <span className="note mono selectable">{log}</span>
      </div>
    </>
  );
}

function Audio({ s }: { s: Settings }) {
  const [devs, setDevs] = useState<{ inputs: string[]; outputs: string[] }>({ inputs: [], outputs: [] });
  const [levels, setLevels] = useState({ me: 0, them: 0 });
  const [audioErr, setAudioErr] = useState<string | null>(null);
  useEffect(() => void api.devices().then(setDevs), []);
  useEvent<{ me: number; them: number }>('levels', (e) => setLevels(e.payload));
  useEvent<{ error: string | null }>('audio-status', (e) => setAudioErr(e.payload.error));
  const setDevice = async (patch: Partial<Settings>) => {
    await updateSettings(patch);
    api.monitor(true); // restart meters on the new device
  };
  const LANGS: [string, string][] = [['cs', 'Čeština (cs)'], ['sk', 'Slovenčina (sk)'], ['en', 'English (en)'], ['de', 'Deutsch (de)'], ['pl', 'Polski (pl)'], ['', 'Auto-detect']];
  return (
    <>
      <h1>{t('Audio & transcription')}</h1>
      <div className="section">
        <span className="label">{t('Devices')}</span>
        {[['mic_device', 'Microphone · Me', devs.inputs, levels.me, 'var(--me)'], ['output_device', 'System audio · Others', devs.outputs, levels.them, 'var(--them)']].map(([key, label, list, lvl, color]) => (
          <div key={key as string} className="field">
            <label className="label">{t(label as string)}</label>
            <div className="row">
              <select className="input grow" value={(s[key as 'mic_device'] as string | null) ?? ''} onChange={(e) => setDevice({ [key as string]: e.target.value || null })}>
                <option value="">{t('System default')}</option>
                {(list as string[]).map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <Meter level={lvl as number} color={color as string} />
            </div>
          </div>
        ))}
        {audioErr && <p className="note status-bad">{audioErr}</p>}
        <p className="note">{t('Use headphones, otherwise the microphone picks up the speakers and the transcript doubles.')}</p>
      </div>

      <div className="section">
        <span className="label">{t('Live transcription')}</span>
        <p className="note">{t('Speech is cut at pauses and transcribed through OpenRouter; text appears 1–3 s after each sentence. Billed only for speech.')}</p>
        <datalist id="stt-models">{STT_MODELS.map((m) => <option key={m} value={m} />)}</datalist>
        <div style={{ maxWidth: 420 }}>
          <Field label={t('Transcription model (OpenRouter)')} value={s.live_model} list="stt-models" mono onSave={(v) => updateSettings({ live_model: v || 'elevenlabs/scribe-v2' })} />
        </div>
        <div className="grid2">
          <button className="option" aria-pressed={s.channels === 2} onClick={() => updateSettings({ channels: 2 })}><b>{t('2 channels')}<span className="price">≤ $0.44/h</span></b><span>{t('Me and Others separately')}</span></button>
          <button className="option" aria-pressed={s.channels === 1} onClick={() => updateSettings({ channels: 1 })}><b>{t('1 channel')}<span className="price">≤ $0.22/h</span></b><span>{t('Mixed, no distinction')}</span></button>
        </div>
        <div className="row"><Toggle on={s.final_transcript} label={s.storage === 'local' ? t('Exact transcript after the call') : t('Exact transcript on the server after the call')} onChange={(v) => updateSettings({ final_transcript: v })} /><span className="price">+$0.22/h {t('per channel')}</span></div>
        {s.storage === 'server' && <Toggle on={s.store_live} label={t('Also store the live transcript on the server')} onChange={(v) => updateSettings({ store_live: v })} />}
        <div className="field" style={{ maxWidth: 320 }}>
          <label className="label">{t('Language of transcription')}</label>
          <select className="input" value={s.language} onChange={(e) => updateSettings({ language: e.target.value })}>
            {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      </div>
    </>
  );
}

function SecretField({ label, name, isSet, placeholder }: { label: string; name: 'server_token' | 'openrouter_key'; isSet: boolean; placeholder: string }) {
  const [v, setV] = useState('');
  const [saved, setSaved] = useState(false);
  const save = async () => {
    await api.setSecret(name, v);
    setV('');
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  return (
    <div className="field">
      <label className="label">{label}{!isSet && <> · <span className="status-bad">{t('not set')}</span></>}</label>
      <div className="row">
        <input className="input mono" type="password" autoComplete="off" value={v} placeholder={isSet ? '••••••••••••' : placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && v && save()} />
        <button className="btn btn-secondary" disabled={!v} onClick={save}>{saved ? '✓' : t('Save')}</button>
      </div>
    </div>
  );
}

function ServerPage({ s }: { s: Settings }) {
  const [secrets, setSecrets] = useState({ server_token: false, openrouter_key: false });
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const refresh = () => api.secretStatus().then(setSecrets);
  useEffect(() => void refresh(), []);
  useEvent('settings', refresh);
  const verify = async () => {
    setCheck(null);
    try {
      const h = await api.verifyServer(s.server_url);
      setCheck({ ok: true, text: t('Connected · {n} meetings', { n: h.meetings }) + ` · v${h.version}` + (h.openrouter ? '' : ' · server lacks OPENROUTER_API_KEY') });
    } catch (e) {
      setCheck({ ok: false, text: String(e) });
    }
  };
  useEffect(() => {
    if (s.storage === 'server' && s.server_url && secrets.server_token) verify();
  }, [s.storage, s.server_url, secrets.server_token]);
  const [exe, setExe] = useState('');
  const [claude, setClaude] = useState<{ ok: boolean; text: string } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  useEffect(() => void api.mcpExe().then(setExe, () => {}), []);
  const addToClaude = async () => {
    try {
      setClaude({ ok: true, text: t('Added to {path}. Restart Claude Desktop.', { path: await api.connectClaudeDesktop() }) });
    } catch (e) {
      setClaude({ ok: false, text: String(e) });
    }
  };
  const claudeCode = `claude mcp add kazetix -- "${exe}" --mcp`;
  const local = s.storage === 'local';
  const mcp = s.server_url ? `${s.server_url.replace(/\/$/, '')}/mcp` : '';
  const MODELS = ['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5', 'anthropic/claude-opus-5.5', 'google/gemini-3.8-flash', 'openai/gpt-5.6-luna'];
  return (
    <>
      <h1>{t('Storage & AI')}</h1>
      {!secrets.openrouter_key && <p className="note status-bad">{t('OpenRouter key is not set — live transcription, hints and chat need it.')}</p>}
      <div className="section">
        <span className="label">{t('Where calls are stored')}</span>
        <div className="grid2">
          <button className="option" aria-pressed={local} onClick={() => updateSettings({ storage: 'local' })}><b>{t('On this PC')}</b><span>{t('Archive, search and MCP run inside Kazetix. No server needed.')}</span></button>
          <button className="option" aria-pressed={!local} onClick={() => updateSettings({ storage: 'server' })}><b>{t('Own server')}</b><span>{t('Your own Kazetix server stores and processes the calls.')}</span></button>
        </div>
      </div>
      {local && (
        <div className="section">
          <span className="label">{t('Connect Claude')}</span>
          <p className="note">{t('Claude reads your calls, summaries and action items from this PC. Claude Desktop starts Kazetix in the background when it needs them.')}</p>
          <div className="row">
            <button className="btn btn-secondary" onClick={addToClaude}>{t('Add to Claude Desktop')}</button>
            {claude && <span className={`note ${claude.ok ? 'status-ok' : 'status-bad'}`}>{claude.text}</span>}
          </div>
          <div className="field">
            <label className="label">{t('Claude Code')}</label>
            <div className="row">
              <input className="input mono" readOnly value={claudeCode} />
              <button className="btn btn-secondary" disabled={!exe} onClick={async () => { await copy(claudeCode); setCopiedCode(true); setTimeout(() => setCopiedCode(false), 1500); }}>{copiedCode ? t('Copied') : t('Copy')}</button>
            </div>
          </div>
        </div>
      )}
      {!local && <div className="section">
        <div className="row">
          <span className="label">{t('Kazetix server')}</span>
          <span className={`note spacer ${check ? (check.ok ? 'status-ok' : 'status-bad') : ''}`}>{check ? check.text : t('Not verified')}</span>
        </div>
        <Field label={t('Server address')} value={s.server_url} placeholder="https://kazetix.example.com" mono onSave={(v) => updateSettings({ server_url: v.replace(/\/$/, '') })} />
        <SecretField label={t('API token')} name="server_token" isSet={secrets.server_token} placeholder="KAZETIX_API_TOKEN" />
        <div><button className="btn btn-secondary" onClick={verify} disabled={!s.server_url}>{t('Verify')}</button></div>
        {mcp && (
          <div className="field">
            <label className="label">{t('MCP for Claude')}</label>
            <div className="row">
              <input className="input mono" readOnly value={mcp} />
              <button className="btn btn-secondary" onClick={async () => { await copy(mcp); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? t('Copied') : t('Copy')}</button>
            </div>
          </div>
        )}
      </div>}
      <div className="section">
        <span className="label">{t('OpenRouter · live transcription, chat, hints')}</span>
        <SecretField label={t('API key')} name="openrouter_key" isSet={secrets.openrouter_key} placeholder="sk-or-…" />
        <datalist id="models">{MODELS.map((m) => <option key={m} value={m} />)}</datalist>
        <div className="grid2">
          <Field label={t('Chat model')} value={s.chat_model} list="models" mono onSave={(v) => updateSettings({ chat_model: v })} />
          <Field label={t('Hints model')} value={s.hints_model} list="models" mono onSave={(v) => updateSettings({ hints_model: v })} />
        </div>
        {local && <div style={{ maxWidth: 420 }}><Field label={t('Summary model')} value={s.summary_model} list="models" mono onSave={(v) => updateSettings({ summary_model: v || 'anthropic/claude-sonnet-5.5' })} /></div>}
      </div>
      <div className="section">
        <span className="label">{t('Hints')}</span>
        <div className="row">
          <Toggle on={s.hints_enabled} label={t('Automatic hints')} onChange={(v) => updateSettings({ hints_enabled: v })} />
          <span className="note">{t('Every')}</span>
          <select className="input" style={{ width: 100 }} value={s.hints_interval_s} onChange={(e) => updateSettings({ hints_interval_s: Number(e.target.value) })}>
            {[15, 25, 40, 60, 120].map((n) => <option key={n} value={n}>{n} s</option>)}
          </select>
        </div>
        <Toggle on={s.hints_on_question} label={t('Also whenever the others ask a question.')} onChange={(v) => updateSettings({ hints_on_question: v })} />
      </div>
    </>
  );
}

function Shortcuts({ s }: { s: Settings }) {
  const rows: [keyof Settings['shortcuts'], string][] = [['record', 'Start / stop recording'], ['overlay', 'Show / hide overlay'], ['chat', 'Focus chat'], ['mark', 'Mark moment ★']];
  const [failed, setFailed] = useState<string[]>([]);
  useEffect(() => void api.shortcutErrors().then(setFailed), [s.shortcuts]);
  return (
    <>
      <h1>{t('Keyboard shortcuts')}</h1>
      <div className="section" style={{ maxWidth: 480 }}>
        {rows.map(([k, label]) => (
          <div key={k}>
            <Field label={t(label)} value={s.shortcuts[k]} mono onSave={(v) => updateSettings({ shortcuts: { ...s.shortcuts, [k]: v } })} />
            {failed.includes(k) && <p className="note status-bad">{t('Not active — invalid format or used by another app.')}</p>}
          </div>
        ))}
        <p className="note">{t('Format: Ctrl+Alt+Shift+R. Applied on save.')}</p>
      </div>
    </>
  );
}
