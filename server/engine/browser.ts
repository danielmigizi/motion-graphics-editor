// Headless Chrome for the native exporter (playwright-core). Executable:
// MGE_BROWSER_EXECUTABLE, else a Chrome Headless Shell already on disk
// (Playwright's cache), else the installed Google Chrome. The flags pin the
// colour profile to sRGB and turn font hinting off, so exports come out the
// same on every machine.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

const FLAGS = [
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-media-suspend',
  '--disable-ipc-flooding-protection',
  '--autoplay-policy=no-user-gesture-required',
  // A screenshot need not wait for a display refresh: about a third faster per frame.
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
  '--enable-features=NetworkService,NetworkServiceInProcess,CanvasDrawElement',
  '--disable-features=IsolateOrigins,site-per-process,Translate,BackForwardCache,LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
];

function headlessShells(): string[] {
  const exe = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  const found: string[] = [];
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? (process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches', 'ms-playwright') : join(homedir(), '.cache', 'ms-playwright'));
  try {
    for (const dir of readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse()) {
      for (const sub of readdirSync(join(cache, dir))) found.push(join(cache, dir, sub, exe));
    }
  } catch {
    /* no Playwright browsers */
  }
  return found;
}

/**
 * `scale` is the device scale factor every page renders at. It is a browser
 * flag, not only a page override: the compositor then
 * rasterises at that scale, which decides how sub-pixel hairlines come out.
 */
export async function launchBrowser(rootDir: string, scale = 1): Promise<Browser> {
  const explicit = process.env.MGE_BROWSER_EXECUTABLE;
  const shell = explicit ? null : headlessShells().find((p) => existsSync(p));
  const executablePath = explicit || shell || undefined;
  // Software raster (SwiftShader) by default: the same pixels on every machine.
  // MGE_ENGINE_GPU=1 rasterises on the GPU: about 10 % faster, antialiasing differs slightly.
  const gpu = process.env.MGE_ENGINE_GPU === '1' ? ['--enable-gpu-rasterization', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])] : [];
  return chromium.launch({ headless: true, args: [...FLAGS, `--force-device-scale-factor=${scale}`, ...gpu], ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
}
