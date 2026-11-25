// Browser stand-in for the Tauri API so the real UI renders with demo data (landing-page screenshots, design review).
// Run: pnpm --filter @kazetix/desktop demo, then open e.g. /?w=overlay&s=assist&lang=cs&plastic=black
// ponytail: one mock for core/event/window; it only answers the calls the UI makes.
const q = new URLSearchParams(location.search);
const W = q.get('w') ?? 'overlay'; // overlay | toast | settings
const S = q.get('s') ?? ''; // overlay: idle | transcript | assist | chat | capsule; toast: start | processing | done; settings: page
const CS = q.get('lang') === 'cs';
localStorage.setItem('kazetix.plastic', q.get('plastic') ?? 'beige');
localStorage.setItem('kazetix.skin', q.get('skin') ?? 'original');


const PREP_MD = CS
  ? '# Příprava: Acme — týdenní sync\n\n## Cíl\nDomluvit rozsah první verze a termín pátek.\n\n## Body\n- Potvrdit rozsah první verze\n- Termín: pátek 28. 11.\n- Cena: 120 000 Kč za první fázi\n- Zeptat se na rozpočet na fázi 2\n- Kdo u nich schvaluje design\n'
  : '# Prep: Acme weekly sync\n\n## Goal\nAgree the scope of the first version and a Friday deadline.\n\n## Points\n- Confirm the first-version scope\n- Deadline: Friday, Nov 28\n- Price: €4,800 for phase one\n- Ask about the phase-two budget\n- Who signs off the design on their side\n';
if (W === 'overlay' && S !== 'idle' && q.get('prep') !== '0') localStorage.setItem('kazetix.prep', JSON.stringify({ name: CS ? 'acme-priprava.md' : 'acme-prep.md', text: PREP_MD }));
else if (W === 'toast' && (S === 'start' || S === 'auto')) localStorage.setItem('kazetix.prep', JSON.stringify({ name: CS ? 'acme-priprava.md' : 'acme-prep.md', text: PREP_MD }));
else localStorage.removeItem('kazetix.prep');
localStorage.removeItem('kazetix.prep.active');

const lines: [string, number, string][] = CS
  ? [
      ['them', 4, 'Dobrý den, tak jsme všichni. Dneska bych rád probral tu první verzi.'],
      ['me', 9, 'Jasně. Poslal jsem včera návrh rozsahu, máte ho před sebou?'],
      ['them', 16, 'Máme. Ten import dat je pro nás klíčový, ten tam musí být.'],
      ['me', 24, 'Import je v rozsahu, počítáme s ním hned v první fázi.'],
      ['them', 33, 'Výborně. A stihli byste první verzi do pátku?'],
      ['me', 40, 'Pátek je reálný, pokud dnes uzavřeme rozsah.'],
      ['them', 49, 'Dobře. Kolik by stála ta první fáze?'],
    ]
  : [
      ['them', 4, "Hi everyone, looks like we're all here. I'd like to go over the first version today."],
      ['me', 9, 'Sure. I sent the scope proposal yesterday, do you have it in front of you?'],
      ['them', 16, 'We do. The data import is key for us, that has to be in.'],
      ['me', 24, "Import is in scope, we're planning it for phase one."],
      ['them', 33, 'Great. And could you deliver the first version by Friday?'],
      ['me', 40, "Friday works if we close the scope today."],
      ['them', 49, 'Okay. How much would the first phase cost?'],
    ];
const segments = lines.map(([channel, s, text], i) => ({ id: `s${i}`, channel, start_ms: (12 * 60 + s) * 1000, end_ms: (12 * 60 + s + 5) * 1000, text }));
const session = { active: true, meeting_id: 'demo', title: CS ? 'Acme — týdenní sync' : 'Acme weekly sync', platform: 'teams', started_at: new Date().toISOString(), elapsed_ms: (13 * 60 + 2) * 1000, channels: 2, language: CS ? 'cs' : 'en', segments };

const hint = CS
  ? { question: 'Kolik by stála ta první fáze?', answer_hint: 'První fáze vychází na 120 000 Kč včetně importu dat; termín pátek platí, když dnes uzavřeme rozsah.', follow_up_questions: ['Jaký máte rozpočet na fázi 2?', 'Kdo u vás schvaluje design?'], missing_topics: [], prep_points: [{ point: 'Potvrdit rozsah první verze', covered: true }, { point: 'Termín: pátek 28. 11.', covered: true }, { point: 'Cena 120 000 Kč za první fázi', covered: false }, { point: 'Rozpočet na fázi 2', covered: false }, { point: 'Kdo schvaluje design', covered: false }] }
  : { question: 'How much would the first phase cost?', answer_hint: 'Phase one is €4,800 including the data import; Friday holds if we close the scope today.', follow_up_questions: ["What's your budget for phase two?", 'Who signs off the design on your side?'], missing_topics: [], prep_points: [{ point: 'Confirm the first-version scope', covered: true }, { point: 'Deadline: Friday, Nov 28', covered: true }, { point: 'Price: €4,800 for phase one', covered: false }, { point: 'Phase-two budget', covered: false }, { point: 'Who signs off the design', covered: false }] };
const realFetch = fetch;
window.fetch = async (url, init) => {
  if (String(url).includes('openrouter.ai')) {
    await new Promise((r) => setTimeout(r, 150));
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(hint) } }] }), { status: 200 });
  }
  return realFetch(url, init);
};

const settings = {
  ui_language: CS ? 'cs' : 'en', mic_device: null, output_device: null, live_model: 'elevenlabs/scribe-v2', channels: 2, final_transcript: true, store_live: false,
  language: CS ? 'cs' : 'en', server_url: 'https://kazetix.example.com', chat_model: 'anthropic/claude-sonnet-5.5', hints_model: 'google/gemini-3.8-flash',
  hints_enabled: true, hints_interval_s: 25, hints_on_question: true, autostart: true, overlay_default: S === 'capsule' ? 'capsule' : 'expanded',
  call_detect: true, call_autostart_s: 10,
  shortcuts: { record: 'Ctrl+Alt+Shift+R', overlay: 'Ctrl+Alt+Shift+O', chat: 'Ctrl+Alt+Shift+K', mark: 'Ctrl+Alt+Shift+M' }, overlay_pos: null,
};
const meeting = (status: string) => ({
  id: 'demo', title: session.title, started_at: session.started_at, ended_at: null, duration_s: 2460, platform: 'teams', channels: 2, status, progress: 62, audio_bytes: 18_400_000, error: null, speakers: 3,
  summary: { markdown: '', key_points: CS ? ['Rozsah první verze potvrzen včetně importu dat', 'Termín pátek 28. 11.', 'Cena fáze 1: 120 000 Kč'] : ['First-version scope confirmed, data import included', 'Deadline Friday, Nov 28', 'Phase one priced at €4,800'], decisions: [] },
  action_items: [{ id: 1, text: 'Send the final scope', owner: 'Me', due_date: null, done: false }, { id: 2, text: 'Share phase-two budget', owner: 'Acme', due_date: null, done: false }],
});

const homeCalls = (() => {
  const T: [number, string, string | null, number, string, string[], number][] = CS
    ? [[0, 'Acme — týdenní sync', 'teams', 41, 'done', ['Rozsah první verze potvrzen včetně importu dat', 'Termín pátek 28. 11.'], 2], [0, 'Konzultace s Novákem', 'meet', 18, 'transcribing', [], 0], [1, 'Plánování sprintu', 'teams', 55, 'done', ['Do sprintu jde import a export', 'Design schvaluje Eva'], 3], [1, 'Telefonát — Dodavatel s.r.o.', null, 9, 'done', ['Dodání posunuto na pondělí'], 1],
       [3, 'Demo pro klienta', 'zoom', 47, 'done', ['Klient chce přidat reporty'], 2], [4, 'Retro týmu', 'meet', 62, 'done', ['Zkrátit daily na 10 minut'], 1], [6, 'Onboarding nové kolegyně', 'teams', 85, 'done', ['Přístupy hotové do středy'], 0], [8, 'Cenová nabídka — Beta', 'zoom', 33, 'error', [], 0],
       [9, 'Acme — týdenní sync', 'teams', 38, 'done', ['Čekáme na podklady od Acme'], 2], [11, 'Product review', 'meet', 51, 'done', ['Priorita: import dat'], 1], [13, 'Schůzka s účetní', null, 27, 'done', ['Podklady do 5. v měsíci'], 2], [14, 'Plánování sprintu', 'teams', 58, 'done', ['Kapacita 32 bodů'], 1],
       [16, 'Hovor s investorem', 'zoom', 44, 'done', ['Další kolo v lednu'], 3], [18, 'Acme — týdenní sync', 'teams', 40, 'done', ['Rozsah v1 definován'], 1], [20, 'Workshop UX', 'meet', 96, 'done', ['Tři persony', 'Prototyp do konce měsíce'], 4], [22, 'Telefonát s Petrem', null, 12, 'done', ['Domluvena schůzka'], 0],
       [25, 'Plánování sprintu', 'teams', 52, 'done', ['Sprint 14 uzavřen'], 1], [27, 'Acme — kickoff', 'teams', 64, 'done', ['Kickoff proběhl, role rozdělené'], 3], [30, 'Retro týmu', 'meet', 49, 'done', ['Zlepšit code review'], 1], [33, 'Rozhovor s kandidátem', 'zoom', 41, 'done', ['Pozvat na druhé kolo'], 1]]
    : [[0, 'Acme weekly sync', 'teams', 41, 'done', ['First-version scope confirmed, data import included', 'Deadline Friday, Nov 28'], 2], [0, 'Call with Mr. Novak', 'meet', 18, 'transcribing', [], 0], [1, 'Sprint planning', 'teams', 55, 'done', ['Import and export go into the sprint', 'Eva signs off the design'], 3], [1, 'Phone call, Supplier Ltd.', null, 9, 'done', ['Delivery moved to Monday'], 1],
       [3, 'Client demo', 'zoom', 47, 'done', ['Client wants reports added'], 2], [4, 'Team retro', 'meet', 62, 'done', ['Cut the daily to 10 minutes'], 1], [6, 'New hire onboarding', 'teams', 85, 'done', ['Access sorted by Wednesday'], 0], [8, 'Beta pricing offer', 'zoom', 33, 'error', [], 0],
       [9, 'Acme weekly sync', 'teams', 38, 'done', ['Waiting for material from Acme'], 2], [11, 'Product review', 'meet', 51, 'done', ['Priority: data import'], 1], [13, 'Meeting with the accountant', null, 27, 'done', ['Documents by the 5th'], 2], [14, 'Sprint planning', 'teams', 58, 'done', ['Capacity 32 points'], 1],
       [16, 'Investor call', 'zoom', 44, 'done', ['Next round in January'], 3], [18, 'Acme weekly sync', 'teams', 40, 'done', ['v1 scope defined'], 1], [20, 'UX workshop', 'meet', 96, 'done', ['Three personas', 'Prototype by month end'], 4], [22, 'Call with Peter', null, 12, 'done', ['Meeting arranged'], 0],
       [25, 'Sprint planning', 'teams', 52, 'done', ['Sprint 14 closed'], 1], [27, 'Acme kickoff', 'teams', 64, 'done', ['Kickoff done, roles assigned'], 3], [30, 'Team retro', 'meet', 49, 'done', ['Improve code review'], 1], [33, 'Candidate interview', 'zoom', 41, 'done', ['Invite to second round'], 1]];
  return T.map(([ago, title, platform, min, status, kp, n], i) => {
    const d = new Date(Date.now() - ago * 864e5); d.setHours(16 - (i % 5) * 2, 30, 0, 0);
    const p = (x: number) => String(x).padStart(2, '0');
    const started_at = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00+01:00`;
    return { id: `h${i}`, title, started_at, ended_at: null, duration_s: min * 60, platform, channels: 2, status, progress: 100, audio_bytes: 0, error: null, speakers: 2,
      summary: kp.length ? { markdown: '', key_points: kp, decisions: [] } : null,
      action_items: Array.from({ length: n }, (_, k) => ({ id: i * 10 + k, text: CS ? ['Poslat finální rozsah', 'Domluvit další schůzku', 'Připravit nabídku', 'Ověřit rozpočet'][k % 4] : ['Send the final scope', 'Schedule the next meeting', 'Prepare the offer', 'Check the budget'][k % 4], owner: k % 2 ? (CS ? 'Acme' : 'Acme') : null, due_date: null, done: k === 2 })) };
  });
})();
const homeOverview = () => {
  const day = (m: { started_at: string }) => m.started_at.slice(0, 10);
  const platforms: Record<string, number> = {};
  for (const m of homeCalls) { const p = m.platform ?? 'other'; platforms[p] = (platforms[p] ?? 0) + 1; }
  const activity = Array.from({ length: 35 }, (_, i) => { const d = new Date(Date.now() - (34 - i) * 864e5); const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; return { day: k, count: homeCalls.filter((m) => day(m) === k).length }; });
  const month = new Date().toISOString().slice(0, 7);
  return { source: 'local', stats: { calls: homeCalls.length, calls_month: homeCalls.filter((m) => day(m).startsWith(month)).length, hours: homeCalls.reduce((a, m) => a + m.duration_s, 0) / 3600, words: 48210, open_items: 17 }, activity, platforms, recent: homeCalls };
};

const handlers: Record<string, (a: any) => unknown> = {
  get_settings: () => settings, save_settings: () => null, secret_status: () => ({ server_token: true, openrouter_key: true }), openrouter_key: () => 'demo',
  verify_server: () => ({ ok: true, version: '0.1.0', meetings: 148, openrouter: true }), server_status: () => ({ ok: true, error: null, pending: 0, pending_uploads: 0 }),
  list_devices: () => ({ inputs: ['Microphone (Jabra Evolve2 65)'], outputs: ['Headphones (Jabra Evolve2 65)'] }), log_path: () => 'C:\\Users\\you\\AppData\\Roaming\\cz.dpstudio.kazetix\\kazetix.log',
  session_snapshot: () => (W === 'overlay' && S === 'idle' ? { active: false } : session), save_hint: () => null, monitor_levels: () => null, shortcut_errors: () => [],
  toast_state: () => (S === 'start' || S === 'auto' ? { kind: 'start', title: session.title, platform: 'teams', ...(S === 'auto' ? { auto: true, mic_app: 'Microsoft Teams', countdown_s: 10 } : {}) } : { kind: 'processing', meeting_id: 'demo', title: session.title, platform: 'teams', duration_s: 2460, upload: true, segments }),
  home_overview: homeOverview,
  meeting_transcript: () => lines.map(([c, s, text]) => `[${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}] ${c === 'me' ? 'Me' : 'Others'}: ${text}`).join('\n'),
  meeting_status: () => meeting(S === 'done' ? 'done' : 'transcribing'),
};
export async function invoke(cmd: string, args?: unknown) {
  return handlers[cmd]?.(args) ?? null;
}

const subs: Record<string, ((e: { payload: unknown }) => void)[]> = {};
export async function listen(name: string, cb: (e: { payload: unknown }) => void) {
  (subs[name] ??= []).push(cb);
  return () => void (subs[name] = subs[name].filter((f) => f !== cb));
}
const emit = (name: string, payload: unknown) => subs[name]?.forEach((f) => f({ payload }));
export type EventCallback<T> = (e: { payload: T }) => void;

if (W === 'overlay' && S !== 'idle') {
  setTimeout(() => emit('session', session), 400); // a call starting: takes the prep and asks for the first hint
  setTimeout(() => {
    emit('transcript', { id: 'p', channel: 'me', start_ms: 0, end_ms: 0, text: CS ? 'První fáze vychází na sto dvacet' : 'Phase one comes to four thousand eight', final: false });
    if (S === 'assist' || S === 'chat') emit('focus-chat', null);
  }, 900);
  let k = 0;
  setInterval(() => emit('levels', { me: 0.35 + 0.3 * Math.abs(Math.sin(k)), them: 0.6 + 0.3 * Math.abs(Math.cos((k += 0.7))) }), 120);
}
if (W === 'settings' && S) setTimeout(() => emit('settings-page', S), 1200);

class Size { constructor(public width: number, public height: number) {} }
export const LogicalSize = Size;
export const LogicalPosition = Size;
const noop = async () => {};
export const getCurrentWindow = () => ({ label: W, setSize: noop, setPosition: noop, hide: noop, setAlwaysOnTop: noop, isVisible: async () => true, startResizeDragging: noop, scaleFactor: async () => 1, onMoved: async () => () => {} });
export const currentMonitor = async () => null;
export const primaryMonitor = async () => null;

// ?flip=1 opens the capsule's flip-out display (README screenshot)
if (q.get('flip') === '1') setTimeout(() => (document.querySelector('.cap-key.icon') as HTMLElement | null)?.click(), 1500);
