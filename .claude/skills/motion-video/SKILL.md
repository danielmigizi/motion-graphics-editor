---
name: motion-video
description: Build or revise a 30–90 second motion-graphics video together with the user inside the live local editor (motion-editor MCP tools). Use when the user asks to create a motion graphic, explainer, launch or product video, or to change "this" scene/element in the editor, handle their notes from the editor, or look at the current video.
---

# Motion video with the live editor

## Route the brief

Before outlining, pick one workflow. Match the deliverable, not a word in passing.
Use that pack, those templates, and that story shape. Do not invent a sixth workflow.

| Route | When | Pack | Templates | Story |
| --- | --- | --- | --- | --- |
| product-launch | a product, site, app or company to showcase | `snappy-saas` | kineticTitle, beforeAfter, uiWalkthrough, featureGrid, statReveal, logoSting | hook → problem/before → product → proof → CTA |
| short-sting | unnarrated, typically under 10 s (logo, title, stat) | `snappy-saas` | logoSting, kineticTitle, statReveal | one beat: the mark lands, holds, exits |
| music-led | beat-synced from a track, no narration | `editorial` | kineticTitle, backdrop, logoSting | cuts and settles on downbeats |
| kinetic-type | type-led or a topic explainer with invented visuals | `editorial` | kineticTitle, beforeAfter, statReveal, testimonial | one statement per scene; carry kicker and line across cuts |
| general | anything else | `paper` | kineticTitle, uiWalkthrough, logoSting, backdrop | hook in 1.5–2 s, one idea per scene, payoff at the end |

A music bed under a launch does not override the subject. State every correction as
an absolute (`fontSize` 32, hold 48 f, travel −80 px), not "bigger" or "a bit longer".

The user watches the editor while you work. Edits normally become proposals the
user reviews; Auto-apply commits them immediately only when enabled.
When the tool says proposed, say "I've proposed …, review it in the editor".
Don't stack edits on an unapplied proposal unless asked: a newer proposal replaces it.
They point at things and leave you notes; they only occasionally edit
text or colours by hand. Work in small, visible moves and check your own output
with rendered frames.

Draw text, charts, data, UI, shapes, logos and motion with code. Generate only photographic or illustrated images, cutouts, textures and plates, music, voice-over and recorded-sounding effects. Use `editor_generation_models`, `editor_generate`, `editor_generation_status` and `editor_cancel_generation` through the editor’s fal studio; each request asks permission with its cost and respects the daily budget. Prefer `image.edit` / `image.composite` with `settings.referenceAssetIds` when the user has a source image. Takes land in Assets › Generated takes and are placed only via an `editor_propose_patch` proposal.

## Start of every session

1. `editor_open` (starts the editor if needed). If it reports no browser tab
   connected, give the user the URL and wait for them to open it.
2. `editor_guide` once: the document model, every component's props, patch rules.
3. `editor_get_context`: what is open, what is selected, the playhead, and the
   user's `notes` for you. "This", "here", "that title" refer to the selection and
   playhead. "Handle my notes" means: work through `notes`.
   Tools use `mge.tools/2`; preserve `docSession` with patches. On STALE_SESSION,
   re-read context before editing the newly opened document.

## New video from a brief

1. The brief arrives in chat, usually with the editor's outline request. The open
   project is blank and made for it (`untouched: true` in context); never overwrite a
   project that is not untouched without asking. Attachments arrive already uploaded
   with asset objects; import any other reference file with `editor_import_asset`.
2. Outline: call `editor_propose_outline` with `story` (hook in 1–2 s, one idea, audience,
   tension, payoff, optional CTA/loop, beats mapped to every scene and a time range) and
   `scenes`, then stop. Write the story beats before any motion. On approval the editor
   fills the open project (same id), stamps `project.story`, and sends the build request.
3. Build straight away (when the brief asks): story beats first (`project.story`: idea, hook,
   tension, payoff, beats → scene names and seconds), then motion. One `editor_write_project`
   with the open project's id and `overwrite: true`; `editor_render_contact_sheet` →
   `editor_critique` → fix what it flags.
4. Build each scene from templates and presets (see "Building scenes" below) to serve those
   beats, one patch per scene, previewed and critiqued first. The build request says how
   it lands: with Auto-apply off, `editor_propose_patch` and wait for each decision; with
   Auto-apply on, `editor_apply_patch` straight through every scene, then one contact sheet
   and critique over the whole video before handing over.
5. Hand over: summarise the scenes and say what the user can tweak. Server projects
   autosave; call `editor_save` only for a project that is not on the server yet.

## Revising with the user

- Re-read `editor_get_context` before each edit; use its `project.revision` as
  `baseRevision`.
- Prefer `editor_apply_patch` with the narrowest targets. One request, one patch, a
  clear `summary` (it shows in the editor's history).
- Use `editor_propose_patch` to always request review, with a rendered Current/Proposed
  comparison. Check `editor_proposal_status` or context for the user's decision.
- Use `editor_preview_patch` to validate and look at a candidate without applying
  or proposing it. `editor_render_contact_sheet` checks committed scenes in one image.
  `editor_critique` returns frame-tied defects against the motion rules, story
  structure (no hook, logo open, too many ideas, dead middle, no payoff) and
  scene-to-scene seams; call it on
  the same patch before proposing. `editor_propose_patch` prepends a critique (soft
  gate — it still proposes).
- Use `editor_export_revision` for a committed MP4 after pending proposals are
  decided; check progress/output/manifest with `editor_inspect_job` and stop an
  active export with `editor_cancel_job`.
- Each note in the context carries its own `target`; patch exactly that target and
  the editor clears the note when applied. Handle one note per patch so each applied edit is its own undo step.
- Use `editor_focus` to show the user what you mean ("the subhead here").
- After applied visual changes, render the affected frames and look before reporting done;
  pending edits appear in the editor's Current/Proposed comparison.
- Adding or reordering scenes needs `editor_write_project` with `overwrite: true`;
  it reloads the editor and resets undo, so say so first. Music and sound effects
  are ordinary patches (see "Music and sound").
- Scenes with a ✓ in the scene strip are approved (locked).

## Music and sound

- Audio is patched like visuals. Targets: `{ "audio": "project" }` for the music bed
  and other project-level clips; `{ sceneId }` for sound effects anchored to that
  scene (a locked scene's effects are locked); both to move a clip between them.
  The review plays each version's own audio and names the change in words.
- Before timing anything to music, call `editor_get_beats`: tempo, beats, downbeats,
  strong hits and each scene cut's distance to the nearest beat, in project frames.
  Cut scenes on downbeats, land the main entrance on a beat and the biggest moment
  on a strong hit, but never shorten reading time to hit a beat — stretch to the
  next downbeat instead. With a weak pulse (confidence < 0.2) use strong hits only.
- "Put the track under the whole video": one patch with the audio target (and the
  scene targets if you retime scenes) that adds or updates the bed with
  `startFrame: 0`, `durationInFrames` = the video's length, and a 1–2 s fade-out.
- Built-in sound effects (whoosh, click, pop, rise, hit, tick; CC0) are listed in
  the guide: `addAsset` (if missing) + `addAudioClip` anchored to the scene. Use a
  few, on transitions and key entrances, not on every element.
- For a bed or a recorded effect that is not in the built-in set, search Openverse
  with `editor_search_audio` { query, kind: "music"|"sfx", mood?, durationSeconds? }
  then `editor_add_audio` { id, role }. Only CC0 and CC BY — the server rejects NC,
  SA, ND and a direct file URL. Never use a paid library. After a bed, call
  `editor_get_beats`. List attributions with `editor_list_credits` (Made with Openverse).
  Trim/fade to length; duck under voice with the envelope below.
- Duck the bed under voice-over with a `volumeEnvelope` on the bed (recipe in the
  guide), not by lowering its whole volume.

## Video elements

- Screen recordings and b-roll are `video` elements: import the file with
  `editor_import_asset` (.mp4, .webm, .mov), `addAsset` it, then add a `video` element.
- `trimStartFrames` is the source in-point in project frames; at element frame f the
  element shows source frame `trimStartFrames + f × playbackRate`. Without `loop` the
  element may last at most (file length − in-point) ÷ speed: shorten it in the same
  patch when you speed up or move the in-point.
- Its sound plays with it (scene-anchored, `volume` animatable via `props.volume`,
  `muted` to silence). Detaching audio is the user's one-click action.
- For "the part where the dashboard loads": place it, render a contact sheet or frames
  to find the moment, then set `trimStartFrames` / `durationInFrames`; propose it as one
  reviewed patch. Use `cornerRadius` or a rounded shape mask for device frames.
- A missing or undecodable video blocks export, stills and contact sheets with an error
  naming the element; ask the user to relink it in Assets.

## Rules

- Never modify locked scenes (the user approved them) and never unlock them.
- On STALE, the user edited meanwhile: re-read context, rebuild the patch from the
  current state. Use `reconcile: true` only when your targets were untouched.
- Never pass `discardUnsaved` or overwrite a saved project the user made without asking.
- Keep text inside a ~96 px safe margin and on screen long enough to read.

## Motion direction (craft v2)

Motion should look directed, not merely correct. `editor_guide` → "Motion direction"
has the full tables; these are the rules to apply on every scene. Frames at 30 fps,
multiplied by the style's `timingScale`.

A draft that follows the timing rules but holds still, sits small and top-left, and
sets its secondary type at 16 px loses a blind comparison on every criterion. The
first four rows below are the ones that decide it: never dead, use the frame,
video-safe type, pacing.

**Style first.** Read `project.style` (fonts, colour roles, motion personality, `craft`
tokens) and use only its fonts and colours. The default house bar is **`pulse`**
(Percussive on cream: 2–4 f pops, 1–4 f irregular stagger, +3 f late cuts, 3–4 % type,
constant drift). Copy it in `editor_write_project` unless the brief names another pack:
`snappy-saas` for SaaS/product UI, `calm-premium` for brand/finance, `playful-consumer`
for consumer apps, `editorial` for type-led stories. On an existing project without a
style, suggest More → Style… (patches can't set it).

**Story first.** Write `project.story` (or the outline `story`) before placing a single
element: the hook in the first 1.5–2 s, one core idea, the audience, tension/setup, the
payoff in the last stretch, an optional CTA or loop-back, and beats mapped to every scene.
Then motion. Then `editor_critique`.

**Plan each scene** in the beat sheet: which story beat it serves, its one hero, how the
hero arrives, the order the rest follow, and how long the text holds.

| Rule | Numbers | Build it with |
| --- | --- | --- |
| Never dead | no frame fully still > 0.5 s; during a reading hold keep secondary motion: push/scale 2–5 % over the hold, a one-way drift 10–30 px, parallax, a texture moving slowly, a rule drawing on, typing, counting, staggered chips. Purposeful drift is allowed; a looping sine (breathe/float/pulse) is filler | group `scale`/`x`/`y` track to the cut; `backdrop` template; chips |
| Use the frame | centred or deliberately balanced, never default top-left; hero cap height ≥ 7 % of the frame height (≈ 105 px at 1080, wrap rather than shrink); screenshots 60–80 % of the width with a glow/shadow/rounded corners, bleeding off one edge on purpose; ≤ 50 % of a content scene empty | layout; `uiWalkthrough` `bleed: 1` |
| Video-safe type | at 1080: labels ≥ 24 px, eyebrows/kickers in tracked caps ≥ 32 (caps ≈ 22 px tall; 26 px reads as tiny), body ≥ 32, callouts/chips ≥ 26, button label ≥ 30; contrast ≥ 4.5:1 — kickers included (deepen the accent on light grounds), the punchline in text or accent colour, never muted grey | `fontSize`, `color` |
| Pacing | something new lands every 0.5–1.0 s; the next element starts while the previous settles; hook text by text (wordStagger), punchline on its own beat at full contrast | `startFrame` overlap, reveals |
| Spotlight | to point at one stat: dim the rest to 40–60 % (background rect, inverted mask cut to the region), accent rounded rect wipes on, callout 6 f later, then lift the dim | `uiWalkthrough` `spotlight: 1` |
| Palette & brand | accents only from the pack's roles (accent, accent2; lower opacity for glows); logo on the product scene and the end card; end card fully composed within ~1 s of its hero (no empty glow, no blank button) | `style.colors`, `logoSting` `cta` |
| Entrance length | Pulse pops 2–4 f (`snapPop`); other packs: micro 6–10 f, small 10–16, medium 14–22, large 20–30, hero 24–40; a single entry ≤ 800 ms (Pulse camera/drift 66–96 f is the hold, not an entry); exits ≈ 0.75× | × `timingScale`, or pack `craft.popFrames` |
| Across cuts | same axis, same direction, similar speed; cut mid-motion (default direction: left). Don't come to rest, cut, and start again from rest | `matchCut`, shared position, carry a screen |
| Pause before a climax | hold 0.3–0.75 s after the last big move, then let the result land | scene length; delay the payoff text |
| Reading hold | key lines: still for words ÷ 3.5 + 0.5 s (≥ 1.2 s) after the text lands — still, not dead. Pulse chips/status may pop and sit; the hero line still reads | scene / element length |
| Easing | arrivals ease out, exits ease in, on-screen moves in-out; never linear position (linear only for idle drift) | first key: `motion.enter` / `motion.exit` |
| Arrive apart | Pulse 1–4 f irregular; other packs 3–6 f (`staggerFrames`) in reading order; a part follows its parent by 2–4 f | offset `startFrame` or first keys |
| Give | pass the mark by `overshoot` (3–12 %), swing back 30 %, settle in 6–12 f | overshootSettle keys |
| Anticipation | wind back 8–15 % of the travel over the first 20–35 % of a big move | anticipateGo keys |
| Follow-through | grouped parts trail ~10 %, carry on 6–12 % past the stop, 2–4 f apart | group + child x tracks |
| Hierarchy | one hero per beat; others hold still or step back to 50–60 % opacity; accent only on the hero | opacity keys |
| Frame | margins 64–96 px at 1080; headline 84–128 px (hero 120–180), ≤ 24 chars a line; body ≥ 32 px | layout |
| Type | statements: one masked line each, rising its own height; headlines: wordStagger; characters only for ≤ 3 words; animate tracking only on kickers | mask + y track, reveals |
| Transitions | cut on the beat; carry something across (same position, match cut, colour, one-take screen); fade 6–10 f only when nothing carries | matchOut / matchIn, transitionIn |
| Beats | Pulse: cut **+3 f after** the beat (±2). Other packs: on the beat (±1). Hits 1 f before | holdHit, scene lengths in whole beats |
| Spring / smear | Mark or hero can spring 3×→1 over 10 f; smear blur ~18 px for 4 f on the fast travel | `springIn`, `smear` |
| Type scale | Pulse calm type 3–4 % of frame height (≈32–43 px at 1080), lots of air. Other packs: hero cap ≥ 7 % | `fontSize` |

## Building scenes

Don't hand-build what a template already does: the templates and presets carry these
rules. Story beats are already written; per scene:

1. `editor_build_template` for its template (params are in the tool description; it holds
   to the cut unless you pass `seconds`): `kineticTitle` for the hook (`sub` for the
   punchline, `widthShare: 0.58` beside a `backdrop`); `uiWalkthrough` / `walkthroughStep`
   for the product (`imageAssetId`, `title`, `bleed: 1`, `spotlight: 1`, `chips`);
   `statReveal`, `featureGrid`, `beforeAfter`, `testimonial` as needed; `logoSting` with
   `cta` for the end card. A `backdrop` goes under content scenes that would hold still.
   For a launch cut (one scene per beat: hook → proof → turn → cta), start each scene
   from a cut card instead: `editor_list_cut_cards` (twelve per beat, with the motion
   idea, why it works and the copy slots), then `editor_build_cut { card, sceneId, slots }`.
   Replace every slot's sample copy (a fictional product, Brieflet) with the user's;
   keep the card's motion. It retimes an empty scene to the card's length.
2. `editor_build_motion` for extra motion: a preset on an element, `arriveApart` on
   siblings, `followThrough` on a group, `matchCut` across a cut.
3. Put the returned commands in one patch (targets `[{ sceneId }]`) and adjust text and
   timing in the same patch (updateElement on the returned ids).
4. `editor_preview_patch` with `contactSheet: true`, then `editor_critique` on the same
   patch, fix once, then `editor_propose_patch` (or `editor_apply_patch` when the build
   request says Auto-apply is on). Name the templates in `templateHints` when outlining.

## Self-critique loop (before every proposal)

Never propose motion you haven't looked at. Once per proposal:

1. **Render.** `editor_preview_patch` with `contactSheet: true` (or 4–8 `frames`:
   mid-entrance, settled, mid-hold, last frame). Whole draft: `editor_render_contact_sheet`.
2. **Critique.** `editor_critique` on the same patch (or `sceneIds`). It names frames for
   reading holds, type below the floors, dead frames, two heroes, linear position, stagger,
   cuts off the pack beat offset, banned clichés the document can prove (gradient type, cyan neon,
   pure #000/#fff, identical card grids, left-edge stripes, back-and-forth idle loops), story structure
   (no hook in the first 1.5–2 s, logo/title-card open, too many ideas, dead middle, no
   payoff, unresolved end; unmapped scenes when `project.story.beats` is set), seams
   (coming to rest before a cut, axis/direction/speed changes, long entries; Pulse camera/drift is the hold),
   and **baseline** notes vs the pack (pop duration, stagger, drift, dead frames, type share,
   palette count). Thresholds come from `project.style.craft` — Pulse pops are not errors.
   After the first sheet,
   `addBanned` anything else you saw (glow taste, a hue that slipped through).
   Fixes are absolutes: `fontSize` 32, hold 48 f — not "a bit bigger".
3. **Look at the sheet** for what numbers miss: crop, collisions, colour taste, accidental
   bleed, a logo missing from the end card.
4. **Revise once.** Fix what failed. At most one extra preview; don't loop.
5. **Propose (or apply).** `editor_propose_patch` prepends a critique of the candidate (soft
   gate — it still proposes); when the build request says Auto-apply is on, `editor_apply_patch`
   lands it instead. Either way, say in one line what changed after looking, e.g. "Looked at frames
   30–90: critique flagged a 16 px kicker and a dead hold; sized the kicker to 32 and
   added a 3 % push." If nothing needed fixing: "Looked at frames 30–90: no changes."

## Golden examples

Reference projects in `src/sample/golden/`, contact sheets in `docs/golden/` (Read the PNG
to see the target level). Mirror the closest one's structure for a similar brief.

- **`saas-launch.png`** (24 s, Snappy SaaS). Hook → before/after → product → features →
  proof → brand, one idea per scene, every scene a whole number of beats. The hook is two
  156 px lines on the left 58 % with a column of unread notes scrolling behind, and the
  punchline lands word by word in the accent. The product scene is logo + headline over a
  78 %-wide screen bleeding off the bottom on a glow: the cursor clicks Send, the rest dims
  and lifts, a callout and two chips follow. The after panel steps the before back to 55 %;
  feature cards arrive 5 f apart with their parts 3 f behind; every scene pushes in 3 %
  through its hold; the end card has logo, line and button within a second.
- **`kinetic-promo.png`** (15 s, Editorial). Type carries everything: one statement per
  scene, lines rising from behind their own masks. "Less noise." → "More signal." share
  the kicker, line position and the scrolling column behind them, so the hard cut reads as
  a word swap. Kickers tighten their tracking (16 → 5 px) as they fade in; headlines never
  animate tracking; nothing holds still.
- **`product-walkthrough.png`** (20 s, Playful Consumer). Three steps cut as one take: the
  screen (72 % wide, on a glow) never moves and each cursor starts where the last one
  clicked, so only the cursor, highlight and callout change, while one continuous push
  (1 → 1.06) runs across all three cuts. Step 2 spotlights the summary. Back-out arrivals
  overshoot about 10 %; the end card has its button from the first second.
- **`pulse-reference.png`** (13.6 s, Pulse — **the house bar**). Two shots only: a
  staggered kit of original tiles that snap-pop (2–4 f, 1–4 f irregular) and assemble
  into a card under a slow camera push, then a springy end-card mark (3×→1 over 10 f
  with a smear) and staggered pills. Type stays at 3–4 % of the frame. Mirror this
  motion feel, not the copy. Before/after strips live next to it in `docs/golden/`.

## Brand kits and reference videos

`editor_scan_brand { url }` fetches HTML and linked CSS (no JavaScript) and
returns ranked colours, fonts with bundled fallbacks, and the site logo
(inline SVG → apple-touch-icon → og:image → favicon; never redraw it).
Pass `propose: true` for a reviewable `setStyle` proposal (`{ style: "project" }`).
Cached per domain.

`editor_analyze_reference { path | url }` runs local ffmpeg (yt-dlp for page
URLs when installed). Read the 1 fps contact sheets, then write a directed
brief. **State every correction as an absolute value** (e.g. "hold 48 f",
"cut at 3.20 s / frame 96") — never "a bit tighter". Analysis only: do not
import the reference's media into the project.
