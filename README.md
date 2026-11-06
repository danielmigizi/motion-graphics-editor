# Motion Graphics Editor

A local-first motion graphics editor that you direct with your own coding
agent. It runs on your computer, in your browser, and makes short product
demos, launch videos and explainers: scenes built from components and
templates, edited by hand on a timeline or by an agent (Claude Code, Codex,
Cursor Agent or OpenCode) that works inside the same open editor tab. Exports
are MP4 (or WebM, ProRes, GIF) that match the preview frame for frame.

Nothing leaves your machine unless you ask for it: projects, uploads and
renders are plain files in this folder, the agents run under your own logins,
and optional media generation goes through your own fal key.

## Requirements

- **Node.js 22.23.4 or newer.** `.nvmrc` pins the version the tests run on.
- **ffmpeg and ffprobe** on your `PATH` (`brew install ffmpeg`, or your
  package manager). Export, audio analysis and reference-video analysis use
  them. `MGE_FFMPEG` / `MGE_FFPROBE` point at other binaries.
- **Google Chrome**, or a Chrome Headless Shell
  (`npx playwright-core install chromium-headless-shell`). Exports render in
  headless Chrome. `MGE_BROWSER_EXECUTABLE` points at another build.
- Optional: **yt-dlp**, so reference-video analysis can take page URLs
  (YouTube, Vimeo and similar) as well as direct video links and local files.
- Optional: at least one coding agent CLI, signed in:
  [Claude Code](https://code.claude.com/docs/en/setup),
  [Codex](https://developers.openai.com/codex/cli),
  [Cursor Agent](https://cursor.com/docs/cli/overview) or
  [OpenCode](https://opencode.ai/docs/cli/).

## Install and run

```bash
npm ci
npm run dev
```

This starts the editor at http://localhost:5317 and the local server
(persistence, uploads, rendering, the agent bridge) at http://localhost:5318.
The server prints a one-time **editor link** (`http://localhost:5317/?session=…`):
open it to unlock the editor in that tab. A plain visit to port 5317 shows a
locked notice, because only the tab opened from the link may change settings,
spend money or approve agent requests (see [SECURITY.md](SECURITY.md)).

The editor opens the project you had open last, or a blank one. The sample
project is under **Open**. Set `MGE_WEB_PORT` / `MGE_SERVER_PORT` to use other
ports.

| Command | What it does |
|---|---|
| `npm run dev` | Editor and local server, with reload on change |
| `npm test` | Unit and integration tests (vitest) |
| `npm run typecheck` | TypeScript check |
| `npm run build` | Typecheck and production build of the editor |
| `npm run mcp` | The `motion-editor` MCP server on stdio |
| `npm run render:project -- --sample` | Render a project through a running server |
| `npm run verify:export -- --job <id>` | Check an export: streams, frame agreement with the preview (SSIM), audio sync |
| `npm run verify:agent` | End-to-end check of the agent loop (MCP client, editor, headless Chrome) on ports 5417/5418 |
| `npm run cards:render` | Re-render the cut-card picker previews in `public/cut-previews/` |
| `npm run fal:stub` | A local stand-in for fal, for trying generation without a key |
| `npm run audit` | Dependency audit (see SECURITY.md) |

## How agents connect

There are two ways to work with an agent, and both drive the same open tab.

**From the editor's chat panel.** Pick an agent and model from the menu at the
top of the chat. The local server starts that agent's CLI for each message,
under your own login and subscription, with the editor's MCP server attached
and its own permissions locked down (SECURITY.md lists exactly what each agent
can and can't reach). Switching agents mid-conversation hands the new one a
short summary of the conversation so far. *Auto-apply* decides whether the
agent's edits land straight away or wait for you as proposals to review.

**From your own agent session.** The repo's `.mcp.json` registers the
`motion-editor` MCP server (`npx tsx mcp/server.ts`). Open Claude Code in this
folder and approve the server when asked; for another agent, add the same
stdio command to its MCP configuration with this folder as the working
directory. Then ask for a video, or say "open the editor". The MCP server
starts the editor if it isn't running and works inside the open tab.

Either way:

- **The agent sees what you see:** the open project, your selection, the
  playhead and any requests you queued for it. "Make this punchier" means the
  selected element.
- **Its changes are reviewable:** each edit is one undoable step and goes
  through the same checks as a hand-written patch (stale, out of scope, locked
  scene, invalid). It never changes a locked scene and never discards unsaved
  work without asking.
- **It checks its own work** by rendering frames and contact sheets with the
  export renderer, and by running a deterministic critique of timing, type
  size, holds, cuts and story structure.
- **New videos start from an outline.** Describe the video, drop in a logo,
  screenshots or a track, approve the outline the agent proposes, and it
  builds the draft scene by scene. Or pick four cut cards (open, show, shift,
  close) for an editable first cut without any agent.

The `/motion-video` skill in `.claude/skills/motion-video/` is the workflow
agents follow; `/openverse-audio` covers finding CC0 and CC BY music and sound
effects. The MCP tools themselves (`editor_open`, `editor_get_context`,
`editor_guide`, `editor_apply_patch`, `editor_render_frame`, `editor_critique`,
`editor_export_revision` and the rest) describe themselves to the agent;
`editor_guide` returns the full document format.

### Optional services

- **Openverse** (music and sound effects). Agents search Openverse through the
  local server and place CC0 or CC BY tracks; anything NC, SA or ND is refused
  in server code. Export writes `credits.txt` next to the video when the project
  uses licensed audio. Anonymous access works; set `OPENVERSE_CLIENT_ID` and
  `OPENVERSE_CLIENT_SECRET` in the server's environment for higher limits
  (see `.env.example`).
- **fal** (image, video, music and voice generation). Paste a fal key in
  **Settings › Generation**. Every request shows its estimated cost and
  respects a daily budget; agent requests ask you first. Use a key with
  prepaid credit and auto top-up off (SECURITY.md explains why).
- **Brand scans and reference videos.** `editor_scan_brand` reads a public
  page's HTML and CSS (no JavaScript) into a reviewable style overlay.
  `editor_analyze_reference` runs ffmpeg on a video to produce contact sheets,
  shot timings, palettes, loudness and beats for the agent to read. Neither
  imports the source media into a project.

## How it works

- **One document.** A versioned JSON project (`src/core/types.ts`) is the
  single source of truth, with stable IDs for the project, scenes, elements,
  assets and audio clips, integer FPS and frame-based timing.
- **One way to change it.** Every manual edit and every agent patch is a
  `Command` (`src/core/commands.ts`), validated against the component property
  schemas (`src/core/components.ts`). Commands share one undo stack, and each
  one bumps the revision by exactly one.
- **Layout versus animation.** An element's `transform` is its base layout.
  Animation tracks layer on top: x, y and rotation are offsets, scale and
  opacity are factors. Moving an element in *Layout* mode never touches its
  tracks; in *Animate* mode the same drag writes keyframes at the playhead.
- **Same composition everywhere.** The editor's Player and the exporter render
  the same `MainComposition` with the same assets and bundled fonts, on a small
  runtime of its own (`src/runtime`). Every animation is a pure function of the
  frame. The exporter drives headless Chrome and pipes frames into ffmpeg,
  caching rendered scenes so re-exporting after an edit renders only what
  changed ([docs/render-engine.md](docs/render-engine.md)).
- **Agent bridge.** The editor keeps an event stream open to the local server
  (`/api/editor/*`, see `src/core/api-contract.ts`). The MCP server in `mcp/`
  sends commands through it; the editor stays the only owner of the document,
  runs them through core and reports its context back.
- **Patches.** An agent edit is an `mge.patch/1` JSON patch that names its
  base revision and its targets. A patch is rejected, and the project left
  unchanged, when it is stale (unless you reconcile it and none of its targets
  changed since its base revision), touches anything outside its declared
  targets, touches a locked (approved) scene, or is invalid.
- **Saving.** Explicit saves, per-project autosave journals, named checkpoints
  and a History of every saved version ([docs/recovery.md](docs/recovery.md)).

## Layout

```
src/core/         document types, schemas, commands, history, patches, motion rules, critique, templates
src/composition/  the composition and its element renderers
src/runtime/      composition runtime (frame context, readiness, media) and the Player
src/editor/       editor UI (React + zustand)
src/render/       export render page, driven by server/engine in headless Chrome
src/capture/      1:1 preview page used by export verification
src/sample/       sample project and golden example projects
server/           local Express server: projects, assets, renders, agent bridge, chat, generation
server/engine/    the exporter: render page bundle, headless Chrome, ffmpeg encode and audio mix
server/agents/    the agent CLIs the chat panel runs (Claude Code, Codex, Cursor Agent, OpenCode)
mcp/              the motion-editor MCP server (stdio)
scripts/          render, verification and asset-generation CLIs
public/assets/    sample assets (logo, screenshot, music bed, whoosh) and built-in sound effects
public/cut-previews/  rendered previews for the cut-card picker
docs/             render engine, saving and recovery, transitions, golden contact sheets
```

The sample assets are original: the logo and screenshot were drawn for the
sample's fictional product, the music bed and whoosh come from
`scripts/make-sample-audio.sh`, and the sound effects from
`scripts/make-sfx.ts`.

## License

[MIT](LICENSE)
