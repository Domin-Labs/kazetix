import { useRef, useState } from 'react';
import { kb, readPrepFile, t, type Prep } from './lib';

import logoInk from './assets/logo-ink.webp';
import logoCream from './assets/logo-cream.webp';

/** The Kazetix wordmark (italic with speed stripes); the cream print shows on black plastic. */
export const Brand = () => (
  <span className="logo-mark">
    <img className="ink" src={logoInk} alt="Kazetix" />
    <img className="cream" src={logoCream} alt="" />
  </span>
);

/** Corner-key glyphs, drawn at key size (the painted keys are ~44px). */
export const KeyIcon = ({ kind }: { kind: 'pin' | 'min' | 'close' | 'expand' }) => (
  <svg className="keyicon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'pin' && <><path d="M6 2.5h4l-.6 3.8L12 8.5v1H4v-1l2.6-2.2z" /><path d="M8 9.5v4" /></>}
    {kind === 'min' && <path d="M3.5 8h9" />}
    {kind === 'close' && <path d="M4 4l8 8M12 4l-8 8" />}
    {kind === 'expand' && <path d="M4 6l4 4 4-4" />}
  </svg>
);

export const XIcon = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
);

const Cassette = () => (
  <svg className="cassette" viewBox="0 0 30 20" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
    <rect x="0.6" y="0.6" width="28.8" height="18.8" rx="2" />
    <rect x="5" y="4" width="20" height="8" rx="4" />
    <circle cx="10" cy="8" r="2" />
    <circle cx="20" cy="8" r="2" />
    <path d="M7 19.4l2-4h12l2 4" />
  </svg>
);

/** The prep cassette slot: attach, replace or remove the .md prepared in Claude/ChatGPT. Accepts a dropped file too. */
export function PrepBox({ prep, onChange, hint }: { prep: Prep | null; onChange: (p: Prep | null) => void; hint: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const pasted = (text: string) => text.trim() && onChange({ name: t('Pasted notes'), text: text.trim() });
  const load = async (f?: File) => {
    if (!f) return;
    try {
      onChange(await readPrepFile(f));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  if (typing)
    return (
      <div className="prep" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <textarea className="input" autoFocus rows={6} style={{ height: 'auto', padding: 8, resize: 'vertical' }} value={draft} placeholder={t('Paste or type your prep notes…')} onChange={(e) => setDraft(e.target.value)} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-sm" onClick={() => setTyping(false)}>{t('Cancel')}</button>
          <button className="btn btn-sm" disabled={!draft.trim()} onClick={() => (pasted(draft), setTyping(false), setDraft(''))}>{t('Save')}</button>
        </div>
      </div>
    );
  return (
    <div
      className={`prep ${over ? 'drop' : ''}`}
      tabIndex={-1}
      onPaste={(e) => {
        const f = e.clipboardData.files[0];
        if (f) load(f);
        else pasted(e.clipboardData.getData('text'));
      }}
      onDragOver={(e) => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        load(e.dataTransfer.files[0]);
      }}
    >
      <Cassette />
      <div className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {prep ? <span className="name">{prep.name}</span> : <span className="label">{t('Prep')}</span>}
        <span className={`meta ${err ? 'status-bad' : ''}`}>{err ?? (prep ? `${kb(prep.text)} · ${hint}` : hint)}</span>
      </div>
      <input ref={input} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange={(e) => (load(e.target.files?.[0]), (e.target.value = ''))} />
      <button className="btn btn-sm" onClick={() => input.current?.click()}>{prep ? t('Replace') : t('File')}</button>
      {!prep && <button className="btn btn-sm" onClick={() => setTyping(true)}>{t('Text')}</button>}
      {prep && <button className="icon-btn" aria-label={t('Remove')} title={t('Remove')} onClick={() => onChange(null)}><XIcon /></button>}
    </div>
  );
}
