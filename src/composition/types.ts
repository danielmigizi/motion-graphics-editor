import type { Project } from '../core/types';

/** Input props shared by the preview <Player> and the export renderer. */
export interface MainCompositionProps extends Record<string, unknown> {
  project: Project;
  /** '/' in the browser preview; 'http://localhost:5318/' when rendering. */
  assetBaseUrl: string;
  /** Editor-only: hide elements being edited? Never set during export. */
  editorMode?: boolean;
}

export const COMPOSITION_ID = 'Main';
