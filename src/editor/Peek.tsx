// A larger look at an image or clip while the pointer rests on its thumbnail
// (the Assets library, generated takes, the Generate composer's tiles and a
// job's results): the whole picture, uncropped, beside the thumbnail on the
// stage side, with its name and size under it. A clip plays, muted, on a loop.
// One host (RightColumn.tsx) draws it for every thumbnail; a press, a drag,
// a scroll or the pointer leaving puts it away.

import { useEffect, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { videoPreviewSrc } from '../composition/previewProxies';
import { resolveAssetUrl } from '../core/timing';
import type { Asset } from '../core/types';

interface PeekState {
  asset: Asset | null;
  el: Element | null;
}

const usePeek = create<PeekState>(() => ({ asset: null, el: null }));

/** How long the pointer rests before the larger view opens. */
const PEEK_DELAY = 220;
/** The larger view fits in this box. */
const PEEK_MAX = 320;
const GAP = 12;
const MARGIN = 8;

let timer: ReturnType<typeof setTimeout> | undefined;

export function hidePeek(): void {
  clearTimeout(timer);
  if (usePeek.getState().asset) usePeek.setState({ asset: null, el: null });
}

/** Pointer handlers that show `asset` larger beside the element they are on. Sound has no picture: nothing. */
export function peekProps(asset: Asset | undefined) {
  if (!asset || asset.kind === 'audio') return {};
  return {
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType === 'touch' || e.buttons) return;
      const el = e.currentTarget;
      clearTimeout(timer);
      timer = setTimeout(() => usePeek.setState({ asset, el }), PEEK_DELAY);
    },
    onPointerLeave: hidePeek,
    onPointerDown: hidePeek,
  };
}

/** The view's size: the asset's shape within PEEK_MAX square. */
function peekSize(asset: Asset): { width: number; height: number } {
  const ratio = asset.width && asset.height ? asset.width / asset.height : asset.kind === 'video' ? 16 / 9 : 1;
  return ratio >= 1 ? { width: PEEK_MAX, height: Math.round(PEEK_MAX / ratio) } : { width: Math.round(PEEK_MAX * ratio), height: PEEK_MAX };
}

/** Beside the thumbnail on the left (the stage side), or on its right when the left has no room; never off screen. */
function place(el: Element, size: { width: number; height: number }, captionH: number): { left: number; top: number } {
  const r = el.getBoundingClientRect();
  const w = size.width;
  const h = size.height + captionH;
  const left = r.left - GAP - w >= MARGIN ? r.left - GAP - w : Math.min(r.right + GAP, window.innerWidth - w - MARGIN);
  const top = Math.min(Math.max(MARGIN, r.top + r.height / 2 - h / 2), window.innerHeight - h - MARGIN);
  return { left, top };
}

const CAPTION_H = 40;

export function PeekHost() {
  const asset = usePeek((s) => s.asset);
  const el = usePeek((s) => s.el);
  const [failed, setFailed] = useState<string | null>(null);

  // A scroll that moves the thumbnail, a key, a drag, or the pointer leaving the thumbnail (even one removed under it) puts the view away.
  useEffect(() => {
    if (!asset || !el) return;
    const away = (e: Event) => {
      if (e.type === 'pointermove' && el.isConnected && el.contains(e.target as Node)) return;
      // Other scrolling (the timeline following playback, the chat) leaves it.
      if (e.type === 'scroll' && e.target instanceof Node && e.target !== document && !e.target.contains(el)) return;
      hidePeek();
    };
    window.addEventListener('pointermove', away, { passive: true });
    window.addEventListener('scroll', away, { capture: true, passive: true });
    window.addEventListener('keydown', away, { capture: true });
    window.addEventListener('dragstart', away, { capture: true });
    return () => {
      window.removeEventListener('pointermove', away);
      window.removeEventListener('scroll', away, { capture: true });
      window.removeEventListener('keydown', away, { capture: true });
      window.removeEventListener('dragstart', away, { capture: true });
    };
  }, [asset, el]);

  if (!asset || !el || !el.isConnected) return null;
  const size = peekSize(asset);
  const pos = place(el, size, CAPTION_H);
  const src = resolveAssetUrl('/', asset.kind === 'video' ? videoPreviewSrc(asset, false) : asset.src);
  const meta = [asset.width && asset.height ? `${asset.width}×${asset.height}` : null, asset.kind].filter(Boolean).join(' · ');
  return createPortal(
    <div className="peek" style={{ left: pos.left, top: pos.top, width: size.width }} role="tooltip" data-testid="asset-peek">
      <div className="peek-frame" style={{ height: size.height }}>
        {failed === src ? (
          <span className="peek-failed">Can’t show this file</span>
        ) : asset.kind === 'video' ? (
          <video src={src} autoPlay muted loop playsInline onError={() => setFailed(src)} />
        ) : (
          <img src={src} alt="" decoding="async" onError={() => setFailed(src)} />
        )}
      </div>
      <div className="peek-caption">
        <span className="peek-name">{asset.name}</span>
        <span className="peek-meta">{meta}</span>
      </div>
    </div>,
    document.body,
  );
}
