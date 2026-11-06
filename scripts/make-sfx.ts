// Synthesise the built-in sound-effect set (src/core/sfx.ts) into
// public/assets/sfx/: 48 kHz mono 16-bit WAVs, peak-normalised to −1 dBFS
// (no clipping), with short edge fades so nothing clicks unintentionally.
// Everything is generated from code with a seeded noise source, so the
// files are deterministic and CC0 by construction (LICENSE.txt is written
// alongside).
//
//   npx tsx scripts/make-sfx.ts [--out public/assets/sfx]

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SFX, SFX_IDS, SFX_LICENSE, type SfxId } from '../src/core/sfx';

export const SFX_RATE = 48000;
const PEAK = 10 ** (-1 / 20); // −1 dBFS

function noiseSource(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    // xorshift32
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff - 0.5;
  };
}

/** RBJ band-pass (constant 0 dB peak gain), coefficients recomputed per sample for sweeps. */
function bandPass(input: Float32Array, centerAt: (t: number) => number, q: number): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const w0 = (2 * Math.PI * Math.min(centerAt(i / SFX_RATE), SFX_RATE * 0.45)) / SFX_RATE;
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    const b0 = alpha / a0, b2 = -alpha / a0, a1 = (-2 * Math.cos(w0)) / a0, a2 = (1 - alpha) / a0;
    const x = input[i];
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

function lowPass(input: Float32Array, cutoff: number): Float32Array {
  const a = Math.exp((-2 * Math.PI * cutoff) / SFX_RATE);
  const out = new Float32Array(input.length);
  let y = 0;
  for (let i = 0; i < input.length; i++) out[i] = y = (1 - a) * input[i] + a * y;
  return out;
}

const buffer = (seconds: number) => new Float32Array(Math.round(seconds * SFX_RATE));
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

function noise(seconds: number, seed: number): Float32Array {
  const rnd = noiseSource(seed);
  const out = buffer(seconds);
  for (let i = 0; i < out.length; i++) out[i] = rnd();
  return out;
}

const SYNTH: Record<SfxId, (seconds: number) => Float32Array> = {
  // Band-passed noise swept up and back down, swelling to a peak ~0.4 s in.
  whoosh: (seconds) => {
    const peak = 0.4;
    const bp = bandPass(noise(seconds, 101), (t) => (t < peak ? 300 + 2700 * smooth(t / peak) : 3000 - 2200 * smooth((t - peak) / (seconds - peak))), 1.4);
    return bp.map((v, i) => {
      const t = i / SFX_RATE;
      const env = t < peak ? smooth(t / peak) ** 1.5 : (1 - smooth((t - peak) / (seconds - peak))) ** 2;
      return v * env;
    });
  },
  // A 3 kHz ping with a 2 ms decay over a noise transient.
  click: (seconds) => {
    const rnd = noiseSource(202);
    return buffer(seconds).map((_, i) => {
      const t = i / SFX_RATE;
      return Math.sin(2 * Math.PI * 3000 * t) * Math.exp(-t / 0.002) + rnd() * 0.6 * Math.exp(-t / 0.0006);
    });
  },
  // A sine dropping 900 → 300 Hz with a fast attack and a 30 ms decay.
  pop: (seconds) => {
    let phase = 0;
    return buffer(seconds).map((_, i) => {
      const t = i / SFX_RATE;
      phase += (2 * Math.PI * (300 + 600 * Math.exp(-t / 0.02))) / SFX_RATE;
      return Math.sin(phase) * smooth(t / 0.002) * Math.exp(-t / 0.03);
    });
  },
  // Noise swept 200 Hz → 6 kHz plus a tone gliding 200 → 1200 Hz, building to a hard stop.
  rise: (seconds) => {
    const bp = bandPass(noise(seconds, 303), (t) => 200 + 5800 * (t / seconds) ** 2, 2);
    let phase = 0;
    return bp.map((v, i) => {
      const t = i / SFX_RATE;
      const x = t / seconds;
      phase += (2 * Math.PI * (200 + 1000 * x * x)) / SFX_RATE;
      return (v * 1.2 + 0.35 * Math.sin(phase)) * x ** 2.2;
    });
  },
  // A 110 → 45 Hz body with a 250 ms decay, plus a low-passed noise thump.
  hit: (seconds) => {
    const thump = lowPass(noise(seconds, 404), 900);
    let phase = 0;
    return thump.map((n, i) => {
      const t = i / SFX_RATE;
      phase += (2 * Math.PI * (45 + 65 * Math.exp(-t / 0.04))) / SFX_RATE;
      return Math.sin(phase) * smooth(t / 0.001) * Math.exp(-t / 0.25) + n * 2.5 * Math.exp(-t / 0.05);
    });
  },
  // A 5 kHz ping with a 1.5 ms decay.
  tick: (seconds) =>
    buffer(seconds).map((_, i) => {
      const t = i / SFX_RATE;
      return Math.sin(2 * Math.PI * 5000 * t) * Math.exp(-t / 0.0015);
    }),
};

/** Edge fades (fade-out always; fade-in only where the sound does not start on a deliberate transient) and peak normalisation. */
export function finish(samples: Float32Array, fadeInSeconds: number, fadeOutSeconds = 0.005): Float32Array {
  const out = samples.slice();
  const fi = Math.round(fadeInSeconds * SFX_RATE);
  const fo = Math.round(fadeOutSeconds * SFX_RATE);
  for (let i = 0; i < fi && i < out.length; i++) out[i] *= i / fi;
  for (let i = 0; i < fo && i < out.length; i++) out[out.length - 1 - i] *= i / fo;
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] *= PEAK / peak;
  return out;
}

/** 16-bit PCM mono WAV. */
export function wav(samples: Float32Array, rate = SFX_RATE): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

export function synthesise(id: SfxId): Float32Array {
  const def = SFX[id];
  // Transient sounds keep their attack; swells get a 2 ms fade-in.
  const fadeIn = id === 'whoosh' || id === 'rise' ? 0.002 : 0.0002;
  return finish(SYNTH[id](def.seconds), fadeIn);
}

async function main() {
  const i = process.argv.indexOf('--out');
  const out = resolve(i >= 0 ? process.argv[i + 1] : join('public', 'assets', 'sfx'));
  await mkdir(out, { recursive: true });
  for (const id of SFX_IDS) {
    const file = join(out, `${id}.wav`);
    await writeFile(file, wav(synthesise(id)));
    console.log(`${file}  ${SFX[id].seconds} s`);
  }
  await writeFile(
    join(out, 'LICENSE.txt'),
    [`Built-in sound effects (${SFX_IDS.map((id) => `${id}.wav`).join(', ')})`, '', SFX_LICENSE, '', 'Regenerate with: npx tsx scripts/make-sfx.ts', ''].join('\n'),
  );
}

if (process.argv[1] && /make-sfx\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
