// The editor's header, one 40 px row across the window in three columns. At
// the start the menubar behind the project title (Menubar.tsx: a click opens
// File, Edit, Scene, Insert, View and Help, a double-click renames) and the
// saved state; in the exact centre the Layout / Animate switch (while the
// stage is editable); at the end an asset warning, undo / redo, the theme,
// Settings, Export (its popover and the render's progress: ExportPopover.tsx),
// and the toggles for the right column and the chat docked under them. While
// the chat is closed its toggle shows what waits for you there.

import { isUntouched } from '../core/newProject';
import { useAssetWarnings } from './AssetsPanel';
import { useChat } from './chat';
import { shortcutLabel } from './editActions';
import { ExportMenu } from './ExportPopover';
import { Icon, type IconName } from './icons';
import { useLayout } from './layout';
import { Menubar } from './Menubar';
import { usePermissions } from './permissions';
import { useProposals } from './proposals';
import { saveToServer, useSaving } from './persistence';
import { useEditor } from './store';
import { cycleTheme, nextTheme, themeLabel, useTheme, type ThemeChoice } from './theme';

/** A dot and a word: draft (steel), not saved (amber, a button), saving, saved (green), offline (red). */
function SaveStatus() {
  const origin = useEditor((s) => s.origin.kind);
  const dirty = useEditor((s) => s.doc.project.revision !== s.cleanRevision);
  const untouched = useEditor((s) => isUntouched(s.doc.project));
  const { saving, failed, message } = useSaving();
  const reason = message?.replace(/\.$/, '');
  // A blank project is created on the server by its first change: nothing to warn about yet.
  if (origin === 'new' && untouched && !dirty && !saving) {
    return (
      <span className="save-status draft" data-testid="save-status" title="A draft. It saves to the local server as soon as you change something.">
        Draft
      </span>
    );
  }
  if (origin !== 'server' && !saving) {
    const why = failed && reason ? ` The last save failed: ${reason}.` : '';
    return (
      <button className="save-status unsaved" data-testid="save" onClick={() => saveToServer()} title={`Not on the local server yet.${why} Click to save it now (${shortcutLabel('S', ['mod'])}).`}>
        Not saved
      </button>
    );
  }
  const state = failed ? 'offline' : saving || dirty ? 'saving' : 'saved';
  const text = { offline: 'Offline', saving: 'Saving…', saved: 'Saved' }[state];
  const title = {
    offline: `Not saved: ${reason ?? 'the local server is not answering'}. Your work is autosaved in this browser.`,
    saving: 'Saving to the local server',
    saved: 'Saved to the local server',
  }[state];
  return (
    <span className={`save-status ${state}`} data-testid="save-status" title={title}>
      {text}
    </span>
  );
}

/**
 * Opens and closes the chat (⌘J, handled with the menus). While it is closed:
 * a count of what waits for your decision there (a permission ask, a
 * proposal), or else a dot while the agent works.
 */
function ChatToggle() {
  const open = useLayout((s) => s.chatOpen);
  const busy = useChat((s) => s.busy);
  const ask = usePermissions((s) => !!s.pending);
  const proposal = useProposals((s) => !!s.proposal && s.check?.status === 'ready');
  const waiting = Number(ask) + Number(proposal);
  const key = shortcutLabel('J', ['mod']);
  const what = [ask && 'a permission ask', proposal && 'a proposal'].filter(Boolean).join(' and ');
  const title = open ? `Hide the chat (${key})` : `Show the chat (${key})${waiting ? `: ${what} waiting for you` : busy ? ': the agent is working' : ''}`;
  return (
    <button
      className="icon-btn panel-toggle chat-toggle"
      data-testid="chat-toggle"
      aria-pressed={open}
      aria-label={!open && waiting ? `Chat, ${waiting} waiting` : 'Chat'}
      aria-keyshortcuts="Meta+J Control+J"
      title={title}
      onClick={() => useLayout.getState().setChatOpen(!open)}
    >
      <Icon name="message" />
      {!open && waiting > 0 ? (
        <span className="chat-toggle-count" data-testid="chat-toggle-count" aria-hidden>
          {waiting}
        </span>
      ) : !open && busy ? (
        <span className="chat-toggle-dot" data-testid="chat-toggle-busy" aria-hidden />
      ) : null}
    </button>
  );
}

/** Shows and hides the right column (Inspector, Layers, Assets, History); the stage takes the room. A proposal's review hides it meanwhile. */
function RightToggle() {
  const open = useLayout((s) => s.rightOpen);
  const reviewing = useProposals((s) => s.open && !!s.proposal);
  return (
    <button
      className="icon-btn panel-toggle"
      data-testid="right-toggle"
      disabled={reviewing}
      aria-pressed={open && !reviewing}
      aria-label="Right column"
      title={open ? 'Hide the right column' : 'Show the right column: Inspector, Layers, Assets and History'}
      onClick={() => useLayout.getState().setRightOpen(!open)}
    >
      <Icon name="panelRight" />
    </button>
  );
}

/** Layout edits the base values; Animate keys them at the playhead. One switch; A toggles it too. */
function ModeToggle() {
  const editMode = useEditor((s) => s.editMode);
  const animate = editMode === 'animate';
  return (
    <button
      className={`mode-toggle ${editMode}`}
      data-testid="mode-toggle"
      data-mode={editMode}
      role="switch"
      aria-checked={animate}
      aria-label="Animate mode"
      title={animate ? 'Animate: changes key the property at the playhead. Switch to Layout (A)' : 'Layout: changes edit the base layout. Switch to Animate (A)'}
      onClick={() => useEditor.getState().setEditMode(animate ? 'layout' : 'animate')}
    >
      <span className={`seg ${animate ? '' : 'on'}`}>Layout</span>
      <span className={`seg ${animate ? 'on' : ''}`}>Animate</span>
    </button>
  );
}

const THEME_ICON: Record<ThemeChoice, IconName> = { system: 'system', light: 'sun', dark: 'moon' };

/** System → Light → Dark, one click (or ⌥⇧T) at a time; the icon shows the current choice. */
function ThemeToggle() {
  const choice = useTheme((s) => s.choice);
  const label = `Theme: ${themeLabel(choice)}. Switch to ${themeLabel(nextTheme(choice))} (${shortcutLabel('T', ['alt', 'shift'])})`;
  return (
    <button className="icon-btn" data-testid="theme-toggle" title={label} aria-label={label} onClick={() => cycleTheme()}>
      <Icon name={THEME_ICON[choice]} />
    </button>
  );
}

/** `editing`: the preview and its transport are showing (not the storyboard picker or a proposal's review), so Layout / Animate applies. */
export function StageHeader({ editing = true }: { editing?: boolean } = {}) {
  const canUndo = useEditor((s) => s.doc.undoStack.length > 0);
  const canRedo = useEditor((s) => s.doc.redoStack.length > 0);
  const undoLabel = useEditor((s) => s.doc.undoStack.at(-1)?.label);
  const redoLabel = useEditor((s) => s.doc.redoStack.at(-1)?.label);
  const warnings = useAssetWarnings();
  const st = useEditor.getState;
  return (
    <header className="stage-head">
      <div className="stage-head-start">
        <Menubar />
        <SaveStatus />
      </div>
      {editing ? <ModeToggle /> : <span aria-hidden />}
      <div className="stage-head-end">
        {warnings.length > 0 && (
          <button
            className="chip warn"
            data-testid="asset-warning-chip"
            onClick={() => useLayout.getState().setRightTab('assets')}
            title={`${warnings.length} asset ${warnings.length === 1 ? 'warning' : 'warnings'}: missing or unset files (opens Assets)`}
            aria-label={`${warnings.length} asset ${warnings.length === 1 ? 'warning' : 'warnings'}`}
          >
            <Icon name="warning" size={13} /> {warnings.length}
          </button>
        )}
        <div className="history-group" role="group" aria-label="History">
          <button className="icon-btn" data-testid="undo" disabled={!canUndo} onClick={() => st().undo()} title={canUndo ? `Undo ${undoLabel} (${shortcutLabel('Z', ['mod'])})` : 'Nothing to undo'}>
            <Icon name="undo" />
          </button>
          <button className="icon-btn" data-testid="redo" disabled={!canRedo} onClick={() => st().redo()} title={canRedo ? `Redo ${redoLabel} (${shortcutLabel('Z', ['shift', 'mod'])})` : 'Nothing to redo'}>
            <Icon name="redo" />
          </button>
        </div>
        <ThemeToggle />
        <button className="icon-btn" data-testid="settings-open" title={`Settings (${shortcutLabel(',', ['mod'])})`} aria-label="Settings" onClick={() => useLayout.getState().openSettings()}>
          <Icon name="settings" />
        </button>
        <ExportMenu />
        <span className="stage-head-rule" aria-hidden />
        <div className="panel-toggles" role="group" aria-label="Panels">
          <RightToggle />
          <ChatToggle />
        </div>
      </div>
    </header>
  );
}
