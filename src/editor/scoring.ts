// Scoring to the cut and narration at scenes (#21, Phase C) in the editor:
// what a scored bed's job row says about its cuts and offers (Place as bed,
// Snap cuts to downbeats), Place at scenes for per-scene narration, the score
// plan and the narration lines kept in step with the scenes, and how long a
// line takes to say. The commands come from core/scorePlan.ts; each goes to
// the review as the person's own generated take, like Use this take
// (TakesPanel.tsx), so nothing changes until Apply.

import type { GeneratedOutputMeta, GenerationJob, ScoreSection } from '../core/generationStudio';
import { cutAlignment, placeBedCommands, placeNarrationCommands, snapCutsCommands } from '../core/scorePlan';
import { sceneStartFrames } from '../core/timing';
import type { AiPatch, Asset, Command, Project } from '../core/types';
import { TAKE_BY, useProposals } from './proposals';
import { useEditor } from './store';
import { commandsPatch, takeUsage } from './takes';

export type Cut = NonNullable<GeneratedOutputMeta['cuts']>[number];

/** A cut this close to a downbeat (frames, either way) counts as on it. */
export const ON_BEAT_FRAMES = 2;
/** Snap cuts to downbeats moves a cut at most this far. */
export const SNAP_MAX_FRAMES = 6;
/** About how fast narration is spoken, characters per second. */
export const SPOKEN_CHARS_PER_SECOND = 15;

/** A take's details from its job: its scene, word timings, cut alignment (absent from an older server). */
export const outputMetaOf = (job: GenerationJob, assetId: string): GeneratedOutputMeta | undefined => job.outputMeta?.[assetId];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const frames = (n: number) => plural(n, 'frame');

export const onBeat = (c: Cut) => c.offsetFrames !== null && Math.abs(c.offsetFrames) <= ON_BEAT_FRAMES;

/** "4 of 5 cuts on a downbeat"; one cut, or none, said plainly. */
export function alignmentText(cuts: readonly Cut[]): string {
  if (cuts.length === 0) return 'One scene, so no cuts to line up';
  const on = cuts.filter(onBeat).length;
  if (cuts.length === 1) return on ? 'The cut is on a downbeat' : 'The cut is off the downbeat';
  return `${on} of ${cuts.length} cuts on a downbeat`;
}

/** Where a bed plays: its start in the video and its in-point in the file (frames). */
export type BedPlacement = { startFrame: number; trimStartFrames: number };

const FROM_ZERO: BedPlacement = { startFrame: 0, trimStartFrames: 0 };

/** The clip playing this take as the music bed: project audio (no scene) with its asset. Undefined while it isn't the bed. */
export const placedBed = (project: Project, assetId: string) => project.audio.find((c) => !c.sceneId && c.assetId === assetId);

/**
 * The take's cuts against the video as it is now, with the bed where it
 * plays (`bed`; from frame 0, untrimmed, until it is placed): measured
 * against every downbeat the analysis found. A take from an older server
 * has only the downbeats nearest each cut: while the scenes and the bed are
 * where the analysis assumed, its own figures; otherwise measured again
 * against those downbeats.
 */
export function currentCuts(project: Project, meta: GeneratedOutputMeta | undefined, bpm: number | null, bed: BedPlacement = FROM_ZERO): Cut[] | null {
  const cuts = meta?.cuts;
  if (!cuts) return null;
  const at = { startFrame: bed.startFrame, trimStartFrames: bed.trimStartFrames };
  if (meta.downbeats) return cutAlignment(project, meta.downbeats, bpm, at);
  const starts = sceneStartFrames(project);
  const later = project.scenes.slice(1);
  const asAnalysed = at.startFrame === 0 && at.trimStartFrames === 0;
  if (asAnalysed && cuts.length === later.length && cuts.every((c, i) => c.sceneId === later[i].id && c.cutFrame === starts[i + 1])) return cuts;
  // Those downbeats are frames of the file (the analysis put the bed at frame 0, untrimmed).
  const downbeats = [...new Set(cuts.flatMap((c) => (c.nearestDownbeatFrame === null ? [] : [c.nearestDownbeatFrame])))];
  return cutAlignment(project, downbeats, bpm, at);
}

/** What a button on a job row would propose: its label, the commands, and why it can't (null when it can). */
export interface TakeAction {
  label: string;
  why: string | null;
  summary: string;
  commands: Command[];
  /** Said after proposing: what was left out. */
  note?: string;
}

const none = (label: string, why: string): TakeAction => ({ label, why, summary: label, commands: [] });

/** Place as bed: the take under the whole video from frame 0, in place of the bed there now, ducked under any voice already placed. */
export function bedAction(project: Project, take: Asset): TakeAction {
  const label = 'Place as bed';
  if (!project.assets[take.id]) return none(label, 'This take is not in the project.');
  const beds = project.audio.filter((c) => !c.sceneId);
  if (beds.some((c) => c.assetId === take.id)) return none(label, 'Already the music bed.');
  // One bed at a time: the one playing now makes way (placeNarrationCommands ducks "the" bed, the first without a scene).
  const old = beds[0];
  try {
    const commands = placeBedCommands(project, take, old ? { replaceClipId: old.id } : {});
    // The new bed gets its own dip under the voice (an envelope update) when voice is already placed.
    const ducked = commands.some((c) => c.type === 'updateAudioClip');
    const what = old ? `Use “${take.name}” as the music bed in place of “${old.name}”` : `Place “${take.name}” as the music bed`;
    return { label, why: null, commands, summary: `${what}${ducked ? ', ducked under the voice' : ''}` };
  } catch (e) {
    return none(label, e instanceof Error ? e.message : String(e));
  }
}

/** Why Snap waits while the take is not the bed: the cuts would line up with music that is not playing. */
export const PLACE_BED_FIRST = 'Place this take as the bed first.';

/**
 * Snap cuts to downbeats: each cut within SNAP_MAX_FRAMES of a downbeat of
 * the bed that plays this take (`bedClipId`; none: Place this take as the
 * bed first) moves onto it; the bed follows the new length. The label says
 * how many move and how far; the note after proposing, how many were already
 * on the beat and any that stay.
 */
export function snapAction(project: Project, cuts: readonly Cut[], bedClipId: string | null | undefined): TakeAction {
  const plain = 'Snap cuts to downbeats';
  const off = cuts.filter((c) => c.offsetFrames !== null && c.offsetFrames !== 0);
  const near = off.filter((c) => Math.abs(c.offsetFrames!) <= SNAP_MAX_FRAMES);
  if (cuts.length === 0) return none(plain, 'One scene, so there are no cuts to move.');
  if (!bedClipId) return none(plain, PLACE_BED_FIRST);
  if (off.length === 0 && cuts.every((c) => c.offsetFrames === 0)) return none(plain, 'Every cut is already on a downbeat.');
  if (near.length === 0) return none(plain, `No cut is within ${frames(SNAP_MAX_FRAMES)} of a downbeat.`);
  const { commands, moved, aligned, skipped } = snapCutsCommands(project, [...cuts], { maxShiftFrames: SNAP_MAX_FRAMES, bedClipId });
  const left = new Set(skipped.map((s) => s.sceneId));
  const nameBefore = (sceneId: string) => project.scenes[project.scenes.findIndex((s) => s.id === sceneId) - 1];
  const locked = near.filter((c) => left.has(c.sceneId) && nameBefore(c.sceneId)?.locked).map((c) => `“${nameBefore(c.sceneId)!.name}”`);
  const lockedText = locked.length ? `${locked.join(', ')} ${locked.length === 1 ? 'is' : 'are'} locked, so ${locked.length === 1 ? 'its cut stays' : 'their cuts stay'} where ${locked.length === 1 ? 'it is' : 'they are'}.` : null;
  if (moved === 0) return none(plain, lockedText ?? `${skipped.find((s) => near.some((c) => c.sceneId === s.sceneId))?.why ?? 'Nothing can move'}.`);
  // How far the cuts travel: each one not left behind ends on its downbeat, its offset from where it was (an earlier move may carry it there).
  const shifts = near.filter((c) => !left.has(c.sceneId)).map((c) => Math.abs(c.offsetFrames!));
  const most = Math.max(...shifts);
  const by = shifts.every((s) => s === most) ? frames(most) : `up to ${frames(most)}`;
  const label = `Snap ${plural(moved, 'cut')} to ${moved === 1 ? 'a downbeat' : 'downbeats'} (${by})`;
  const stay = near.filter((c) => left.has(c.sceneId)).length;
  const tally = `${plural(moved, 'cut')} moved${aligned ? `, ${aligned} already on the beat` : ''}.`;
  const stayText = stay > 0 ? ` ${lockedText ?? `${plural(stay, 'cut')} could not move.`}` : '';
  return { label, why: null, commands, summary: `Snap ${plural(moved, 'cut')} to the music’s downbeats`, note: `${tally}${stayText}` };
}

/** A narration job's lines in scene order: each scene still in the video with its takes in the project (the job's order). */
export function narrationScenes(project: Project, job: GenerationJob): { sceneId: string; takes: Asset[] }[] {
  const byScene = new Map<string, Asset[]>();
  for (const a of job.outputs) {
    const sceneId = outputMetaOf(job, a.id)?.sceneId;
    if (!sceneId || !project.assets[a.id]) continue;
    byScene.set(sceneId, [...(byScene.get(sceneId) ?? []), project.assets[a.id]]);
  }
  return project.scenes.flatMap((s) => (byScene.has(s.id) ? [{ sceneId: s.id, takes: byScene.get(s.id)! }] : []));
}

/** Scene id → the take picked for it on the job row. */
export type TakePicks = Readonly<Record<string, string>>;

/**
 * The take a scene's line uses: the one picked; else the one already in the
 * video (so a placed job reads "Already placed" rather than offering to swap
 * every scene to its next take); else the first not in the video.
 */
export function pickedTake(takes: readonly Asset[], picked: string | undefined, used: ReadonlyMap<string, number>): Asset {
  return takes.find((t) => t.id === picked) ?? takes.find((t) => used.get(t.id)) ?? takes.find((t) => !used.get(t.id)) ?? takes[0];
}

/** A narration job's takes with their scenes, one per scene in scene order (the picked take where a line has several). */
export function narrationTakes(project: Project, job: GenerationJob, picks: TakePicks = {}): { asset: Asset; sceneId: string }[] {
  const used = takeUsage(project);
  return narrationScenes(project, job).map((s) => ({ asset: pickedTake(s.takes, picks[s.sceneId], used), sceneId: s.sceneId }));
}

/** Scene names, "Open, Close"; an id no longer in the video is said as such. */
const sceneNames = (project: Project, ids: readonly string[]) => ids.map((id) => project.scenes.find((s) => s.id === id)?.name ?? 'a deleted scene').join(', ');

/**
 * Place at scenes: each line's take (the picked one) at its scene, in place
 * of the narration there, the music ducked under them when there is a bed.
 * The summary says what it replaces and which lines run past their scene.
 */
export function narrationAction(project: Project, job: GenerationJob, picks: TakePicks = {}): TakeAction & { ducked: boolean } {
  const plain = 'Place at scenes';
  const all = narrationTakes(project, job, picks);
  const used = takeUsage(project);
  const fresh = all.filter((t) => !used.get(t.asset.id));
  const locked = fresh.filter((t) => project.scenes.find((s) => s.id === t.sceneId)?.locked);
  const open = fresh.filter((t) => !locked.includes(t));
  const lockedText = locked.length ? `${locked.map((t) => `“${project.scenes.find((s) => s.id === t.sceneId)!.name}”`).join(', ')} ${locked.length === 1 ? 'is' : 'are'} locked, so ${locked.length === 1 ? 'its line was' : 'their lines were'} left out.` : undefined;
  const no = (why: string) => ({ ...none(plain, why), ducked: false });
  if (all.length === 0) return no('These takes don’t say which scene they belong to.');
  if (fresh.length === 0) return no('Already placed at their scenes.');
  if (open.length === 0) return no(lockedText!);
  try {
    const { commands, ducked, trimmed } = placeNarrationCommands(project, open);
    const replaced = commands.filter((c) => c.type === 'removeAudioClip').length;
    const where = plural(open.length, 'scene');
    const parts = [
      `Place narration at ${where}`,
      replaced ? `in place of ${plural(replaced, 'earlier narration clip')}` : null,
      ducked ? 'with the music ducked under it' : null,
    ].filter(Boolean);
    const cutOff = trimmed.length ? `; cut off in ${sceneNames(project, trimmed)} — shorten ${trimmed.length === 1 ? 'that line or lengthen the scene' : 'those lines or lengthen the scenes'}` : '';
    return {
      label: `Place at ${where}${ducked ? ' with the music ducked' : ''}`,
      why: null,
      commands,
      ducked,
      summary: `${parts.join(', ')}${cutOff}`,
      ...(lockedText ? { note: lockedText } : {}),
    };
  } catch (e) {
    return no(e instanceof Error ? e.message : String(e));
  }
}

/** Propose a patch as the person's own generated take: the review opens on it; nothing changes until Apply. */
export function proposeAsTake(patch: AiPatch, note?: string): boolean {
  const st = useEditor.getState();
  const r = useProposals.getState().propose(patch, { agent: TAKE_BY, source: 'paste' });
  if (!r.ok) {
    st.toast({ tone: 'error', message: `Could not propose “${patch.summary}”: ${r.error.message}` });
    return false;
  }
  useProposals.getState().openReview();
  if (note) st.toast({ tone: 'info', message: note });
  return true;
}

/** A job-row button: the action worked out again against the project as it is at the click, then proposed. */
export function proposeAction(plan: (project: Project) => TakeAction): boolean {
  const st = useEditor.getState();
  const project = st.doc.project;
  const a = plan(project);
  if (a.why) {
    st.toast({ tone: 'info', message: a.why });
    return false;
  }
  return proposeAsTake(commandsPatch(project, a.commands, a.summary), a.note);
}

// ---------------------------------------------------------------------------
// The plan and the lines, in step with the scenes.
// ---------------------------------------------------------------------------

/** "Intro + Product": the scenes a section covers, by their names now. */
export function sectionScenes(project: Project, section: ScoreSection): string {
  return section.sceneIds.map((id) => project.scenes.find((s) => s.id === id)?.name ?? 'A deleted scene').join(' + ');
}

/** Sections keyed by their scenes, the n-th of a split scene apart. */
function sectionKeys(plan: readonly ScoreSection[]): string[] {
  const seen = new Map<string, number>();
  return plan.map((s) => {
    const k = s.sceneIds.join(' ');
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return `${k}#${n}`;
  });
}

/** The plan built again for the scenes as they are, keeping the styles of every section whose scenes are unchanged. */
export function mergeScorePlan(prev: readonly ScoreSection[] | undefined, next: ScoreSection[]): ScoreSection[] {
  if (!prev?.length) return next;
  const keys = sectionKeys(prev);
  const styles = new Map(prev.map((s, i) => [keys[i], s.styles]));
  return sectionKeys(next).map((k, i) => (styles.has(k) ? { ...next[i], styles: [...styles.get(k)!] } : next[i]));
}

/** The lines again for the scenes as they are: a scene's line is kept as written, a new scene gets its story beat, a deleted one's line goes. */
export function mergeNarrationLines(prev: readonly { sceneId: string; text: string }[] | undefined, next: { sceneId: string; text: string }[]): { sceneId: string; text: string }[] {
  if (!prev?.length) return next;
  const written = new Map(prev.map((l) => [l.sceneId, l.text]));
  return next.map((l) => (written.has(l.sceneId) ? { sceneId: l.sceneId, text: written.get(l.sceneId)! } : l));
}

/** "quiet, building" → ["quiet", "building"]. */
export const parseStyles = (text: string) => text.split(',').map((s) => s.trim()).filter(Boolean);

/** About how long a line takes to say, seconds. */
export const spokenSeconds = (text: string) => text.trim().length / SPOKEN_CHARS_PER_SECOND;

/** A line against its scene: its length in characters and seconds, and whether it likely runs past the scene. */
export function lineFit(project: Project, line: { sceneId: string; text: string }): { chars: number; seconds: number; sceneSeconds: number | null; long: boolean } {
  const scene = project.scenes.find((s) => s.id === line.sceneId);
  const seconds = spokenSeconds(line.text);
  const sceneSeconds = scene ? scene.durationInFrames / project.fps : null;
  return { chars: line.text.trim().length, seconds, sceneSeconds, long: sceneSeconds !== null && seconds > sceneSeconds };
}

/** "4.0 s": a section's or a line's length, always to a tenth. */
export const tenths = (s: number) => `${(Math.round(s * 10) / 10).toFixed(1)} s`;
