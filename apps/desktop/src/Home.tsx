import { useEffect, useState } from 'react';
import { api, copy, platformName, t, type MeetingView, type Settings } from './lib';
import './home.css';

type Overview = {
  source: 'local' | 'server';
  stats: { calls: number; calls_month: number; hours: number; words: number; open_items: number } | null;
  activity: { day: string; count: number }[];
  platforms: Record<string, number>;
  recent: MeetingView[];
};

const PLATFORMS = ['teams', 'meet', 'zoom', 'other'];
const lit = (n: number) => (n === 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : 3);
const dur = (s?: number | null) => (!s ? '' : s >= 3600 ? `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')} min` : `${Math.max(1, Math.round(s / 60))} min`);
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function dayLabel(day: string) {
  const now = new Date();
  if (day === ymd(now)) return t('Today');
  if (day === ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return t('Yesterday');
  const d = new Date(`${day}T12:00:00`);
  return d.toLocaleDateString(t('en-GB'), { weekday: 'long', day: 'numeric', month: 'long' });
}

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div className="home-stat">
      <b data-ghost={n.replace(/\d/g, '8')}>{n}</b>
      <i>{label}</i>
    </div>
  );
}

function Call({ m }: { m: MeetingView }) {
  const [open, setOpen] = useState(false);
  const key = m.summary?.key_points ?? [];
  const items = m.action_items ?? [];
  const lamp = m.status === 'done' ? 'on' : m.status === 'error' ? 'red' : 'amber';
  const status = m.status === 'done' ? t('Done') : m.status === 'error' ? t('Error') : t('Transcribing');
  return (
    <li className="home-call">
      <button className="home-call-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`lamp ${lamp}`} title={status} />
        <span className="home-call-main">
          <b>{m.title}</b>
          <span className="note">{[m.started_at.slice(11, 16), platformName(m.platform), dur(m.duration_s), status].filter(Boolean).join(' · ')}</span>
          {key[0] && <span className="home-call-point">{key[0]}</span>}
        </span>
        {items.length > 0 && <span className="chip">{t('{n} to do', { n: items.length })}</span>}
      </button>
      {open && (
        <div className="home-call-body">
          {key.length > 0 && <><span className="label">{t('Summary')}</span><ul>{key.map((k, i) => <li key={i}>{k}</li>)}</ul></>}
          {items.length > 0 && <><span className="label">{t('Action items')}</span><ul>{items.map((a) => <li key={a.id} className={a.done ? 'done' : ''}>{a.text}{a.owner ? <span className="note"> — {a.owner}</span> : null}</li>)}</ul></>}
          {!key.length && !items.length && <p className="note">{t('No summary yet.')}</p>}
          <div className="home-actions">
            {key.length > 0 && <button className="btn" onClick={() => void copy(m.summary?.markdown || key.map((k) => `- ${k}`).join('\n'))}>{t('Copy summary')}</button>}
            {items.length > 0 && <button className="btn" onClick={() => void copy(items.map((a) => `- [${a.done ? 'x' : ' '}] ${a.text}${a.owner ? ` (${a.owner})` : ''}`).join('\n'))}>{t('Copy action items')}</button>}
          </div>
        </div>
      )}
    </li>
  );
}

export default function Home({ s }: { s: Settings }) {
  const [o, setO] = useState<Overview | null>(null);
  useEffect(() => void api.homeOverview().then(setO), []);
  if (!o) return <h1>{t('Home')}</h1>;
  const days = [...new Set(o.recent.map((m) => m.started_at.slice(0, 10)))];
  const max = Math.max(1, ...PLATFORMS.map((p) => o.platforms[p] ?? 0));
  return (
    <>
      <h1>{t('Home')}</h1>
      {o.stats && (
        <div className="home-lcd">
          <Stat n={String(o.stats.calls_month)} label={t('Calls this month')} />
          <Stat n={o.stats.hours.toFixed(1)} label={t('Hours recorded')} />
          <Stat n={String(o.stats.words)} label={t('Words transcribed')} />
          <Stat n={String(o.stats.open_items)} label={t('Open action items')} />
        </div>
      )}
      {o.source === 'server' || s.storage === 'server' ? (
        <p className="note">{t('Your calls are stored on your server. Read them from Claude through MCP; this overview shows calls kept on this PC.')}</p>
      ) : o.recent.length === 0 ? (
        <p className="note">{t('No calls yet. Calls appear here after you record one: start from the tray icon or when Kazetix offers to record a Teams, Meet or Zoom call.')}</p>
      ) : (
        <>
          <div className="home-two">
            <div className="section">
              <span className="label">{t('Last 5 weeks')}</span>
              <div className="home-grid">
                {o.activity.map((d) => <span key={d.day} className="home-led" data-lit={lit(d.count)} title={`${d.day}: ${d.count}`} />)}
              </div>
            </div>
            <div className="section">
              <span className="label">{t('Top platforms')}</span>
              <ul className="home-top">
                {PLATFORMS.map((p) => (
                  <li key={p}><span>{p === 'other' ? t('Other') : platformName(p)}</span><span className="home-bar"><i style={{ width: `${((o.platforms[p] ?? 0) / max) * 100}%` }} /></span><b>{o.platforms[p] ?? 0}</b></li>
                ))}
              </ul>
            </div>
          </div>
          <div className="section">
            <span className="label">{t('Recent calls')}</span>
            {days.map((day) => (
              <div key={day} className="home-day">
                <span className="note">{dayLabel(day)}</span>
                <ul>{o.recent.filter((m) => m.started_at.startsWith(day)).map((m) => <Call key={m.id} m={m} />)}</ul>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
