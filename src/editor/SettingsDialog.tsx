// Settings (layout.ts overlay 'settings'; the gear in the header, ⌘,), three
// pages. Project is what the video itself keeps: its name, size and frame
// rate, style and music, each change one undo step. Editor is how the editor
// works for you: the theme, Auto-apply, which agent and model answer in the
// chat, a new unlocked tab or a one-time link for another browser (session.ts), and the
// queued requests (AiPanel). Generation is the fal key, the
// budget and the routing policy, kept by the local server
// (GenerationSettings.tsx). The command palette opens it at one setting
// (openSettingsAt). Mounted once in App.

import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { newId } from '../core/ids';
import { PERSONALITY_NOTES, STYLE_PACK_NOTES, type StylePackId } from '../core/style';
import { formatTimecode, projectDurationInFrames } from '../core/timing';
import type { Asset, AudioClip, Command, Project } from '../core/types';
import { AiPanel } from './AiPanel';
import { api, errorText, LOCKED_MESSAGE } from './api';
import { newAsset, uploadAsset } from './assets';
import { loadProviders, providerLabel, providerStatus, setChatSettings, useChat } from './chat';
import { autoApplyTitle } from './ChatPanel';
import { isTyping, shortcutLabel } from './editActions';
import { CommitText, Section, SelectField } from './fields';
import { FormatForm } from './FormatDialog';
import { FieldError, GenerationPage, type GenerationSection } from './GenerationSettings';
import { Icon, type IconName } from './icons';
import { useLayout, type SettingsPage } from './layout';
import { holdFocus, isTextEntry, trapTab, useDialogFocus } from './overlayFocus';
import { useProposals } from './proposals';
import { openUnlockedTab, useSession } from './session';
import { useEditor } from './store';
import { openStylePanel, PackSwatch } from './StylePanel';
import { THEME_CHOICES, useTheme } from './theme';

export type SettingsSection = 'name' | 'format' | 'style' | 'music' | 'theme' | 'autoApply' | 'agent' | 'otherBrowser' | 'requests' | GenerationSection;

/** Every setting, in page order, as the command palette lists it. */
export const SETTINGS_SECTIONS: { id: SettingsSection; page: SettingsPage; label: string; keywords: string[] }[] = [
  { id: 'name', page: 'project', label: 'Project name', keywords: ['rename', 'title'] },
  { id: 'format', page: 'project', label: 'Size and frame rate', keywords: ['format', 'resolution', 'aspect', 'fps', 'width', 'height', 'landscape', 'vertical', 'square'] },
  { id: 'style', page: 'project', label: 'Style', keywords: ['pack', 'fonts', 'colours', 'colors', 'motion', 'personality'] },
  { id: 'music', page: 'project', label: 'Music', keywords: ['audio', 'soundtrack', 'track', 'bed'] },
  { id: 'theme', page: 'editor', label: 'Theme', keywords: ['dark', 'light', 'system', 'appearance'] },
  { id: 'autoApply', page: 'editor', label: 'Auto-apply', keywords: ['agent edits', 'review', 'proposals', 'auto mode'] },
  { id: 'agent', page: 'editor', label: 'Agent and model', keywords: ['claude', 'codex', 'cursor', 'opencode', 'provider'] },
  { id: 'otherBrowser', page: 'editor', label: 'Open in another tab or browser', keywords: ['editor link', 'one-time link', 'unlock', 'session', 'browser', 'tab', 'new tab', 'copy link'] },
  { id: 'requests', page: 'editor', label: 'Queued requests', keywords: ['revision', 'patch', 'prompt'] },
  { id: 'falKey', page: 'generation', label: 'fal API key', keywords: ['fal', 'api key', 'key', 'token', 'keychain', 'billing', 'generate', 'generation'] },
  { id: 'spending', page: 'generation', label: 'Generation spending', keywords: ['budget', 'spend', 'cost', 'price', 'daily', 'limit', 'confirm', 'permission', 'credit', 'gpt image', 'reserve'] },
  { id: 'routing', page: 'generation', label: 'Choosing models', keywords: ['model', 'policy', 'routing', 'quality', 'balanced', 'draft', 'cheap', 'generation'] },
  { id: 'models', page: 'generation', label: 'Models', keywords: ['scoreboard', 'evidence', 'keep rate', 'cost per kept', 'use rate', 'suggestion', 'default model', 'results', 'generation'] },
];

const PAGES: { id: SettingsPage; label: string; icon: IconName; intro: string }[] = [
  { id: 'project', label: 'Project', icon: 'film', intro: 'Kept in this video. Each change is one step you can undo.' },
  { id: 'editor', label: 'Editor', icon: 'monitor', intro: 'How the editor looks, and how your agent works with it.' },
  { id: 'generation', label: 'Generation', icon: 'sparkles', intro: 'Your fal key, what generation may spend, how models are chosen, and how each has done for you. Kept on this computer, for every project.' },
];

/** The section a palette pick asked for; read by the next opening only. */
let requested: SettingsSection | null = null;

/** Open Settings on the page of `id`, scrolled to it, with focus on its first control. */
export function openSettingsAt(id: SettingsSection) {
  const section = SETTINGS_SECTIONS.find((s) => s.id === id);
  if (!section) return;
  requested = id;
  useLayout.getState().openSettings(section.page);
}

// The queued requests are AiPanel's own sections; the rest are this file's.
const sectionSelector = (id: SettingsSection) => `[data-testid="${id === 'requests' ? 'ai-panel' : `settings-${id}`}"]`;

const close = () => useLayout.getState().openOverlay(null);

export function SettingsDialog() {
  const open = useLayout((s) => s.overlay === 'settings');
  return open ? <Settings /> : null;
}

function Settings() {
  const page = useLayout((s) => s.settingsPage);
  const ref = useRef<HTMLDivElement>(null);
  // Read in the initializer (twice under StrictMode, harmlessly) and cleared after mount.
  const [target] = useState(() => requested);
  useEffect(() => {
    requested = null;
  }, []);
  useDialogFocus(ref, target ? `${sectionSelector(target)} :is(input, select, textarea, button)` : '.set-tab[aria-selected="true"]');
  useLayoutEffect(() => {
    const el = target && ref.current?.querySelector<HTMLElement>(sectionSelector(target));
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
    el.dataset.flash = '';
  }, [target]);

  // A review opening (Preview changes in the queued requests) needs the stage: get out of its way.
  const reviewing = useProposals((s) => s.open);
  const wasReviewing = useRef(reviewing);
  useEffect(() => {
    if (reviewing && !wasReviewing.current) close();
    wasReviewing.current = reviewing;
  }, [reviewing]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      // The first Escape leaves a text field (a name field reverts too); the next one closes.
      if (isTextEntry(e.target)) (e.target as HTMLElement).blur();
      else close();
      return;
    }
    trapTab(e, ref.current);
    // Keys stay in the dialog, except ⌘ shortcuts outside a field: undo, redo, save, the palette.
    if (!(e.metaKey || e.ctrlKey) || isTyping(e.target)) e.stopPropagation();
  };

  const onTabKey = (e: KeyboardEvent) => {
    const i = PAGES.findIndex((p) => p.id === page);
    const next = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? PAGES.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const to = PAGES[(next + PAGES.length) % PAGES.length].id;
    useLayout.getState().openSettings(to);
    ref.current?.querySelector<HTMLElement>(`#settings-tab-${to}`)?.focus();
  };

  const current = PAGES.find((p) => p.id === page) ?? PAGES[0];

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={ref}
        className="modal set-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        data-testid="settings-dialog"
        onKeyDown={onKeyDown}
        onBlur={(e: FocusEvent) => holdFocus(e, ref.current)}
      >
        <header className="modal-head">
          <h2 id="settings-title">Settings</h2>
          <button className="icon-btn" onClick={close} aria-label="Close" title="Close (Esc)" data-testid="settings-close">
            <Icon name="close" />
          </button>
        </header>
        <div className="set-body">
          <div className="set-nav" role="tablist" aria-orientation="vertical" aria-label="Settings pages">
            {PAGES.map((p) => (
              <button
                key={p.id}
                id={`settings-tab-${p.id}`}
                role="tab"
                aria-selected={p.id === page}
                aria-controls={`settings-page-${p.id}`}
                tabIndex={p.id === page ? 0 : -1}
                className="set-tab"
                data-testid={`settings-tab-${p.id}`}
                onClick={() => useLayout.getState().openSettings(p.id)}
                onKeyDown={onTabKey}
              >
                <Icon name={p.icon} />
                {p.label}
              </button>
            ))}
          </div>
          <div key={page} className="set-page" role="tabpanel" id={`settings-page-${page}`} aria-labelledby={`settings-tab-${page}`} data-testid={`settings-page-${page}`}>
            <p className="set-intro">{current.intro}</p>
            {page === 'project' ? <ProjectPage /> : page === 'editor' ? <EditorPage /> : <GenerationPage focusSection={target} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Project -------------------------------------------------------------

function ProjectPage() {
  const name = useEditor((s) => s.doc.project.name);
  return (
    <>
      <Section title="Name" testId="settings-name">
        <CommitText value={name} testId="settings-project-name" maxLength={80} onCommit={(v) => v.trim() && useEditor.getState().run({ type: 'updateProject', changes: { name: v.trim() } }, 'Renamed the project')} />
      </Section>
      <Section title="Size and frame rate" testId="settings-format">
        <FormatForm />
      </Section>
      <Section title="Style" testId="settings-style">
        <StyleSetting />
      </Section>
      <Section title="Music" testId="settings-music">
        <MusicSetting />
      </Section>
    </>
  );
}

function StyleSetting() {
  const pack = useEditor((s) => s.doc.project.style ?? null);
  const note = !pack
    ? 'Editor defaults; templates borrow the project’s own fonts and colours.'
    : pack.id in STYLE_PACK_NOTES
      ? STYLE_PACK_NOTES[pack.id as StylePackId]
      : `${pack.fonts.heading} headlines, ${pack.fonts.body} text.`;
  const motion = pack && (pack.motion.id === 'custom' ? 'Motion tuned by hand' : `${PERSONALITY_NOTES[pack.motion.id].label} motion`);
  return (
    <div className="set-style">
      <PackSwatch pack={pack} />
      <div className="set-style-text">
        <span className="set-style-name">
          {pack?.name ?? 'No pack'}
          {motion && <span className="set-meta"> · {motion}</span>}
        </span>
        <span className="set-note">{note}</span>
      </div>
      <button className="btn" data-testid="settings-style-open" onClick={openStylePanel}>
        {pack ? 'Change…' : 'Choose…'}
      </button>
    </div>
  );
}

/** A new bed, the way a new video places its chosen track (core/newProject.ts): the whole video, 60 %, a short fade in and a longer fade out. */
function musicBed(project: Project, asset: Asset): AudioClip {
  const total = projectDurationInFrames(project);
  const durationInFrames = Math.max(1, Math.min(total, asset.durationInFrames ?? total));
  return {
    id: newId('aud'),
    assetId: asset.id,
    name: 'Music bed',
    startFrame: 0,
    trimStartFrames: 0,
    durationInFrames,
    volume: 0.6,
    fadeInFrames: Math.min(durationInFrames, Math.round(project.fps * 0.5)),
    fadeOutFrames: Math.min(durationInFrames, Math.round(project.fps * 1.5)),
  };
}

/** The bed plays `asset` instead: from where it starts to the end of the video, or of the track if that is shorter. */
function replaceTrack(project: Project, clip: AudioClip, asset: Asset): Command {
  const old = project.assets[clip.assetId];
  const durationInFrames = Math.max(1, Math.min(projectDurationInFrames(project) - clip.startFrame, asset.durationInFrames ?? clip.durationInFrames));
  return {
    type: 'updateAudioClip',
    clipId: clip.id,
    changes: {
      assetId: asset.id,
      // A bed named after its file takes the new file's name; one the user named keeps it.
      name: !old || clip.name === old.name ? asset.name : clip.name,
      trimStartFrames: 0,
      durationInFrames,
      fadeInFrames: Math.min(clip.fadeInFrames, durationInFrames),
      fadeOutFrames: Math.min(clip.fadeOutFrames, durationInFrames),
      ...(clip.volumeEnvelope ? { volumeEnvelope: clip.volumeEnvelope.filter((p) => p.frame <= durationInFrames) } : {}),
    },
  };
}

/**
 * The project's music: its project-level audio clips (no sceneId, the
 * timeline's Music lane). Each can play another of the project's tracks or an
 * uploaded file, or be removed; with none, one can be added.
 */
export async function uploadMusic(clip: AudioClip | null): Promise<boolean> {
  const session = useEditor.getState().docSession;
  const fields = await uploadAsset(['audio']);
  if (!fields) return false;
  const st = useEditor.getState();
  if (st.docSession !== session) {
    st.toast({ tone: 'info', message: `“${fields.name}” was uploaded, but another project is open now, so it was not added.` });
    return false;
  }
  const asset = newAsset(fields);
  const now = st.doc.project;
  const bed = clip && now.audio.find((c) => c.id === clip.id);
  const label = bed ? `Replaced the music with “${asset.name}”` : `Added music “${asset.name}”`;
  return st.run({ type: 'batch', label, commands: [{ type: 'addAsset', asset }, bed ? replaceTrack(now, bed, asset) : { type: 'addAudioClip', clip: musicBed(now, asset) }] });
}

function MusicSetting() {
  const project = useEditor((s) => s.doc.project);
  const [busy, setBusy] = useState(false);
  const beds = project.audio.filter((c) => !c.sceneId);
  const tracks = Object.values(project.assets).filter((a) => a.kind === 'audio' && !a.reference);
  const run = (command: Command, label: string) => useEditor.getState().run(command, label);

  const choose = (clip: AudioClip | null, assetId: string) => {
    const asset = project.assets[assetId];
    if (!asset || asset.id === clip?.assetId) return;
    if (clip) run(replaceTrack(project, clip, asset), `Replaced the music with “${asset.name}”`);
    else run({ type: 'addAudioClip', clip: musicBed(project, asset) }, `Added music “${asset.name}”`);
  };

  const upload = async (clip: AudioClip | null) => {
    setBusy(true);
    try {
      await uploadMusic(clip);
    } finally {
      setBusy(false);
    }
  };

  const trackOptions = (clip: AudioClip) => {
    const options = tracks.map((a) => ({ value: a.id, label: a.name }));
    // A bed playing something outside the list (a video's sound, a missing file) still shows what it plays.
    if (!options.some((o) => o.value === clip.assetId)) options.unshift({ value: clip.assetId, label: project.assets[clip.assetId]?.name ?? 'Missing file' });
    return options;
  };

  return (
    <div className="set-music-list">
      {beds.map((clip) => (
        <div key={clip.id} className="set-music" data-testid={`settings-music-${clip.id}`}>
          <Icon name="music" />
          <div className="set-music-text">
            <span className="set-music-name">{clip.name}</span>
            <span className="set-meta tabular">
              {formatTimecode(clip.startFrame, project.fps)} – {formatTimecode(clip.startFrame + clip.durationInFrames, project.fps)} · {Math.round(clip.volume * 100)} %
              {clip.volumeEnvelope?.length ? ' · ducked under voice' : ''}
            </span>
          </div>
          <div className="set-music-actions">
            <SelectField value={clip.assetId} options={trackOptions(clip)} testId={`settings-music-track-${clip.id}`} onCommit={(id) => choose(clip, id)} />
            <button className="btn" disabled={busy} data-testid={`settings-music-upload-${clip.id}`} onClick={() => void upload(clip)}>
              Upload…
            </button>
            <button className="icon-btn" aria-label={`Remove “${clip.name}”`} title="Remove the music" data-testid={`settings-music-remove-${clip.id}`} onClick={() => run({ type: 'removeAudioClip', clipId: clip.id }, `Removed the music “${clip.name}”`)}>
              <Icon name="trash" />
            </button>
          </div>
        </div>
      ))}
      {beds.length === 0 && (
        <div className="set-music empty" data-testid="settings-music-none">
          <Icon name="music" />
          <div className="set-music-text">
            <span className="set-music-name">No music</span>
            <span className="set-meta">A track here plays under the whole video.</span>
          </div>
          <div className="set-music-actions">
            {tracks.length > 0 && (
              <select className="input select" value="" data-testid="settings-music-add" aria-label="Use one of the project’s tracks" onChange={(e) => choose(null, e.target.value)}>
                <option value="">Use a track…</option>
                {tracks.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
            <button className="btn" disabled={busy} data-testid="settings-music-upload" onClick={() => void upload(null)}>
              Upload…
            </button>
          </div>
        </div>
      )}
      <p className="set-note">Volume, fades and ducking: Scene settings › Project audio, or the timeline’s Music lane.</p>
    </div>
  );
}

// ---- Editor --------------------------------------------------------------

function EditorPage() {
  return (
    <>
      <Section title="Theme" testId="settings-theme">
        <ThemeSetting />
      </Section>
      <Section title="Auto-apply" testId="settings-autoApply">
        <AutoApplySetting />
      </Section>
      <Section title="Agent and model" testId="settings-agent">
        <AgentSetting />
      </Section>
      <Section title="Open in another tab or browser" testId="settings-otherBrowser">
        <OtherBrowserSetting />
      </Section>
      {/* Its own sections: Request a revision, Queued requests, Apply patch. */}
      <AiPanel />
    </>
  );
}

function ThemeSetting() {
  const { choice, setChoice } = useTheme();
  return (
    <>
      <div className="cv-chips" role="radiogroup" aria-label="Theme">
        {THEME_CHOICES.map((c) => (
          <button key={c.id} role="radio" aria-checked={choice === c.id} className={`cv-chip ${choice === c.id ? 'on' : ''}`} data-testid={`settings-theme-${c.id}`} onClick={() => setChoice(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
      <p className="set-note">System follows your computer. The stage stays dark in every theme. {shortcutLabel('T', ['alt', 'shift'])} steps through them.</p>
    </>
  );
}

/**
 * Two ways to a second unlocked editor (session.ts). New tab: opened from this
 * one, it inherits the secret, so no link changes hands. Another browser: a
 * one-time link, copied (shown to select by hand when the clipboard refuses);
 * opening it asks this tab to allow it, a permission card like an agent's.
 */
export function OtherBrowserSetting() {
  const locked = useSession((s) => s.editor === false);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ url: string; copied: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const newTab = () => setError(openUnlockedTab() ? null : NEW_TAB_BLOCKED);
  const copy = async () => {
    setBusy(true);
    setError(null);
    setLink(null);
    try {
      const { url } = await api.editorLink();
      const copied = await navigator.clipboard?.writeText(url).then(() => true, () => false) ?? false;
      setLink({ url, copied });
    } catch (e) {
      setError(errorText(e).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="set-open" data-testid="settings-new-tab-row">
        <div className="set-open-text">
          <span className="set-open-name">New tab</span>
          <p className="set-note">Opens the editor in a new tab of this browser, already unlocked. No link to copy.</p>
        </div>
        <button className="btn" disabled={locked} data-testid="settings-new-tab" onClick={newTab}>
          Open a new unlocked tab
        </button>
      </div>
      <div className="set-open" data-testid="settings-other-browser-row">
        <div className="set-open-text">
          <span className="set-open-name">Another browser</span>
          <p className="set-note">Each link works once, for 5 minutes. When it’s opened, this tab asks you to allow it. Links stop working when the server restarts.</p>
        </div>
        <div className="set-link-row">
          {link?.copied && <span className="set-meta" role="status">Copied</span>}
          <button className="btn" disabled={busy || locked} data-testid="settings-copy-link" onClick={() => void copy()}>
            {busy ? 'Making a link…' : 'Copy a one-time link'}
          </button>
        </div>
      </div>
      {link && !link.copied && (
        <input className="input mono" readOnly value={link.url} aria-label="One-time editor link" data-testid="settings-link" onFocus={(e) => e.currentTarget.select()} />
      )}
      <FieldError message={locked ? LOCKED_MESSAGE : error} />
    </>
  );
}

const NEW_TAB_BLOCKED = 'The browser blocked the new tab. Allow pop-ups for this page, then try again.';

/** The chat's Auto-apply switch (proposals.ts autoApply): one setting, remembered in this browser. */
function AutoApplySetting() {
  const on = useProposals((s) => s.autoApply);
  const provider = useChat((s) => s.provider);
  const agent = useChat((s) => providerLabel(s.providers, s.provider));
  return (
    <>
      <button className={`c-switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} data-testid="settings-auto-apply" onClick={() => useProposals.getState().setAutoApply(!on)}>
        <span className="c-switch-track" aria-hidden>
          <span className="c-switch-knob" />
        </span>
        Apply agent edits without review
      </button>
      <p className="set-note">{autoApplyTitle(on, agent, provider)} The same switch sits under the chat’s message box.</p>
    </>
  );
}

/** The chat's agent picker as a setting: the same providers and models (chat.ts), the same switch (setChatSettings). */
function AgentSetting() {
  const providers = useChat((s) => s.providers);
  const provider = useChat((s) => s.provider);
  const model = useChat((s) => s.model);
  const busy = useChat((s) => s.busy);
  const switching = useChat((s) => s.switching);
  useEffect(() => {
    void loadProviders();
  }, []);
  const name = providerLabel(providers, provider);
  const current = providers.find((p) => p.id === provider);
  const locked = busy || switching;
  const models = current?.models.length ? current.models : [{ id: '', label: 'Default' }];

  return (
    <>
      {providers.length === 0 ? (
        <p className="set-note">Checking which agents are signed in…</p>
      ) : (
        <div className="fmt-choices set-agents" role="radiogroup" aria-label="Agent">
          {providers.map((p) => {
            const status = providerStatus(p);
            const on = p.id === provider;
            return (
              <button
                key={p.id}
                role="radio"
                aria-checked={on}
                className={`fmt-choice ${on ? 'on' : ''}`}
                disabled={!on && (locked || status !== 'available')}
                title={status === 'available' ? p.detail : undefined}
                data-testid={`settings-agent-${p.id}`}
                // An agent's first model is its default.
                onClick={() => !on && void setChatSettings(p.id, p.models[0]?.id ?? '')}
              >
                <span className="fmt-choice-label set-agent-name">
                  <span className={`c-dot ${status} ${on && busy ? 'busy' : ''}`} aria-hidden />
                  {p.label}
                </span>
                <span className="fmt-choice-hint">{status === 'available' ? 'Ready' : p.detail || 'Unavailable'}</span>
              </button>
            );
          })}
        </div>
      )}
      <label className="set-field">
        <span className="set-field-label">Model</span>
        <SelectField
          value={model}
          options={models.map((m) => ({ value: m.id, label: m.label }))}
          disabled={locked || !current || providerStatus(current) !== 'available'}
          testId="settings-model"
          onCommit={(id) => void setChatSettings(provider, id)}
        />
      </label>
      <p className="set-note">
        {busy ? `${name} is working — wait for it to finish (or stop it) to switch. ` : switching ? 'Switching… ' : ''}
        Each agent uses your own subscription. Switching carries a short summary of the conversation over.
      </p>
    </>
  );
}
