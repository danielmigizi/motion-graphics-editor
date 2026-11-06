// Dragging assets inside the editor (the Assets library, generated takes, a
// job's results) onto the Generate composer, and files from the computer onto
// it. An asset travels as its id under its own type, so nothing outside the
// editor mistakes it for a file; files are uploaded as references on drop
// (assets.ts, addReferenceFiles).

import { useRef, useState, type DragEvent } from 'react';
import type { Asset, AssetKind } from '../core/types';
import { addReferenceFiles } from './assets';
import { hidePeek } from './Peek';

export const ASSET_MIME = 'application/x-mge-asset';

/** Start dragging `asset`; `image` (its thumbnail) is what follows the pointer. */
export function startAssetDrag(e: DragEvent, asset: Asset, image?: Element | null): void {
  hidePeek();
  e.dataTransfer.setData(ASSET_MIME, asset.id);
  e.dataTransfer.setData('text/plain', asset.name);
  e.dataTransfer.effectAllowed = 'copy';
  if (image) {
    const r = image.getBoundingClientRect();
    e.dataTransfer.setDragImage(image, r.width / 2, r.height / 2);
  }
}

/** The drag carries an asset of this editor or files from the computer. */
export const carriesMedia = (dt: DataTransfer): boolean => dt.types.includes(ASSET_MIME) || dt.types.includes('Files');

/**
 * The asset ids a drop brings: the dragged asset, or the dropped files once
 * uploaded and added as references (only `kinds`). Empty when there is nothing usable.
 */
export async function droppedAssetIds(dt: DataTransfer, kinds: readonly AssetKind[]): Promise<string[]> {
  const id = dt.getData(ASSET_MIME);
  if (id) return [id];
  const files = Array.from(dt.files);
  if (!files.length) return [];
  return (await addReferenceFiles(files, kinds)).map((a) => a.id);
}

/**
 * A drop target for media: `over` while a drag that carries some hovers it
 * (entering children does not flicker it), and `uploading` while dropped files
 * go up. A target inside another keeps its drops to itself.
 */
export function useMediaDrop(onIds: (ids: string[]) => void, kinds: readonly AssetKind[]) {
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(0);
  const depth = useRef(0);
  const handlers = {
    onDragEnter: (e: DragEvent) => {
      if (!carriesMedia(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current++;
      setOver(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!carriesMedia(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: DragEvent) => {
      if (!carriesMedia(e.dataTransfer)) return;
      e.stopPropagation();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (!carriesMedia(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current = 0;
      setOver(false);
      const files = e.dataTransfer.types.includes(ASSET_MIME) ? 0 : e.dataTransfer.files.length;
      if (files) setUploading((n) => n + files);
      void droppedAssetIds(e.dataTransfer, kinds)
        .then((ids) => ids.length && onIds(ids))
        .finally(() => files && setUploading((n) => n - files));
    },
  };
  return { over, uploading, handlers };
}
