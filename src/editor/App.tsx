// The editor's shell. The header runs across the top (StageHeader.tsx). Under
// it, left to right: the tool rail, the stage (preview, transport row, scene
// strip), the right column (Inspector, Layers, Assets, History) and the chat
// docked at the far right, full height, closed by default and resizable from
// its left edge. The timeline runs across the bottom under all but the chat.
// Each panel folds away on its own and the stage takes the room (layout.ts
// remembers which are open). A pending proposal's review owns the stage while
// it is open: no right column and no timeline beside or under it.

import { useEffect, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { isUntouched } from '../core/newProject';
import { handleShellShortcut } from './actions';
import { startAgentBridge } from './agentBridge';
import { startChatSync } from './chat';
import { api, onServerStatus } from './api';
import { useAssetFileChecks } from './AssetsPanel';
import { ChatPanel } from './ChatPanel';
import { CommandPalette } from './CommandPalette';
import { ContextMenuHost } from './ContextMenu';
import { canvasKeyDown, canvasKeyUp } from './canvasControls';
import { useCreate } from './createFlow';
import { CutPicker } from './CutPicker';
import { useCutPicker } from './firstCut';
import { installOutcomeTracker } from './generationOutcomes';
import { deleteSelected, editContext, guardLocked, isFocusedControl, isTyping, nudgeSelected, reorderSelected, selectParent } from './editActions';
import { CHAT_DEFAULT_W, CHAT_MAX_W, CHAT_MIN_W, useLayout } from './layout';
import { CreateDialogs } from './NewVideoDialog';
import { bootProject, saveToServer, startAutosave, startServerAutosave } from './persistence';
import { togglePlayback } from './playback';
import { PermissionPrompt } from './PermissionPrompt';
import { ProposalReview } from './ProposalReview';
import { useProposals } from './proposals';
import { RightColumn } from './RightColumn';
import { claimFromUrl, watchSession, whileUnlocked } from './session';
import { SettingsDialog } from './SettingsDialog';
import { Sheets } from './Sheets';
import { ShortcutsSheet } from './ShortcutsSheet';
import { SimpleTimeline } from './SimpleTimeline';
import { Stage } from './Stage';
import { StageHeader } from './StageHeader';
import { useEditor } from './store';
import { StylePanel } from './StylePanel';
import { cycleTheme } from './theme';
import { Timeline } from './Timeline';
import { addFromRail, pickTool, setHandLatch, ToolRail } from './ToolRail';
import { LockedBanner, OpenDialog, RecoveryBanner, Toasts } from './TopBar';
import { stepFrame, Transport } from './Transport';

function onKeyDown(e: KeyboardEvent) {
  const st = useEditor.getState();
  const mod = e.metaKey || e.ctrlKey;
  // The shell's own keys first: palette, chat, settings, right-column tabs (actions.ts).
  if (handleShellShortcut(e)) return;
  if (mod && e.key.toLowerCase() === 'z') {
    if (isTyping(e.target)) return; // let fields undo their own text
    e.preventDefault();
    if (e.shiftKey) st.redo();
    else st.undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void saveToServer();
    return;
  }
  if (mod && (e.key === ']' || e.key === '[') && !isTyping(e.target) && !useProposals.getState().open && !st.sheet && !useLayout.getState().overlay) {
    e.preventDefault();
    reorderSelected(e.key === ']' ? 1 : -1);
    return;
  }
  if (isTyping(e.target)) return;
  // ⌥⇧T: the next theme. Matched on the physical key, since ⌥ turns e.key into a glyph on a Mac.
  if (e.altKey && e.shiftKey && !mod && e.code === 'KeyT') {
    e.preventDefault();
    cycleTheme();
    return;
  }
  // The cut picker's browse dialog has its own keys (CutPicker.tsx).
  if (useCutPicker.getState().browse) return;
  // The proposal review has its own keys (ProposalReview.tsx); a sheet has its own Escape (Sheets.tsx);
  // Settings, the palette and the shortcuts sheet own the keyboard while open (undo and save still reach the editor).
  if (useProposals.getState().open || st.sheet || useLayout.getState().overlay) return;
  // V and P (canvasControls.ts) also let go of a latched hand tool.
  if (!mod && !e.altKey && !e.shiftKey && /^[vp]$/i.test(e.key)) setHandLatch(false);
  // Zoom / fit / hand tool, select all, group, Tab, Enter, the pen.
  if (canvasKeyDown(e)) return;
  if (mod || e.altKey) return;
  const hasElement = !!st.selection.elementId;
  switch (e.key) {
    case ' ':
      if (isFocusedControl(e.target)) return;
      e.preventDefault();
      togglePlayback(e);
      return;
    case ',':
      stepFrame(-1);
      return;
    case '.':
      stepFrame(1);
      return;
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown': {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      if (!hasElement) {
        if (e.key === 'ArrowLeft') stepFrame(-step);
        if (e.key === 'ArrowRight') stepFrame(step);
        return;
      }
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      nudgeSelected(dx, dy);
      return;
    }
    case 'Escape':
      // Keyframe first, then up out of a group, then nothing selected (the inspector shows the scene).
      if (st.selectedKeyframe) st.selectKeyframe(null);
      else if (selectParent()) return;
      else if (hasElement) st.select({ elementId: null });
      else if (st.sceneInspectorOpen) st.setSceneInspectorOpen(false);
      return;
    case 'a':
    case 'A':
      st.setEditMode(st.editMode === 'layout' ? 'animate' : 'layout');
      return;
    // The rail's letters (ToolRail.tsx); V and P are in canvasControls.ts.
    case 'h':
    case 'H':
      if (!e.shiftKey) pickTool('hand');
      return;
    case 't':
    case 'T':
      if (!e.shiftKey) addFromRail('text');
      return;
    case 'r':
    case 'R':
      if (!e.shiftKey) addFromRail('shape');
      return;
    case 'i':
    case 'I':
      if (!e.shiftKey) addFromRail('image');
      return;
    case 'Delete':
    case 'Backspace': {
      const ctx = editContext();
      if (!ctx?.element) return;
      e.preventDefault();
      if (guardLocked(ctx.scene)) return;
      const k = st.selectedKeyframe;
      if (k) {
        if (st.run({ type: 'removeKeyframe', sceneId: ctx.scene.id, elementId: ctx.element.id, property: k.property, frame: k.frame }, `Remove ${k.property} keyframe`)) st.selectKeyframe(null);
      } else {
        deleteSelected();
      }
      return;
    }
  }
}

export function App() {
  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', canvasKeyUp);
    const stopAutosave = startAutosave();
    const stopServerAutosave = startServerAutosave();
    // The editor link first (session.ts): the agent bridge is the user's, so it runs only
    // while this tab is unlocked, and stops when it locks (a restarted server forgets it).
    const stopSessionWatch = watchSession();
    void claimFromUrl();
    const stopBridge = whileUnlocked(startAgentBridge);
    const stopChat = startChatSync();
    // Studio takes used, replaced or deleted (generationOutcomes.ts).
    const stopOutcomes = installOutcomeTracker();
    const stopStatus = onServerStatus((up) => useEditor.getState().setServer(up ? 'up' : 'down'));
    void bootProject();
    const ping = () => api.listProjects().catch(() => undefined);
    void ping();
    const t = setInterval(ping, 15000);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', canvasKeyUp);
      stopAutosave();
      stopServerAutosave();
      stopBridge();
      stopSessionWatch();
      stopChat();
      stopOutcomes();
      stopStatus();
      clearInterval(t);
    };
  }, []);

  return <Editor />;
}

/** The chat's left edge, 6 px: drag (or the arrow keys, 16 px a step) to resize it, double-click for the default width. */
function ChatEdge() {
  const width = useLayout((s) => s.chatWidth);
  const drag = useRef<{ x: number; w: number; max: number } | null>(null);
  const edgeRef = useRef<HTMLDivElement>(null);
  // Never so wide the stage drops under --stage-min (styles.css), nor past 300–560 px (layout.ts).
  const maxWidth = () => {
    const edge = edgeRef.current;
    const app = edge?.closest<HTMLElement>('.app');
    const stage = app?.querySelector<HTMLElement>('.stage-column');
    if (!edge?.parentElement || !app || !stage) return CHAT_MAX_W;
    const stageMin = parseFloat(getComputedStyle(app).getPropertyValue('--stage-min')) || 0;
    return Math.max(CHAT_MIN_W, Math.min(CHAT_MAX_W, edge.parentElement.offsetWidth + stage.offsetWidth - stageMin));
  };
  const setWidth = (w: number, max = maxWidth()) => useLayout.getState().setChatWidth(Math.min(max, w));
  const end = () => {
    drag.current = null;
    edgeRef.current?.closest('.app')?.classList.remove('is-resizing');
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: e.currentTarget.parentElement?.offsetWidth ?? width, max: maxWidth() };
    e.currentTarget.closest('.app')?.classList.add('is-resizing');
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // The edge moves with the arrow: left widens the chat. Home / End go to the extremes.
    const step = e.key === 'ArrowLeft' ? 16 : e.key === 'ArrowRight' ? -16 : 0;
    if (!step && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    e.stopPropagation();
    setWidth(e.key === 'Home' ? CHAT_MAX_W : e.key === 'End' ? CHAT_MIN_W : width + step);
  };
  return (
    <div
      ref={edgeRef}
      className="chat-edge"
      role="separator"
      aria-orientation="vertical"
      aria-label="Chat width"
      aria-valuenow={width}
      aria-valuemin={CHAT_MIN_W}
      aria-valuemax={CHAT_MAX_W}
      tabIndex={0}
      title="Drag to resize the chat; double-click for the default width"
      data-testid="chat-resize"
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) setWidth(d.w + d.x - e.clientX, d.max);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => setWidth(CHAT_DEFAULT_W)}
      onKeyDown={onKeyDown}
    />
  );
}

function Editor() {
  const reviewing = useProposals((s) => s.open && !!s.proposal);
  const timelineOpen = useEditor((s) => s.timelineOpen) && !reviewing;
  // A review owns the stage: no right column and no timeline beside or under it.
  const rightOpen = useLayout((s) => s.rightOpen) && !reviewing;
  // A blank project's stage is the cut picker until the user describes it in the chat instead, or a brief is under way.
  const briefBusy = useCreate((s) => s.step !== 'idle' || s.status === 'pending');
  const dismissed = useCutPicker((s) => s.dismissed);
  const picking = useEditor((s) => isUntouched(s.doc.project) && s.docSession !== dismissed) && !briefBusy && !reviewing;
  // A closed chat stays mounted (its draft and scroll survive); its permission asks float over the stage instead.
  const chatOpen = useLayout((s) => s.chatOpen);
  const chatWidth = useLayout((s) => s.chatWidth);
  useAssetFileChecks();

  return (
    <div className={`app ${rightOpen ? 'right-open' : ''} ${chatOpen ? 'chat-open' : ''}`} style={{ '--chat-w': `${chatWidth}px` } as CSSProperties} data-testid="editor">
      <div className="stage-head-area">
        <StageHeader editing={!reviewing && !picking} />
        <RecoveryBanner />
        <LockedBanner />
      </div>
      <ToolRail />
      <main className={`stage-column ${reviewing ? 'is-reviewing' : ''}`} data-testid="stage-column">
        {reviewing ? (
          // Its header row, the plates with the change list, and its transport row take the stage's grid areas.
          <ProposalReview />
        ) : picking ? (
          <section className="stage-view" aria-label="Start from a storyboard">
            <CutPicker />
          </section>
        ) : (
          <>
            <section className="stage-view" aria-label="Preview">
              <Stage />
            </section>
            <Transport />
          </>
        )}
        {!picking && (
          <section className="stage-scenes" aria-label="Scenes">
            <SimpleTimeline transport={false} />
          </section>
        )}
      </main>
      {rightOpen && (
        <div className="right-column" data-testid="right-column">
          <RightColumn />
        </div>
      )}
      {timelineOpen && (
        <section className="stage-bottom" data-testid="stage-bottom">
          <Timeline />
        </section>
      )}
      <aside className="chat-column" aria-label="Chat" inert={!chatOpen} data-testid="chat-column">
        <ChatEdge />
        <ChatPanel />
      </aside>
      {!chatOpen && <PermissionPrompt floating />}
      <Sheets />
      <CreateDialogs />
      <StylePanel />
      <SettingsDialog />
      <CommandPalette />
      <ShortcutsSheet />
      <ContextMenuHost />
      <OpenDialog />
      <Toasts />
    </div>
  );
}
