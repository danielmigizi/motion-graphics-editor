// Plain-language consequences of a changeFormat command, for the "Size &
// frame rate" dialog. Format changes are never silent: the user picks how
// layout and timing adapt, and reads what that does before applying.

import { applyCommand } from './commands';
import { projectDurationInFrames } from './timing';
import type { FormatConversion, Project } from './types';

export interface FormatChoice {
  width: number;
  height: number;
  fps: number;
  conversion: FormatConversion;
}

export interface FormatPreview {
  /** "1920×1080 · 30 fps → 1080×1920 · 30 fps" */
  summary: string;
  /** What happens, one sentence per consequence. Empty when nothing changes. */
  lines: string[];
  changed: boolean;
  sizeChanged: boolean;
  fpsChanged: boolean;
  /** Why it cannot be applied right now (locked scenes, invalid size). */
  blocked?: string;
}

const secs = (frames: number, fps: number) => {
  const s = Math.round((frames / fps) * 10) / 10;
  return `${s} s`;
};

const ratio = (n: number) => `×${Math.round(n * 100) / 100}`;

/** Visible top-level elements whose base layout sits partly outside the frame. */
function offFrame(project: Project): number {
  let n = 0;
  for (const scene of project.scenes) {
    for (const el of scene.elements) {
      if (el.parentId || !el.visible) continue;
      const t = el.transform;
      const w = t.width * t.scale;
      const h = t.height * t.scale;
      const x = t.x + (t.width - w) / 2;
      const y = t.y + (t.height - h) / 2;
      if (x < -1 || y < -1 || x + w > project.width + 1 || y + h > project.height + 1) n++;
    }
  }
  return n;
}

export function describeFormatChange(project: Project, choice: FormatChoice): FormatPreview {
  const sizeChanged = choice.width !== project.width || choice.height !== project.height;
  const fpsChanged = choice.fps !== project.fps;
  const summary = `${project.width}×${project.height} · ${project.fps} fps → ${choice.width}×${choice.height} · ${choice.fps} fps`;
  const preview: FormatPreview = { summary, lines: [], changed: sizeChanged || fpsChanged, sizeChanged, fpsChanged };
  if (!preview.changed) return { ...preview, lines: ['Nothing changes.'] };

  const valid = (n: number, max: number) => Number.isInteger(n) && n >= 1 && n <= max;
  if (!valid(choice.width, 8192) || !valid(choice.height, 8192)) return { ...preview, blocked: 'Width and height must be whole numbers from 1 to 8192.' };
  if (!valid(choice.fps, 120)) return { ...preview, blocked: 'Frame rate must be a whole number from 1 to 120.' };
  const locked = project.scenes.filter((s) => s.locked);
  if (locked.length) {
    preview.blocked = `Unlock ${locked.length === 1 ? `the approved scene “${locked[0].name}”` : `${locked.length} approved scenes`} first: a format change touches every scene.`;
  }

  const total = projectDurationInFrames(project);
  if (fpsChanged) {
    if (choice.conversion.timing === 'keepSeconds') {
      const converted = project.scenes.reduce((n, s) => n + Math.max(1, Math.round((s.durationInFrames * choice.fps) / project.fps)), 0);
      const before = secs(total, project.fps);
      const after = secs(converted, choice.fps);
      preview.lines.push(`A ${before} video at ${project.fps} fps becomes ${after} at ${choice.fps} fps; every key moves to the matching time.`);
      if (before !== after || converted * project.fps !== total * choice.fps) preview.lines.push('Lengths round to whole frames, so some keys and cuts shift by up to half a frame.');
    } else {
      const faster = choice.fps > project.fps;
      preview.lines.push(
        `Frame numbers stay the same, so the ${secs(total, project.fps)} video plays in ${secs(total, choice.fps)} at ${choice.fps} fps — ${ratio(Math.max(choice.fps, project.fps) / Math.min(choice.fps, project.fps)).slice(1)} times ${faster ? 'faster' : 'slower'}.`,
      );
      if (project.audio.length) preview.lines.push(`Audio keeps its own speed, so music and sounds ${faster ? 'are cut short' : 'end early'} and drift from the picture.`);
    }
  }

  if (sizeChanged) {
    const rx = choice.width / project.width;
    const ry = choice.height / project.height;
    const uniform = Math.min(rx, ry);
    const { layout } = choice.conversion;
    if (layout === 'scale') {
      preview.lines.push(
        rx === ry
          ? `Everything scales ${ratio(rx)} to the new frame.`
          : `Positions stretch to the new frame (${ratio(rx)} across, ${ratio(ry)} down); sizes and text scale ${ratio(uniform)} so nothing distorts.`,
      );
    } else if (layout === 'fit') {
      const bars = rx === ry ? '' : rx > ry ? '; the background fills the left and right' : '; the background fills the top and bottom';
      preview.lines.push(`The whole picture scales ${ratio(uniform)} and is centred${bars}.`);
    } else {
      preview.lines.push(`Elements keep their pixel positions and sizes; the frame ${choice.width < project.width || choice.height < project.height ? 'crops' : 'grows'} around them from the top-left.`);
    }
    if (!preview.blocked) {
      const r = applyCommand(project, { type: 'changeFormat', width: choice.width, height: choice.height, fps: choice.fps, conversion: choice.conversion }, { source: 'user' });
      if (r.ok) {
        const before = offFrame(project);
        const after = offFrame(r.project);
        if (after > before) preview.lines.push(`${after - before} element${after - before === 1 ? '' : 's'} will sit partly outside the frame.`);
      }
    }
  }
  return preview;
}
