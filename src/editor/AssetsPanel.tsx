// The Assets tab of the right column: asset problems, when there are any
// (missing files, files a browser cannot decode, bundled fonts that did not
// load — each naming the elements it affects, with Select buttons), then the
// library: every asset as a list or a grid of square thumbnails, searched,
// filtered (images, video, audio, generated, references) and sorted, each
// thumbnail shown larger while the pointer rests on it and draggable into the
// Generate composer. Generated takes, as a list, are grouped by request
// (TakesPanel.tsx). The library's filter, sort and view are remembered per
// browser (assetLibrary.ts).

import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { loadBundledFonts } from '../composition/fonts';
import { videoPreviewSrc } from '../composition/previewProxies';
import { framesToSeconds, resolveAssetUrl, sceneStartFrame } from '../core/timing';
import type { Asset } from '../core/types';
import { startAssetDrag } from './assetDrag';
import { DEFAULT_LIBRARY_PREFS, filterCounts, LIBRARY_FILTERS, LIBRARY_SORTS, libraryItems, parseLibraryPrefs, type LibraryFilter, type LibraryPrefs } from './assetLibrary';
import { assetWarnings, collectAssetRefs, groupWarnings, newAsset, probeAsset, uploadAsset, useAssetStatus, type AssetOwner, type AssetProbe, type AssetProblem, type AssetWarning } from './assets';
import { bpmText, useBeats } from './audioBeats';
import { AudioPlayButton } from './AudioPreview';
import { CommitText, Section } from './fields';
import { sendToGenerate } from './generateDrop';
import { Icon } from './icons';
import { useLayout } from './layout';
import { peekProps } from './Peek';
import { Chip, Option, PopLabel } from './Popover';
import { useEditor } from './store';
import { TakesPanel } from './TakesPanel';
import { formatClipLength, VideoPreviewState } from './VideoAssetRow';
import { replacementChanges } from './videoEdits';
import { useVideoProxyFill } from './videoProxies';

/** Runs once in App: probes every asset file whenever the asset set changes or the server comes up, and checks bundled fonts. */
export function useAssetFileChecks() {
  useVideoProxyFill();
  const assets = useEditor((s) => s.doc.project.assets);
  const server = useEditor((s) => s.server);
  const key = useMemo(() => [...new Set(Object.values(assets).map((a) => a.src))].sort().join('|'), [assets]);
  useEffect(() => {
    if (server !== 'up') {
      useEditor.setState({ missingSrc: [] });
      useAssetStatus.setState({ probes: {} });
      return;
    }
    let cancelled = false;
    const srcs = key ? key.split('|') : [];
    Promise.all(srcs.map(async (src) => [src, await probeAsset(src)] as const)).then((results) => {
      if (cancelled) return;
      const probes = Object.fromEntries(results.filter((r): r is [string, NonNullable<(typeof r)[1]>] => !!r[1]));
      useAssetStatus.setState({ probes });
      useEditor.setState({ missingSrc: Object.entries(probes).filter(([, p]) => !p.exists).map(([src]) => src) });
    });
    return () => {
      cancelled = true;
    };
  }, [key, server]);
  useEffect(() => {
    let cancelled = false;
    void loadBundledFonts().then(({ failed }) => {
      if (!cancelled) useAssetStatus.setState({ fontFailures: failed });
    });
    return () => {
      cancelled = true;
    };
  }, []);
}

export function useAssetWarnings(): AssetWarning[] {
  const project = useEditor((s) => s.doc.project);
  const missing = useEditor((s) => s.missingSrc);
  const probes = useAssetStatus((s) => s.probes);
  const fontFailures = useAssetStatus((s) => s.fontFailures);
  return useMemo(() => {
    const undecodable = new Map(Object.entries(probes).flatMap(([src, p]) => (p.exists && !p.decodable ? [[src, p.error ?? 'unreadable file'] as const] : [])));
    return assetWarnings(project, { missingSrc: new Set(missing), undecodable, fontFailures });
  }, [project, missing, probes, fontFailures]);
}

/** Select what a warning points at and show it in the Inspector tab: the element, or for audio the scene it plays in. */
export function selectOwner(owner: AssetOwner) {
  const st = useEditor.getState();
  const project = st.doc.project;
  if (owner.kind === 'element') {
    const scene = project.scenes.find((s) => s.id === owner.sceneId);
    const el = scene?.elements.find((e) => e.id === owner.elementId);
    if (!scene || !el) return;
    st.seek(sceneStartFrame(project, scene.id) + el.startFrame);
    st.selectElement(scene.id, el.id);
  } else if (owner.kind === 'audio') {
    if (owner.sceneId) st.seek(sceneStartFrame(project, owner.sceneId));
    st.select({ elementId: null });
    st.setSceneInspectorOpen(true);
  } else return; // an element inside a component has nothing to select
  useLayout.getState().setRightTab('inspector');
}

const PROBLEM_TITLE: Record<AssetProblem['problem'], string> = {
  noFile: 'No file chosen',
  unknownAsset: 'Unknown asset',
  missing: 'File missing',
  undecodable: 'Can’t decode file',
  font: 'Fonts failed to load',
};

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Replace an asset's file in place, keeping its name; every reference follows. */
async function replaceFile(a: Asset, verb: 'Replace' | 'Relink', setBusy: (b: boolean) => void) {
  setBusy(true);
  const f = await uploadAsset([a.kind]);
  setBusy(false);
  if (!f) return;
  useEditor.getState().run({ type: 'replaceAsset', assetId: a.id, changes: replacementChanges(a, f) }, `${verb} file of ${a.name}`);
}

const PREFS_KEY = 'mge.assets';

function readLibraryPrefs(): LibraryPrefs {
  try {
    return parseLibraryPrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return DEFAULT_LIBRARY_PREFS;
  }
}

/** The library's filter, sort and view, remembered in this browser (a blocked store just forgets). */
const useLibraryPrefs = create<LibraryPrefs>(readLibraryPrefs);

function setLibraryPrefs(patch: Partial<LibraryPrefs>): void {
  useLibraryPrefs.setState(patch);
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(useLibraryPrefs.getState()));
  } catch {
    // Private window or blocked storage: the choice lasts this session.
  }
}

/** Open the Assets tab on one of the library's filters (Generate's "show the takes"). */
export function showInLibrary(filter: LibraryFilter): void {
  setLibraryPrefs({ filter });
  useLayout.getState().setRightTab('assets');
}

/** A file's figures for its row: size or length, bytes, uses; no break inside a figure ("170 KB"). */
function assetFigures(a: Asset, probe: AssetProbe | undefined, uses: number, fps: number): string {
  const seconds = a.durationInFrames ? framesToSeconds(a.durationInFrames, fps) : undefined;
  const parts =
    a.kind === 'video'
      ? [seconds !== undefined ? formatClipLength(seconds) : null, a.width && a.height ? `${a.width}×${a.height}` : null, a.fps ? `${Math.round(a.fps * 100) / 100} fps` : null, a.hasAudio === false ? 'no sound' : 'sound']
      : a.kind === 'audio'
        ? [seconds !== undefined ? `${seconds.toFixed(1)} s` : null]
        : [a.width && a.height ? `${a.width}×${a.height}` : null];
  return [...parts, probe?.bytes !== undefined ? fmtBytes(probe.bytes) : null, `used ${uses}×`]
    .filter((m): m is string => !!m)
    .map((m) => m.replaceAll(' ', '\u00a0'))
    .join(' · ');
}

export function AssetsPanel() {
  const project = useEditor((s) => s.doc.project);
  const server = useEditor((s) => s.server);
  const run = useEditor((s) => s.run);
  const probes = useAssetStatus((s) => s.probes);
  const fontFailures = useAssetStatus((s) => s.fontFailures);
  const warnings = useAssetWarnings();
  const problems = useMemo(() => groupWarnings(warnings), [warnings]);
  const [busy, setBusy] = useState(false);
  const prefs = useLibraryPrefs();
  const setPrefs = setLibraryPrefs;
  const [query, setQuery] = useState('');
  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of collectAssetRefs(project)) m.set(r.assetId, (m.get(r.assetId) ?? 0) + 1);
    return m;
  }, [project]);
  const all = useMemo(() => Object.values(project.assets), [project.assets]);
  const counts = useMemo(() => filterCounts(all), [all]);
  const items = useMemo(() => libraryItems(all, { filter: prefs.filter, sort: prefs.sort, query, bytes: (a) => probes[a.src]?.bytes, uses: usage }), [all, prefs.filter, prefs.sort, query, probes, usage]);
  const grouped = prefs.filter === 'generated' && prefs.view === 'list';

  const addNew = async () => {
    setBusy(true);
    const f = await uploadAsset(['image', 'svg', 'audio', 'video']);
    setBusy(false);
    if (f) {
      const asset = newAsset(f);
      run({ type: 'addAsset', asset }, `Add asset ${asset.name}`);
    }
  };

  const detail = (p: AssetProblem) => (p.problem === 'font' ? `${fontFailures.join(', ')}. Text in these faces previews in a fallback font; an export stops rather than use one.` : p.reason);
  const sortLabel = LIBRARY_SORTS.find((x) => x.id === prefs.sort)!;

  return (
    <div className="panel-scroll" data-testid="assets-panel">
      {(problems.length > 0 || server !== 'up') && (
        <Section title={`Problems (${problems.length})`} testId="asset-problems">
          {server !== 'up' && <p className="fine">File checks need the local server; only project references and fonts are checked right now.</p>}
          {problems.length > 0 && (
            <ul className="problem-list" data-testid="asset-warnings">
              {problems.map((p) => {
                const asset = p.assetId ? project.assets[p.assetId] : undefined;
                return (
                  <li key={p.key} className={`problem ${p.problem}`} data-testid={`asset-problem-${p.key}`}>
                    <Icon name="warning" size={14} />
                    <div className="problem-main">
                      <div className="problem-title">
                        {PROBLEM_TITLE[p.problem]}
                        {asset && <span> · {asset.name}</span>}
                      </div>
                      <div className="fine">{detail(p)}</div>
                      <ul className="problem-users">
                        {p.users.map((w) => (
                          <li key={w.key}>
                            <span title={w.owner.label}>{w.owner.label}</span>
                            {w.owner.kind === 'component' ? (
                              <span className="fine">in a component</span>
                            ) : (
                              <button className="mini-btn" data-testid={`asset-select-${w.key}`} onClick={() => selectOwner(w.owner)}>
                                Select
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                    {asset && (p.problem === 'missing' || p.problem === 'undecodable') && (
                      <button className="mini-btn" disabled={busy} data-testid={`asset-fix-${asset.id}`} onClick={() => replaceFile(asset, p.problem === 'missing' ? 'Relink' : 'Replace', setBusy)}>
                        {p.problem === 'missing' ? 'Relink…' : 'Replace…'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      )}
      <section className="lib" data-testid="asset-library">
        <header className="lib-head">
          <h3>
            Assets <span className="lib-n">{all.length}</span>
          </h3>
          <div className="lib-view" role="radiogroup" aria-label="View">
            {(['list', 'grid'] as const).map((v) => (
              <button key={v} type="button" role="radio" aria-checked={prefs.view === v} className={`icon-btn small${prefs.view === v ? ' on' : ''}`} aria-label={v === 'list' ? 'List' : 'Grid'} title={v === 'list' ? 'List: names, sizes and uses' : 'Grid: larger pictures'} data-testid={`asset-view-${v}`} onClick={() => setPrefs({ view: v })}>
                <Icon name={v === 'list' ? 'rows' : 'grid'} size={14} />
              </button>
            ))}
          </div>
          <button className="mini-btn" disabled={busy} onClick={addNew} data-testid="asset-add">
            Upload…
          </button>
        </header>
        <div className="lib-tools">
          <label className="lib-search">
            <Icon name="search" size={13} />
            <input
              type="search"
              value={query}
              placeholder="Search"
              aria-label="Search assets"
              data-testid="asset-search"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape') setQuery('');
              }}
            />
          </label>
          <Chip icon="rows" label={sortLabel.short} title="Sort" menu align="end" popClass="lib-sort-pop" testId="asset-sort">
            {(close) => (
              <>
                <PopLabel>Sort by</PopLabel>
                {LIBRARY_SORTS.map((x) => (
                  <Option
                    key={x.id}
                    label={x.label}
                    checked={x.id === prefs.sort}
                    testId={`asset-sort-${x.id}`}
                    onSelect={() => {
                      setPrefs({ sort: x.id });
                      close();
                    }}
                  />
                ))}
              </>
            )}
          </Chip>
        </div>
        <div className="lib-filters" role="radiogroup" aria-label="Show">
          {LIBRARY_FILTERS.filter((f) => f.id === 'all' || counts[f.id] > 0 || f.id === prefs.filter).map((f) => (
            <button key={f.id} type="button" role="radio" aria-checked={prefs.filter === f.id} className={`lib-filter${prefs.filter === f.id ? ' on' : ''}`} data-testid={`asset-filter-${f.id}`} onClick={() => setPrefs({ filter: f.id })}>
              {f.label}
              <span className="lib-filter-n">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        {grouped ? (
          <TakesPanel query={query} order={prefs.sort === 'oldest' ? 'oldest' : 'newest'} />
        ) : items.length === 0 ? (
          <p className="lib-empty">{all.length === 0 ? 'No assets yet. Upload images, video or sound, or make some in Generate.' : query ? `Nothing matches “${query}”.` : 'Nothing here yet.'}</p>
        ) : prefs.view === 'grid' ? (
          <ul className="lib-grid" data-testid="asset-grid">
            {items.map((a) => (
              <AssetTile key={a.id} asset={a} probe={probes[a.src]} uses={usage.get(a.id) ?? 0} />
            ))}
          </ul>
        ) : (
          <ul className="lib-list" data-testid="asset-list">
            {items.map((a) => (
              <AssetRow key={a.id} asset={a} probe={probes[a.src]} uses={usage.get(a.id) ?? 0} busy={busy} onReplace={(verb) => replaceFile(a, verb, setBusy)} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Use as a reference, or stop: a reference steers generation and is never placed in the video. */
function ReferenceToggle({ asset, uses }: { asset: Asset; uses: number }) {
  const run = useEditor((s) => s.run);
  const on = !!asset.reference;
  const blocked = !on && uses > 0;
  return (
    <button
      type="button"
      className={`icon-btn small lib-ref${on ? ' on' : ''}`}
      aria-pressed={on}
      aria-label={on ? 'Reference: stop using as a reference' : 'Use as a reference'}
      title={blocked ? 'In use in the video; remove it from the video first to make it a reference' : on ? 'A reference: steers generation, never placed in the video. Click to stop.' : 'Use as a reference: steers generation and agents, never placed in the video'}
      disabled={blocked}
      data-testid={`ref-toggle-${asset.id}`}
      onClick={() => run({ type: 'replaceAsset', assetId: asset.id, changes: { reference: !on } }, on ? `Stop using ${asset.name} as a reference` : `Use ${asset.name} as a reference`)}
    >
      <Icon name="bookmark" size={13} />
    </button>
  );
}

/** Open Generate working from this picture or clip. */
function GenerateWith({ asset }: { asset: Asset }) {
  if (asset.kind === 'audio') return null;
  return (
    <button type="button" className="icon-btn small" aria-label={`Generate from ${asset.name}`} title={asset.kind === 'video' ? 'Generate from this clip: keep its subject in a new shot' : 'Generate from this image: animate, edit or combine it'} data-testid={`asset-generate-${asset.id}`} onClick={() => sendToGenerate([asset.id])}>
      <Icon name="sparkles" size={13} />
    </button>
  );
}

/** Where it came from, as a mark before its kind: generated, or a reference. */
function Marks({ asset }: { asset: Asset }) {
  const generated = asset.provenance?.source === 'generated';
  if (!generated && !asset.reference) return null;
  return (
    <>
      {generated && (
        <span className="lib-mark" title={`Generated${asset.provenance?.model ? ` with ${asset.provenance.model}` : ''}`} aria-label="Generated">
          <Icon name="sparkles" size={11} />
        </span>
      )}
      {asset.reference && (
        <span className="lib-mark ref" title="A reference: steers generation, never placed in the video" aria-label="Reference">
          <Icon name="bookmark" size={11} />
        </span>
      )}
    </>
  );
}

function AssetRow({ asset: a, probe, uses, busy, onReplace }: { asset: Asset; probe: AssetProbe | undefined; uses: number; busy: boolean; onReplace: (verb: 'Replace' | 'Relink') => void }) {
  const fps = useEditor((s) => s.doc.project.fps);
  const run = useEditor((s) => s.run);
  const missing = probe ? !probe.exists : false;
  const broken = probe ? probe.exists && !probe.decodable : false;
  return (
    <li data-testid={`asset-${a.id}`} className={`lib-row${missing ? ' is-missing' : broken ? ' is-broken' : ''}`}>
      <AssetThumb asset={a} missing={missing} />
      <div className="asset-meta">
        <CommitText className="asset-name-input" value={a.name} maxLength={80} testId={`asset-name-${a.id}`} onCommit={(name) => name.trim() && run({ type: 'replaceAsset', assetId: a.id, changes: { name: name.trim() } }, `Rename asset to ${name.trim()}`)} />
        <div className="fine" title={`public/${a.src}${a.provenance?.prompt ? `\n“${a.provenance.prompt}”` : ''}`}>
          <Marks asset={a} />
          <span className={`kind-tag ${a.kind}`}>{a.kind}</span> {assetFigures(a, probe, uses, fps)}
          {a.kind === 'audio' && !missing && <AssetBpm src={a.src} fps={fps} />}
        </div>
        {missing || broken ? <div className="asset-status">{missing ? 'File missing on disk' : `Can’t decode: ${probe?.error}`}</div> : a.kind === 'video' && <VideoPreviewState asset={a} />}
      </div>
      <div className="lib-actions">
        <GenerateWith asset={a} />
        <ReferenceToggle asset={a} uses={uses} />
        <button className="mini-btn" disabled={busy} data-testid={`asset-replace-${a.id}`} onClick={() => onReplace(missing ? 'Relink' : 'Replace')} title={missing ? 'Pick the file again; every reference follows' : 'Swap the file; every reference follows'}>
          {missing ? 'Relink…' : 'Replace…'}
        </button>
      </div>
    </li>
  );
}

/** The grid's tile: the picture filling a square, its marks and length on it, the name under it. */
function AssetTile({ asset: a, probe, uses }: { asset: Asset; probe: AssetProbe | undefined; uses: number }) {
  const fps = useEditor((s) => s.doc.project.fps);
  const missing = probe ? !probe.exists : false;
  const seconds = a.durationInFrames ? framesToSeconds(a.durationInFrames, fps) : undefined;
  return (
    <li className={`lib-tile${missing ? ' is-missing' : ''}`} data-testid={`asset-${a.id}`} title={`${a.name}\n${a.kind} · ${assetFigures(a, probe, uses, fps).replaceAll('\u00a0', ' ')}`}>
      <AssetThumb asset={a} missing={missing} large />
      <span className="lib-tile-marks">
        <Marks asset={a} />
      </span>
      {seconds !== undefined && <span className="lib-tile-len">{a.kind === 'video' ? formatClipLength(seconds) : `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`}</span>}
      <div className="lib-tile-actions">
        <GenerateWith asset={a} />
        <ReferenceToggle asset={a} uses={uses} />
      </div>
      <span className="lib-tile-name">{a.name}</span>
    </li>
  );
}

/** The picture, filling its square (cropped, never letterboxed); larger on hover; the drag handle into Generate. */
function AssetThumb({ asset, missing, large }: { asset: Asset; missing: boolean; large?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const cls = `asset-thumb${large ? ' large' : ''}`;
  if (asset.kind === 'audio') {
    return (
      <span className={`${cls} audio`}>
        {missing ? <Icon name="audio" /> : <AudioPlayButton src={asset.src} name={asset.name} testId={`asset-play-${asset.id}`} />}
      </span>
    );
  }
  const src = resolveAssetUrl('/', asset.kind === 'video' ? videoPreviewSrc(asset, false) : asset.src);
  if (missing || failed === src) {
    return (
      <span className={`${cls} broken`} title={missing ? 'File missing' : 'The browser could not load this file'}>
        <Icon name="warning" size={14} />
      </span>
    );
  }
  return (
    <span ref={ref} className={`${cls}${asset.kind === 'video' ? ' video' : ''}`} draggable aria-label={`${asset.name}: drag into Generate`} onDragStart={(e) => startAssetDrag(e, asset, ref.current)} {...peekProps(asset)}>
      {asset.kind === 'video' ? (
        <>
          {/* A poster half a second in (the first frame is often black). */}
          <video src={`${src}#t=0.5`} muted playsInline preload="metadata" onError={() => setFailed(src)} />
          <span className="asset-thumb-play" aria-hidden>
            <Icon name="play" size={9} />
          </span>
        </>
      ) : (
        <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(src)} />
      )}
    </span>
  );
}

/** Tempo of an audio asset (server beat analysis), e.g. " · ≈120 BPM". */
function AssetBpm({ src, fps }: { src: string; fps: number }) {
  const text = bpmText(useBeats(src, fps));
  return text ? <span data-testid="asset-bpm"> · {text.replaceAll(' ', '\u00a0')}</span> : null;
}
