// "New video" and "Size & frame rate" state: the brief being written in the
// chat, which create dialog is open, and the outline the chat agent proposed.
//
// New video is prompt-first:
// 1. "New video…" opens a blank project (openBlank) and focuses the chat. The
//    chat's empty state on that untouched project is the brief: a prompt,
//    attachments (brand files, a music track), Length, Format and "Outline
//    first" (BriefComposer.tsx).
// 2. Sending it (draftOutline) asks the chat's agent for an outline, or, with
//    "Outline first" off, to build the video straight away.
// 3. The outline arrives as the bridge command `proposeOutline`
//    (receiveOutline) and shows as a card in the conversation, editable;
//    Expand opens the same review in a wide dialog.
// 4. Approve fills the open blank project in place (same id, so its chat and
//    its server record stay) and asks the agent, in the same chat, to build it.
//    How the build lands follows the chat's Auto-apply switch (the outline card
//    and dialog show it as "Review each scene" / "Build it all"): off, one
//    proposal per scene, each reviewed before the next; on, every scene is
//    applied as it is built and the user iterates afterwards. When the open
//    project already has content, Approve creates and opens a new project
//    instead. Decline only records the answer.
// The outline and its status live here, never in a document; agents read them
// from EditorContext.outline (agentBridge.ts).

import type { KeyboardEvent } from 'react';
import { create } from 'zustand';
import type { AgentProviderId, ChatAttachment, OutlineDraft, OutlineStatus, OutlineSummary } from '../core/api-contract';
import { createDocState } from '../core/history';
import { newId } from '../core/ids';
import type { BeatsResponse } from '../core/beats';
import { applyOutline, formatOf, isUntouched } from '../core/newProject';
import { buildScenesPrompt, buildSkeletonProject, directBuildPrompt, likelyLogo, musicFile, outlineRequestPrompt, parseOutline, type BrandFile, type BriefMusic, type BriefTempo, type Outline, type VideoBrief } from '../core/outline';
import type { Project } from '../core/types';
import { validateProject } from '../core/validate';
import { api, errorText } from './api';
import { fetchBeats } from './audioBeats';
import { cancelChat, loadChat, providerLabel, sendChat, setChatSettings, useChat } from './chat';
import { serializeDoc, writeAutosave } from './doc';
import { isTyping } from './editActions';
import { useLayout } from './layout';
import { openBlank, saveToServer } from './persistence';
import { useProposals } from './proposals';
import { useEditor } from './store';

/** 'review': the outline review, expanded into a wide dialog. */
export type CreateDialog = 'format' | 'review' | null;
/** 'drafting': the agent was asked for an outline; 'review': one is pending. */
export type NewVideoStep = 'idle' | 'drafting' | 'review';

export interface BriefDraft extends VideoBrief {
  provider: AgentProviderId;
  /** '' = the agent's default model. */
  model: string;
}

interface CreateState {
  dialog: CreateDialog;
  step: NewVideoStep;
  brief: BriefDraft;
  /** "Outline first" in the brief composer; off asks the agent to build straight away. */
  outlineFirst: boolean;
  /** Bumped to focus the chat composer (New video). */
  composerFocus: number;
  /** The chat message that asked for the outline (to tell when its turn ended). */
  request: string | null;
  /** The agent's turn ended without proposing an outline. */
  noOutline: boolean;
  outline: Outline | null;
  status: OutlineStatus | null;
  /** Who proposed the outline. */
  agent: string | null;
  targetSeconds: number;
  /** approved: the project filled or created for it. */
  projectId: string | null;
  approving: boolean;
}

/** An empty brief. The length carries over; format and agent are read again when it is sent. */
export function freshBrief(prev?: BriefDraft): BriefDraft {
  return {
    brief: '',
    audience: '',
    tone: '',
    targetSeconds: prev?.targetSeconds ?? 30,
    ...formatOf(useEditor.getState().doc.project),
    brandColors: [],
    files: [],
    provider: useChat.getState().provider,
    model: useChat.getState().model,
  };
}

export const useCreate = create<CreateState>()(() => ({
  dialog: null,
  step: 'idle',
  brief: freshBrief(),
  outlineFirst: true,
  composerFocus: 0,
  request: null,
  noOutline: false,
  outline: null,
  status: null,
  agent: null,
  targetSeconds: 30,
  projectId: null,
  approving: false,
}));

const set = useCreate.setState;
const get = useCreate.getState;

/** Reveal the composer before requesting focus, including when chat starts closed. */
export function requestComposerFocus(): void {
  useLayout.getState().setChatOpen(true);
  set((s) => ({ composerFocus: s.composerFocus + 1 }));
}

/**
 * "New video…": open a blank project in the current format, and write the
 * brief in the chat. The outgoing project's latest edits are saved first (the
 * switch would cancel their pending autosave), a pending outline is dropped
 * (it was for that project), and the chat follows the new project even while
 * the previous project's agent is still answering.
 */
export async function openNewVideo(): Promise<boolean> {
  const session = useEditor.getState().docSession;
  if ((await saveOutgoing('New video')) !== 'saved') return false;
  // The await yields even with nothing to save: whatever opened meanwhile stays.
  if (useEditor.getState().docSession !== session) return false;
  openBlank();
  const s = get();
  set({ brief: freshBrief(s.brief), outline: null, status: null, step: 'idle', request: null, noOutline: false, agent: null, projectId: null, dialog: null });
  requestComposerFocus();
  await loadChat(useEditor.getState().doc.project.id);
  return true;
}

/**
 * Before switching away from the open project: its latest edits are saved
 * when it lives on the server (or is a `new` project that changed), so the
 * switch cannot lose them. 'saved': go ahead. 'changed': the user opened
 * something else meanwhile, which is what stays open. 'unsaved': two saves
 * failed; the project stays open and a toast says so.
 */
async function saveOutgoing(action: string): Promise<'saved' | 'changed' | 'unsaved'> {
  const st = useEditor.getState();
  const session = st.docSession;
  const isDirty = () => useEditor.getState().doc.project.revision !== useEditor.getState().cleanRevision;
  if ((st.origin.kind === 'server' || st.origin.kind === 'new') && isDirty()) {
    // Twice: the first save can fail, or edits can land while it runs.
    for (let attempt = 0; attempt < 2 && isDirty(); attempt++) {
      await saveToServer({ quiet: true });
      if (useEditor.getState().docSession !== session) return 'changed';
    }
    if (isDirty()) {
      const now = useEditor.getState();
      now.toast({ tone: 'error', message: `“${now.doc.project.name}” could not be saved, so it stays open.`, hint: `Save it (⌘S) or export JSON, then try ${action} again.` });
      return 'unsaved';
    }
  }
  return useEditor.getState().docSession === session ? 'saved' : 'changed';
}

export const openFormat = () => set({ dialog: 'format' });
/** The pending outline in the wide review dialog (its chat card hides meanwhile). */
export const expandOutline = () => set({ dialog: 'review' });
export const closeCreateDialog = () => set({ dialog: null });

/** Keys inside a create dialog stay there (no editor shortcuts); Escape outside a field closes it. */
export function dialogKeyDown(e: KeyboardEvent) {
  e.stopPropagation();
  if (e.key === 'Escape' && !isTyping(e.target)) closeCreateDialog();
}
export const setBrief = (changes: Partial<BriefDraft>) => set({ brief: { ...get().brief, ...changes } });
export const setOutlineFirst = (outlineFirst: boolean) => set({ outlineFirst });
export const editOutline = (fn: (o: Outline) => Outline) => {
  const outline = get().outline;
  if (outline) set({ outline: fn(outline) });
};

// ---- Music --------------------------------------------------------------

/** The beats endpoint's analysis as the brief keeps it (seconds). */
export function tempoOf(b: BeatsResponse): BriefTempo {
  return { bpm: b.bpm, confidence: b.confidence, durationSeconds: b.durationSeconds, downbeatSeconds: b.downbeats.map((f) => Math.round((f / b.fps) * 1000) / 1000) };
}

export const setMusic = (changes: Partial<BriefMusic>) => setBrief({ music: { ...get().brief.music, ...changes } });

/**
 * Use `file` as the new video's music bed (adding it to the brief's files when
 * it is new), then read its tempo and bar starts for the outline request.
 */
export async function chooseMusic(file: BrandFile): Promise<void> {
  const b = get().brief;
  setBrief({ files: b.files.some((f) => f.id === file.id) ? b.files : [...b.files, file], music: { ...b.music, fileId: file.id, tempo: undefined } });
  const beats = await fetchBeats(file.src, b.fps);
  const now = get().brief;
  if (!beats || now.music?.fileId !== file.id) return;
  // The analysis also knows the length when the upload probe could not tell.
  const files = now.files.map((f) => (f.id === file.id && !f.durationSeconds ? { ...f, durationSeconds: beats.durationSeconds } : f));
  setBrief({ files, music: { ...now.music, tempo: tempoOf(beats) } });
}

/**
 * Take an audio file out of the brief (it no longer becomes the music bed or
 * an asset). When it was the bed and another track remains, that track becomes
 * the chosen bed and is analysed (chooseMusic), so its beats stay usable.
 */
export function removeMusicFile(id: string): Promise<void> {
  const b = get().brief;
  const wasBed = musicFile(b)?.id === id;
  setBrief({ files: b.files.filter((f) => f.id !== id), ...(wasBed ? { music: { ...b.music, fileId: undefined, tempo: undefined, snapToBeats: false } } : {}) });
  const next = wasBed ? musicFile(get().brief) : undefined;
  return next ? chooseMusic(next) : Promise.resolve();
}

// ---- The brief, sent from the chat ---------------------------------------

/** The agent answering in the chat now. */
export const agentName = () => providerLabel(useChat.getState().providers, useChat.getState().provider);

/** Which attachments of a brief become the logo and the music bed (indexes, for the composer's tags). */
export function briefRoles(attachments: readonly ChatAttachment[]): { logo?: number; music?: number } {
  const files = attachments.map((a, i) => ({ ...a, id: String(i) }));
  const logo = likelyLogo(files.filter((f) => f.kind !== 'video'));
  const music = files.find((f) => f.kind === 'audio')?.id;
  return { ...(logo !== undefined ? { logo: Number(logo) } : {}), ...(music !== undefined ? { music: Number(music) } : {}) };
}

export interface BriefInput {
  text: string;
  attachments: ChatAttachment[];
  /** true: ask for an outline to approve first; false: ask the agent to build straight away. */
  outlineFirst: boolean;
}

/**
 * Send the brief written in the chat to the chat's agent. Images become brand
 * files (the likeliest one the logo); the first audio file becomes the music
 * bed, analysed for its beats before the message goes. Format comes from the
 * open project, length from the composer.
 */
export async function draftOutline(input: BriefInput): Promise<boolean> {
  const text = input.text.trim();
  if (!text) return false;
  const files: BrandFile[] = input.attachments.filter((a) => a.kind !== 'video').map((a) => ({ ...a, id: newId('ast') }));
  const visual = files.filter((f) => f.kind !== 'audio');
  const [bed, ...otherTracks] = files.filter((f) => f.kind === 'audio');
  set({ brief: { ...freshBrief(get().brief), brief: text, files: [...visual, ...otherTracks], logoId: likelyLogo(visual) } });
  const session = useEditor.getState().docSession;
  if (bed) await chooseMusic(bed);
  // Another project was opened while the track was analysed: this brief was for the previous one.
  if (useEditor.getState().docSession !== session) return false;
  const brief = get().brief;
  const request = input.outlineFirst ? outlineRequestPrompt(brief) : directBuildPrompt(brief);
  // The files go along so the agent can look at them.
  if (!(await sendChat(request, input.attachments))) return false;
  if (input.outlineFirst) set({ step: 'drafting', request, noOutline: false, outline: null, status: null, agent: null, projectId: null });
  else set({ step: 'idle', request: null, noOutline: false });
  return true;
}

export async function stopDrafting() {
  await cancelChat();
  set({ step: 'idle', request: null });
}

export type ReceiveResult = { ok: true; outline: Outline } | { ok: false; message: string; path?: string };

/** An agent proposed an outline (bridge command): it shows as a card in the chat, replacing a pending one. */
export function receiveOutline(draft: OutlineDraft, agent: string): ReceiveResult {
  const parsed = parseOutline(draft);
  if (!parsed.ok) return parsed;
  const s = get();
  // An outline nobody asked for (e.g. from an agent in a terminal) is reviewed against the open project's format.
  const target = s.step === 'drafting' || s.brief.brief.trim() ? s.brief.targetSeconds : Math.round(parsed.outline.scenes.reduce((n, sc) => n + sc.durationSeconds, 0));
  const brief = s.brief.brief.trim() ? s.brief : { ...s.brief, ...formatOf(useEditor.getState().doc.project), targetSeconds: target };
  set({ outline: parsed.outline, status: 'pending', agent, targetSeconds: target, projectId: null, brief, dialog: null, step: 'review', noOutline: false });
  return { ok: true, outline: parsed.outline };
}

export function declineOutline() {
  if (get().status !== 'pending') return;
  set({ status: 'declined', dialog: null, step: 'idle' });
}

/**
 * Approve the outline. An untouched open project (the blank one New video
 * made) is filled in place; otherwise a new project is created and opened.
 * Either way the project is saved on the server, then the agent is asked to
 * build it.
 */
export async function approveOutline(): Promise<boolean> {
  const { outline, approving } = get();
  if (!outline?.scenes.length || approving) return false;
  set({ approving: true });
  try {
    const { doc, docSession } = useEditor.getState();
    // A project filled from an outline is work, even when the outline had one scene and no file.
    return isUntouched(doc.project) && !filledInPlace.has(docSession) ? await fillOpenProject(outline) : await createProject(outline);
  } finally {
    set({ approving: false });
  }
}

/** Document sessions filled in place from an outline: a second outline creates a new project beside them. */
const filledInPlace = new Set<string>();

const NOT_SENT = { sent: false, autoApply: false };

/**
 * Hand the approved outline to the agent in the chat. The build follows the
 * chat's Auto-apply as it is now (the same value goes with the message): off,
 * the agent proposes one scene at a time for review; on, it builds every scene
 * straight through and the user iterates afterwards.
 */
async function sendBuild(outline: Outline, brief: VideoBrief, project: Project, created: boolean): Promise<{ sent: boolean; autoApply: boolean }> {
  const autoApply = useProposals.getState().autoApply;
  const sent = await sendChat(buildScenesPrompt(outline, brief, project, { created, autoApply }), []);
  return { sent, autoApply };
}

/** The toast's second line once the agent was asked to build: what happens next, by the Auto-apply it was sent with. */
const buildHint = (autoApply: boolean) => (autoApply ? 'Auto-apply is on: the scenes land as they are built; iterate in the chat when it hands over.' : 'Review each scene’s proposal as it arrives.');

/** The in-place path: the open blank project becomes the outline's skeleton, keeping its id and chat. */
async function fillOpenProject(outline: Outline): Promise<boolean> {
  const st = useEditor.getState();
  const open = st.doc.project;
  // The format is the open project's now (the Format chip may have changed it since the brief was sent).
  const brief = { ...get().brief, ...formatOf(open) };
  const filled = applyOutline(open, outline, brief, { scene: () => newId('scn'), audioClip: () => newId('aud') });
  const project = { ...filled, revision: open.revision + 1 };
  const valid = validateProject(project);
  if (!valid.ok) {
    st.toast({ tone: 'error', message: `Could not fill the project: ${valid.error.message}`, path: valid.error.path, hint: valid.error.hint });
    return false;
  }
  const doc = createDocState(project);
  st.loadDocument(doc, st.origin.kind === 'server' ? st.origin : { kind: 'new' });
  // Dirty until the save lands, so browser recovery and the autosave cover it meanwhile.
  useEditor.setState({ cleanRevision: open.revision });
  set({ status: 'approved', projectId: project.id, dialog: null, step: 'idle', request: null, brief: freshBrief(brief) });

  // Messages go to whatever project is open: stop if the user opens another one meanwhile.
  const session = useEditor.getState().docSession;
  const stillOpen = () => useEditor.getState().docSession === session;
  filledInPlace.add(session);
  // Through the shared save queue (after any save in flight, so an older one cannot land on top), to the project's file.
  await saveToServer({ quiet: true, canonical: true });
  // Saving failed: keep a browser recovery copy now (the autosave only reacts to the next edit).
  if (stillOpen() && useEditor.getState().doc.project.revision !== useEditor.getState().cleanRevision) writeAutosave(useEditor.getState().doc, session);

  const name = agentName();
  const { sent, autoApply } = stillOpen() ? await sendBuild(outline, brief, project, false) : NOT_SENT;
  const n = project.scenes.length;
  useEditor.getState().toast({
    tone: 'success',
    message: `“${project.name}” has ${n} scene${n === 1 ? '' : 's'}; ${sent ? `${name} is building ${autoApply ? 'all of it' : 'it'}.` : 'nothing is built yet.'}`,
    hint: sent ? buildHint(autoApply) : stillOpen() ? `Ask ${name} in the chat to build it.` : `Open “${project.name}” and ask ${name} in its chat to build it.`,
  });
  return true;
}

/** The open project has content: create the outline's project next to it, open it, and hand it over there. */
async function createProject(outline: Outline): Promise<boolean> {
  const { brief, agent } = get();
  const st = useEditor.getState();
  const project = buildSkeletonProject(outline, brief, { project: newId('prj'), scene: () => newId('scn'), audioClip: () => newId('aud') });
  const valid = validateProject(project);
  if (!valid.ok) {
    st.toast({ tone: 'error', message: `Could not create the project: ${valid.error.message}`, path: valid.error.path, hint: valid.error.hint });
    return false;
  }
  // Keep the open project's latest edits before switching away from it (a `new` project whose fill failed to save included).
  const outgoing = st.docSession;
  if ((await saveOutgoing('Approve')) !== 'saved') return false;
  // The await yields even with nothing to save: whatever opened meanwhile stays.
  if (useEditor.getState().docSession !== outgoing) return false;
  const doc = createDocState(project);
  let savedAt: string | null = null;
  try {
    savedAt = (await api.saveProject(serializeDoc(doc))).savedAt;
  } catch (e) {
    st.toast({ tone: 'error', message: `“${project.name}” was created but not saved: ${errorText(e).message}`, hint: 'Save it once the local server is back.' });
  }
  useEditor.getState().loadDocument(doc, savedAt ? { kind: 'server', id: project.id } : { kind: 'file', name: project.name }, savedAt);
  set({ status: 'approved', projectId: project.id, dialog: null, step: 'idle', request: null, brief: freshBrief(brief) });

  // Hand over to the agent in the new project's conversation. Chat settings
  // and messages go to whatever project is open, so stop if the user opens
  // another one while a request is in flight.
  const session = useEditor.getState().docSession;
  const stillOpen = () => useEditor.getState().docSession === session;
  await loadChat(project.id);
  const name = providerLabel(useChat.getState().providers, brief.provider);
  const { sent, autoApply } = stillOpen() && (await setChatSettings(brief.provider, brief.model)) && stillOpen() ? await sendBuild(outline, brief, project, true) : NOT_SENT;
  useEditor.getState().toast({
    tone: 'success',
    message: `Created “${project.name}” with ${project.scenes.length} empty scene${project.scenes.length === 1 ? '' : 's'}.`,
    hint: sent
      ? `${name} is building it ${autoApply ? 'straight through' : 'scene by scene'}. ${buildHint(autoApply)}`
      : stillOpen() ? `Ask ${agent ?? name} in the chat to build it.` : `Open “${project.name}” and ask ${agent ?? name} in its chat to build it.`,
  });
  return true;
}

/** The outline as agents see it in editor_get_context. */
export function outlineSummary(): OutlineSummary | null {
  const { outline, status, agent, targetSeconds, projectId } = get();
  if (!outline || !status) return null;
  return { status, title: outline.title, scenes: outline.scenes, ...(outline.story ? { story: outline.story } : {}), ...(agent ? { agent } : {}), targetSeconds, ...(projectId ? { projectId } : {}) };
}

// A drafting turn that ends without an outline: say so instead of waiting forever.
useChat.subscribe((chat, prev) => {
  const s = get();
  if (s.step !== 'drafting' || !s.request || !prev.busy || chat.busy) return;
  const asked = chat.messages.findLastIndex((m) => m.role === 'user' && m.text === s.request);
  if (asked >= 0 && chat.messages.slice(asked + 1).some((m) => m.role === 'assistant' && m.status !== 'running' && m.status !== 'queued')) set({ noOutline: true });
});
