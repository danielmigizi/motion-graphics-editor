// Help › Shortcuts (layout.ts overlay 'shortcuts'): every action in the
// registry that has a shortcut, grouped by menu, then the keys and gestures
// that are not menu items (playback, the canvas, the mouse), in two columns
// with searchable labels. Mounted once in App.

import { useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { ACTIONS, labelOf, MENUS, shortcutText, type Shortcut } from './actions';
import { sameShortcut, splitShortcut } from './palette';
import { isTyping } from './editActions';
import { Icon } from './icons';
import { fieldMatches, queryTokens } from './inspectorSearch';
import { useLayout } from './layout';
import { holdFocus, isTextEntry, trapTab, useDialogFocus } from './overlayFocus';

interface Row {
  label: string;
  /** Alternatives, printed "A / B". A gesture's key is just its modifiers (key ''). */
  keys: Shortcut[];
  /** What the mouse does with the keys held: "drag", "click". */
  gesture?: string;
  /** Where the keys work, when not everywhere: "Timeline open". */
  where?: string;
  keywords?: readonly string[];
}

const key = (k: string, mods: Omit<Shortcut, 'key'> = {}): Shortcut => ({ key: k, ...mods });
const SHIFT = key('', { shift: true });
const ALT = key('', { alt: true });

/** Keys and gestures handled outside the registry (App.tsx, canvasControls.ts, Timeline.tsx, Stage.tsx, fields.tsx). */
const MORE: { title: string; rows: Row[] }[] = [
  {
    title: 'Playback and timeline',
    rows: [
      { label: 'Play or pause', keys: [key('Space')] },
      { label: 'Previous or next frame', keys: [key(','), key('.')] },
      { label: 'One frame back or forward', keys: [key('←'), key('→')], where: 'Nothing selected' },
      { label: 'Ten frames back or forward', keys: [key('←', { shift: true }), key('→', { shift: true })], where: 'Nothing selected' },
      { label: 'Previous or next keyframe', keys: [key('←', { alt: true }), key('→', { alt: true })], where: 'Timeline open; markers when nothing is selected', keywords: ['marker', 'jump'] },
      { label: 'First or last frame', keys: [key('Home'), key('End')], where: 'Timeline open' },
      { label: 'Add a marker', keys: [key('M')] },
      { label: 'Trim the layer to the playhead', keys: [key('['), key(']')] },
      { label: 'Work area starts or ends at the playhead', keys: [key('B'), key('N')], where: 'Timeline open' },
      { label: 'Switch between Layout and Animate', keys: [key('A')] },
    ],
  },
  {
    title: 'Canvas',
    rows: [
      { label: 'Nudge the selection', keys: [key('←↑→↓')], keywords: ['move', 'arrow'] },
      { label: 'Nudge by ten', keys: [key('←↑→↓', { shift: true })], keywords: ['move', 'arrow'] },
      { label: 'Next or previous element', keys: [key('Tab'), key('Tab', { shift: true })] },
      { label: 'Into a group, or edit a path’s points', keys: [key('Enter')] },
      { label: 'Out of a group, then select nothing', keys: [key('Esc')] },
    ],
  },
  {
    title: 'Mouse',
    rows: [
      { label: 'Pan the stage', keys: [key('Space')], gesture: 'drag', keywords: ['hand', 'scroll'] },
      { label: 'Add to the selection, or take out', keys: [SHIFT], gesture: 'click' },
      { label: 'Move along one axis', keys: [SHIFT], gesture: 'drag', keywords: ['constrain'] },
      { label: 'Resize keeping proportions', keys: [SHIFT], gesture: 'drag a handle', keywords: ['constrain', 'aspect'] },
      { label: 'Rotate in 15° steps', keys: [SHIFT], gesture: 'rotate', keywords: ['constrain', 'snap'] },
      { label: 'Scrub a value', keys: [], gesture: 'drag a field’s label' },
      { label: 'Scrub ten times as fast', keys: [SHIFT], gesture: 'drag a label', keywords: ['scrub'] },
      { label: 'Scrub in fine steps', keys: [ALT], gesture: 'drag a label', keywords: ['scrub', 'precise'] },
      { label: 'Seek, snapping to markers', keys: [SHIFT], gesture: 'drag the ruler', keywords: ['scrub', 'snap'] },
    ],
  },
];

/** The registry's shortcuts by menu, then the rest; a key the registry already prints isn't listed twice. */
function groups(): { title: string; rows: Row[] }[] {
  const withKeys = ACTIONS.filter((a) => a.shortcut);
  const taken = (k: Shortcut) => withKeys.some((a) => sameShortcut(a.shortcut!, k));
  const menus = MENUS.map((m) => ({
    title: m.label,
    rows: withKeys.filter((a) => a.menu === m.id).map((a) => ({ label: labelOf(a), keys: [a.shortcut!], keywords: a.keywords })),
  }));
  const more = MORE.map((g) => ({ ...g, rows: g.rows.filter((r) => r.gesture || !r.keys.every(taken)) }));
  return [...menus, ...more].filter((g) => g.rows.length > 0);
}

const caps = (cs: string[]) =>
  cs.map((cap, j) => (
    <kbd key={j} className="kbd">
      {cap}
    </kbd>
  ));

function Keys({ row }: { row: Row }) {
  const [first, ...rest] = row.keys;
  // Alternatives held with the same modifiers print them once: ⇧ ← / →.
  const shared = first && first.key && rest.length > 0 && rest.every((k) => k.key && !!k.mod === !!first.mod && !!k.shift === !!first.shift && !!k.alt === !!first.alt);
  const mods = shared ? splitShortcut(shortcutText(first), first.key).slice(0, -1) : [];
  return (
    <span className="keys-caps">
      {caps(mods)}
      {row.keys.map((k, i) => (
        <span key={i} className="keys-alt">
          {i > 0 && <span className="keys-or">/</span>}
          {caps(shared ? [k.key] : splitShortcut(shortcutText(k), k.key))}
        </span>
      ))}
      {row.gesture && <span className="keys-gesture">{row.keys.length ? `+ ${row.gesture}` : row.gesture}</span>}
    </span>
  );
}

const close = () => useLayout.getState().openOverlay(null);

export function ShortcutsSheet() {
  const open = useLayout((s) => s.overlay === 'shortcuts');
  return open ? <Shortcuts /> : null;
}

function Shortcuts() {
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, '.keys-search input');
  const tokens = queryTokens(query);
  const shown = groups()
    .map((g) => ({ ...g, rows: g.rows.filter((r) => fieldMatches({ label: r.label, section: g.title, aliases: [...(r.keywords ?? []), ...(r.where ? [r.where] : [])] }, tokens)) }))
    .filter((g) => g.rows.length > 0);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      // The first Escape clears a search; the next closes.
      if (query && isTextEntry(e.target)) setQuery('');
      else close();
      return;
    }
    trapTab(e, ref.current);
    if (!(e.metaKey || e.ctrlKey) || isTyping(e.target)) e.stopPropagation();
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={ref}
        className="modal keys-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        tabIndex={-1}
        data-testid="shortcuts-sheet"
        onKeyDown={onKeyDown}
        onBlur={(e: FocusEvent) => holdFocus(e, ref.current)}
      >
        <header className="modal-head">
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <label className="keys-search">
            <Icon name="search" size={14} />
            <input className="input" type="text" placeholder="Search" aria-label="Search shortcuts" spellCheck={false} value={query} data-testid="shortcuts-search" onChange={(e) => setQuery(e.target.value)} />
          </label>
          <button className="icon-btn" onClick={close} aria-label="Close" title="Close (Esc)" data-testid="shortcuts-close">
            <Icon name="close" />
          </button>
        </header>
        <div className="keys-body">
          {shown.length === 0 && <p className="keys-none">No shortcut matches “{query.trim()}”.</p>}
          <div className="keys-cols">
            {shown.map((g) => (
              <section key={g.title} className="keys-group" aria-labelledby={`keys-${g.title.replace(/\W+/g, '-')}`}>
                <h3 id={`keys-${g.title.replace(/\W+/g, '-')}`}>{g.title}</h3>
                <dl>
                  {g.rows.map((r, i) => (
                    <div key={i} className="keys-row">
                      <dt>
                        {r.label}
                        {r.where && <span className="keys-where">{r.where}</span>}
                      </dt>
                      <dd>
                        <Keys row={r} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
