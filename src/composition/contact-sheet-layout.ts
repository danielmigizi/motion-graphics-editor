import type { Project } from '../core/types';

export function contactSheetLayout(props: { project: Project; frames: number[]; columns: number; labels: boolean; scale?: number }) {
  const columns = Math.min(props.columns, props.frames.length);
  const scale = Math.min(props.scale ?? 1, 1920 / (columns * props.project.width));
  const cellWidth = Math.max(1, Math.floor(props.project.width * scale));
  const actualScale = cellWidth / props.project.width;
  const cellHeight = Math.max(1, Math.round(props.project.height * actualScale));
  const captionHeight = props.labels ? 32 : 0;
  return { columns, scale: actualScale, cellWidth, cellHeight, captionHeight, width: cellWidth * columns, height: (cellHeight + captionHeight) * Math.ceil(props.frames.length / columns) };
}

