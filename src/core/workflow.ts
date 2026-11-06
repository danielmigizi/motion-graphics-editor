// From a brief to one workflow: a small lookup that gives an agent the style
// pack, templates and story shape for the kind of video asked for, so it
// starts from a known recipe instead of making up a new genre. All routes
// live in this one table.

export const WORKFLOW_IDS = ['product-launch', 'short-sting', 'music-led', 'kinetic-type', 'general'] as const;
export type WorkflowId = (typeof WORKFLOW_IDS)[number];

export interface WorkflowRoute {
  id: WorkflowId;
  /** First matching row wins — match the deliverable, not a word in passing. */
  when: string;
  pack: string;
  templates: readonly string[];
  story: string;
}

export const WORKFLOWS: Record<WorkflowId, WorkflowRoute> = {
  'product-launch': {
    id: 'product-launch',
    when: 'a product, site, app or company to showcase (a launch brief or a URL)',
    pack: 'snappy-saas',
    templates: ['kineticTitle', 'beforeAfter', 'uiWalkthrough', 'featureGrid', 'statReveal', 'logoSting'],
    story: 'hook → problem/before → product → proof → CTA',
  },
  'short-sting': {
    id: 'short-sting',
    when: 'a short unnarrated motion unit, typically under 10 s (logo, title, stat)',
    pack: 'snappy-saas',
    templates: ['logoSting', 'kineticTitle', 'statReveal'],
    story: 'one beat: the mark lands, holds, exits',
  },
  'music-led': {
    id: 'music-led',
    when: 'a beat-synced film from a track, with no narration (music is the clock)',
    pack: 'editorial',
    templates: ['kineticTitle', 'backdrop', 'logoSting'],
    story: 'cuts and hero settles on downbeats; one idea per bar',
  },
  'kinetic-type': {
    id: 'kinetic-type',
    when: 'type-led or a topic explainer with invented visuals (no product capture)',
    pack: 'editorial',
    templates: ['kineticTitle', 'beforeAfter', 'statReveal', 'testimonial'],
    story: 'one statement per scene; carry kicker and line position across cuts',
  },
  general: {
    id: 'general',
    when: 'anything else (custom, mixed, or longer than a sting/launch)',
    pack: 'paper',
    templates: ['kineticTitle', 'uiWalkthrough', 'logoSting', 'backdrop'],
    story: 'hook in 1.5–2 s, one idea per scene, payoff in the last stretch',
  },
};

export interface WorkflowHint {
  brief?: string;
  audience?: string;
  tone?: string;
  targetSeconds?: number;
  hasMusic?: boolean;
}

/**
 * First matching row. A music bed under a launch does not override the
 * subject; only a beat-driven piece with no narration routes to music-led.
 */
export function routeWorkflow(hint: WorkflowHint): WorkflowId {
  const blob = `${hint.brief ?? ''} ${hint.audience ?? ''} ${hint.tone ?? ''}`.toLowerCase();
  const short = hint.targetSeconds !== undefined && hint.targetSeconds <= 10;
  if (/\b(logo\s*sting|title\s*card|motion\s*sting|\bsting\b)\b/.test(blob) || (short && /\b(logo|title card|stat hit)\b/.test(blob))) {
    return 'short-sting';
  }
  if (
    /\b(beat[- ]sync|music[- ]led|music[- ]to[- ]video|to the (track|music|beats?))\b/.test(blob) &&
    !/\b(narrat|voice[- ]?over|explainer|launch|product)\b/.test(blob)
  ) {
    return 'music-led';
  }
  if (hint.hasMusic && short && /\b(music|track|song|beat)\b/.test(blob) && !/\b(launch|product|saas)\b/.test(blob)) {
    return 'music-led';
  }
  if (/\b(kinetic|type[- ]led|explainer|faceless|magazine)\b/.test(blob)) return 'kinetic-type';
  if (/\b(launch|product|saas|demo|showcase|website|\bapp\b)\b/.test(blob)) return 'product-launch';
  return 'general';
}

export function workflowLine(id: WorkflowId): string {
  const w = WORKFLOWS[id];
  return `${w.id} — pack \`${w.pack}\`; templates ${w.templates.join(', ')}; story ${w.story}.`;
}
