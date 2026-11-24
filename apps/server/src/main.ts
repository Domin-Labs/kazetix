import { createHash, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { MeetingCreate, SegmentBatch, HintIn, MarkIn, Finish } from '@kazetix/shared';
import { openDb, getMeeting, meetingView, now, setStatus, tx, channelLabel, type DB } from './db.ts';
import { startWorker, enqueue } from './worker.ts';
import { mountMcp } from './mcp.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export function loadConfig(env = process.env) {
  const port = Number(env.PORT ?? 8767);
  return {
    version: pkg.version,
    port,
    dataDir: env.DATA_DIR ?? './data',
    publicUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    apiToken: env.KAZETIX_API_TOKEN ?? '',
    mcpPassword: env.KAZETIX_MCP_PASSWORD ?? '',
    openrouterKey: env.OPENROUTER_API_KEY ?? '',
    openrouterBase: env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
    summaryModel: env.SUMMARY_MODEL || 'anthropic/claude-sonnet-5.5',
    sttModel: env.STT_MODEL || 'elevenlabs/scribe-v2',
    defaultLanguage: env.DEFAULT_LANGUAGE || 'cs',
    // Scribe v2 via OpenRouter, $/h per channel; only for cost reporting when OpenRouter omits usage.cost.
    sttUsdPerHour: Number(env.STT_USD_PER_HOUR ?? 0.22),
    workerIntervalMs: Number(env.WORKER_INTERVAL_MS ?? 2000),
    // A channel whose whole-file STT times out upstream (long diarized calls) is re-sent in pieces of this many seconds.
    sttChunkS: Number(env.STT_CHUNK_S ?? 2400), // 47 min diarized passed whole, 95 min timed out
  };
}
export type Config = ReturnType<typeof loadConfig>;

const sha = (s: string) => createHash('sha256').update(s).digest();

export function createApp(db: DB, cfg: Config) {
  const app = express();
  app.set('trust proxy', 1); // behind a reverse proxy
  app.disable('x-powered-by');

  app.get('/', (_req, res) => res.json({ name: 'kazetix', version: cfg.version, mcp: `${cfg.publicUrl}/mcp` }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  const { signer } = mountMcp(app, db, cfg);

  app.get('/a/:id', (req, res) => {
    const id = String(req.params.id);
    if (!signer.verify(id, String(req.query.e ?? ''), String(req.query.s ?? ''))) return res.status(403).send('bad or expired link');
    const m = getMeeting(db, id);
    if (!m?.audio_path || !existsSync(m.audio_path)) return res.status(404).send('no audio');
    res.download(m.audio_path, `${m.title.replace(/[^\p{L}\p{N} _-]+/gu, '_')}.ogg`);
  });

  // ---------------------------------------------------------------- REST API for the desktop app
  const api = express.Router();
  api.use((req: Request, res: Response, next: NextFunction) => {
    const tok = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!cfg.apiToken || !tok || !timingSafeEqual(sha(tok), sha(cfg.apiToken))) return res.status(401).json({ error: 'invalid token' });
    next();
  });

  api.get('/health', (_req, res) => {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM meetings').get() as { n: number }).n;
    res.json({ ok: true, version: cfg.version, meetings: n, openrouter: !!cfg.openrouterKey });
  });

  api.post('/meetings', express.json(), (req, res) => {
    const b = MeetingCreate.parse(req.body);
    const id = b.id ?? crypto.randomUUID();
    db.prepare(`INSERT INTO meetings(id, title, started_at, platform, channels, language, final_transcript, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .run(id, b.title, b.started_at, b.platform ?? null, b.channels, b.language ?? null, b.final_transcript ? 1 : 0, now(), now());
    res.status(201).json({ id });
  });

  const meeting = (req: Request, res: Response) => {
    const m = getMeeting(db, String(req.params.id));
    if (!m) res.status(404).json({ error: 'meeting not found' });
    return m;
  };

  api.get('/meetings/:id', (req, res) => {
    const v = meetingView(db, String(req.params.id));
    if (!v) return res.status(404).json({ error: 'meeting not found' });
    res.json(v);
  });

  api.post('/meetings/:id/segments', express.json({ limit: '5mb' }), (req, res) => {
    const m = meeting(req, res);
    if (!m) return;
    const { segments } = SegmentBatch.parse(req.body);
    let inserted = 0;
    tx(db, () => {
      const ins = db.prepare('INSERT OR IGNORE INTO live_segments(id, meeting_id, channel, start_ms, end_ms, text) VALUES(?, ?, ?, ?, ?, ?)');
      const finalDone = !!db.prepare('SELECT 1 FROM turns WHERE meeting_id = ? LIMIT 1').get(m.id);
      const fts = db.prepare('INSERT INTO fts_turns(text, meeting_id, start_ms, speaker) VALUES(?, ?, ?, ?)');
      for (const s of segments) {
        if (ins.run(s.id, m.id, s.channel, s.start_ms, s.end_ms, s.text).changes && !finalDone) {
          fts.run(s.text, m.id, s.start_ms, channelLabel(s.channel));
          inserted++;
        }
      }
    });
    res.json({ inserted });
  });

  api.post('/meetings/:id/hints', express.json(), (req, res) => {
    const m = meeting(req, res);
    if (!m) return;
    const h = HintIn.parse(req.body);
    db.prepare('INSERT OR IGNORE INTO hints(id, meeting_id, at_ms, payload_json) VALUES(?, ?, ?, ?)').run(h.id, m.id, h.at_ms, JSON.stringify(h.payload));
    res.json({ ok: true });
  });

  api.post('/meetings/:id/marks', express.json(), (req, res) => {
    const m = meeting(req, res);
    if (!m) return;
    const k = MarkIn.parse(req.body);
    db.prepare('INSERT OR IGNORE INTO marks(id, meeting_id, at_ms, label) VALUES(?, ?, ?, ?)').run(k.id, m.id, k.at_ms, k.label ?? null);
    res.json({ ok: true });
  });

  // Resumable upload: PUT chunks with `Content-Range: bytes start-end/total`. A chunk that does not start at the
  // number of bytes already received gets 409 + { received } so the client continues from there.
  api.put('/meetings/:id/audio', express.raw({ type: () => true, limit: '64mb' }), async (req, res) => {
    const m = meeting(req, res);
    if (!m) return;
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers['content-range'] ?? ''));
    if (!range) return res.status(400).json({ error: 'Content-Range: bytes start-end/total is required' });
    const [start, end, total] = range.slice(1).map(Number);
    const body = req.body as Buffer;
    const part = join(cfg.dataDir, 'audio', `${m.id}.ogg.part`);
    const final = join(cfg.dataDir, 'audio', `${m.id}.ogg`);
    if (m.audio_path && existsSync(final) && statSync(final).size === total) return res.json({ received: total, complete: true });
    if (start === 0 && existsSync(part)) unlinkSync(part); // client restarts from scratch
    const have = existsSync(part) ? statSync(part).size : 0;
    if (start !== have || end - start + 1 !== body.length || end >= total) return res.status(409).json({ received: have });
    appendFileSync(part, body); // sync on purpose: no await between the size check and the append
    const received = have + body.length;
    const complete = received === total;
    if (complete) renameSync(part, final);
    db.prepare('UPDATE meetings SET audio_bytes = ?, audio_path = ?, status = CASE WHEN status = ? THEN ? ELSE status END, updated_at = ? WHERE id = ?')
      .run(received, complete ? final : null, 'live', 'uploading', now(), m.id);
    res.json({ received, complete });
  });

  api.post('/meetings/:id/finish', express.json(), (req, res) => {
    const m = meeting(req, res);
    if (!m) return;
    const f = Finish.parse(req.body);
    const duration = f.duration_s ?? Math.round((Date.parse(f.ended_at) - Date.parse(m.started_at)) / 1000);
    db.prepare('UPDATE meetings SET ended_at = ?, duration_s = ?, updated_at = ? WHERE id = ?').run(f.ended_at, duration, now(), m.id);
    setStatus(db, m.id, m.final_transcript && m.audio_path ? 'transcribing' : 'summarizing', 0);
    // Without audio the summary is built from live segments; the desktop may still be posting the last ones.
    enqueue(db, m.id, !!f.force, m.final_transcript && m.audio_path ? 0 : 20_000);
    res.json(meetingView(db, m.id));
  });

  app.use('/api', api);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'invalid request', issues: err.issues });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'too large' });
    console.error('[http]', err);
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}

export function start(cfg = loadConfig()): Promise<{ server: Server; db: DB; stop: () => void }> {
  if (!cfg.apiToken) console.warn('[kazetix] KAZETIX_API_TOKEN is empty — the REST API rejects every request');
  const db = openDb(cfg.dataDir);
  const timer = startWorker(db, cfg);
  const app = createApp(db, cfg);
  return new Promise((ok) => {
    const server = app.listen(cfg.port, () => {
      console.log(`[kazetix] v${cfg.version} listening on :${cfg.port} (${cfg.publicUrl})`);
      ok({ server, db, stop: () => { clearInterval(timer); server.close(); db.close(); } });
    });
  });
}

if (import.meta.main) start();
