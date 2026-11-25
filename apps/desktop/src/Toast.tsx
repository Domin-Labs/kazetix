import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getCurrentWindow, currentMonitor, primaryMonitor, LogicalSize, LogicalPosition } from '@tauri-apps/api/window';
import { api, copy, machine, machineScale, machineSize, mmss, setMachineScale, platformName, setPrepSlot, speaker, t, updateSettings, useEvent, usePrepSlot, useSettings, type MeetingView, type Segment, type ServerStatus } from './lib';
import { KeyIcon, PrepBox } from './Prep';
import { Counter } from './Overlay';

const win = getCurrentWindow();

type ToastState =
  | { kind: 'start'; title: string; platform: string | null; auto?: boolean; mic_app?: string; countdown_s?: number }
  | { kind: 'processing'; meeting_id: string; title: string; platform: string | null; duration_s: number; upload: boolean; local?: boolean; segments: Segment[] }
  | { kind?: undefined };

// The toast is the overlay's machine: same skin and scale (remembered from resizing either window).
let placing = false;

/** Size the window to the machine at the remembered scale and dock it bottom-right above the taskbar. */
async function fit() {
  const [W, h] = machineSize();
  document.documentElement.style.zoom = String(machineScale());
  const mon = (await currentMonitor()) ?? (await primaryMonitor());
  if (!mon) return;
  placing = true;
  const k = mon.scaleFactor;
  const area = (mon as { workArea?: { position: { x: number; y: number }; size: { width: number; height: number } } }).workArea ?? {
    position: mon.position,
    size: { width: mon.size.width, height: mon.size.height - 48 * k },
  };
  await win.setSize(new LogicalSize(W, h));
  await win.setPosition(new LogicalPosition(Math.round((area.position.x + area.size.width) / k - W - 16), Math.round((area.position.y + area.size.height) / k - h - 16)));
  setTimeout(() => (placing = false), 300);
}

export default function Toast() {
  const [st, setSt] = useState<ToastState>({});
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const load = () => api.toastState().then((s) => setSt(s as ToastState), () => setTimeout(load, 250));
    load();
  }, []);
  useEvent<ToastState>('toast', (e) => setSt(e.payload));
  useLayoutEffect(() => {
    if (!ref.current) return;
    fit();
    // a drag on the corner grip resizes the window: keep the machine's shape, remember the width for both windows
    let t0: ReturnType<typeof setTimeout>;
    const onResize = () => {
      if (placing) return;
      document.documentElement.style.zoom = String(innerWidth / machine()[0]);
      clearTimeout(t0);
      t0 = setTimeout(() => {
        setMachineScale(innerWidth / machine()[0]);
        fit();
      }, 250);
    };
    const onSkin = (e: StorageEvent) => e.key === 'kazetix.skin' && fit();
    addEventListener('resize', onResize);
    addEventListener('storage', onSkin);
    return () => (clearTimeout(t0), removeEventListener('resize', onResize), removeEventListener('storage', onSkin));
  }, []);
  return (
    <div ref={ref} className="toast" onKeyDown={(e) => e.key === 'Escape' && win.hide()}>
      {st.kind === 'start' && <Start key={`${st.title}|${st.mic_app}`} title={st.title} platform={st.platform} micApp={st.auto ? st.mic_app : undefined} countdown={st.auto ? st.countdown_s ?? 0 : 0} />}
      {st.kind === 'processing' && <Processing key={st.meeting_id} {...st} />}
    </div>
  );
}

/** The toast is the overlay's own machine: the message is on its LCD, the actions are its keys. */
function Device(p: { counter: number; tag: string; title: string; sub: string; lamp?: 'on' | 'amber'; keys: [React.ReactNode, React.ReactNode]; red: React.ReactNode; rec?: boolean; onRed: () => void; children: React.ReactNode }) {
  return (
    <div className="housing toast-device" data-tauri-drag-region>
      <span className={`hw hw-led ${p.lamp ? '' : 'off'}`} />
      <div className="hw hw-counter"><Counter ms={p.counter} tag={p.tag} /></div>
      <button className="hw key hw-close" aria-label={t('Close')} onClick={() => win.hide()}><KeyIcon kind="close" /></button>
      {p.keys[0]}
      {p.keys[1]}
      <div className="hw hw-lcd lcd"><div className="scroll toast-lcd"><h2>{p.title}</h2><p className="sub">{p.lamp === 'amber' && <span className="lamp amber" />}{p.sub}</p>{p.children}</div></div>
      <button className={`hw key hw-end ${p.rec ? 'rec' : 'plain'}`} onClick={p.onRed}>{p.red}</button>
      <span className="resize-grip" title={t('Drag to resize')} aria-hidden="true" onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); win.startResizeDragging('SouthEast'); } }} />
    </div>
  );
}

// A1 — call start: manual (shortcut / tray) or after automatic detection with an optional countdown.
function Start({ title, platform, micApp, countdown }: { title: string; platform: string | null; micApp?: string; countdown: number }) {
  const settings = useSettings();
  const prep = usePrepSlot();
  const [name, setName] = useState(title);
  const [err, setErr] = useState<string | null>(null);
  const [left, setLeft] = useState(countdown); // auto-start countdown; any edit or click stops it
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const go = async () => {
    setLeft(0);
    try {
      await api.start(name, platform);
    } catch (e) {
      setErr(String(e));
    }
  };
  useEffect(() => {
    if (left <= 0) return;
    const id = setTimeout(() => (left === 1 ? go() : setLeft(left - 1)), 1000);
    return () => clearTimeout(id);
  }, [left]);
  const p = platformName(platform);
  const hints = !!settings?.hints_enabled;
  return (
    <Device counter={left * 1000} tag={left > 0 ? 'AUTO' : 'STOP'} title={p ? t('Call started in {p}', { p }) : t('Call started')}
      sub={micApp ? t('{app} is using the microphone', { app: micApp }) : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} lamp={micApp ? 'amber' : undefined}
      keys={[
        <button key="tx" className="hw key hw-tab hw-tab1" role="radio" aria-checked={!hints} aria-selected={!hints} onClick={() => updateSettings({ hints_enabled: false })}><span className="lamp" />{t('Transcript only')}</button>,
        <button key="hints" className="hw key hw-tab hw-tab2" role="radio" aria-checked={hints} aria-selected={hints} onClick={() => updateSettings({ hints_enabled: true })}><span className="lamp" />{t('Automatic hints')}</button>,
      ]}
      red={left > 0 ? `REC ${left}` : 'REC'} rec onRed={go}>
      <label className="label" htmlFor="title">{t('Title')}</label>
      <input id="title" ref={input} className="input lcd-input" value={name} placeholder={`Meeting ${new Date().toLocaleString([], { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
        onChange={(e) => (setName(e.target.value), setLeft(0))} onKeyDown={(e) => e.key === 'Enter' && go()} />
      <span className="label">{t('Prep')}</span>
      <PrepBox prep={prep} onChange={setPrepSlot} hint={prep ? t('Prep') : t('Drop or paste a .md file or text made in Claude or ChatGPT. Kazetix follows it during the call and tells you what has not come up yet.')} />
      {err && <p className="lcd-error">{err}</p>}
      <p className="note">{left > 0 ? t('Recording in {n} s', { n: left }) + ' · ' : ''}REC · {settings?.shortcuts.record}</p>
    </Device>
  );
}

// C1 → C2 — exact transcript and summary (locally or on the server); then the notes.
function Processing(p: { meeting_id: string; title: string; platform: string | null; duration_s: number; upload: boolean; local?: boolean; segments: Segment[] }) {
  const [up, setUp] = useState<{ sent: number; total: number } | null>(null);
  const [m, setM] = useState<MeetingView | null>(null);
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEvent<{ meeting_id: string; sent: number; total: number }>('upload', (e) => e.payload.meeting_id === p.meeting_id && setUp(e.payload));
  useEvent<ServerStatus>('server-status', (e) => setServer(e.payload));
  useEffect(() => {
    let alive = true;
    let n = 0;
    const tick = async () => {
      try {
        const v = await api.meeting(p.meeting_id);
        if (alive) setM(v);
        if (v.status === 'done' || v.status === 'error') return;
      } catch {
        /* not created yet or offline — server-status shows why */
      }
      if (alive) setTimeout(tick, Math.min(3000 + n++ * 500, 30_000));
    };
    tick();
    return () => void (alive = false);
  }, [p.meeting_id]);

  const cp = async (label: string, text: string) => {
    await copy(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };
  const live = () => p.segments.map((s) => `[${mmss(s.start_ms)}] ${speaker(s.channel)}: ${s.text}`).join('\n');
  const mins = Math.max(1, Math.round(p.duration_s / 60));
  const meta = [p.title, platformName(p.platform), `${mins} ${t('min')}`].filter(Boolean).join(' · ');

  if (m?.status === 'done') {
    const summary = m.summary;
    const actions = m.action_items.map((a) => `- ${a.text}${a.owner ? ` (${a.owner})` : ''}${a.due_date ? ` — ${a.due_date}` : ''}`).join('\n');
    return (
      <Device counter={p.duration_s * 1000} tag="END" title={t('Notes are ready')} sub={p.title} lamp="on"
        keys={[
          <button key="s" className="hw key hw-tab hw-tab1" disabled={!summary} onClick={() => cp('s', `${p.title}\n\n${summary?.markdown ?? ''}`)}>{copied === 's' ? t('Copied') : t('Copy summary')}</button>,
          <button key="a" className="hw key hw-tab hw-tab2" disabled={!m.action_items.length} onClick={() => cp('a', actions)}>{copied === 'a' ? t('Copied') : t('Copy action items')}</button>,
        ]}
        red="OK" onRed={() => win.hide()}>
        <p className="sub">{[`${mins} ${t('min')}`, m.speakers ? t(m.speakers === 1 ? '1 speaker' : '{n} speakers', { n: m.speakers }) : '', t(m.action_items.length === 1 ? '1 action item' : '{n} action items', { n: m.action_items.length })].filter(Boolean).join(' · ')}</p>
        {summary?.key_points.slice(0, 4).map((k) => <div key={k} className="dash">{k}</div>)}
        <p className="note">{p.local ? t('Saved on this PC · available via MCP') : t('Saved on the server · available via MCP')}</p>
      </Device>
    );
  }

  const status = m?.status;
  const uploaded = !p.upload || (up ? up.sent >= up.total : !!m && ['transcribing', 'summarizing', 'done'].includes(m.status));
  const steps: { label: string; state: 'done' | 'run' | 'wait'; info: string }[] = [];
  if (p.upload) {
    const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
    if (!p.local) steps.push({ label: t('Uploaded to server'), state: uploaded ? 'done' : up ? 'run' : 'wait', info: up ? (uploaded ? mb(up.total) : `${Math.round((up.sent / Math.max(1, up.total)) * 100)} %`) : uploaded ? '' : t('waiting') });
    steps.push({ label: t('Exact transcript'), state: status === 'summarizing' ? 'done' : status === 'transcribing' ? 'run' : 'wait', info: status === 'transcribing' ? `${m?.progress ?? 0} %` : status === 'summarizing' ? t('done') : t('waiting') });
  }
  steps.push({ label: t('Summary and action items'), state: status === 'summarizing' ? 'run' : 'wait', info: status === 'summarizing' ? '…' : t('waiting') });
  const offline = server && !server.ok;
  const progress = (status === 'summarizing' ? 85 : status === 'transcribing' ? 30 + (m?.progress ?? 0) * 0.5 : uploaded ? 30 : up ? (up.sent / Math.max(1, up.total)) * 30 : 5) / 100;

  return (
    <Device counter={p.duration_s * 1000} tag="END" title={status === 'error' ? t('Processing failed') : offline ? t('Server unavailable') : t('Call saved')} sub={meta} lamp="amber"
      keys={[
        <button key="l" className="hw key hw-tab hw-tab1" disabled={!p.segments.length} onClick={() => cp('l', live())}>{copied === 'l' ? t('Copied') : t('Copy live transcript')}</button>,
        <button key="set" className="hw key hw-tab hw-tab2" onClick={() => api.openSettings('server')}>{t('Open settings')}</button>,
      ]}
      red={t('Hide')} onRed={() => win.hide()}>
      {status === 'error' ? (
        <p className="lcd-error">{m?.error}</p>
      ) : offline ? (
        <p>{server.error}. {t('{n} recordings wait on this PC and upload automatically once the connection is back.', { n: Math.max(1, server.pending_uploads) })}</p>
      ) : (
        steps.map((s) => (
          <div key={s.label} className={`step ${s.state}`}>
            <span className={`lamp ${s.state === 'done' ? 'on' : s.state === 'run' ? 'amber' : ''}`} />
            <span>{s.label}</span>
            <span className="state">{s.info}</span>
          </div>
        ))
      )}
      <div className="bar"><div style={{ transform: `scaleX(${progress})` }} /></div>
      <p className="note">{p.local ? t('You can close this, it finishes in the background.') : t('You can close this, it finishes on the server.')}</p>
    </Device>
  );
}
