// Scene-led music and narration planning. These helpers only return data or
// commands; callers review and apply them through the normal proposal path.
import { duckUnder, likelyVoiceClips, trimEnvelope } from './audioDucking';
import { applyCommand } from './commands';
import type { GeneratedOutputMeta, ScoreSection } from './generationStudio';
import { projectDurationInFrames, sceneStartFrames } from './timing';
import type { Asset, AudioClip, Command, Project, Scene, StoryBeatRole } from './types';

const roleStyles: Record<StoryBeatRole, string> = {
  hook: 'attention-grabbing intro', setup: 'steady, establishing', tension: 'building tension',
  turn: 'shift, lift', proof: 'confident, driving', payoff: 'full, triumphant',
  cta: 'resolving, clear ending', loop: 'loops back to the opening',
};

function beatsFor(project: Project, scene: Scene) {
  return project.story?.beats.filter((beat) => beat.sceneId === scene.id || !beat.sceneId && beat.sceneName === scene.name) ?? [];
}

/** One section per scene, merging short scenes forward (the last backward),
 * then splitting long sections evenly so no tiny remainder is left. */
export function buildScorePlan(project: Project): ScoreSection[] {
  const sections: ScoreSection[] = [];
  let pending: ScoreSection | undefined;
  for (const scene of project.scenes) {
    const section: ScoreSection = {
      sceneIds: [...pending?.sceneIds ?? [], scene.id],
      seconds: (pending?.seconds ?? 0) + scene.durationInFrames / project.fps,
      styles: [...new Set([...pending?.styles ?? [], ...beatsFor(project, scene).map((beat) => roleStyles[beat.role])])],
      label: pending ? `${pending.label} / ${scene.name}` : scene.name,
    };
    pending = undefined;
    if (section.seconds < 3) pending = section;
    else sections.push(section);
  }
  if (pending) {
    const previous = sections[sections.length - 1];
    if (previous) {
      previous.sceneIds.push(...pending.sceneIds);
      previous.seconds += pending.seconds;
      previous.styles = [...new Set([...previous.styles, ...pending.styles])];
      previous.label = `${previous.label} / ${pending.label}`;
    } else sections.push(pending); // A video shorter than 3 s cannot form a valid fal plan.
  }
  const split = sections.flatMap((section) => {
    const count = Math.ceil(section.seconds / 120);
    return Array.from({ length: count }, () => ({ ...section, sceneIds: [...section.sceneIds], styles: [...section.styles], seconds: section.seconds / count }));
  });
  while (split.length > 30) {
    let index = 0;
    for (let i = 1; i < split.length - 1; i++) if (split[i].seconds + split[i + 1].seconds < split[index].seconds + split[index + 1].seconds) index = i;
    const a = split[index], b = split[index + 1];
    split.splice(index, 2, { sceneIds: [...new Set([...a.sceneIds, ...b.sceneIds])], seconds: a.seconds + b.seconds,
      styles: [...new Set([...a.styles, ...b.styles])], label: `${a.label ?? ''} / ${b.label ?? ''}` });
  }
  return split;
}

/** Explain provider plan limits before a request is submitted. */
export function planProblem(plan: readonly ScoreSection[]): string | null {
  if (!plan.length || plan.length > 30) return 'A score needs between 1 and 30 sections.';
  const total = plan.reduce((sum, section) => sum + section.seconds, 0);
  if (total > 600) return 'The video is longer than 600 seconds.';
  if (!Number.isFinite(total) || total < 3) return 'A score needs at least 3 seconds of video.';
  if (plan.some((section) => !Number.isFinite(section.seconds) || section.seconds < 3 || section.seconds > 120)) return 'Each score section must be between 3 and 120 seconds.';
  return null;
}

/** Story summaries in scene order, including empty lines for unmapped scenes. */
export function narrationLines(project: Project): { sceneId: string; text: string }[] {
  return project.scenes.map((scene) => ({ sceneId: scene.id, text: beatsFor(project, scene).map((beat) => beat.summary).join(' ') }));
}

type Cuts = NonNullable<GeneratedOutputMeta['cuts']>;

/** Nearest downbeat within one bar; positive offsets move a cut later. */
export function cutAlignment(project: Project, downbeats: readonly number[], bpm: number | null, bed: { startFrame: number; trimStartFrames: number } = { startFrame: 0, trimStartFrames: 0 }): Cuts {
  const window = Number.isFinite(bpm) && bpm! > 0 ? project.fps * 240 / bpm! : project.fps * 2;
  const beats = downbeats.filter((frame) => Number.isFinite(frame) && frame >= 0).map((frame) => bed.startFrame + frame - bed.trimStartFrames).filter((frame) => frame >= bed.startFrame).sort((a, b) => a - b);
  const starts = sceneStartFrames(project);
  return project.scenes.slice(1).map((scene, index) => {
    const cutFrame = starts[index + 1];
    const nearest = beats.reduce<number | null>((best, frame) => Math.abs(frame - cutFrame) <= window && (best === null || Math.abs(frame - cutFrame) < Math.abs(best - cutFrame)) ? frame : best, null);
    return { sceneId: scene.id, cutFrame, nearestDownbeatFrame: nearest, offsetFrames: nearest === null ? null : nearest - cutFrame };
  });
}

/** Move cuts within their original-position limit, keeping the complete proposal valid. */
export function snapCutsCommands(project: Project, cuts: Cuts, opts: { maxShiftFrames?: number; bedClipId?: string } = {}): { commands: Command[]; moved: number; aligned: number; skipped: { sceneId: string; why: string }[] } {
  const commands: Command[] = [];
  const skipped: { sceneId: string; why: string }[] = [];
  const starts = sceneStartFrames(project);
  const maxShiftFrames = opts.maxShiftFrames ?? 6;
  let shift = 0, moved = 0, aligned = 0;
  let snapped = project;
  const refit = (next: Project): Command[] => {
    const bed = next.audio.find((clip) => clip.id === opts.bedClipId && !clip.sceneId);
    if (!bed) return [];
    const durationInFrames = Math.max(1, projectDurationInFrames(next) - bed.startFrame);
    const changes: Partial<AudioClip> = { durationInFrames, fadeInFrames: Math.min(bed.fadeInFrames, durationInFrames),
      fadeOutFrames: Math.min(bed.fadeOutFrames, durationInFrames),
      ...(bed.volumeEnvelope ? { volumeEnvelope: trimEnvelope(bed.volumeEnvelope, 0, durationInFrames) } : {}) };
    const fitted = { ...next, audio: next.audio.map((clip) => clip.id === bed.id ? { ...clip, ...changes } : clip) };
    if (bed.volumeEnvelope) {
      const duck = duckUnder(fitted, bed.id, likelyVoiceClips(fitted, bed.id).map((clip) => clip.id));
      if (duck.ok) changes.volumeEnvelope = duck.command.changes.volumeEnvelope;
    }
    return [{ type: 'updateAudioClip', clipId: bed.id, changes }];
  };
  for (let i = 1; i < project.scenes.length; i++) {
    const sceneId = project.scenes[i].id;
    const cut = cuts.find((entry) => entry.sceneId === sceneId);
    if (!cut) continue;
    const skip = (why: string) => skipped.push({ sceneId, why });
    const target = cut.nearestDownbeatFrame;
    if (target === null || !Number.isFinite(target)) { skip('No nearby downbeat'); continue; }
    if (Math.abs(Math.round(target) - starts[i]) > maxShiftFrames) { skip('Downbeat is beyond the maximum shift'); continue; }
    const offset = Math.round(target) - (starts[i] + shift);
    if (!offset) { aligned++; continue; }
    const previous = snapped.scenes[i - 1];
    if (previous.locked) { skip(`Preceding scene "${previous.name}" is locked`); continue; }
    const durationInFrames = previous.durationInFrames + offset;
    const endAligned = previous.elements.filter((element) => !element.parentId && element.startFrame + element.durationInFrames === previous.durationInFrames);
    if (durationInFrames < 1 || durationInFrames < previous.transitionIn.durationInFrames
      || endAligned.some((element) => element.durationInFrames + offset < 1)
      || previous.elements.some((element) => !element.parentId && !endAligned.includes(element) && element.startFrame + element.durationInFrames > durationInFrames)
      || project.audio.some((clip) => clip.sceneId === previous.id && clip.startFrame + clip.durationInFrames > durationInFrames)) {
      skip('Shortening the preceding scene would trim its contents'); continue;
    }
    if (project.markers.some((marker) => marker.frame >= projectDurationInFrames(snapped) + offset)) {
      skip('A marker would be beyond the new project end'); continue;
    }
    const resize: Command[] = endAligned.map((element) => ({ type: 'updateElement', sceneId: previous.id, elementId: element.id, changes: { durationInFrames: element.durationInFrames + offset } }));
    const sceneCommand: Command = { type: 'updateScene', sceneId: previous.id, changes: { durationInFrames } };
    const proposed = { ...snapped, scenes: snapped.scenes.map((scene) => scene.id === previous.id ? { ...scene, durationInFrames } : scene) };
    const nextCommands = [...commands, ...resize, sceneCommand];
    const checked = applyCommand(project, { type: 'batch', label: 'Snap cuts', commands: [...nextCommands, ...refit(proposed)] }, { source: 'ai' });
    if (!checked.ok) { skip(`Scene contents cannot fit: ${checked.error.message}`); continue; }
    commands.push(...resize, sceneCommand);
    // Keep the original bed until the final refit so its envelope is rebuilt once.
    snapped = { ...checked.project, audio: project.audio };
    shift += offset;
    moved++;
  }
  for (const cut of cuts) if (!project.scenes.slice(1).some((scene) => scene.id === cut.sceneId)) skipped.push({ sceneId: cut.sceneId, why: 'Scene has no cut in this project' });
  if (moved) commands.push(...refit(snapped));
  return { commands, moved, aligned, skipped };
}

function clipId(project: Project, base: string, reserved: readonly AudioClip[] = []): string {
  const ids = new Set([...project.audio, ...reserved].map((clip) => clip.id));
  let id = base;
  for (let suffix = 2; ids.has(id); suffix++) id = `${base}_${suffix}`;
  return id;
}

/** Place scene-relative voice takes and duck the project bed under all voices. */
export function placeNarrationCommands(project: Project, takes: readonly { asset: Asset; sceneId: string }[], opts: { leadInFrames?: number } = {}): { commands: Command[]; ducked: boolean; trimmed: string[] } {
  const clips: AudioClip[] = [];
  const trimmed: string[] = [];
  const lead = opts.leadInFrames ?? 6;
  if (!Number.isInteger(lead) || lead < 0) throw new Error('leadInFrames must be a non-negative integer');
  for (const { asset, sceneId } of takes) {
    const scene = project.scenes.find((entry) => entry.id === sceneId);
    if (!scene) throw new Error(`Narration scene ${sceneId} not found`);
    if (scene.locked) throw new Error(`Narration scene "${scene.name}" is locked`);
    if (asset.kind !== 'audio') throw new Error(`Narration asset ${asset.id} must be audio`);
    const durationInFrames = Math.min(asset.durationInFrames ?? scene.durationInFrames - lead, scene.durationInFrames - lead);
    if (durationInFrames < 1) throw new Error(`Narration scene "${scene.name}" has no room after the lead-in`);
    if (asset.durationInFrames !== undefined && asset.durationInFrames > scene.durationInFrames - lead && !trimmed.includes(sceneId)) trimmed.push(sceneId);
    clips.push({ id: clipId(project, `aud_narration_${asset.id}_${sceneId}`, clips), assetId: asset.id, name: `Narration: ${asset.name}`,
      sceneId, startFrame: lead, trimStartFrames: 0, durationInFrames, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 });
  }
  const targets = new Set(takes.map((take) => take.sceneId));
  const removed = project.audio.filter((clip) => clip.sceneId && targets.has(clip.sceneId)
    && (clip.name.startsWith('Narration') || project.assets[clip.assetId]?.provenance?.providerRefs?.job === 'voice.narration'));
  const commands: Command[] = [...removed.map((clip): Command => ({ type: 'removeAudioClip', clipId: clip.id })), ...clips.map((clip): Command => ({ type: 'addAudioClip', clip }))];
  const bed = project.audio.find((clip) => !clip.sceneId);
  if (!bed || !clips.length) return { commands, ducked: false, trimmed };
  const placed = { ...project, audio: [...project.audio.filter((clip) => !removed.includes(clip)), ...clips] };
  const voiceIds = [...new Set([...likelyVoiceClips(placed, bed.id).map((clip) => clip.id), ...clips.map((clip) => clip.id)])];
  const duck = duckUnder(placed, bed.id, voiceIds);
  if (duck.ok) commands.push(duck.command);
  return { commands, ducked: duck.ok, trimmed };
}

/** A project-level bed at frame zero, trimmed to the video or available audio. */
export function placeBedCommands(project: Project, asset: Asset, opts: { replaceClipId?: string } = {}): Command[] {
  if (asset.kind !== 'audio') throw new Error(`Bed asset ${asset.id} must be audio`);
  const durationInFrames = Math.min(projectDurationInFrames(project), asset.durationInFrames ?? projectDurationInFrames(project));
  if (durationInFrames < 1) throw new Error('A music bed needs a non-empty video and audio');
  const clip: AudioClip = {
    id: clipId(project, `aud_bed_${asset.id}`), assetId: asset.id, name: asset.name, startFrame: 0, trimStartFrames: 0,
    durationInFrames, volume: 0.6, fadeInFrames: Math.min(durationInFrames, Math.round(project.fps * 0.5)), fadeOutFrames: Math.min(durationInFrames, Math.round(project.fps * 1.5)),
  };
  const commands: Command[] = opts.replaceClipId ? [{ type: 'removeAudioClip', clipId: opts.replaceClipId }] : [];
  commands.push({ type: 'addAudioClip', clip });
  const placed = { ...project, audio: [...project.audio.filter((old) => old.id !== opts.replaceClipId), clip] };
  const duck = duckUnder(placed, clip.id, likelyVoiceClips(placed, clip.id).map((voice) => voice.id));
  if (duck.ok) commands.push(duck.command);
  return commands;
}
