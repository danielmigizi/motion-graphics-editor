// Bundled fonts. The @fontsource CSS (and the woff2 files it references) is
// bundled by Vite for both the preview and the export render page, so
// preview and export rasterise identical glyphs.
//
// FontsReady holds a readiness handle until every family/weight is loaded,
// so no frame is captured with fallback fonts (Player and renderer alike).
// If a font fails to load while RENDERING, the render is cancelled with a
// message naming the font — an export must never silently use fallback fonts.
// In the editor preview it warns and keeps going.

import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource/ibm-plex-mono/700.css';
// Variable font (opsz + wght axes): one face serves every weight, registered as
// "Fraunces Variable". Same file the editor UI imports (src/editor/main.tsx), so
// the page never holds two different faces under that name.
import '@fontsource-variable/fraunces/opsz.css';
// Variable fonts with a width axis (Archivo: wdth 62–125 %, wght 100–900) and a
// mono for annotations. "Archivo Expanded" and "Archivo Narrow" are width presets
// of the same file (see fontStretchFor).
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/geist-mono/wght.css';
import React, { useEffect, useState } from 'react';
import { useRenderHold, useEnvironment } from '../runtime';
import { FONT_FAMILIES } from '../core/components';
import { cssFontFamily } from './elements/shared';

const WEIGHTS = [400, 500, 600, 700] as const;
/** Covers the latin subset plus the punctuation the sample uses (− – ’ …). */
const SAMPLE_TEXT = 'AaBbGgQq 0123456789 %$€ − – ’ …';

export interface FontLoadResult {
  /** "Family weight" for every bundled face that did not load, e.g. "Inter 700". */
  failed: string[];
}

let fontsPromise: Promise<FontLoadResult> | null = null;

async function loadFace(family: string, weight: number): Promise<string | null> {
  const label = `${family} ${weight}`;
  try {
    const faces = await document.fonts.load(`${weight} 32px "${cssFontFamily(family)}"`, SAMPLE_TEXT);
    // No matching face means the @font-face rules are missing: text would use a fallback.
    return faces.length > 0 && faces.every((f) => f.status === 'loaded') ? null : label;
  } catch {
    return label;
  }
}

/** Load every bundled family/weight once per page. Never rejects; reports what failed. */
export function loadBundledFonts(): Promise<FontLoadResult> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve({ failed: [] });
  if (!fontsPromise) {
    const p = Promise.all(FONT_FAMILIES.flatMap((family) => WEIGHTS.map((weight) => loadFace(family, weight)))).then(async (results) => {
      await document.fonts.ready;
      const failed = results.filter((r): r is string => r !== null);
      // Let a later mount try again instead of caching the failure for the page's lifetime.
      if (failed.length && fontsPromise === p) fontsPromise = null;
      return { failed };
    });
    fontsPromise = p;
  }
  return fontsPromise;
}

export function fontFailureMessage(failed: string[]): string {
  return `Bundled font${failed.length > 1 ? 's' : ''} failed to load: ${failed.join(', ')}.`;
}

export const FontsReady: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { delayRender, continueRender, cancelRender } = useRenderHold();
  const { isRendering } = useEnvironment();
  const [handle] = useState(() => delayRender('Loading bundled fonts'));
  useEffect(() => {
    let done = false;
    void loadBundledFonts().then(({ failed }) => {
      if (done) return;
      done = true;
      if (failed.length) {
        const message = fontFailureMessage(failed);
        if (isRendering) {
          // Fail the export loudly rather than encode frames with fallback fonts.
          cancelRender(new Error(`${message} The render was stopped so the MP4 does not use fallback fonts. Reinstall dependencies (npm ci) and export again.`));
          return;
        }
        console.warn(`[fonts] ${message} The preview is using fallback fonts; exports will fail until this is fixed.`);
      }
      continueRender(handle);
    });
    return () => {
      if (!done) {
        done = true;
        continueRender(handle);
      }
    };
  }, [continueRender, cancelRender, handle, isRendering]);
  return <>{children}</>;
};
