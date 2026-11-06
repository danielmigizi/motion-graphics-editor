// Registry of element renderers: one per ElementType in src/core/components.ts.
// 'group' and 'instance' have no renderer: ElementTree draws their contents.
import type { ElementType } from '../../core/types';
import { ChatBubbleElement } from './ChatBubbleElement';
import { ImageElement, LogoElement } from './MediaElements';
import { PathElement } from './PathElement';
import { ShapeElement } from './ShapeElement';
import { TextElement } from './TextElement';
import { UiCardElement } from './UiCardElement';
import { VideoElement } from './VideoElement';
import type { ElementRenderer } from './shared';

export const ELEMENT_RENDERERS: Partial<Record<ElementType, ElementRenderer>> = {
  text: TextElement,
  shape: ShapeElement,
  logo: LogoElement,
  image: ImageElement,
  uiCard: UiCardElement,
  chatBubble: ChatBubbleElement,
  path: PathElement,
  video: VideoElement,
};

export { MissingAsset } from './shared';
export type { ElementRenderer, ElementRendererProps } from './shared';
