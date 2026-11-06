// A small raised panel anchored to the control that opened it: below it, or
// above when there is no room below; inside the window either way. Escape, a
// press outside or a choice closes it and gives the focus back. Keys typed in
// it stay in it (editor shortcuts do not fire), and in a menu the arrows move
// between the options. Chip opens one from a compact 24 px chip; Option is a
// menu row with a check, a label, a detail and a figure at its end.

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons';

const MARGIN = 8;
const GAP = 4;

export function Popover({ anchor, open, onClose, children, className, label, menu, align = 'start', testId }: { anchor: HTMLElement | null; open: boolean; onClose: () => void; children: ReactNode; className?: string; label: string; menu?: boolean; align?: 'start' | 'end'; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor) return setPos(null);
    const placeIt = () => {
      const el = ref.current;
      if (!el) return;
      const a = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const below = a.bottom + GAP;
      const top = below + h <= window.innerHeight - MARGIN || a.top - GAP - h < MARGIN ? Math.min(below, window.innerHeight - h - MARGIN) : a.top - GAP - h;
      const left = align === 'end' ? a.right - w : a.left;
      setPos({ left: Math.max(MARGIN, Math.min(left, window.innerWidth - w - MARGIN)), top: Math.max(MARGIN, top) });
    };
    placeIt();
    const ro = new ResizeObserver(placeIt);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener('resize', placeIt);
    window.addEventListener('scroll', placeIt, { capture: true, passive: true });
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', placeIt);
      window.removeEventListener('scroll', placeIt, { capture: true });
    };
  }, [open, anchor, align]);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Focus moves in (to the chosen option of a menu, else the first control); a press outside closes.
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[aria-checked="true"], [aria-selected="true"]') ?? el?.querySelector<HTMLElement>('input, textarea, select, button:not(:disabled)');
    (first ?? el)?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!el?.contains(t) && !anchor?.contains(t)) closeRef.current();
    };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  }, [open, anchor]);

  if (!open) return null;

  const onKey = (e: KeyboardEvent) => {
    // ⌘ combinations still reach the editor; everything else is the popover's.
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      anchor?.focus();
      return;
    }
    if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('.pop-opt:not(:disabled)') ?? []);
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  };

  return createPortal(
    <div ref={ref} className={`pop${className ? ` ${className}` : ''}`} role={menu ? 'menu' : 'dialog'} aria-label={label} tabIndex={-1} style={pos ?? { opacity: 0, left: 0, top: 0 }} data-testid={testId} onKeyDown={onKey}>
      {children}
    </div>,
    document.body,
  );
}

/** A compact chip that opens a popover; `children` gets `close`. */
export function Chip({ icon, glyph, label, title, on, testId, menu, popClass, align, disabled, className, children }: { icon?: IconName; glyph?: ReactNode; label: ReactNode; title: string; on?: boolean; testId?: string; menu?: boolean; popClass?: string; align?: 'start' | 'end'; disabled?: boolean; className?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const close = () => setOpen(false);
  return (
    <>
      <button ref={setAnchor} type="button" className={`chip-btn${className ? ` ${className}` : ''}${open ? ' open' : ''}${on ? ' on' : ''}`} aria-haspopup={menu ? 'menu' : 'dialog'} aria-expanded={open} title={title} disabled={disabled} data-testid={testId} onClick={() => setOpen(!open)}>
        {glyph ?? (icon && <Icon name={icon} size={13} />)}
        <span className="chip-label">{label}</span>
        <Icon name="down" size={11} className="chip-caret" />
      </button>
      <Popover anchor={anchor} open={open} onClose={close} label={title} menu={menu} className={popClass} align={align} testId={testId ? `${testId}-pop` : undefined}>
        {children(close)}
      </Popover>
    </>
  );
}

/** One choice in a menu popover: a check when chosen, the label, a detail under it, a figure at its end. */
export function Option({ label, detail, figure, icon, checked, disabled, title, testId, onSelect }: { label: ReactNode; detail?: ReactNode; figure?: ReactNode; icon?: IconName; checked?: boolean; disabled?: boolean; title?: string; testId?: string; onSelect: () => void }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={!!checked} className={`pop-opt${detail ? ' has-detail' : ''}`} disabled={disabled} title={title} data-testid={testId} onClick={onSelect}>
      <span className="pop-opt-mark" aria-hidden>
        {icon ? <Icon name={icon} size={14} /> : checked ? <Icon name="check" size={13} /> : null}
      </span>
      <span className="pop-opt-text">
        <span className="pop-opt-label">{label}</span>
        {detail && <span className="pop-opt-detail">{detail}</span>}
      </span>
      {figure !== undefined && <span className="pop-opt-figure">{figure}</span>}
      {icon && checked && <Icon name="check" size={13} className="pop-opt-check" />}
    </button>
  );
}

/** A quiet heading over a group of options. */
export function PopLabel({ children }: { children: ReactNode }) {
  return <div className="pop-label">{children}</div>;
}
