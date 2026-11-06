// Per-user generation settings and fal credentials, shared across projects.
// Keys prefer the OS keychain; the fallback file is private to the user.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_GENERATION_SETTINGS, type FalKeyStatus, type GenerationSettings } from '../../src/core/generationStudio';
import { JOBS, MODELS } from '../../src/core/generationRoutes';

function overrideJob(job: unknown): asserts job is keyof GenerationSettings['routeOverrides'] {
  if (typeof job !== 'string' || !Object.hasOwn(JOBS, job)) throw new SettingsError('Unknown generation job.', 'routeOverrides.' + String(job));
}

function overrideModel(job: keyof GenerationSettings['routeOverrides'], model: unknown): asserts model is string {
  if (typeof model !== 'string' || !Object.hasOwn(MODELS, model) || !MODELS[model].endpoints[job]) {
    throw new SettingsError('Choose a registry model that serves this job.', `routeOverrides.${job}`);
  }
}

/** ~/.config/motion-editor, or MGE_CONFIG_DIR. Per user, shared by every project. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MGE_CONFIG_DIR || join(env.HOME || homedir(), '.config', 'motion-editor');
}

/** A settings value that cannot be saved. */
export class SettingsError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(message);
    this.name = 'SettingsError';
    this.path = path;
  }
}

function settingsPatch(raw: unknown, onDropped?: () => void): Partial<GenerationSettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SettingsError('Settings must be an object.', '');
  const patch: Partial<GenerationSettings> = {};
  for (const [path, value] of Object.entries(raw)) {
    switch (path) {
      case 'routeOverrides': {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          if (onDropped) { onDropped(); patch.routeOverrides = {}; break; }
          throw new SettingsError('routeOverrides must be an object.', path);
        }
        const overrides: GenerationSettings['routeOverrides'] = {};
        for (const [job, model] of Object.entries(value)) {
          try {
            overrideJob(job);
            overrideModel(job, model);
            overrides[job] = model;
          } catch (error) { if (!onDropped) throw error; onDropped(); }
        }
        patch.routeOverrides = overrides;
        break;
      }
      case 'dismissedSuggestions': {
        if (!Array.isArray(value)) {
          if (onDropped) { onDropped(); patch.dismissedSuggestions = []; break; }
          throw new SettingsError('dismissedSuggestions must be an array.', path);
        }
        const keys: string[] = [];
        for (const [i, key] of value.entries()) {
          try {
            if (typeof key !== 'string' || key.split(':').length !== 2) throw new Error('Invalid key');
            const [job, model] = key.split(':');
            overrideJob(job);
            overrideModel(job, model);
            keys.push(key);
          } catch {
            if (!onDropped) throw new SettingsError('Choose a real job:model suggestion.', `${path}[${i}]`);
            onDropped();
          }
        }
        patch.dismissedSuggestions = [...new Set(keys)];
        break;
      }
      case 'dailyBudgetUsd':
      case 'confirmOverUsd':
      case 'gptImageReserveUsd': {
        const max = path === 'gptImageReserveUsd' ? 10 : 1000;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
          throw new SettingsError(`${path} must be a number from 0 to ${max}.`, path);
        }
        patch[path] = value;
        break;
      }
      case 'skipCardForOwnClicks':
        if (typeof value !== 'boolean') throw new SettingsError('skipCardForOwnClicks must be true or false.', path);
        patch[path] = value;
        break;
      case 'policy':
        if (value !== 'quality' && value !== 'balanced' && value !== 'draft') throw new SettingsError('policy must be quality, balanced or draft.', path);
        patch[path] = value;
        break;
      default:
        throw new SettingsError('Unknown generation setting.', path);
    }
  }
  return patch;
}

export async function writePrivate(path: string, text: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text, { mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Validated settings persisted with an atomic rename. */
export class GenerationSettingsStore {
  private readonly path: string;
  private warnedStale = false;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(opts: { dir: string }) {
    this.path = join(opts.dir, 'generation-settings.json');
  }

  /** Stored settings over defaults; missing or corrupt files give defaults. */
  async get(): Promise<GenerationSettings> {
    try {
      return { ...structuredClone(DEFAULT_GENERATION_SETTINGS), ...settingsPatch(JSON.parse(await readFile(this.path, 'utf8')), () => {
        if (!this.warnedStale) { this.warnedStale = true; console.warn('Dropped stale generation route overrides or suggestion dismissals from settings.'); }
      }) };
    } catch {
      return structuredClone(DEFAULT_GENERATION_SETTINGS);
    }
  }

  /** Validate and merge a patch, then persist it with mode 0600. */
  async update(patch: unknown): Promise<GenerationSettings> {
    const valid = settingsPatch(patch);
    const update = this.pending.then(async () => {
      const settings = { ...await this.get(), ...valid };
      await writePrivate(this.path, `${JSON.stringify(settings, null, 2)}\n`);
      return settings;
    });
    this.pending = update.catch(() => undefined);
    return update;
  }

  /** Serialize dismissals so simultaneous cards cannot overwrite each other. */
  async dismissSuggestion(job: unknown, model: unknown): Promise<GenerationSettings> {
    overrideJob(job);
    overrideModel(job, model);
    const update = this.pending.then(async () => {
      const settings = await this.get();
      settings.dismissedSuggestions = [...new Set([...settings.dismissedSuggestions, `${job}:${model}`])];
      await writePrivate(this.path, `${JSON.stringify(settings, null, 2)}\n`);
      return settings;
    });
    this.pending = update.catch(() => undefined);
    return update;
  }

  /** Serialize individual override edits with all other settings writes. */
  async setRouteOverride(job: unknown, model: unknown): Promise<GenerationSettings> {
    overrideJob(job);
    if (model !== null) overrideModel(job, model);
    const update = this.pending.then(async () => {
      const settings = await this.get();
      if (model === null) delete settings.routeOverrides[job];
      else settings.routeOverrides[job] = model as string;
      await writePrivate(this.path, `${JSON.stringify(settings, null, 2)}\n`);
      return settings;
    });
    this.pending = update.catch(() => undefined);
    return update;
  }
}

export interface StoredKey { key: string; source: 'keychain' | 'file' | 'env' }

/** OS keychain access; tests inject a fake. */
export interface Keychain {
  /** null when the keychain is unavailable or has no entry. */
  get(): Promise<string | null>;
  /** false when unavailable, so the caller can fall back to a file. */
  set(key: string): Promise<boolean>;
  remove(): Promise<void>;
}

function keychainCommand(command: string, args: string[], input?: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 10_000 });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output = (output + chunk).slice(0, 4096); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? output.trim() : null));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  }).catch(() => null);
}

/** The platform keychain; command failures never expose credentials. */
export function systemKeychain(): Keychain {
  if (process.platform === 'darwin') {
    return {
      get: () => keychainCommand('security', ['find-generic-password', '-s', 'motion-editor', '-a', 'fal', '-w']),
      set: async (key) => await keychainCommand('security', ['-i'], `add-generic-password -U -s motion-editor -a fal -w "${key.replace(/[\\"]/g, '\\$&')}"\n`) !== null,
      remove: async () => { await keychainCommand('security', ['delete-generic-password', '-s', 'motion-editor', '-a', 'fal']); },
    };
  }
  if (process.platform === 'linux') {
    return {
      get: () => keychainCommand('secret-tool', ['lookup', 'service', 'motion-editor', 'account', 'fal']),
      set: async (key) => await keychainCommand('secret-tool', ['store', '--label=Motion editor fal key', 'service', 'motion-editor', 'account', 'fal'], key) !== null,
      remove: async () => { await keychainCommand('secret-tool', ['clear', 'service', 'motion-editor', 'account', 'fal']); },
    };
  }
  return { get: async () => null, set: async () => false, remove: async () => undefined };
}

export interface KeyStore {
  /** Keychain, then the private file, then FAL_KEY. */
  get(): Promise<StoredKey | null>;
  /** Save to keychain or file and remove the stale copy. */
  set(key: string): Promise<'keychain' | 'file'>;
  /** Remove saved copies; an environment key stays visible. */
  remove(): Promise<void>;
  /** Masked status without testing; never contains the key. */
  status(): Promise<FalKeyStatus>;
}

/** Trim a key and check its shape without contacting fal. */
export function checkKeyShape(raw: unknown): { ok: true; key: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'Enter a fal key.' };
  const key = raw.trim();
  if (key.length > 512) return { ok: false, error: 'The fal key must be at most 512 characters.' };
  if (/\s/.test(key)) return { ok: false, error: 'The fal key cannot contain whitespace.' };
  if (/[^\x21-\x7e]/.test(key)) return { ok: false, error: 'The fal key must contain printable ASCII characters.' };
  return { ok: true, key };
}

/** Store credentials outside projects, with a private file fallback. */
export function createKeyStore(opts: { dir: string; env?: NodeJS.ProcessEnv; keychain?: Keychain }): KeyStore {
  const env = opts.env ?? process.env;
  const keychain = opts.keychain ?? systemKeychain();
  const path = join(opts.dir, 'fal-key');
  const get = async (): Promise<StoredKey | null> => {
    const fromKeychain = checkKeyShape(await keychain.get());
    if (fromKeychain.ok) return { key: fromKeychain.key, source: 'keychain' };
    const fromFile = checkKeyShape(await readFile(path, 'utf8').catch(() => null));
    if (fromFile.ok) return { key: fromFile.key, source: 'file' };
    const fromEnv = checkKeyShape(env.FAL_KEY);
    return fromEnv.ok ? { key: fromEnv.key, source: 'env' } : null;
  };
  return {
    get,
    async set(raw) {
      const checked = checkKeyShape(raw);
      if (!checked.ok) throw new Error(checked.error);
      if (await keychain.set(checked.key)) {
        await rm(path, { force: true });
        return 'keychain';
      }
      await writePrivate(path, checked.key);
      await keychain.remove();
      return 'file';
    },
    async remove() {
      await keychain.remove();
      await rm(path, { force: true });
    },
    async status() {
      const stored = await get();
      return stored ? { configured: true, source: stored.source, last4: stored.key.slice(-4) } : { configured: false };
    },
  };
}
