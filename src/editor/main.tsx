// Editor UI faces, the editor's brand: Instrument Sans for every control,
// Geist Mono for timecode, frames, ids and shortcuts, Instrument Serif for the
// project title only (bundled; the video's own fonts live in src/composition/fonts.tsx).
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import '@fontsource/instrument-serif/400.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useLayout } from './layout';
import { useProposals } from './proposals';
import { useEditor } from './store';
import './styles.css';

// Dev-only inspection hooks for automated verification (read state; drive the UI, not this).
if (import.meta.env.DEV) Object.assign(window as unknown as { __mge: typeof useEditor; __mgeProposals: typeof useProposals; __mgeLayout: typeof useLayout }, { __mge: useEditor, __mgeProposals: useProposals, __mgeLayout: useLayout });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
