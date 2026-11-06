import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Local newline-delimited JSON-RPC, shared by Codex App Server and Cursor ACP. */
export class JsonRpcPeer {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 0;
  private stopped = false;
  private stderr = '';
  private abort: () => void;

  constructor(bin: string, args: string[], private opts: {
    cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; jsonrpc?: boolean;
    onNotification: (method: string, params: any) => void;
    onRequest: (method: string, params: any) => Promise<any>;
    onClose: (error: Error) => void;
  }) {
    this.child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.abort = () => this.finish(new Error('Stopped.'));
    opts.signal.addEventListener('abort', this.abort, { once: true });
    this.child.stdin.on('error', error => this.finish(error));
    this.child.on('error', error => this.finish(error));
    this.child.on('close', code => this.finish(new Error(`Agent connection closed (${code}). ${this.stderr.trim()}`)));
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-2000); });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      if (this.stopped || !line.trim()) return;
      let message: any;
      try { message = JSON.parse(line); } catch { this.finish(new Error('Agent sent invalid JSON-RPC.')); return; }
      if (message && typeof message.method === 'string') {
        if (message.id !== undefined) {
          void Promise.resolve().then(() => opts.onRequest(message.method, message.params)).then(
            result => this.send({ id: message.id, result }),
            () => this.send({ id: message.id, error: { code: -32603, message: 'Client could not complete the request.' } }),
          );
        } else {
          try { opts.onNotification(message.method, message.params); } catch (error) { this.finish(error instanceof Error ? error : new Error(String(error))); }
        }
      } else if (message && typeof message.id === 'number') {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer); this.pending.delete(message.id);
        if (message.error) request.reject(new Error(String(message.error.message ?? 'Agent request failed.')));
        else request.resolve(message.result);
      }
    });
    if (opts.signal.aborted) this.abort();
  }

  private send(message: object) {
    if (!this.stopped) this.child.stdin.write(JSON.stringify(this.opts.jsonrpc ? { jsonrpc: '2.0', ...message } : message) + '\n');
  }
  request(method: string, params: object, timeoutMs = 60000): Promise<any> {
    if (this.stopped) return Promise.reject(new Error('Agent connection is closed.'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Agent request timed out: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  notify(method: string, params: object) { this.send({ method, params }); }
  close() { this.finish(); }
  private finish(error?: Error) {
    if (this.stopped) return;
    this.stopped = true;
    this.opts.signal.removeEventListener('abort', this.abort);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error ?? new Error('Agent connection closed.')); }
    this.pending.clear();
    this.child.kill('SIGTERM');
    const kill = setTimeout(() => { if (this.child.exitCode === null) this.child.kill('SIGKILL'); }, 1000);
    kill.unref();
    if (error) this.opts.onClose(error);
  }
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  private error: Error | null = null;
  push(item: T) { if (!this.ended) { this.items.push(item); this.wake?.(); } }
  end() { this.ended = true; this.wake?.(); }
  fail(error: Error) { this.error = error; this.end(); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.items.length) yield this.items.shift()!;
      if (this.ended) { if (this.error) throw this.error; return; }
      await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = null;
    }
  }
}
