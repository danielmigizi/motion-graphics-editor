# Render engine

The editor previews and exports with its own engine: a small React runtime
for the composition, a Player for the editor, and an exporter that drives
headless Chrome and ffmpeg. Every animation is a pure function of the frame,
so the preview, stills, contact sheets and exports all draw the same picture.

## Runtime (`src/runtime`)

The composition (`src/composition`) imports nothing but the runtime:

- `useFrame()`, `useCompositionConfig()`, `TimeSpan`, `HoldFrame`,
  `FullFrame`: a frame context. A `TimeSpan` re-bases the frame for its
  children and mounts them only inside `[from, from + durationInFrames)`;
  `HoldFrame` pins it (contact-sheet cells).
- `useRenderHold()`: a readiness registry. Fonts, images and video frames
  hold a handle until they are ready; a frame is captured only once the
  registry has drained.
- `useEnvironment()`: preview or export.
- `useMedia()`: the host's `Video` and `Audio`, and `Img`.

Hosts wrap the composition in `RuntimeRoot` with the root frame, config,
readiness and media.

## Player (`src/runtime/Player.tsx`)

Used by the Stage, the storyboard picker, the proposal review, timeline
thumbnails (`Thumbnail`) and the capture page.

- Clock: the shared `AudioContext`, snapped to whole frames. Frame `f` is
  heard at `anchorTime + (f − anchorFrame) / fps` and shown when the output
  clock (context time minus output latency) reaches it, so picture and sound
  share one time base. Before the context runs (no user gesture yet) it falls
  back to `performance.now()` and moves onto the audio clock once it can.
- Sound: every `<Audio>` the composition declares is decoded once into an
  `AudioBuffer` and scheduled on the clock, with its per-frame gain as linear
  ramps (fades, envelopes, ducking).
- Video: a `<video>` element follows the clock: seeked exactly while paused
  (holding readiness until the frame is on screen), drift-corrected while
  playing. Speed changes move the pitch, as in exports.
- Scale-to-fit (contain, centred), in/out work-area looping, `frameupdate`,
  `play`, `pause`, `ended`, `seeked`, `waiting` and `resume` events.

## Exporter (`server/engine`)

- **Render page.** `render.html` (`src/render/main.tsx`) is built by Vite
  into `.engine-bundle/<hash>`, where the hash covers every source the page
  can import; an unchanged tree reuses the build across server restarts.
  It hosts MainComposition or the contact sheet.
  `window.__mge.load(input)` mounts one and reports its declared sounds;
  `window.__mge.seek(frame)` shows a frame and resolves once fonts, images
  and video frames are ready and the page has produced a frame with them,
  with what the frame's videos play.
- **Chrome.** playwright-core with a Chrome Headless Shell
  (`MGE_BROWSER_EXECUTABLE`, else one already on disk, else installed
  Chrome; `npx playwright-core install chromium-headless-shell` fetches one).
  sRGB colour, no font hinting, no vsync, software raster (`MGE_ENGINE_GPU=1`
  rasterises on the GPU: about 10 % faster, antialiasing differs slightly).
  One browser per output scale, launched with `--force-device-scale-factor`,
  so 720p and 4K are drawn at that size, not resampled.
- **Chunks.** A video is cut into chunks: each scene, in runs of 60 frames
  from the scene's start. Several pages (60 % of the cores, 2–8;
  `MGE_ENGINE_WORKERS`) render chunks in parallel, each piping CDP
  screenshots into its own ffmpeg. Chunks are joined by stream copy.
- **Cache.** A chunk is stored in `.engine-cache/chunks` under a hash of
  everything that can change its pixels: the render page's code, the encode
  settings, the scene, the project's size, rate and background, its
  components, and its assets' file contents. Re-exporting after a one-scene
  edit renders that scene only; an unchanged export only joins chunks and
  mixes the sound. The cache keeps the most recently used 4 GB
  (`MGE_ENGINE_CACHE=0` turns it off).
- **Codecs.** H.264 (CRF 18, x264 "faster" with a 40-frame lookahead,
  yuv420p, limited range, untagged), VP9 (CRF 28), ProRes 4444 with alpha (PNG frames on a
  transparent page, yuva444p10le), GIF (lossless chunks, one
  palettegen/paletteuse pass, half frame rate).
- **Audio.** The declared sounds (project clips: trim, start, fades, volume
  envelopes, ducking) and every unmuted video's soundtrack (from per-frame
  reports: source time, rate, volume) are decoded by ffmpeg to 48 kHz stereo
  and mixed in Node with per-frame gain, unnormalised, then muxed (AAC, Opus
  or PCM).
- **Video elements.** ffmpeg decodes every frame of a video file once
  (`fps_mode passthrough`, presentation times from `showinfo`), converting
  colour the way Chrome's `<video>` plays the file (its own matrix and
  range; an untagged file as BT.709 at HD sizes, BT.601 below, limited
  range). At source time `t` the page shows the last frame starting at or
  before `t`, the frame the preview shows. Cached per file content, so any
  format ffmpeg reads works, even ones Chrome cannot decode.
- **Stills and contact sheets** reuse an idle page of the same size.

## Settings

`MGE_ENGINE_WORKERS` (parallel pages), `MGE_ENGINE_CACHE=0` (no chunk cache),
`MGE_ENGINE_GPU=1` (GPU raster), `MGE_ENGINE_PROFILE=1` (where the time
goes), `MGE_BROWSER_EXECUTABLE`, `MGE_FFMPEG` / `MGE_FFPROBE`. ffmpeg must be
installed (`brew install ffmpeg`).

## Choices that keep preview and export identical

- An untagged SD video (below 1280 wide and 577 high) is read as BT.601, the
  way Chrome's `<video>` (the preview) reads it; larger untagged video is read
  as BT.709.
- Frames are captured as JPEG quality 90 (PNG when the codec needs alpha or a
  lossless source), and x264 runs "faster" with a 40-frame lookahead: plain
  "faster" lets quality pulse on held frames.
- Chrome is launched with `--force-device-scale-factor` for scaled output, so
  hairlines are rasterised at the output size rather than resampled.
- After every seek the page produces one more animation frame before the
  screenshot, so a capture never returns the previous compositor frame.

## Checking an export

`npm run verify:export -- --job <id>` checks a finished export against the
project it was made from: the container and streams (ffprobe and a full
decode), frame agreement between the MP4 and the preview page
(`capture.html`) by SSIM at checkpoints in every scene, audio sync (each
clip's onset within ±2 frames), and the project revision and text. It writes
a JSON report and the compared frames, and exits non-zero when a check fails.

Typical export times on an Apple M2 Pro (10 cores), 1080p H.264:

| Project | From scratch | After a one-scene edit | Unchanged |
|---|---|---|---|
| saas-launch (720 frames, music bed) | 12.6 s | 3.8 s | 1.5 s |
| kinetic-promo (450 frames) | 6.3 s | 2.1 s | 0.3 s |
| product-walkthrough | 10.1 s | 3.9 s | 0.4 s |

"From scratch" includes building the render page and starts with an empty
chunk cache. Single stills reuse a warm page and take a fraction of a second.
