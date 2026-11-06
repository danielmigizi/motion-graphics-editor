// Align and distribute: pure math on the selected elements' on-screen bounds
// (composition pixels). The result is a world-space offset per element; the
// caller turns offsets into one batch of commands.

import { boxUnion, type Box } from './snap';

export type AlignMode = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';
export type DistributeAxis = 'horizontal' | 'vertical';

export interface ArrangeItem {
  id: string;
  box: Box;
}

export interface Offset {
  id: string;
  dx: number;
  dy: number;
}

export const ALIGN_LABELS: Record<AlignMode, string> = {
  left: 'Align left edges',
  centre: 'Align horizontal centres',
  right: 'Align right edges',
  top: 'Align top edges',
  middle: 'Align vertical centres',
  bottom: 'Align bottom edges',
};

/**
 * Line the items up on one edge or centre of their combined bounds, or of
 * `canvas` when a single item is aligned (so one element can be centred on the
 * frame).
 */
export function alignOffsets(items: ArrangeItem[], mode: AlignMode, canvas: Box): Offset[] {
  if (!items.length) return [];
  const ref = items.length === 1 ? canvas : boxUnion(items.map((i) => i.box));
  return items.map(({ id, box: b }) => {
    switch (mode) {
      case 'left':
        return { id, dx: ref.left - b.left, dy: 0 };
      case 'centre':
        return { id, dx: (ref.left + ref.right) / 2 - (b.left + b.right) / 2, dy: 0 };
      case 'right':
        return { id, dx: ref.right - b.right, dy: 0 };
      case 'top':
        return { id, dx: 0, dy: ref.top - b.top };
      case 'middle':
        return { id, dx: 0, dy: (ref.top + ref.bottom) / 2 - (b.top + b.bottom) / 2 };
      case 'bottom':
        return { id, dx: 0, dy: ref.bottom - b.bottom };
    }
  });
}

/**
 * Equal gaps between neighbours along one axis. Items are ordered by their
 * leading edge (ties by id for determinism); the first and last stay put and
 * the rest are spaced so every gap is the same. Needs three or more items.
 */
export function distributeOffsets(items: ArrangeItem[], axis: DistributeAxis): Offset[] {
  if (items.length < 3) return items.map(({ id }) => ({ id, dx: 0, dy: 0 }));
  const h = axis === 'horizontal';
  const start = (b: Box) => (h ? b.left : b.top);
  const size = (b: Box) => (h ? b.right - b.left : b.bottom - b.top);
  const sorted = [...items].sort((a, b) => start(a.box) - start(b.box) || a.id.localeCompare(b.id));
  const first = sorted[0].box;
  const last = sorted[sorted.length - 1].box;
  const span = (h ? last.right : last.bottom) - start(first);
  const gap = (span - sorted.reduce((n, i) => n + size(i.box), 0)) / (sorted.length - 1);
  let cursor = start(first);
  const out = new Map<string, Offset>();
  for (const { id, box } of sorted) {
    const d = cursor - start(box);
    out.set(id, { id, dx: h ? d : 0, dy: h ? 0 : d });
    cursor += size(box) + gap;
  }
  // The last item lands on its own edge up to rounding; pin it exactly.
  out.set(sorted[sorted.length - 1].id, { id: sorted[sorted.length - 1].id, dx: 0, dy: 0 });
  return items.map(({ id }) => out.get(id)!);
}
