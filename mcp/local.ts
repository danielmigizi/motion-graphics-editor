// HTTP client for the editor's local server, plus starting the dev servers and
// opening a browser when nothing is running. Requests go straight to the
// server on 127.0.0.1 without an Origin header, which its write rule allows.

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import type { BridgeCommand, BridgeReply, EditorStateResponse } from '../src/core/api-contract';
import { configDir } from '../server/generation/config';
import type { CommandError } from '../src/core/types';

export interface LocalConfig {
  /** Repo root (where package.json lives). */
  rootDir: string;
  serverPort: number;
  webPort: number;
  /** Try to open a browser tab when no editor is connected. */
  openBrowser: boolean;
}

export class LocalApiError extends Error {
  status: number;
  error: CommandError | null;
  constructor(status: number, message: string, error: CommandError | null) {
    super(message);
    this.name = 'LocalApiError';
    this.status = status;
    this.error = error;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LocalEditor {
  constructor(readonly cfg: LocalConfig) {}

  get editorLinkFile() {
    return join(configDir(), `editor-link-${this.cfg.serverPort}`);
  }

  get serverUrl() {
    return `http://127.0.0.1:${this.cfg.serverPort}`;
  }

  get editorUrl() {
    return `http://localhost:${this.cfg.webPort}/`;
  }

  async request<T>(method: string, path: string, body?: unknown, raw?: { data: Buffer; contentType: string }, timeoutMs?: number): Promise<T> {
    const init = {
      method,
      headers: raw ? { 'Content-Type': raw.contentType } : body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: raw ? new Uint8Array(raw.data) : body !== undefined ? JSON.stringify(body) : undefined,
    };
    // Permission cards can outlast fetch's default five-minute headers timeout.
    const res = timeoutMs === undefined ? await fetch(`${this.serverUrl}${path}`, init) : await new Promise<Response>((resolve, reject) => {
      const req = httpRequest(`${this.serverUrl}${path}`, { method, headers: init.headers, signal: AbortSignal.timeout(timeoutMs) }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('error', reject);
        response.on('end', () => resolve(new Response(response.statusCode === 204 ? null : body, { status: response.statusCode })));
      });
      req.on('error', reject);
      req.end(init.body);
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON
    }
    if (!res.ok) {
      const error = (parsed as { error?: CommandError })?.error ?? null;
      throw new LocalApiError(res.status, error?.message ?? (typeof parsed === 'string' && parsed.trim() ? parsed : `Server answered ${res.status} for ${method} ${path}`), error);
    }
    return parsed as T;
  }

  state(): Promise<EditorStateResponse> {
    return this.request<EditorStateResponse>('GET', '/api/editor/state');
  }

  /** Send a bridge command; non-2xx replies carry a BridgeReply body too. */
  async command(command: BridgeCommand): Promise<BridgeReply> {
    const res = await fetch(`${this.serverUrl}/api/editor/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    const body = (await res.json()) as BridgeReply | { error: CommandError };
    if ('ok' in body) return body;
    return { ok: false, error: body.error };
  }

  private async up(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      return res.status < 500;
    } catch {
      return false;
    }
  }

  serverUp() {
    return this.up(`${this.serverUrl}/api/health`);
  }

  webUp() {
    // Vite may listen on ::1 only; `localhost` lets fetch try both families.
    return this.up(this.editorUrl);
  }

  /** Start whichever of the editor (Vite) and local server is not running. */
  async ensureRunning(timeoutMs = 45000): Promise<{ started: string[]; logPath: string }> {
    const logDir = join(this.cfg.rootDir, '.mge');
    const logPath = join(logDir, 'dev.log');
    const [server, web] = await Promise.all([this.serverUp(), this.webUp()]);
    const scripts = !server && !web ? ['dev'] : [...(server ? [] : ['dev:server']), ...(web ? [] : ['dev:web'])];
    if (!scripts.length) return { started: [], logPath };
    mkdirSync(logDir, { recursive: true });
    for (const script of scripts) {
      const fd = openSync(logPath, 'a');
      try {
        const child = spawn('npm', ['run', script], {
          cwd: this.cfg.rootDir,
          detached: true,
          stdio: ['ignore', fd, fd],
          env: { ...process.env, MGE_EDITOR_LINK_FILE: this.editorLinkFile, MGE_SERVER_PORT: String(this.cfg.serverPort), MGE_WEB_PORT: String(this.cfg.webPort) },
        });
        child.unref();
      } finally {
        closeSync(fd);
      }
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.serverUp()) && (await this.webUp())) return { started: scripts, logPath };
      await sleep(500);
    }
    throw new Error(`The editor did not start within ${Math.round(timeoutMs / 1000)} s. See ${logPath}.`);
  }

  /** Best effort: open the editor in the default browser. Returns whether a launcher was found. */
  openBrowser(): boolean {
    if (!this.cfg.openBrowser) return false;
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    if (process.platform === 'linux' && spawnSync('which', [cmd]).status !== 0) return false;
    try {
      let url = this.editorUrl;
      try { url = readFileSync(this.editorLinkFile, 'utf8').trim() || url; }
      catch { /* A server launched directly may only have printed its link. */ }
      spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
      return true;
    } catch {
      return false;
    }
  }

  /** Poll until an editor tab is connected to the bridge. */
  async waitForEditor(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await this.state()).connected) return true;
      if (Date.now() >= deadline) return false;
      await sleep(400);
    }
  }
}
