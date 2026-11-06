import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AsyncQueue, JsonRpcPeer } from './json-rpc';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'mge-rpc-')); });
afterAll(() => rm(dir, { recursive: true, force: true }));
async function fake(name: string, body: string) {
  const path = join(dir, name);
  await writeFile(path, '#!/usr/bin/env node\n' + body);
  await chmod(path, 0o755);
  return path;
}

describe('agent JSON-RPC transport', () => {
  it('routes responses while an incoming approval is pending; preserves string request IDs and protocol envelopes', async () => {
    const bin = await fake('multiplex', `
const lines = require('node:readline').createInterface({ input: process.stdin });
const send = x => console.log(JSON.stringify(x));
lines.on('line', l => { const m = JSON.parse(l);
 if (m.method === 'begin') { send({ jsonrpc:'2.0', id:'approval', method:'permission', params:{ action:'write' } }); send({ jsonrpc:'2.0', id:m.id, result:'ready' }); }
 else if (m.id === 'approval') send({ method:'decision', params:{ allowed:m.result.allowed, envelope:m.jsonrpc } });
});`);
    const notifications = new AsyncQueue<any>();
    let release: ((value: object) => void) | undefined;
    const rpc = new JsonRpcPeer(bin, [], { cwd: dir, env: process.env, signal: new AbortController().signal, jsonrpc: true,
      onNotification: (method, params) => { notifications.push({ method, params }); notifications.end(); },
      onRequest: () => new Promise(resolve => { release = resolve; }), onClose: error => notifications.fail(error),
    });
    try {
      expect(await rpc.request('begin', {})).toBe('ready');
      expect(release).toBeTypeOf('function');
      release!({ allowed: false });
      const received = []; for await (const n of notifications) received.push(n);
      expect(received).toEqual([{ method:'decision', params:{ allowed:false, envelope:'2.0' } }]);
    } finally { rpc.close(); }
  });

  it('aborts outstanding requests and closes the child without accepting late replies', async () => {
    const bin = await fake('hanging', `setInterval(() => {}, 1000);`);
    const abort = new AbortController();
    const closed: string[] = [];
    const rpc = new JsonRpcPeer(bin, [], { cwd: dir, env: process.env, signal: abort.signal, onNotification: () => {}, onRequest: async () => ({}), onClose: e => closed.push(e.message) });
    const request = rpc.request('wait', {});
    abort.abort();
    await expect(request).rejects.toThrow('Stopped.');
    await expect(rpc.request('late', {})).rejects.toThrow('closed');
    expect(closed).toEqual(['Stopped.']);
  });

  it('rejects malformed protocol output and unexpected EOF', async () => {
    for (const [name, body, expected] of [['invalid', `console.log('invalid json');`, 'invalid JSON-RPC'], ['eof', 'process.exit(2);', 'closed (2)']] as const) {
      const bin = await fake(name, body);
      const rpc = new JsonRpcPeer(bin, [], { cwd: dir, env: process.env, signal: new AbortController().signal, onNotification: () => {}, onRequest: async () => ({}), onClose: () => {} });
      await expect(rpc.request('hello', {})).rejects.toThrow(expected);
    }
  });
});
