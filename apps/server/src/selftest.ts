// End-to-end self-check: real server + fake OpenRouter. Run: pnpm --filter @kazetix/server test
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { start, loadConfig } from './main.ts';
import { buildTurns, cutPoints, mergeSpeakers, type Turn } from './worker.ts';

// --- buildTurns unit check
const turns = buildTurns({
  transcripts: [
    { channel_index: 0, words: [{ text: 'Ahoj', start: 0, end: 0.4, type: 'word', speaker_id: 'speaker_0' }, { text: ' ', type: 'spacing', start: 0.4, end: 0.5 }, { text: 'světe', start: 0.5, end: 0.9, type: 'word', speaker_id: 'speaker_0' }] },
    { channel_index: 1, words: [{ text: 'Dobrý', start: 0.2, end: 0.6, type: 'word', speaker_id: 'speaker_0' }, { text: 'Jo', start: 5, end: 5.2, type: 'word', speaker_id: 'speaker_1' }] },
  ],
}, 2);
assert.deepEqual(turns.map((t) => [t.speaker, t.text]), [['Me', 'Ahoj světe'], ['Speaker 1', 'Dobrý'], ['Speaker 2', 'Jo']]);

// --- cutPoints: pieces end in the last pause before the limit, hard cut when there is none
assert.deepEqual(cutPoints([100, 1150, 1190, 1300, 2390], 3000, 1200), [0, 1190, 2390]);
assert.deepEqual(cutPoints([], 2500, 1200), [0, 1200, 2400]);

// --- mergeSpeakers: model groups labels across pieces; two labels of one piece never merge; renumbered by first appearance
const tt = (speaker: string, sid?: string): Turn => ({ speaker, channel: sid ? 'them' : 'me', start_ms: 0, end_ms: 0, text: 'x', ...(sid && { sid }) });
const pieced = [tt('Me'), tt('Speaker 1', 'p0_speaker_0'), tt('Speaker 2', 'p0_speaker_1'), tt('Speaker 3', 'p1_speaker_0'), tt('Speaker 4', 'p1_speaker_1'), tt('Speaker 5', 'p2_speaker_0')];
assert.deepEqual(
  mergeSpeakers(pieced, [{ labels: ['Speaker 1', 'Speaker 4', 'Speaker 2'], name: 'Daniel' }, { labels: ['Speaker 3', 'Speaker 5', 'Speaker 9'], name: null }], 2).map((t) => [t.speaker, t.name ?? null]),
  [['Me', null], ['Speaker 1', 'Daniel'], ['Speaker 2', null], ['Speaker 3', null], ['Speaker 1', 'Daniel'], ['Speaker 3', null]],
);
assert.deepEqual(mergeSpeakers([tt('Speaker 1', 'p0_speaker_0'), tt('Speaker 2', 'p1_speaker_0')], [{ labels: ['Speaker 1', 'Speaker 2'], name: null }], 2).map((t) => t.speaker), ['Others', 'Others']);

// --- fakes
let sttCalls = 0;
let diarized = 0;
const fake = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  res.setHeader('content-type', 'application/json');
  if (req.url === '/audio/transcriptions') {
    sttCalls++;
    assert.match(body, /name="model"\r\n\r\nelevenlabs\/scribe-v2/);
    assert.match(body, /name="language"\r\n\r\ncs/);
    const diarize = /name="diarize"\r\n\r\ntrue/.test(body);
    // The whole R channel times out upstream (OpenRouter: HTTP 200 + {error}); it is re-sent in 1 s pieces (STT_CHUNK_S=1)
    // and only the second piece (offset 1 s) has speech, with times relative to the piece.
    if (diarize && ++diarized === 1) return res.end(JSON.stringify({ error: { message: 'Provider returned 524', code: 524 } }));
    if (diarize && diarized !== 3) return res.end(JSON.stringify({ text: '', duration: 1, words: [], usage: { seconds: 1, cost: 0.01 } }));
    // L channel (Me) is sent without diarization, R (Others) with it — words come without spacing tokens like on OpenRouter
    const words = diarize
      ? [{ word: 'Zvládnete', start: 0, end: 0.4, type: 'word', speaker_label: 'speaker_0' }, { word: 'smlouvu', start: 0.4, end: 0.8, type: 'word', speaker_label: 'speaker_0' }, { word: 'o', start: 0.8, end: 0.9, type: 'word', speaker_label: 'speaker_0' }, { word: 'dílo?', start: 0.9, end: 1.5, type: 'word', speaker_label: 'speaker_0' }, { word: '(smích)', start: 1.5, end: 1.8, type: 'audio_event', speaker_label: 'speaker_0' }]
      : [{ word: 'Do', start: 3, end: 3.2, type: 'word', speaker_label: 'speaker_0' }, { word: 'konce', start: 3.2, end: 3.6, type: 'word', speaker_label: 'speaker_0' }, { word: 'měsíce.', start: 3.6, end: 5, type: 'word', speaker_label: 'speaker_0' }];
    return res.end(JSON.stringify({ text: '', duration: 1800, words, usage: { seconds: 1800, cost: 0.11 } }));
  }
  if (req.url === '/chat/completions') {
    const r = JSON.parse(body);
    assert.equal(r.response_format.type, 'json_schema');
    assert.match(r.messages[1].content, /\[00:01\] Others: Zvládnete smlouvu o dílo\?\n\[00:03\] Me: Do konce měsíce\./);
    return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary_markdown: '## Termín\nRezervace do konce měsíce.', key_points: ['Spuštění do konce měsíce'], decisions: ['Termín 24. 11.'], action_items: [{ text: 'Poslat přístupy k API', owner: 'Martin', due_date: '2026-11-07' }] }) } }] }));
  }
  res.statusCode = 404;
  res.end('{}');
});
await new Promise<void>((ok) => fake.listen(0, ok));
const fakeUrl = `http://localhost:${(fake.address() as any).port}`;

const dir = mkdtempSync(join(tmpdir(), 'kazetix-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const cfg = loadConfig({
  PORT: String(port), DATA_DIR: dir, KAZETIX_API_TOKEN: 'api-secret', KAZETIX_MCP_PASSWORD: 'owner-pass',
  OPENROUTER_API_KEY: 'or', OPENROUTER_BASE_URL: fakeUrl, WORKER_INTERVAL_MS: '100', STT_CHUNK_S: '1',
  WAITLIST_ORIGINS: 'https://kazetix.com',
});
const app = await start(cfg);
const base = `http://localhost:${port}`;
const H = { Authorization: 'Bearer api-secret', 'Content-Type': 'application/json' };
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = H) => {
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};

try {
  // --- REST
  assert.equal((await call('GET', '/api/health', undefined, {})).status, 401);
  assert.equal((await call('GET', '/api/health')).body.ok, true);

  const id = crypto.randomUUID();
  const created = await call('POST', '/api/meetings', { id, title: 'Sync rezervací', platform: 'teams', channels: 2, started_at: '2026-11-04T10:00:00+01:00' });
  assert.equal(created.body.id, id);
  assert.equal((await call('POST', '/api/meetings', { id, title: 'dup', channels: 2, started_at: '2026-11-04T10:00:00+01:00' })).status, 201); // idempotent
  assert.equal((await call('POST', '/api/meetings', { title: 'x', started_at: 'nope' })).status, 400);
  const segs = [
    { id: 's1', channel: 'them', start_ms: 1000, end_ms: 2500, text: 'Zvládnete to do konce měsíce?' },
    { id: 's2', channel: 'me', start_ms: 3000, end_ms: 5000, text: 'Ano, pokud dorazí přístupy.' },
  ];
  assert.equal((await call('POST', `/api/meetings/${id}/segments`, { segments: segs })).body.inserted, 2);
  assert.equal((await call('POST', `/api/meetings/${id}/segments`, { segments: segs })).body.inserted, 0);
  await call('POST', `/api/meetings/${id}/hints`, { id: 'h1', at_ms: 2600, payload: { question: 'Zvládnete to?', answer_hint: 'Ano.', follow_up_questions: [], missing_topics: [] } });
  await call('POST', `/api/meetings/${id}/marks`, { id: 'm1', at_ms: 4000, label: 'deadline' });

  // --- MCP with the static API token
  const mcp = new Client({ name: 'selftest', version: '1' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: 'Bearer api-secret' } } }));
  const tool = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await mcp.callTool({ name, arguments: args })) as any).content[0].text);
  assert.equal((await mcp.listTools()).tools.length, 8);
  const live = await tool('get_live_meeting');
  assert.match(live.live.transcript, /\[00:01\] Others: Zvládnete/);
  assert.equal((await tool('read_transcript', { meeting_id: id })).source, 'live');

  const trn = await call('GET', `/api/meetings/${id}/transcript`);
  assert.match(trn.body.text, /^\[00:01\] Others: Zvládnete/m);
  assert.equal((await call('GET', '/api/meetings/nope/transcript')).status, 404);
  assert.equal((await call('GET', `/api/meetings/${id}/transcript`, undefined, {})).status, 401);

  // --- resumable upload
  // a real 16 kHz stereo WAV (ffmpeg on the server must decode it)
  const pcm = Buffer.alloc(299_956);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), i * 2);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(2, 22); hdr.writeUInt32LE(16000, 24); hdr.writeUInt32LE(64000, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
  const audio = Buffer.concat([hdr, pcm]);
  const put = (from: number, to: number) => call('PUT', `/api/meetings/${id}/audio`, audio.subarray(from, to + 1), { Authorization: 'Bearer api-secret', 'Content-Range': `bytes ${from}-${to}/${audio.length}`, 'Content-Type': 'application/octet-stream' });
  assert.equal((await put(0, 99_999)).body.received, 100_000);
  const conflict = await put(150_000, 299_999);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.received, 100_000);
  assert.equal((await put(100_000, 299_999)).body.complete, true);

  // --- finish → worker → done
  await call('POST', `/api/meetings/${id}/finish`, { ended_at: '2026-11-04T10:30:00+01:00' });
  let view: any;
  for (let i = 0; i < 100 && view?.status !== 'done'; i++) {
    await new Promise((r) => setTimeout(r, 100));
    view = (await call('GET', `/api/meetings/${id}`)).body;
    assert.notEqual(view.status, 'error', view.error);
  }
  assert.equal(view.status, 'done');
  assert.equal(view.duration_s, 1800);
  assert.equal(view.speakers, 2);
  assert.deepEqual(view.summary.key_points, ['Spuštění do konce měsíce']);
  assert.equal(view.action_items[0].owner, 'Martin');

  const billed = sttCalls;
  assert.ok(billed >= 6, `L whole + R whole (524) + R in ≥4 pieces, got ${billed}`);
  // re-finish must not bill the transcription again
  await call('POST', `/api/meetings/${id}/finish`, { ended_at: '2026-11-04T10:30:00+01:00' });
  for (let i = 0; i < 50 && (await call('GET', `/api/meetings/${id}`)).body.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(sttCalls, billed, 'transcribed once');

  // --- home overview (desktop Home page)
  const ov = (await call('GET', '/api/meetings?limit=50&today=2026-11-04')).body;
  assert.equal(ov.source, 'server');
  assert.deepEqual([ov.stats.calls, ov.stats.calls_month, ov.stats.words, ov.stats.open_items > 0], [1, 1, 7, true]);
  assert.equal(ov.activity.length, 35);
  assert.equal(ov.activity[34].day, '2026-11-04');
  assert.equal(ov.recent[0].id, id);
  assert.equal(Object.values(ov.platforms).reduce((a: number, b) => a + (b as number), 0), 1);
  assert.equal((await call('GET', '/api/meetings', undefined, {})).status, 401);

  // --- MCP tools on the finished meeting
  assert.equal((await tool('list_meetings')).meetings[0].id, id);
  assert.equal((await tool('list_meetings', { not_exported_to: 'notion' })).meetings.length, 1);
  await tool('mark_exported', { meeting_id: id, target: 'notion', url: 'https://notion.so/x' });
  assert.equal((await tool('list_meetings', { not_exported_to: 'notion' })).meetings.length, 0);
  const tr = await tool('read_transcript', { meeting_id: id, max_chars: 500 });
  assert.equal(tr.source, 'final');
  assert.match(tr.transcript, /^\[00:01\] Others: Zvládnete smlouvu o dílo\?\n\[00:03\] Me: Do konce měsíce\.$/);
  const page = await tool('read_transcript', { meeting_id: id, from_turn: 0, max_chars: 500 });
  assert.equal(page.total_turns, 2);
  const hits = await tool('search', { query: 'smlouv* OR faktur*' });
  assert.equal(hits.transcript_hits[0].meeting_id, id);
  assert.equal((await tool('search', { query: 'dilo' })).transcript_hits.length, 1, 'diacritics-insensitive');
  assert.equal((await tool('search', { query: 'termin' })).summary_hits.length, 1);
  assert.ok(Array.isArray((await tool('search', { query: 'a"b (' })).transcript_hits), 'bad FTS syntax falls back');
  assert.equal((await tool('get_action_items', { owner: 'mart' })).action_items.length, 1);
  const got = await tool('get_meeting', { meeting_id: id });
  assert.equal(got.marks[0].at, '00:04');
  assert.match(got.audio_url, /\/a\/.+\?e=\d+&s=/);
  assert.equal((await fetch(got.audio_url)).status, 200);
  assert.equal((await fetch(got.audio_url.replace(/s=.*/, 's=bad'))).status, 403);
  assert.equal((await tool('status')).meetings, 1);
  await mcp.close();

  // --- OAuth: DCR + PKCE + password login + refresh
  const meta = (await call('GET', '/.well-known/oauth-authorization-server', undefined, {})).body;
  assert.equal(meta.issuer, `${base}/`);
  const bad = await call('POST', '/register', { redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none' }, { 'Content-Type': 'application/json' });
  assert.equal(bad.status, 400);
  const reg = await call('POST', '/register', { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none', client_name: 'Claude' }, { 'Content-Type': 'application/json' });
  assert.equal(reg.status, 201);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authUrl = `${base}/authorize?response_type=code&client_id=${reg.body.client_id}&redirect_uri=${encodeURIComponent('https://claude.ai/api/mcp/auth_callback')}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`;
  const page1 = await (await fetch(authUrl)).text();
  const pending = /name="pending" value="([^"]+)"/.exec(page1)![1];
  const form = (pw: string) => fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ pending, password: pw }) });
  assert.equal((await form('wrong')).status, 401);
  const ok = await form('owner-pass');
  assert.equal(ok.status, 302);
  const loc = new URL(ok.headers.get('location')!);
  assert.equal(loc.searchParams.get('state'), 'xyz');
  const tokenReq = (params: Record<string, string>) => fetch(`${base}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: reg.body.client_id, ...params }) }).then((r) => r.json() as any);
  const badPkce = await tokenReq({ grant_type: 'authorization_code', code: loc.searchParams.get('code')!, code_verifier: 'x'.repeat(43), redirect_uri: 'https://claude.ai/api/mcp/auth_callback' });
  assert.equal(badPkce.error, 'invalid_grant');
  // code was not consumed by the failed PKCE check → retry with the right verifier
  const tokens = await tokenReq({ grant_type: 'authorization_code', code: loc.searchParams.get('code')!, code_verifier: verifier, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' });
  assert.ok(tokens.access_token, JSON.stringify(tokens));
  const mcp2 = new Client({ name: 'oauth', version: '1' });
  await mcp2.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
  assert.equal((await mcp2.listTools()).tools.length, 8);
  await mcp2.close();
  const refreshed = await tokenReq({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  assert.ok(refreshed.access_token);
  assert.equal((await tokenReq({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).error, 'invalid_grant', 'refresh tokens rotate');
  const unauth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate') ?? '', /resource_metadata=/);

  // --- public waitlist: allowed origin only, validated, deduplicated, honeypot, readable with the API token
  const wl = (body: unknown, origin = 'https://kazetix.com') => call('POST', '/waitlist', body, { 'Content-Type': 'application/json', Origin: origin });
  assert.equal((await wl({ email: 'a@b.cz', products: ['cloud'] }, 'https://evil.example')).status, 403);
  assert.equal((await wl({ email: 'nope', products: ['cloud'] })).status, 400);
  assert.equal((await wl({ email: 'a@b.cz', products: ['tv'] })).status, 400);
  assert.equal((await wl({ email: ' A@b.cz ', products: ['cloud', 'mac'], lang: 'cs' })).body.ok, true);
  assert.equal((await wl({ email: 'a@b.cz', products: ['mac'] })).body.ok, true); // duplicate is fine
  assert.equal((await wl({ email: 'bot@spam.io', products: ['mac'], website: 'http://x' })).body.ok, true);
  assert.deepEqual((await call('GET', '/api/waitlist')).body.map((r: any) => [r.email, r.product, r.lang]), [['a@b.cz', 'cloud', 'cs'], ['a@b.cz', 'mac', 'cs']]);
  assert.equal((await call('GET', '/api/waitlist', undefined, {})).status, 401);

  console.log('selftest: all checks passed');
} finally {
  app.stop();
  fake.close();
  rmSync(dir, { recursive: true, force: true });
}
