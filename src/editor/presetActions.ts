// Motion presets and templates as editor actions. Each is ONE command batch:
// one undo step, one revision, the same validation as any other edit.
// The inspector (and any menu) calls applyPreset; the Insert menu calls both.
// Every preset takes its timing and curves from the project's style pack.

import { applyStagger, defaultPresetOptions, followThroughCommands, PRESETS, presetAppliesTo, presetCommands, staggerTargets, type PresetId, type PresetOptions } from '../core/presets';
import { buildTemplate, TEMPLATES, type TemplateId, type TemplateParams } from '../core/templates';
import { sceneStartFrame } from '../core/timing';
import { guardLocked } from './editActions';
import { useEditor } from './store';

/**
 * Apply a motion preset to an element. Entrances start on its first frame,
 * exits end on its last, emphasis and loops start at the playhead when the
 * playhead is inside the element. `options` overrides any of that.
 */
export function applyPreset(sceneId: string, elementId: string, presetId: PresetId, options: Partial<Omit<PresetOptions, 'fps'>> = {}): boolean {
  const st = useEditor.getState();
  const project = st.doc.project;
  const scene = project.scenes.find((s) => s.id === sceneId);
  const element = scene?.elements.find((e) => e.id === elementId);
  if (!scene || !element) return false;
  if (guardLocked(scene)) return false;
  const preset = PRESETS[presetId];
  if (!presetAppliesTo(preset, element)) {
    st.toast({ tone: 'info', message: `${preset.label} doesn’t apply to “${element.name}”.`, hint: element.durationInFrames < 2 ? 'The element is on screen for less than two frames.' : `It works on ${preset.appliesTo.join(', ')} elements.` });
    return false;
  }
  // Element-local playhead: a group child's start is relative to its group.
  let start = element.startFrame;
  for (let parent = scene.elements.find((e) => e.id === element.parentId); parent; parent = scene.elements.find((e) => e.id === parent!.parentId)) start += parent.startFrame;
  const localFrame = st.playhead - sceneStartFrame(project, sceneId) - start;
  const o = { ...defaultPresetOptions(preset, element, { fps: project.fps, localFrame, intensity: options.intensity, motion: project.style?.motion }), ...options, fps: project.fps };
  const commands = presetCommands(sceneId, element, presetId, o);
  if (!commands.length) return false;
  const label = `${preset.label} on “${element.name}”`;
  return st.run({ type: 'batch', label, commands }, label);
}

/**
 * Insert a template into the current scene at the playhead (or early enough
 * to play out when less than a second of the scene is left) and select it.
 */
export function insertTemplate(templateId: TemplateId, params: TemplateParams = {}): boolean {
  const st = useEditor.getState();
  const project = st.doc.project;
  const scene = project.scenes.find((s) => s.id === st.selection.sceneId);
  if (!scene || guardLocked(scene)) return false;
  const frameInScene = st.playhead - sceneStartFrame(project, scene.id);
  const designed = Math.round(TEMPLATES[templateId].seconds * project.fps);
  const at = frameInScene >= 0 && scene.durationInFrames - frameInScene >= project.fps ? frameInScene : Math.max(0, scene.durationInFrames - designed);
  const built = buildTemplate(templateId, params, { sceneId: scene.id, at, project });
  if (!built.ok) {
    st.toast({ tone: 'error', message: built.message });
    return false;
  }
  if (!st.run({ type: 'batch', label: built.label, commands: built.commands }, built.label)) return false;
  useEditor.getState().selectElement(scene.id, built.group.id);
  return true;
}

export { staggerTargets };

/**
 * Arrive apart: the selected layers (or the selected group's children) enter
 * one after another in reading order, `style.motion.staggerFrames` apart.
 */
export function arriveApart(presetId: PresetId = 'riseIn', intensity = 1): boolean {
  const st = useEditor.getState();
  const project = st.doc.project;
  const scene = project.scenes.find((s) => s.id === st.selection.sceneId);
  if (!scene || guardLocked(scene)) return false;
  const targets = staggerTargets(scene, st.selection);
  if (targets.length < 2) {
    st.toast({ tone: 'info', message: 'Arrive apart needs two or more layers.', hint: 'Shift-click several layers, or select a group.' });
    return false;
  }
  const commands = applyStagger(targets, presetId, { sceneId: scene.id, fps: project.fps, intensity, motion: project.style?.motion, within: scene.elements });
  if (!commands.length) return false;
  const label = `Arrive apart · ${targets.length} layers`;
  return st.run({ type: 'batch', label, commands }, label);
}

/** Follow-through: the selected group slides in and its children carry on past the stop, then settle. */
export function followThrough(sceneId: string, groupId: string, intensity = 1): boolean {
  const st = useEditor.getState();
  const project = st.doc.project;
  const scene = project.scenes.find((s) => s.id === sceneId);
  const group = scene?.elements.find((e) => e.id === groupId);
  if (!scene || !group || guardLocked(scene)) return false;
  const children = scene.elements.filter((e) => e.parentId === group.id);
  if (group.type !== 'group' || !children.length) {
    st.toast({ tone: 'info', message: 'Follow-through works on a group with layers in it.', hint: 'Group the parts that should trail (⌘G), then select the group.' });
    return false;
  }
  const commands = followThroughCommands(scene.id, group, children, { fps: project.fps, intensity, motion: project.style?.motion });
  if (!commands.length) return false;
  const label = `Follow-through on “${group.name}”`;
  return st.run({ type: 'batch', label, commands }, label);
}
