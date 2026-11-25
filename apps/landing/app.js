// Kazetix landing: CZ/EN, beige/black housing, hero screen switch, copy-the-prompt, the prep cassette.
const REPO = 'https://github.com/Domin-Labs/kazetix';
const PROMPT = {
  en: `Set up Kazetix for me by following ${REPO}/blob/main/INSTALL.md: install the Windows app, add my OpenRouter key and connect Claude to its built-in MCP. Ask me before each step that needs my keys.`,
  cs: `Nastav mi Kazetix podle návodu ${REPO}/blob/main/INSTALL.md: nainstaluj aplikaci pro Windows, přidej můj OpenRouter klíč a připoj Clauda k jejímu vestavěnému MCP. Před každým krokem, který potřebuje moje klíče, se mě zeptej.`,
};

// English is the source text in the HTML; Czech overrides by key (values may contain <br />).
const CS = {
  'faq.q8': 'Je to open source?',
  'faq.a8': 'Zdrojový kód je veřejný na GitHubu pod licencí Functional Source License (FSL-1.1). Kazetix můžete zdarma používat, číst a upravovat kód a provozovat ho pro sebe i pro svou firmu. Nesmíte ho prodávat ani nabízet jako konkurenční produkt. Dva roky po vydání přechází každá verze na Apache 2.0, běžnou open-source licenci.',
  'kzh.title': 'Všechny hovory na jeden pohled',
  'kzh.copy': 'Otevřete Kazetix a archiv máte hned před sebou: kolik jste tento měsíc navolali, co zůstává otevřené a každý nedávný hovor se souhrnem a úkoly, na jedno kliknutí ve schránce.',
  'kzh.t1': 'Hovory, hodiny, slova a otevřené úkoly na jednom displeji', 'kzh.t2': 'Pět týdnů aktivity a nejčastější aplikace', 'kzh.t3': 'Nedávné hovory se souhrnem a úkoly',
  'foot.by': 'Produkt DominLabs · dominlabs.cz',
  'works.label': 'Funguje s', 'works.more': 'a s každou aplikací, která používá mikrofon',
  'aria.theme': 'Přepnout plast', 'aria.skip': 'Přeskočit na obsah', 'aria.housing': 'Kryt', 'aria.screen': 'Obrazovka', 'aria.specs': 'Parametry',
  'nav.features': 'Funkce', 'nav.how': 'Jak to funguje', 'nav.plans': 'Plány',
  'plastic.beige': 'Béžový', 'plastic.black': 'Černý', 'view.transcript': 'Přepis', 'view.assist': 'Asistent',
  'cta.download': 'Stáhnout pro Windows', 'cta.prompt': 'Nastavit jedním promptem',
  'hero.catno': 'Kat. č. KZ-01 — Kazetix, záznamník hovorů',
  'hero.headline': 'Každý hovor<br />na pásku.',
  'hero.lead': 'Kazetix poslouchá obě strany hovoru, napoví odpověď, když vás někdo zaskočí otázkou, a pár minut po zavěšení máte hotový zápis.',
  'trust.free': 'Zdarma, zdrojový kód na GitHubu', 'trust.anyapp': 'Meet, Teams, Zoom i cokoli jiného', 'trust.nobot': 'Žádný bot ve schůzce', 'trust.server': 'Archiv zůstává ve vašem PC',
  'hero.c1': 'Obě strany živě', 'hero.c2': 'Odpověď, když se zeptají', 'hero.c3': 'Skryté při sdílení obrazovky', 'hero.c4': 'Stop a zápis se napíše sám',
  'spec.head': 'Technické údaje',
  'spec.channels': 'Kanály', 'spec.channelsV': '2 · Vy + Ostatní, odděleně', 'spec.live': 'Živý text', 'spec.liveV': '1–3 s po každé větě',
  'spec.prep': 'Příprava', 'spec.prepV': '.md soubor nebo text z Clauda či ChatGPT', 'spec.start': 'Začátek hovoru', 'spec.startV': 'Rozpozná se sám',
  'spec.server': 'Úložiště', 'spec.serverV': 'Ve vašem PC, nebo na vlastním serveru', 'spec.archive': 'Claude', 'spec.archiveV': 'Vestavěné MCP pro Claude Desktop i Code',
  'f.title': 'Od prvního zazvonění po poslední úkol',
  'kz02.title': 'Odpověď, ještě než dořeknou otázku',
  'kz02.copy': 'Když se vás ostatní na něco zeptají, Kazetix ukáže krátký návrh odpovědi z toho, co zaznělo, a z vaší přípravy. Vedle toho otázky, které stojí za to položit teď, a chat nad celým hovorem.',
  'kz02.t1': 'Návrh odpovědi na poslední otázku', 'kz02.t2': 'Až tři otázky, na které se zeptat', 'kz02.t3': '„Ať zním chytře“, shrnutí a ověření faktů na jedno kliknutí',
  'kz03.title': 'Přípravu vložíte jako kazetu',
  'kz03.copy': 'Připravte se v Claudovi nebo ChatGPT a vložte .md soubor, nebo jen text. Během hovoru z přípravy odpovídá a odškrtává body, které jste chtěli probrat, takže nic důležitého nezůstane nevyřčené.',
  'kz03.c1': 'Rozpočet probrán', 'kz03.c2': 'Termín: pátek', 'kz03.c3': 'Potvrdit další kroky',
  'kz04.title': 'Zápis hotový dřív, než začne další schůzka',
  'kz04.copy': 'Po zavěšení Kazetix vytvoří přesný přepis s mluvčími, souhrn a úkoly přímo ve vašem PC (nebo na vašem serveru), připravené ke zkopírování kamkoli.',
  'kz05.title': 'Malá přítomnost. Plná pozornost.',
  'kz05.copy': 'Sbalte overlay do proužku nahoře na obrazovce. Když se vás někdo zeptá, návrh odpovědi pod ním vyjede a zase zmizí.',
  'how.title': 'Čtyři kroky a pak už to jede samo',
  'how.s1': 'Instalace', 'how.s1c': 'Stáhněte aplikaci, nebo vložte jeden prompt do Clauda či ChatGPT a nechte je všechno nastavit.',
  'how.s2': 'Příprava', 'how.s2c': 'Volitelně: před hovorem vložte poznámky z Clauda nebo ChatGPT.',
  'how.s3': 'Volejte jako vždycky', 'how.s3c': 'Připojte se z jakékoli aplikace. Kazetix hovor pozná, nahraje ho a pomáhá přímo vedle něj.',
  'how.s4': 'Zeptejte se Clauda', 'how.s4c': 'Každý hovor skončí ve vašem archivu. Zeptejte se Clauda, co se dohodlo, kdo co dluží a do kdy.',
  'sh.title': 'Vaše hovory zůstávají vaše',
  'sh.lead': 'Nahrávky, přepisy i zápisy žijí ve vašem PC a Claude je čte přes vestavěné MCP. Zvuk jde jen do modelu pro přepis, přes váš vlastní OpenRouter klíč. Žádný bot ve schůzce a overlay se při sdílení obrazovky nikdy neukáže.',
  'sh.local': 'Vestavěné, ve vašem PC', 'sh.localCopy': 'Výchozí volba. Nahrávky, přepisy, souhrny i úkoly se ukládají ve vašem počítači. Kromě aplikace nic dalšího neinstalujete.',
  'sh.mcp': 'Claude na jedno kliknutí', 'sh.mcpCopy': 'Nastavení → Připojit Clauda přidá Kazetix do Claude Desktop. Pro Claude Code stačí jeden příkaz:',
  'sh.docker': 'Vlastní server, volitelně', 'sh.dockerCopy': 'Pro týmy a pro claude.ai na webu: spusťte server Kazetix z našeho GitHubu v Dockeru za vaší HTTPS a nasměrujte na něj aplikaci.',
  'group.before': 'Před hovorem', 'group.during': 'Během hovoru', 'group.after': 'Po hovoru',
  'kz04.replay': 'Vložit kazetu znovu',
  'kz06.title': 'Pozná hovor dřív než vy', 'kz06.copy': 'Jakmile Teams, Zoom nebo prohlížeč sáhne po mikrofonu, Kazetix nabídne nahrávání s předvyplněným názvem schůzky. Potvrďte jednou klávesou, nebo ho nechte začít samo po pár sekundách.',
  'kz06.t1': 'Funguje s každou aplikací, která používá mikrofon', 'kz06.t2': 'Název převezme z okna Teams, Meetu nebo Zoomu', 'kz06.t3': 'Pokaždé se zeptat, nebo začít samo po 5, 10 či 20 s',
  'plans.title': 'Dnes zdarma. Brzy ještě jednodušší.', 'plans.freeTag': 'K dispozici teď', 'plans.free': 'Zdarma, se zdrojovým kódem', 'plans.freePrice': 'Zdarma · vlastní klíče',
  'plans.f1': 'Vše z tohoto katalogu, na Windows 10 a 11', 'plans.f2': 'Archiv a MCP přímo v aplikaci, nebo vlastní server', 'plans.f3': 'OpenRouteru platíte přímo za to, co spotřebujete',
  'plans.cloudTag': 'Připravujeme', 'plans.cloudPrice': 'Přihlášení · předplatné', 'plans.c1': 'Žádné klíče: přihlásit se a nahrávat', 'plans.c2': 'Přepisy, souhrny a statistiky na webu',
  'plans.c3': 'Připojení Clauda přes MCP v nastavení', 'plans.join': 'Přidat se na waitlist',
  'wl.title': 'Buďte první na Macu i v Cloudu', 'wl.lead': 'Kazetix Cloud (přihlášení bez klíčů) i verze pro Mac jsou na cestě. Nechte nám e-mail a napíšeme jednou, až bude vaše volba hotová.',
  'wl.email': 'E-mail', 'wl.which': 'Chci', 'wl.mac': 'Verzi pro Mac', 'wl.submit': 'Přidat se na waitlist',
  'wl.fine': 'E-mail použijeme jen k oznámení těchto novinek. Stačí napsat a smažeme ho.',
  'wl.ok': 'Hotovo, ozveme se, až to bude venku.', 'wl.bad': 'Zkontrolujte e-mail a vyberte aspoň jednu možnost.', 'wl.fail': 'Nepodařilo se odeslat. Zkuste to prosím znovu za chvíli.',
  'faq.q7': 'Potřebuju server?', 'faq.a7': 'Ne. Archiv i MCP připojení pro Clauda jsou přímo v aplikaci. Server je jen pro týmy nebo pro claude.ai na webu.',
  'faq.title': 'Než se zeptáte',
  'faq.q1': 'Kolik to stojí?', 'faq.a1': 'Kazetix je zdarma. Platíte jen vlastní spotřebu na OpenRouteru: živý přepis se účtuje za rozpoznanou řeč, nejvýš asi 0,44 $ za hodinu se dvěma kanály; přesný přepis po hovoru přidá 0,22 $ za hodinu a kanál; nápovědy, chat a souhrny jsou běžné využití LLM.',
  'faq.q2': 'Připojí se do schůzky bot?', 'faq.a2': 'Ne. Kazetix nahrává váš mikrofon a zvuk počítače přímo u vás, takže funguje s jakoukoli aplikací a nikdo neuvidí účastníka navíc.',
  'faq.q3': 'Uvidí ho ostatní, když sdílím obrazovku?', 'faq.a3': 'Ne. Overlay i oznámení jsou ze snímání obrazovky vyřazené.',
  'faq.q4': 'Jaké jazyky?', 'faq.a4': 'Hovory v češtině, slovenštině, angličtině, němčině, polštině nebo s automatickou detekcí. Aplikace mluví česky a anglicky.',
  'faq.q5': 'Mac nebo Linux?', 'faq.a5': 'Dnes Windows 10 (verze 2004 a novější) a Windows 11. Verzi pro Mac připravujeme: zapište se na waitlist a dáme vědět, až bude hotová.',
  'faq.q6': 'Můžu se jen přihlásit místo klíče?', 'faq.a6': 'Brzy. Kazetix Cloud s přihlášením a předplatným připravujeme, zapište se na waitlist. Dnes jde všechna AI přes jeden OpenRouter klíč, který máte pod kontrolou.',
  'coupon.form': 'Objednací kupón · KZ-01', 'coupon.title': 'Instalace jedním promptem',
  'coupon.note': 'Vložte ho do Clauda nebo ChatGPT. Provede vás instalací aplikace, přidáním OpenRouter klíče i připojením Clauda a před vším, co potřebuje vaše klíče, se zeptá.',
  'coupon.copy': 'Kopírovat', 'coupon.copied': 'Zkopírováno', 'coupon.fine': 'Zdarma k používání. Váš počítač. Vaše hovory.',
  'foot.install': 'Návod k instalaci',
};

const root = document.documentElement;
const nodes = [...document.querySelectorAll('[data-i18n]')];
const EN = Object.fromEntries(nodes.map((n) => [n.dataset.i18n, n.innerHTML]));
const ariaEN = new Map([...document.querySelectorAll('[data-i18n-aria]')].map((n) => [n, n.getAttribute('aria-label')]));
// messages that only appear from script, so they have no English source node in the HTML
const MSG = { 'wl.ok': 'Done. We’ll write when it’s out.', 'wl.bad': 'Check the email and pick at least one option.', 'wl.fail': 'Couldn’t send it. Please try again in a moment.' };
const t = (k) => (state.lang === 'cs' && CS[k]) || EN[k] || MSG[k];
const state = {
  // English by default; Czech when the browser prefers Czech (or Slovak) and the visitor has not picked a language
  lang: localStorage.getItem('kazetix.lang') || ((navigator.languages || [navigator.language]).some((l) => /^(cs|sk)\b/i.test(l)) ? 'cs' : 'en'),
  plastic: root.dataset.plastic,
  view: 'transcript',
};

const heroShot = document.getElementById('hero-shot');
function shots() {
  const suffix = `${state.lang}-${state.plastic}`;
  const next = `shots/overlay-${state.view}-${suffix}.webp`;
  if (!heroShot.src.endsWith(next)) {
    heroShot.classList.add('swap'); // ponytail: a quick dim-and-swap; a crossfade needs a second <img>
    const img = new Image();
    img.onload = () => ((heroShot.src = next), heroShot.classList.remove('swap'));
    img.src = next;
  }
  for (const im of document.querySelectorAll('[data-shot]')) im.src = `shots/${im.dataset.shot}-${suffix}.webp`;
}

function render() {
  root.lang = state.lang;
  root.dataset.plastic = state.plastic;
  for (const n of nodes) n.innerHTML = t(n.dataset.i18n);
  for (const n of document.querySelectorAll('[data-i18n-title]')) n.title = state.lang === 'cs' ? CS[n.dataset.i18nTitle] : 'Insert the prep cassette again';
  for (const [n, en] of ariaEN) n.setAttribute('aria-label', (state.lang === 'cs' && CS[n.dataset.i18nAria]) || en);
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang));
  for (const b of document.querySelectorAll('[data-plastic]')) b.setAttribute('aria-pressed', String(b.dataset.plastic === state.plastic));
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
  for (const p of document.querySelectorAll('[data-prompt]')) p.textContent = PROMPT[state.lang];
  shots();
}

document.querySelectorAll('[data-theme-toggle]').forEach((b) =>
  b.addEventListener('click', () => {
    localStorage.setItem('kazetix.plastic', (state.plastic = state.plastic === 'black' ? 'beige' : 'black'));
    render();
  }),
);
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-lang],[data-plastic],[data-view]');
  if (!b) return;
  if (b.dataset.lang) localStorage.setItem('kazetix.lang', (state.lang = b.dataset.lang));
  if (b.dataset.plastic) localStorage.setItem('kazetix.plastic', (state.plastic = b.dataset.plastic));
  if (b.dataset.view) state.view = b.dataset.view;
  render();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (localStorage.getItem('kazetix.plastic')) return;
  state.plastic = e.matches ? 'black' : 'beige';
  render();
});

document.querySelectorAll('[data-copy]').forEach((b) =>
  b.addEventListener('click', async () => {
    await navigator.clipboard.writeText(PROMPT[state.lang]);
    const label = b.querySelector('[data-i18n]');
    label.textContent = state.lang === 'cs' ? CS['coupon.copied'] : 'Copied';
    setTimeout(() => (label.textContent = t('coupon.copy')), 1600);
  }),
);

// the prep cassette: slides into the deck when it scrolls into view, the checklist ticks, then it is ejected again;
// clicking the deck plays it once more
const deck = document.querySelector('.deck');
const prepItem = deck?.closest('.prep-item');
let ejectTimer = 0;
function insertCassette() {
  const c = deck.querySelector('.cassette').getBoundingClientRect(), m = deck.querySelector('.deck-mouth').getBoundingClientRect();
  if (!deck.classList.contains('loaded')) deck.style.setProperty('--drop', `${Math.round(m.top - c.bottom)}px`); // cassette bottom → slot mouth
  clearTimeout(ejectTimer);
  prepItem.classList.remove('ticked');
  deck.classList.remove('loaded');
  void deck.offsetWidth; // restart the animation on a replay
  deck.classList.add('loaded');
  ejectTimer = setTimeout(() => prepItem.classList.add('ticked'), 900);
}
if (deck) {
  new IntersectionObserver((entries, io) => {
    if (entries.some((e) => e.isIntersecting)) insertCassette(), io.disconnect();
  }, { threshold: 0.6 }).observe(deck);
  deck.addEventListener('click', insertCassette);
}

// waitlist: posts to the Kazetix server, which accepts only the landing page's origins
const WAITLIST_URL = 'https://hintwell.dpstudio.cz/waitlist';
for (const form of document.querySelectorAll('[data-waitlist]'))
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = form.querySelector('.wl-status');
    const fd = new FormData(form);
    const body = { email: String(fd.get('email') || '').trim(), products: fd.getAll('products'), lang: state.lang, website: fd.get('website') };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email) || !body.products.length) return (status.textContent = t('wl.bad'), status.dataset.state = 'bad');
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const r = await fetch(WAITLIST_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      status.textContent = t(r.ok ? 'wl.ok' : r.status === 400 ? 'wl.bad' : 'wl.fail');
      status.dataset.state = r.ok ? 'ok' : 'bad';
      if (r.ok) form.reset();
    } catch {
      status.textContent = t('wl.fail');
      status.dataset.state = 'bad';
    } finally {
      button.disabled = false;
    }
  });

// live star count; stays hidden while the repo is private or the API is rate-limited
fetch('https://api.github.com/repos/Domin-Labs/kazetix')
  .then((r) => (r.ok ? r.json() : null))
  .then((repo) => {
    if (!repo || typeof repo.stargazers_count !== 'number') return;
    const n = repo.stargazers_count;
    for (const el of document.querySelectorAll('[data-stars]')) {
      el.querySelector('b').textContent = n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
      el.hidden = false;
    }
  })
  .catch(() => {});

render();
