// A tiny deterministic builder for the golden examples: every step is an
// ordinary command, applied and validated as it goes, so a golden project is
// exactly what the editor (or an agent) would produce with the same moves.

import { applyCommand } from '../../core/commands';
import { STYLE_PACKS, type StylePackId } from '../../core/style';
import { buildTemplate, type TemplateId, type TemplateParams } from '../../core/templates';
import { PROJECT_SCHEMA_VERSION } from '../../core/types';
import type { Asset, Command, Element, Marker, Project, Scene, SceneTransition } from '../../core/types';

export const RELAY_ASSETS: Record<'logo' | 'screenshot' | 'music', Asset> = {
  logo: { id: 'ast_logo', kind: 'svg', name: 'Relay logo', src: 'assets/logo.svg', mimeType: 'image/svg+xml', width: 480, height: 140 },
  screenshot: { id: 'ast_screenshot', kind: 'image', name: 'Product screenshot', src: 'assets/product-screenshot.png', mimeType: 'image/png', width: 1600, height: 1000 },
  music: { id: 'ast_music', kind: 'audio', name: 'Music bed', src: 'assets/music-bed.wav', mimeType: 'audio/wav', durationInFrames: 720 },
};

export class Draft {
  project: Project;
  private n = 0;

  constructor(opts: { id: string; name: string; pack: StylePackId; assets?: Asset[]; width?: number; height?: number }) {
    const pack = STYLE_PACKS[opts.pack];
    this.project = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: opts.id,
      name: opts.name,
      revision: 1,
      fps: 30,
      width: opts.width ?? 1920,
      height: opts.height ?? 1080,
      backgroundColor: pack.colors.background,
      scenes: [],
      assets: Object.fromEntries((opts.assets ?? []).map((a) => [a.id, a])),
      audio: [],
      compositions: {},
      markers: [],
      style: pack,
    };
  }

  private nextId = (prefix: string) => `${prefix}_${this.project.id.replace(/^prj_/, '')}_${++this.n}`;

  run(command: Command): void {
    const r = applyCommand(this.project, command, { source: 'user' });
    if (!r.ok) throw new Error(`${this.project.id}: ${r.error.message} at ${r.error.path ?? '(root)'}`);
    this.project = r.project;
  }

  /** Add a scene `frames` long (keep it a whole number of beats), with a transition in. */
  scene(name: string, frames: number, transitionIn: SceneTransition = { type: 'none', durationInFrames: 0 }): string {
    const scene: Scene = { id: this.nextId('scn'), name, durationInFrames: frames, backgroundColor: this.project.style!.colors.background, locked: false, transitionIn, elements: [] };
    this.run({ type: 'addScene', scene });
    return scene.id;
  }

  /** Insert a template into a scene, holding to the scene's end; returns its elements (group first). */
  template(sceneId: string, id: TemplateId, params: TemplateParams = {}, at = 0): Element[] {
    const scene = this.project.scenes.find((s) => s.id === sceneId);
    const seconds = scene ? (scene.durationInFrames - at) / this.project.fps : undefined;
    const built = buildTemplate(id, { seconds, ...params }, { sceneId, at, project: this.project, newId: () => this.nextId('el') });
    if (!built.ok) throw new Error(`${this.project.id}: ${built.message}`);
    this.run({ type: 'batch', label: built.label, commands: built.commands });
    return built.elements;
  }

  marker(frame: number, label: string): void {
    const marker: Marker = { id: this.nextId('mk'), frame, label };
    this.run({ type: 'setMarker', marker });
  }

  /** Add a finished element (used by the Pulse reference shots). */
  add(sceneId: string, element: Element): Element {
    this.run({ type: 'addElement', sceneId, element });
    return element;
  }

  next(prefix: string): string {
    return this.nextId(prefix);
  }

  music(asset: Asset, frames: number): void {
    this.run({ type: 'addAudioClip', clip: { id: this.nextId('aud'), assetId: asset.id, name: asset.name, startFrame: 0, trimStartFrames: 0, durationInFrames: frames, volume: 0.6, fadeInFrames: 15, fadeOutFrames: 45 } });
  }
}
