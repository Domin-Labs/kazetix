import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getCurrentWindow, currentMonitor, primaryMonitor, LogicalSize, LogicalPosition } from '@tauri-apps/api/window';
import type { Hint } from '@kazetix/shared';
import { activePrep, api, copy, keepActivePrep, mmss, platformName, setPrepSlot, speaker, t, takePrep, uid, updateSettings, useEvent, useNow, usePrepSlot, useSettings, type Prep, type Segment, type ServerStatus, type SessionSnap, type SttStatus, type TranscriptEvt } from './lib';
import { KeyIcon, PrepBox, XIcon } from './Prep';
import { chat, hint, updateRolling, type Msg, type Rolling } from './ai';

type Card = { id: string; at_ms: number; segId?: string; hint: Hint; fresh: boolean; created: number };
type Ask = { q: string; added: number };
type Tab = 'transcript' | 'assist';
const NEW_MS = 30_000; // how long a fresh hint or question stays marked as new
const win = getCurrentWindow();

// The overlay can be resized by dragging its edge; the machine keeps its 2:3 shape and scales as a whole (CSS zoom).
const BASE_W = 440;
const CAP_H = 96; // the machine's thickness at BASE_W (docs/device-drawing.svg)
const HINT_H = 170; // hint card under the capsule
const FLIP_H = 210; // the display flipped out of the capsule on its hinge
const ovW = () => Math.min(660, Math.max(300, Number(localStorage.getItem('kazetix.overlay.w')) || BASE_W));

/** `extra`: px (at BASE_W) hanging under the capsule: the hint card or the flipped-out display. */
async function placeWindow(mode: 'expanded' | 'capsule', extra: number, pos: [number, number] | null) {
  const mon = (await currentMonitor()) ?? (await primaryMonitor());
  if (!mon) return;
  const k = mon.scaleFactor;
  const [mx, my, mw] = [mon.position.x / k, mon.position.y / k, mon.size.width / k];
  if (mode === 'capsule') {
    // the capsule is the same machine seen from its side: as wide as the front, as tall as the machine is thick
    const w = ovW();
    await win.setSize(new LogicalSize(w, Math.round((CAP_H + extra) * (w / BASE_W))));
    await win.setPosition(new LogicalPosition(Math.round(mx + (mw - w) / 2), Math.round(my + 10)));
  } else {
    const w = ovW();
    await win.setSize(new LogicalSize(w, Math.round(w * 1.5)));
    const [x, y] = pos ?? [mx + mw - w - 24, my + 80];
    await win.setPosition(new LogicalPosition(x, y));
  }
}

/** LED meter: segment i lights once the level passes i/5. */
export function Meter({ level, color }: { level: number; color: string }) {
  return (
    <div className="meter" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => <span key={i} className={level > i / 5 + 0.02 ? 'lit' : ''} style={{ background: i === 4 ? 'var(--rec)' : color }} />)}
    </div>
  );
}

/** Seven-segment counter window; unlit segments show through like on a real LCD. */
export function Counter({ ms, tag }: { ms: number; tag?: string }) {
  const v = mmss(ms);
  return (
    <span className="counter" role="timer" aria-label={v}>
      <b data-ghost={v.replace(/\d/g, '8')}>{v}</b>
      {tag && <i>{tag}</i>}
    </span>
  );
}

const Icon = {
  refresh: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.55" /><path d="M13 2.5v3h-3" /></svg>,
  copy: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></svg>,
};

export default function Overlay() {
  const settings = useSettings();
  const [snap, setSnap] = useState<SessionSnap>({ active: false });
  const [snapAt, setSnapAt] = useState(Date.now());
  const [segs, setSegs] = useState<Segment[]>([]);
  const [partial, setPartial] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<Tab>('transcript');
  const [mode, setMode] = useState<'expanded' | 'capsule'>('expanded');
  const [levels, setLevels] = useState({ me: 0, them: 0 });
  const [stt, setStt] = useState<Record<string, SttStatus>>({});
  const [echo, setEcho] = useState(false);
  const [echoDismissed, setEchoDismissed] = useState(false);
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [audioErr, setAudioErr] = useState<string | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [hintBusy, setHintBusy] = useState(false);
  const [hintErr, setHintErr] = useState<string | null>(null);
  const [popup, setPopup] = useState<Card | null>(null);
  const [flip, setFlip] = useState(false);
  const flipRef = useRef(false);
  flipRef.current = flip;
  const [pinned, setPinned] = useState(true);
  const [nowId, setNowId] = useState<string | null>(null);
  const [asks, setAsks] = useState<Ask[]>([]);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [prep, setPrepState] = useState<Prep | null>(null);
  const [points, setPoints] = useState<Hint['prep_points']>([]);
  const nextPrep = usePrepSlot();

  const segsRef = useRef<Segment[]>([]);
  segsRef.current = segs;
  const asksRef = useRef<Ask[]>([]);
  asksRef.current = asks;
  const prepRef = useRef<Prep | null>(null);
  prepRef.current = prep;
  const pointsRef = useRef<Hint['prep_points']>([]);
  pointsRef.current = points;
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const dismissed = useRef(new Set<string>());
  const rolling = useRef<Rolling>({ summary: '', upTo: 0 });
  const hs = useRef({ busy: false, lastAt: 0, lastCount: 0, timer: 0 as ReturnType<typeof setTimeout> | 0, again: null as null | { segId?: string; manual: boolean } });
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const now = useNow(1000);

  const reset = (s: SessionSnap) => {
    setSnap(s);
    setSnapAt(Date.now());
    setSegs(s.segments ?? []);
    setPartial({});
    setCards([]);
    setNowId(null);
    setAsks([]);
    setPrepState(activePrep(s.meeting_id)); // an overlay reloaded mid-call gets its prep back
    setPoints([]);
    dismissed.current = new Set();
    setStt({});
    setEcho(false);
    setEchoDismissed(false);
    setAudioErr(null);
    rolling.current = { summary: '', upTo: 0 };
    hs.current = { busy: false, lastAt: Date.now(), lastCount: 0, timer: 0, again: null };
  };

  useEffect(() => {
    const load = () => Promise.all([api.snapshot().then(reset), api.serverStatus().then(setServer)]).catch(() => setTimeout(load, 250));
    load();
  }, []);

  useEvent<SessionSnap>('session', (e) => {
    if (e.payload.active) {
      reset(e.payload);
      const p = takePrep(e.payload.meeting_id ?? '');
      setPrepState(p);
      prepRef.current = p;
      if (p) setTimeout(() => runHint(undefined, true), 0); // build the checklist and an opener before anyone speaks
      const m = settings?.overlay_default ?? 'expanded';
      modeRef.current = m; // 'overlay-shown' follows right away, before the re-render
      setMode(m);
      setTab('transcript');
      placeWindow(m, flipRef.current && m === 'capsule' ? FLIP_H : 0, settings?.overlay_pos ?? null);
    } else setSnap({ active: false });
  });
  useEvent('overlay-shown', () => placeWindow(modeRef.current, modeRef.current === 'capsule' ? (flipRef.current ? FLIP_H : popup ? HINT_H : 0) : 0, settings?.overlay_pos ?? null));
  useEvent('focus-chat', () => {
    setTab('assist');
    if (modeRef.current === 'capsule') expand();
    setTimeout(() => document.getElementById('chat-input')?.focus(), 50);
  });
  useEvent<{ me: number; them: number }>('levels', (e) => setLevels(e.payload));
  useEvent<SttStatus>('stt-status', (e) => setStt((s) => ({ ...s, [e.payload.channel]: e.payload })));
  useEvent<{ detected: boolean }>('echo', (e) => setEcho(e.payload.detected));
  useEvent<ServerStatus>('server-status', (e) => setServer(e.payload));
  useEvent<{ error: string | null }>('audio-status', (e) => setAudioErr(e.payload.error));
  useEvent<{ at_ms: number }>('mark', () => flash(t('Marked ★')));
  useEvent<TranscriptEvt>('transcript', (e) => {
    const ev = e.payload;
    if (!ev.final) return setPartial((p) => ({ ...p, [ev.channel]: ev.text }));
    setSegs((s) => [...s, ev].sort((a, b) => a.start_ms - b.start_ms));
    if (ev.channel !== 'me' && ev.text.includes('?') && settings?.hints_enabled && settings.hints_on_question) {
      clearTimeout(hs.current.timer || undefined);
      hs.current.timer = setTimeout(() => runHint(ev.id), 1200); // let the rest of the question arrive
    }
  });

  // resize by dragging: keep the 2:3 shape, scale the machine, remember the width
  useEffect(() => {
    const scale = () => (document.documentElement.style.zoom = String(innerWidth / BASE_W));
    scale();
    let t0: ReturnType<typeof setTimeout>;
    const onResize = () => {
      scale();
      if (modeRef.current === 'capsule') return;
      clearTimeout(t0);
      t0 = setTimeout(() => {
        const w = Math.min(660, Math.max(300, Math.round(innerWidth)));
        localStorage.setItem('kazetix.overlay.w', String(w));
        if (Math.abs(innerHeight - w * 1.5) > 2) win.setSize(new LogicalSize(w, Math.round(w * 1.5)));
      }, 250);
    };
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, []);

  // remember the expanded overlay position
  useEffect(() => {
    let t0: ReturnType<typeof setTimeout>;
    const un = win.onMoved(({ payload }) => {
      clearTimeout(t0);
      t0 = setTimeout(async () => {
        if (modeRef.current !== 'expanded' || !(await win.isVisible())) return;
        const k = await win.scaleFactor();
        updateSettings({ overlay_pos: [Math.round(payload.x / k), Math.round(payload.y / k)] });
      }, 600);
    });
    return () => void un.then((f) => f());
  }, []);

  const flash = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 1500);
  };

  async function runHint(segId?: string, manual = false) {
    if (hs.current.busy) {
      if (segId || manual) hs.current.again = { segId, manual }; // a question must not be lost behind an interval hint
      return;
    }
    if (!settings || (!settings.hints_enabled && !manual) || (!segsRef.current.length && !prepRef.current)) return;
    hs.current.busy = true;
    hs.current.lastAt = Date.now();
    hs.current.lastCount = segsRef.current.length;
    setHintBusy(true);
    try {
      const h = await hint(settings.hints_model, segsRef.current, rolling.current, asksRef.current.map((a) => a.q), prepRef.current, pointsRef.current);
      if (prepRef.current && h.prep_points.length) setPoints(h.prep_points);
      const card: Card = { id: uid(), at_ms: segsRef.current.at(-1)?.end_ms ?? 0, segId, hint: h, fresh: true, created: Date.now() };
      setCards((c) => [card, ...c].slice(0, 50)); // only the newest is shown; the rest back the transcript's question links
      setNowId(card.id);
      // the model returns the whole list: asked, answered and outdated questions are gone, kept ones keep their age
      setAsks((prev) => h.follow_up_questions.filter((q) => !dismissed.current.has(q)).slice(0, 3).map((q) => prev.find((a) => a.q === q) ?? { q, added: Date.now() }));
      setHintErr(null);
      api.saveHint(card.id, card.at_ms, h);
      if (modeRef.current === 'capsule' && !flipRef.current) {
        // the flipped-out display already shows the hint; otherwise it slides out under the capsule for a while
        setPopup(card);
        placeWindow('capsule', HINT_H, null);
        setTimeout(() => {
          setPopup((p) => (p?.id === card.id ? null : p));
          if (modeRef.current === 'capsule' && !flipRef.current) placeWindow('capsule', 0, null);
        }, 12_000);
      }
    } catch (e) {
      setHintErr(String(e instanceof Error ? e.message : e));
    } finally {
      hs.current.busy = false;
      setHintBusy(false);
      const again = hs.current.again;
      hs.current.again = null;
      if (again) runHint(again.segId, again.manual);
    }
  }

  // interval hints + rolling summary
  useEffect(() => {
    if (!snap.active || !settings) return;
    const iv = setInterval(() => {
      const fresh = segsRef.current.length > hs.current.lastCount;
      if (settings.hints_enabled && fresh && Date.now() - hs.current.lastAt >= settings.hints_interval_s * 1000) runHint();
    }, 1000);
    const rv = setInterval(async () => {
      const r = await updateRolling(settings.hints_model, segsRef.current, rolling.current).catch(() => null);
      if (r) rolling.current = r;
    }, 60_000);
    return () => {
      clearInterval(iv);
      clearInterval(rv);
    };
  }, [snap.active, settings?.hints_enabled, settings?.hints_interval_s, settings?.hints_model]); // not the whole object: an overlay drag saves settings

  useEffect(() => {
    if (tab === 'assist') setCards((c) => (c.some((x) => x.fresh) ? c.map((x) => ({ ...x, fresh: false })) : c));
  }, [tab, cards.length]);

  const setPrep = (p: Prep | null) => {
    setPrepState(p);
    prepRef.current = p;
    setPoints([]);
    keepActivePrep(snapRef.current.meeting_id, p);
    if (p) runHint(undefined, true);
  };

  const collapse = () => {
    setMode('capsule');
    placeWindow('capsule', flipRef.current ? FLIP_H : 0, null);
  };
  function expand() {
    setMode('expanded');
    setPopup(null);
    placeWindow('expanded', 0, settings?.overlay_pos ?? null);
  }

  const elapsed = (snap.elapsed_ms ?? 0) + (snap.active ? now - snapAt : 0);
  const freshCount = cards.filter((c) => c.fresh).length;
  const sttDown = Object.values(stt).find((s) => s.state === 'down');
  const lang = snap.language ?? settings?.language ?? 'cs';

  if (!snap.active) {
    return (
      <div className="housing" data-tauri-drag-region>
        <div className="hw hw-counter"><Counter ms={0} tag="STOP" /></div>
        <button className="hw key hw-close" aria-label={t('Close')} onClick={() => win.hide()}><KeyIcon kind="close" /></button>
        <button className="hw key hw-end rec" onClick={() => api.showStart()}>REC</button>
        <div className="hw hw-lcd lcd">
          <div className="lcd-head" data-tauri-drag-region><b>Kazetix</b><span>{t('Not recording')}</span></div>
          <div className="scroll">
            <div className="empty" style={{ padding: '18px 6px 12px' }}>
              <p>{t('Press REC to start recording')} · {settings?.shortcuts.record}</p>
            </div>
            <div className="section">
              <span className="label" style={{ color: 'var(--lcd-ink)' }}>{t('Prep for the next call')}</span>
              <PrepBox prep={nextPrep} onChange={setPrepSlot} hint={nextPrep ? t('Used when the next call starts.') : t('Drop or paste a .md file or text made in Claude or ChatGPT. Kazetix follows it during the call and tells you what has not come up yet.')} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'capsule') {
    return (
      <div>
        <div className="capsule" data-tauri-drag-region>
          <div className="cap-face" data-tauri-drag-region>
          <div className="cap-tray" data-tauri-drag-region>
          <span className="rec-dot" />
          <button className="cap-window" title={t('Expand overlay')} aria-label={t('Expand overlay')} onClick={expand}>
            <Counter ms={elapsed} />
            <span className="cap-sep" aria-hidden="true" />
            <div className="meters" aria-hidden="true"><Meter level={levels.me} color="#7cc0ff" /><Meter level={levels.them} color="#ffb04a" /></div>
          </button>
          <span className="spacer" data-tauri-drag-region />
          <button className="cap-key" onClick={() => { expand(); setTab('assist'); }}>
            <span className={`lamp ${freshCount > 0 ? 'on' : ''}`} />{t('Assist')}{freshCount > 0 && <span className="badge">{freshCount}</span>}
          </button>
          <button className="cap-key icon" aria-label={t('Flip out the display')} title={t('Flip out the display')} aria-pressed={flip}
            onClick={() => { const v = !flip; setFlip(v); setPopup(null); placeWindow('capsule', v ? FLIP_H : 0, null); }}><KeyIcon kind="flip" /></button>
          <button className="cap-key red" onClick={() => api.stop()}>{t('End')}</button>
          </div>
          </div>
        </div>
        {flip && <FlipDisplay segs={segs} card={cards.find((c) => c.id === nowId) ?? null} />}
        {popup && !flip && (
          <div className="card hl capsule-hint">
            <div className="card-head"><span className="label">{t('Question')} · {mmss(popup.at_ms)}</span></div>
            <div className="card-body">
              {popup.hint.question && <div className="q">„{popup.hint.question}“</div>}
              <div className="a">{popup.hint.answer_hint}</div>
              <span className="note">{settings?.shortcuts.overlay} — {t('Expand overlay')}</span>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="housing" data-tauri-drag-region>
      <span className="hw hw-led" />
      <div className="hw hw-counter"><Counter ms={elapsed} tag="REC" /></div>
      <button className={`hw key hw-pin`} aria-label={t('Pin on top')} aria-pressed={pinned} onClick={() => { setPinned(!pinned); win.setAlwaysOnTop(!pinned); }}><KeyIcon kind="pin" /></button>
      <button className="hw key hw-min" aria-label={t('Collapse to capsule')} onClick={collapse}><KeyIcon kind="min" /></button>

      <div role="tablist" style={{ display: 'contents' }}>
        {(['transcript', 'assist'] as Tab[]).map((k, i) => (
          <button key={k} className={`hw key hw-tab hw-tab${i + 1}`} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            <span className="lamp" />{t(k === 'transcript' ? 'Transcript' : 'Assist')}
            {k === 'assist' && freshCount > 0 && <span className="badge">{freshCount}</span>}
          </button>
        ))}
      </div>

      <div className="hw hw-lcd lcd ov-body">
      <div className="lcd-head" data-tauri-drag-region>
        <b>{snap.title}</b>
        <span>{[platformName(snap.platform), t('Hidden'), `${sttDown ? '…' : t('live')} · ${lang}`].filter(Boolean).join(' · ')}</span>
      </div>
      {sttDown && (
        <div className="banner" role="status">
          <b>{t('Live transcription interrupted')}</b>
          <p>{t('Recording continues. The missing part is filled in from the exact transcript after the call.')}</p>
          <p className="mono">{sttDown.detail ? `${sttDown.detail.slice(0, 120)} · ` : ''}{t('Retrying with the next sentence.')}</p>
        </div>
      )}
      {echo && !echoDismissed && (
        <div className="banner amber" role="status">
          <b>{t('Transcript is doubling')}</b>
          <p>{t('The microphone picks up your speakers. Put on headphones or mute the microphone channel.')}</p>
          <div className="row">
            <button className="btn btn-secondary btn-sm" onClick={() => setEchoDismissed(true)}>{t('Got it')}</button>
            <button className="btn btn-secondary btn-sm" onClick={() => api.openSettings('audio')}>{t('Audio settings')}</button>
          </div>
        </div>
      )}
      {server && !server.ok && (
        <div className="banner" role="status">
          <b>{t('Server unavailable')}</b>
          <p>{server.error}</p>
          <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => api.openSettings('server')}>{t('Open settings')}</button>
        </div>
      )}
      {audioErr && (
        <div className="banner" role="status"><b>{t('Audio problem')}</b><p>{audioErr}</p></div>
      )}

        {tab === 'transcript' && (
          <TranscriptView segs={segs} partial={partial} cards={cards} onQuestion={(segId) => {
            const c = cards.find((x) => x.segId === segId);
            setTab('assist');
            if (c) setNowId(c.id);
            else runHint(segId, true);
          }} />
        )}
        <div style={{ display: tab === 'assist' ? 'contents' : 'none' }}>
          <NowPanel card={cards.find((c) => c.id === nowId) ?? null} asks={asks} prep={prep} points={points} onPrep={setPrep} now={now} busy={hintBusy} error={hintErr} auto={!!settings?.hints_enabled}
            interval={settings?.hints_interval_s ?? 25} onQuestion={!!settings?.hints_on_question} onRefresh={() => runHint(undefined, true)} onHide={() => setNowId(null)}
            onDismiss={(q) => { dismissed.current.add(q); setAsks((a) => a.filter((x) => x.q !== q)); }} onCopied={() => flash(t('Copied'))} />
          <ChatView key={snap?.meeting_id} segs={segs} rolling={rolling} prep={prep} model={settings?.chat_model ?? ''} shortcut={settings?.shortcuts.chat ?? ''} onCite={(ms) => {
          setTab('transcript');
          setTimeout(() => {
            const el = [...document.querySelectorAll<HTMLElement>('[data-ms]')].find((e) => Number(e.dataset.ms) >= ms - 999);
            el?.scrollIntoView({ block: 'center' });
          }, 50);
        }} /></div>
        {toastMsg && <div className="latest" role="status">{toastMsg}</div>}
      </div>

      <div className="hw hw-meters" title={`${t('Me')} / ${t('Others')}`}>
        <Meter level={levels.me} color="#7cc0ff" />
        <Meter level={levels.them} color="#ffb04a" />
      </div>
      <span className="hw hw-live" aria-hidden="true"><span className={`lamp ${sttDown ? 'amber' : 'on'}`} /></span>
      <button className="hw key hw-end" onClick={() => api.stop()}>{t('End')}</button>
    </div>
  );
}

/** The display flipped out of the capsule on a hinge: the latest lines and the current hint, read at a glance. */
function FlipDisplay({ segs, card }: { segs: Segment[]; card: Card | null }) {
  return (
    <div className="flip">
      <span className="flip-hinge" aria-hidden="true" />
      <div className="flip-body">
        <div className="lcd flip-lcd">
          {card && (
            <div className="flip-hint">
              <span className="label">{card.hint.question ? t('Question') : t('Say next')} · {mmss(card.at_ms)}</span>
              <p>{card.hint.answer_hint}</p>
            </div>
          )}
          {segs.slice(card ? -2 : -4).map((s) => (
            <p key={s.id} className="flip-line"><b style={{ color: s.channel === 'me' ? 'var(--me)' : 'var(--them)' }}>{speaker(s.channel)}</b> {s.text}</p>
          ))}
          {!segs.length && !card && <p className="flip-line">{t('Waiting for speech…')}</p>}
        </div>
      </div>
    </div>
  );
}

function TranscriptView({ segs, partial, cards, onQuestion }: { segs: Segment[]; partial: Record<string, string>; cards: Card[]; onQuestion: (segId: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const partials = Object.entries(partial).filter(([, v]) => v);
  useLayoutEffect(() => {
    if (stuck && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [segs.length, partial, stuck]);
  return (
    <>
      <div className="scroll" ref={ref} onScroll={(e) => {
        const el = e.currentTarget;
        setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
      }}>
        {!segs.length && !partials.length && <div className="empty">{t('Waiting for speech…')}</div>}
        {segs.map((s) => (
          <div className="line" key={s.id} data-ms={s.start_ms}>
            <span className="time">{mmss(s.start_ms)}</span>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
              <span className="who" style={{ color: s.channel === 'me' ? 'var(--me)' : 'var(--them)' }}>{speaker(s.channel)}</span>
              <span className="text">{s.text}</span>
              {s.channel !== 'me' && s.text.includes('?') && (
                <button className="q-link" onClick={() => onQuestion(s.id)}>{t('Question · suggested answer →')}</button>
              )}
            </div>
          </div>
        ))}
        {partials.map(([ch, text]) => (
          <div className="line partial" key={`p-${ch}`}>
            <span className="time">··</span>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span className="who" style={{ color: ch === 'me' ? 'var(--me)' : 'var(--them)' }}>{speaker(ch)} {ch === 'me' && <span style={{ color: 'var(--lcd-ink-2)' }}>· {t('speaking')}</span>}</span>
              <span className="text">{text}<span className="caret" /></span>
            </div>
          </div>
        ))}
      </div>
      {!stuck && <button className="latest" onClick={() => setStuck(true)}>↓ {t('Latest')}</button>}
    </>
  );
}

/** Top of the Assist tab: only the current hint and the up-to-3 questions worth asking now. */
function NowPanel(p: { card: Card | null; asks: Ask[]; prep: Prep | null; points: Hint['prep_points']; onPrep: (p: Prep | null) => void; now: number; busy: boolean; error: string | null; auto: boolean; interval: number; onQuestion: boolean; onRefresh: () => void; onHide: () => void; onDismiss: (q: string) => void; onCopied: () => void }) {
  const cp = async (s: string) => {
    await copy(s);
    p.onCopied();
  };
  const c = p.card;
  const when = !p.auto ? t('Automatic hints are off') : p.onQuestion ? t('On questions and every {n} s', { n: p.interval }) : t('Every {n} s', { n: p.interval });
  return (
    <div className="assist-top">
      {!c && (
        <div className="row" style={{ paddingTop: 4 }}>
          <span className="note">{when}</span>
          <button className="btn btn-secondary btn-sm spacer" onClick={p.onRefresh} disabled={p.busy}>{p.busy ? t('Thinking…') : t('Refresh')}</button>
        </div>
      )}
      {p.error && <div className="banner" style={{ margin: '8px 0 0' }}><p>{p.error}</p></div>}
      {!c && !p.asks.length && !p.busy && !p.prep && <p className="note" style={{ margin: '8px 0 0' }}>{t('Hints appear when the others ask a question or every few seconds of new speech.')}</p>}
      {c && (
        <div className={`card ${c.hint.question ? 'hl' : ''}`}>
          <div className="card-head">
            <span className="label">{c.hint.question ? t('Question') : t('Say next')} · {mmss(c.at_ms)}{p.now - c.created < NEW_MS ? ` · ${t('new')}` : ''}</span>
            <button className="icon-btn spacer" aria-label={t('Refresh')} title={`${t('Refresh')} · ${when}`} disabled={p.busy} onClick={p.onRefresh}>
              <span style={{ display: 'inline-flex', animation: p.busy ? 'spin 0.9s linear infinite' : undefined }}>{Icon.refresh}</span>
            </button>
            <button className="icon-btn" aria-label={t('Copy')} title={t('Copy')} onClick={() => cp(c.hint.answer_hint)}>{Icon.copy}</button>
            <button className="icon-btn" aria-label={t('Hide')} title={t('Hide')} onClick={p.onHide}><XIcon /></button>
          </div>
          <div className="card-body">
            {c.hint.question && <div className="q">„{c.hint.question}“</div>}
            <div className="a">{c.hint.answer_hint}</div>
          </div>
        </div>
      )}
      {p.asks.length > 0 && (
        <div className="card">
          <div className="card-head"><span className="label">{t('Ask next')}</span></div>
          <div className="card-body" style={{ gap: 0, padding: '4px 4px 4px 6px' }}>
            {p.asks.map((a) => (
              <div key={a.q} className="ask">
                <button className={`item ${p.now - a.added < NEW_MS ? 'new' : ''}`} title={t('Copy')} onClick={() => cp(a.q)}><span>{a.q}</span></button>
                <button className="icon-btn" aria-label={t('Dismiss')} title={t('Dismiss')} onClick={() => p.onDismiss(a.q)}><XIcon /></button>
              </div>
            ))}
          </div>
        </div>
      )}
      {p.prep && p.points.length > 0 && (
        <div className="card">
          <div className="card-head"><span className="label">{t('From your prep')} · {t('{a} of {b} covered', { a: p.points.filter((x) => x.covered).length, b: p.points.length })}</span></div>
          <div className="card-body" style={{ gap: 0 }}>
            {p.points.map((x) => <div key={x.point} className={`check ${x.covered ? 'done' : ''}`}>{x.point}</div>)}
          </div>
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <PrepBox prep={p.prep} onChange={p.onPrep} hint={p.prep && !p.points.length ? t('Reading your prep…') : t('Prep')} />
      </div>
    </div>
  );
}

// Chat shortcuts: the label is shown in the chat, the prompt goes to the model (it answers in the call's language).
const PRESETS = [
  { label: 'Make me sound smart', prompt: 'Give me one or two sentences I can say right now that make me sound sharp on the current topic: a precise insight, a relevant fact or number, or a smart reframing. Build on what was actually said. Write them in first person, ready to say out loud, no preamble.' },
  { label: 'What should I ask?', prompt: 'What are the 3 best questions I could ask right now to move the conversation forward? Most important first, one line each, no preamble.' },
  { label: 'Recap', prompt: 'Recap the call so far in 3-5 short bullets: key points, decisions, open items.' },
  { label: 'Fact-check', prompt: 'Check the factual claims made in the last few minutes. Briefly list anything that looks wrong or doubtful and why. If everything checks out, say so in one line.' },
];
type ChatMsg = Msg & { label?: string };

function ChatView({ segs, rolling, prep, model, shortcut, onCite }: { segs: Segment[]; rolling: React.RefObject<Rolling>; prep: Prep | null; model: string; shortcut: string; onCite: (ms: number) => void }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<'all' | 'recent'>('all');
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [msgs]);

  const send = async (q = input.trim(), label?: string) => {
    if (!q || busy) return;
    if (!label) setInput('');
    const history: ChatMsg[] = [...msgs, { role: 'user', content: q, label }];
    setMsgs([...history, { role: 'assistant', content: '' }]);
    setBusy(true);
    try {
      const plain = history.map(({ role, content }) => ({ role, content }));
      await chat(model, segs, rolling.current, plain, scope, prep, (text) => setMsgs([...history, { role: 'assistant', content: text }]));
    } catch (e) {
      setMsgs([...history, { role: 'assistant', content: `⚠ ${e instanceof Error ? e.message : e}` }]);
    } finally {
      setBusy(false);
    }
  };

  const render = (text: string) =>
    text.split(/(\[\d{1,2}:\d{2}(?::\d{2})?\])/g).map((part, i) => {
      const m = /^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]$/.exec(part);
      if (!m) return part;
      const ms = (m[3] ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) : (+m[1] * 60 + +m[2])) * 1000;
      return <button key={i} className="cite" onClick={() => onCite(ms)}>{part.slice(1, -1)}</button>;
    });

  return (
    <>
      <div className="scroll" ref={ref} style={{ display: 'flex', flexDirection: 'column' }}>
        {!msgs.length && <div className="empty" style={{ padding: '10px 12px' }}>{t('Ask anything about what was said so far.')}</div>}
        {msgs.map((m, i) => m.role === 'user'
          ? <div key={i} className="msg-user">{m.label ? t(m.label) : m.content}</div>
          : <div key={i} className="msg-ai">{m.content ? render(m.content) : <span className="muted">{t('Thinking…')}</span>}</div>)}
      </div>
      <div className="presets">
        {PRESETS.map((x) => <button key={x.label} className="chip" disabled={busy} onClick={() => send(x.prompt, x.label)}>{t(x.label)}</button>)}
      </div>
      <div className="chat-box">
        <input id="chat-input" className="input" placeholder={t('Ask about the call…')} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
        <button className="btn" onClick={() => send()} disabled={busy || !input.trim()}>{t('Send')}</button>
      </div>
      <div className="chat-meta">
        <span>{scope === 'all' ? t('Context: whole call') : t('Context: last 10 min')} · <button className="linkish" onClick={() => setScope(scope === 'all' ? 'recent' : 'all')}>{t('Change')}</button></span>
        <span className="mono">{shortcut}</span>
      </div>
    </>
  );
}
