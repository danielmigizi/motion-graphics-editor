// The tool rail's Insert popover (ToolRail.tsx): every element the scene can
// take (Image, SVG logo and Video ask for their file), templates for the
// current scene, and motion presets for the selected layer — principle
// presets and the multi-layer moves (arrive apart, follow-through) first.
// Every pick is one undo step and follows the project's style pack. Sound
// lives beside it, under Audio (SoundEffectsMenu.tsx); a new picture or clip
// is made in the Generate tab (the last two Elements rows open it).

import { useId, useState } from 'react';
import { COMPONENTS } from '../core/components';
import { PRESET_IDS, PRESET_KIND_LABELS, PRESETS, presetAppliesTo, type PresetKind } from '../core/presets';
import { PERSONALITY_NOTES } from '../core/style';
import { TEMPLATE_IDS, TEMPLATES } from '../core/templates';
import type { ElementType } from '../core/types';
import { ADDABLE } from './editActions';
import { openGenerate } from './generateStore';
import { Icon } from './icons';
import { ELEMENT_ICON } from './InspectorColumn';
import { applyPreset, arriveApart, followThrough, insertTemplate, staggerTargets } from './presetActions';
import { useCurrentScene, useEditor } from './store';

type Tab = 'elements' | 'templates' | 'animate';

const TABS: { id: Tab; label: string }[] = [
  { id: 'elements', label: 'Elements' },
  { id: 'templates', label: 'Templates' },
  { id: 'animate', label: 'Animate' },
];

/** The rail's letters, printed beside their elements. */
const ELEMENT_KEY: Partial<Record<ElementType, string>> = { text: 'T', shape: 'R', image: 'I' };

/** Elements that need a file: adding one opens the file dialog first (ToolRail.tsx addFromRail). */
export const ASKS_FOR_FILE: ElementType[] = ['image', 'logo', 'video'];

const INTENSITIES = [
  { value: 0.5, label: 'Subtle' },
  { value: 1, label: 'Normal' },
  { value: 1.6, label: 'Strong' },
];

const KINDS: PresetKind[] = ['enter', 'emphasis', 'exit', 'loop'];

/** A small drawing of each template's layout. */
function TemplateGlyph({ id }: { id: string }) {
  const bar = (x: number, y: number, w: number, h = 3, accent = false) => <rect x={x} y={y} width={w} height={h} rx={1.5} className={accent ? 'ins-glyph-accent' : 'ins-glyph-ink'} />;
  const shapes: Record<string, React.ReactNode> = {
    titleCard: (
      <>
        {bar(21, 9, 6, 2, true)}
        {bar(10, 14, 28, 4)}
        {bar(15, 21, 18, 2)}
      </>
    ),
    lowerThird: (
      <>
        <rect x={4} y={18} width={24} height={9} rx={2} className="ins-glyph-plate" />
        {bar(6, 20, 1.5, 5, true)}
        {bar(9, 20, 14, 2.5)}
        {bar(9, 24, 9, 1.5)}
      </>
    ),
    logoOutro: (
      <>
        <circle cx={24} cy={12} r={4} className="ins-glyph-accent" />
        {bar(14, 19, 20, 2.5)}
        {bar(18, 24, 12, 1.5)}
      </>
    ),
    featureCallout: (
      <>
        <rect x={5} y={7} width={18} height={18} rx={2} className="ins-glyph-plate" />
        {bar(8, 15, 8, 3, true)}
        {bar(27, 11, 16, 3)}
        {bar(27, 17, 12, 1.5)}
      </>
    ),
    chatExchange: (
      <>
        <rect x={22} y={5} width={20} height={6} rx={3} className="ins-glyph-accent" />
        <rect x={6} y={13} width={24} height={6} rx={3} className="ins-glyph-plate" />
        <rect x={26} y={21} width={16} height={6} rx={3} className="ins-glyph-accent" />
      </>
    ),
    statCounter: (
      <>
        <circle cx={24} cy={14} r={8} fill="none" strokeWidth={2.5} className="ins-glyph-track" />
        <path d="M24 6 A8 8 0 1 1 16.4 16.5" fill="none" strokeWidth={2.5} strokeLinecap="round" className="ins-glyph-ring" />
        {bar(17, 25, 14, 1.5)}
      </>
    ),
    walkthroughStep: (
      <>
        <rect x={4} y={7} width={24} height={17} rx={2} className="ins-glyph-plate" />
        <rect x={7} y={11} width={12} height={5} rx={1.5} fill="none" strokeWidth={1.2} className="ins-glyph-ring" />
        {bar(31, 11, 12, 3)}
        {bar(31, 17, 9, 1.5)}
      </>
    ),
    kineticTitle: (
      <>
        {bar(7, 8, 5, 1.5, true)}
        {bar(7, 12, 26, 5)}
        {bar(7, 19, 32, 5, true)}
      </>
    ),
    uiWalkthrough: (
      <>
        <rect x={6} y={5} width={36} height={22} rx={2} className="ins-glyph-plate" />
        <rect x={27} y={8} width={12} height={5} rx={1.5} fill="none" strokeWidth={1.2} className="ins-glyph-ring" />
        <path d="M30 11v8l2-2 1.5 3 1.2-.6-1.5-2.9h2.8z" className="ins-glyph-ink" />
      </>
    ),
    featureGrid: (
      <>
        {bar(6, 6, 20, 3)}
        {[6, 15.5, 25, 34.5].map((x) => (
          <g key={x}>
            <rect x={x} y={13} width={8} height={13} rx={1.5} className="ins-glyph-plate" />
            {bar(x + 1.5, 15, 3, 3, true)}
          </g>
        ))}
      </>
    ),
    beforeAfter: (
      <>
        <rect x={5} y={7} width={17} height={18} rx={2} className="ins-glyph-plate" />
        <rect x={26} y={7} width={17} height={18} rx={2} fill="none" strokeWidth={1.2} className="ins-glyph-ring" />
        {bar(8, 11, 10, 2)}
        {bar(29, 11, 10, 2)}
        <circle cx={24} cy={16} r={2.4} className="ins-glyph-accent" />
      </>
    ),
    statReveal: (
      <>
        {bar(21, 6, 6, 1.5, true)}
        {bar(13, 10, 22, 8)}
        {bar(21, 21, 6, 1, true)}
        <rect x={18} y={24} width={12} height={3} rx={1.5} fill="none" strokeWidth={1} className="ins-glyph-ring" />
      </>
    ),
    testimonial: (
      <>
        <text x={7} y={14} className="ins-glyph-quote">“</text>
        {bar(8, 14, 30, 3)}
        {bar(8, 19, 22, 3)}
        <circle cx={10} cy={25.5} r={2} className="ins-glyph-accent" />
        {bar(14, 24.5, 10, 2)}
      </>
    ),
    logoSting: (
      <>
        <circle cx={24} cy={14} r={8} fill="none" strokeWidth={1.4} className="ins-glyph-ring" />
        {[0, 60, 120, 180, 240, 300].map((a) => (
          <path key={a} d={`M${24 + 10.5 * Math.cos((a * Math.PI) / 180)} ${14 + 10.5 * Math.sin((a * Math.PI) / 180)}L${24 + 13 * Math.cos((a * Math.PI) / 180)} ${14 + 13 * Math.sin((a * Math.PI) / 180)}`} strokeWidth={1.2} className="ins-glyph-ring" />
        ))}
        {bar(19, 13, 10, 2.5)}
      </>
    ),
  };
  return (
    <svg className="ins-glyph" viewBox="0 0 48 32" aria-hidden>
      <rect x={0.5} y={0.5} width={47} height={31} rx={3} className="ins-glyph-frame" />
      {shapes[id]}
    </svg>
  );
}

/** Where an insert lands, or why it cannot. */
function sceneNote(scene: ReturnType<typeof useCurrentScene>, where: string): string {
  if (!scene) return 'Pick a scene first.';
  return scene.locked ? `“${scene.name}” is approved — unlock it to insert.` : `Into “${scene.name}”${where}.`;
}

/** Every element the Insert menu offers, Video last. */
const ELEMENTS: ElementType[] = [...ADDABLE, 'video'];

/** One row per element, the rail's letter beside the three it carries; those that need a file say so with an ellipsis. */
function Elements({ onDone, onAdd }: { onDone: () => void; onAdd: (type: ElementType) => boolean }) {
  const scene = useCurrentScene();
  const hasCompositions = useEditor((s) => Object.keys(s.doc.project.compositions).length > 0);
  const editable = !!scene && !scene.locked;
  return (
    <div className="ins-section" role="group" aria-label="Elements">
      <p className="ins-note">{sceneNote(scene, '')}</p>
      <ul className="ins-items">
        {ELEMENTS.map((type) => {
          const noComponent = type === 'instance' && !hasCompositions;
          return (
            <li key={type}>
              <button
                className="ins-item"
                data-testid={`insert-element-${type}`}
                disabled={!editable || noComponent}
                title={noComponent ? 'Make a reusable component first' : type === 'video' ? 'Upload an MP4, WebM or MOV and place it at the playhead' : COMPONENTS[type].description}
                onClick={() => {
                  if (onAdd(type)) onDone();
                }}
              >
                <Icon name={ELEMENT_ICON[type]} />
                <span className="ins-item-label">{ASKS_FOR_FILE.includes(type) ? `${COMPONENTS[type].label}…` : COMPONENTS[type].label}</span>
                {ELEMENT_KEY[type] && <kbd className="ins-item-key">{ELEMENT_KEY[type]}</kbd>}
              </button>
            </li>
          );
        })}
        <li>
          <button
            className="ins-item"
            data-testid="insert-generate-image"
            title="Open the Generate tab. Takes land in Assets › Generated for you to pick."
            onClick={() => {
              openGenerate({ mode: 'image', job: 'image.generate' });
              onDone();
            }}
          >
            <Icon name="sparkles" />
            <span className="ins-item-label">Generate an image…</span>
          </button>
        </li>
        <li>
          <button
            className="ins-item"
            data-testid="insert-generate-video"
            title="Open the Generate tab on Video. Clips land in Assets › Generated for you to pick."
            onClick={() => {
              openGenerate({ mode: 'video', job: 'video.generate' });
              onDone();
            }}
          >
            <Icon name="sparkles" />
            <span className="ins-item-label">Generate a video clip…</span>
          </button>
        </li>
      </ul>
    </div>
  );
}

function Templates({ onDone }: { onDone: () => void }) {
  const scene = useCurrentScene();
  return (
    <div className="ins-section" role="group" aria-label="Templates">
      <p className="ins-note">{sceneNote(scene, ' at the playhead')}</p>
      <ul className="ins-templates">
        {TEMPLATE_IDS.map((id) => (
          <li key={id}>
            <button
              className="ins-template"
              data-testid={`insert-template-${id}`}
              disabled={!scene || scene.locked}
              onClick={() => {
                if (insertTemplate(id)) onDone();
              }}
            >
              <TemplateGlyph id={id} />
              <span className="ins-template-text">
                <span className="ins-name">{TEMPLATES[id].label}</span>
                <span className="ins-desc">{TEMPLATES[id].description}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One pill per preset (or multi-layer move); disabled ones say why in their tooltip. */
function PresetPill({ label, title, disabled, testId, onClick }: { label: string; title: string; disabled: boolean; testId: string; onClick: () => void }) {
  return (
    <button className="ins-preset" data-testid={testId} disabled={disabled} title={title} onClick={onClick}>
      {label}
    </button>
  );
}

function Animate({ onDone }: { onDone: () => void }) {
  const scene = useCurrentScene();
  const selection = useEditor((s) => s.selection);
  const style = useEditor((s) => s.doc.project.style);
  const element = scene?.elements.find((e) => e.id === selection.elementId);
  const [intensity, setIntensity] = useState(1);
  const editable = !!scene && !scene.locked;
  const several = scene ? staggerTargets(scene, selection).length : 0;
  const isGroup = element?.type === 'group' && !!scene?.elements.some((e) => e.parentId === element.id);
  const pill = (id: (typeof PRESET_IDS)[number]) => {
    const p = PRESETS[id];
    const ok = !!element && editable && presetAppliesTo(p, element);
    const length = p.seconds ? ` · ${p.seconds} s` : '';
    return (
      <PresetPill
        key={id}
        label={p.label}
        testId={`insert-preset-${id}`}
        disabled={!ok}
        title={`${p.description}${length}${element && !presetAppliesTo(p, element) ? ` — not for ${element.type} layers` : ''}`}
        onClick={() => {
          if (scene && element && applyPreset(scene.id, element.id, id, { intensity })) onDone();
        }}
      />
    );
  };
  const motion = style?.motion;
  return (
    <div className="ins-section" role="group" aria-label="Motion presets">
      <div className="ins-animate-head">
        <p className="ins-note">{element ? <>On “{element.name}” · editable keys</> : several ? `${several} layers selected` : 'Select a layer to animate it.'}</p>
        <div className="ins-seg" role="radiogroup" aria-label="Intensity">
          {INTENSITIES.map((i) => (
            <button key={i.label} role="radio" aria-checked={intensity === i.value} className={intensity === i.value ? 'on' : ''} onClick={() => setIntensity(i.value)}>
              {i.label}
            </button>
          ))}
        </div>
      </div>
      <p className="ins-style-note" data-testid="insert-style-note">
        {style && motion ? (
          <>
            {style.name} · {motion.id === 'custom' ? 'custom' : PERSONALITY_NOTES[motion.id].label.toLowerCase()} motion · {motion.timingScale}× · {motion.staggerFrames} f apart
          </>
        ) : (
          'No style pack: editor default motion (More → Style…)'
        )}
      </p>
      <div className="ins-kind">
        <span className="ins-kind-label">Principles</span>
        <div className="ins-presets">
          <PresetPill
            label="Arrive apart"
            testId="insert-arrive-apart"
            disabled={!editable || several < 2}
            title={`The selected layers (or a group's layers) rise in one after another in reading order, ${motion?.staggerFrames ?? 4} frames apart.${several < 2 ? ' — select two or more layers, or a group' : ''}`}
            onClick={() => {
              if (arriveApart('riseIn', intensity)) onDone();
            }}
          />
          <PresetPill
            label="Follow-through"
            testId="insert-follow-through"
            disabled={!editable || !isGroup}
            title={`The group slides in; its layers trail, carry on past the stop and settle.${isGroup ? '' : ' — select a group'}`}
            onClick={() => {
              if (scene && element && followThrough(scene.id, element.id, intensity)) onDone();
            }}
          />
          {PRESET_IDS.filter((id) => PRESETS[id].principle).map(pill)}
        </div>
      </div>
      {KINDS.map((kind) => (
        <div key={kind} className="ins-kind">
          <span className="ins-kind-label">{PRESET_KIND_LABELS[kind]}</span>
          <div className="ins-presets">{PRESET_IDS.filter((id) => PRESETS[id].kind === kind && !PRESETS[id].principle).map(pill)}</div>
        </div>
      ))}
      {element && <p className="ins-foot fine">Entrances start on the layer’s first frame, exits end on its last; emphasis and loops start at the playhead.</p>}
    </div>
  );
}

/** The popover's contents. It opens on Animate while a layer is selected, otherwise on Elements. `onAdd` adds an element the rail's way (back to Select). */
export function InsertMenu({ onDone, onAdd }: { onDone: () => void; onAdd: (type: ElementType) => boolean }) {
  const [tab, setTab] = useState<Tab>(() => (useEditor.getState().selection.elementId ? 'animate' : 'elements'));
  const id = useId();
  return (
    <>
      <div className="ins-tabs" role="tablist" aria-label="Insert">
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`${id}-${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`${id}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            className={tab === t.id ? 'on' : ''}
            data-testid={`insert-tab-${t.id}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} data-testid="insert-pop">
        {tab === 'elements' ? <Elements onDone={onDone} onAdd={onAdd} /> : tab === 'templates' ? <Templates onDone={onDone} /> : <Animate onDone={onDone} />}
      </div>
    </>
  );
}
