// Generation studio HTTP routes, with editor-only credential/settings writes.

import express, { type Express, type Request, type Response } from 'express';
import type { GenerateRequest, OutcomeEvent } from '../../src/core/generationStudio';
import type { CommandError } from '../../src/core/types';
import { USER_REQUIRED } from '../session';
import { SettingsError } from './config';
import { FalError } from './fal';
import { GenerationRefusal, type GenerationService } from './jobs';

/** Register exactly the generation studio contract's routes. */
export function registerGenerationRoutes(app: Express, deps: {
  generation: GenerationService;
  isUser: (req: Request) => boolean;
  isAllowedOrigin: (origin: string) => boolean;
  fail: (res: Response, status: number, error: CommandError) => unknown;
}): void {
  const { generation, fail } = deps;
  app.use('/api/generation', (req, res, next) => {
    const origin = req.get('origin');
    if (origin !== undefined && !deps.isAllowedOrigin(origin)) {
      fail(res, 403, { code: 'PROTOCOL', message: 'This origin cannot access generation.' });
      return;
    }
    next();
  });
  const json = express.json({ limit: '1mb' });
  const handler = (fn: (req: Request, res: Response) => unknown | Promise<unknown>, editorOnly = false) => async (req: Request, res: Response) => {
    if (editorOnly && !deps.isUser(req)) return void fail(res, 401, USER_REQUIRED);
    try { await fn(req, res); }
    catch (err) {
      if (res.destroyed || res.headersSent) return;
      if (err instanceof GenerationRefusal) fail(res, err.status, err.error);
      else if (err instanceof SettingsError) fail(res, 400, { code: 'INVALID', message: err.message, path: err.path });
      else if (err instanceof FalError) fail(res, err.status === 401 || err.status === 403 ? 409 : 502, { code: 'PROTOCOL', message: err.message });
      else fail(res, 500, { code: 'PROTOCOL', message: 'Could not complete the generation request. Try again.' });
    }
  };
  const found = (res: Response, value: unknown) => value === undefined || value === false
    ? fail(res, 404, { code: 'NOT_FOUND', message: 'Generation job not found.' }) : res.json(value);

  app.get('/api/generation/status', handler(async (_req, res) => { res.json(await generation.status()); }));
  app.get('/api/generation/scoreboard', handler(async (_req, res) => { res.json(await generation.scoreboard()); }));
  app.post('/api/generation/suggestions/dismiss', json, handler(async (req, res) => { res.json(await generation.dismissSuggestion(req.body?.job, req.body?.model)); }, true));
  app.post('/api/generation/route-overrides', json, handler(async (req, res) => { res.json(await generation.setRouteOverride(req.body?.job, req.body?.model)); }, true));
  app.put('/api/generation/settings', json, handler(async (req, res) => { res.json(await generation.updateSettings(req.body)); }, true));
  app.put('/api/generation/key', json, handler(async (req, res) => { res.json(await generation.setKey(req.body?.key)); }, true));
  app.post('/api/generation/key/test', handler(async (_req, res) => { res.json(await generation.testKey()); }, true));
  app.delete('/api/generation/key', handler(async (_req, res) => { res.json(await generation.removeKey()); }, true));
  app.get('/api/generation/models', handler(async (_req, res) => { res.json(await generation.models()); }));
  app.post('/api/generation/estimate', json, handler(async (req, res) => { res.json(await generation.quote(req.body as GenerateRequest)); }));
  app.post('/api/generation/jobs', json, handler(async (req, res) => {
    const controller = new AbortController();
    const closed = () => { if (!res.writableEnded) controller.abort(); };
    // IncomingMessage.close also fires after an ordinary request body ends.
    // The response closing is the HTTP client's disconnection signal.
    res.on('close', closed);
    req.on('aborted', closed);
    try {
      const job = await generation.create(req.body, {
        origin: deps.isUser(req) ? 'user' : 'agent',
        agent: typeof req.body?.agent === 'string' ? req.body.agent.slice(0, 40) : 'Agent',
        confirmed: req.body?.confirmed === true,
      }, controller.signal);
      if (!res.destroyed) res.json({ job });
    } finally {
      res.off('close', closed);
      req.off('aborted', closed);
    }
  }));
  app.get('/api/generation/jobs', handler((req, res) => { res.json(generation.list(typeof req.query.projectId === 'string' ? req.query.projectId : undefined)); }));
  app.get('/api/generation/jobs/:id', handler((req, res) => { found(res, generation.get(String(req.params.id))); }));
  app.post('/api/generation/jobs/:id/cancel', handler(async (req, res) => {
    const id = String(req.params.id);
    if (generation.get(id)?.requestedBy.origin === 'user' && !deps.isUser(req)) return void fail(res, 401, USER_REQUIRED);
    found(res, await generation.cancel(id));
  }));
  app.post('/api/generation/jobs/:id/delivered', handler(async (req, res) => { found(res, await generation.delivered(String(req.params.id))); }, true));
  const events: OutcomeEvent[] = ['auditioned', 'used', 'kept', 'replaced', 'deleted', 'thumbsUp', 'thumbsDown', 'thumbCleared'];
  app.post('/api/generation/outcomes', json, handler(async (req, res) => {
    const raw = req.body;
    if (!raw || typeof raw.jobId !== 'string' || !raw.jobId || typeof raw.assetId !== 'string' || !raw.assetId || !events.includes(raw.event)) {
      return void fail(res, 400, { code: 'INVALID', message: 'Supply jobId, assetId and a supported outcome event.' });
    }
    if (!await generation.outcome({ jobId: raw.jobId, assetId: raw.assetId, event: raw.event })) return void found(res, false);
    res.json({ ok: true });
  }, true));
  app.get('/api/generation/thumbs', handler(async (req, res) => {
    if (req.query.jobIds !== undefined && typeof req.query.jobIds !== 'string') return void fail(res, 400, { code: 'INVALID', message: 'jobIds must be a comma-separated list.', path: 'jobIds' });
    const ids = typeof req.query.jobIds === 'string' ? req.query.jobIds.split(',').filter(Boolean) : [];
    if (ids.length > 100) return void fail(res, 400, { code: 'INVALID', message: 'Supply at most 100 job ids.', path: 'jobIds' });
    res.json(await generation.thumbs(ids));
  }));
}
