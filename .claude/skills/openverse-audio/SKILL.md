---
name: openverse-audio
description: Find CC0/CC BY music and SFX on Openverse and place them in the live editor via motion-editor MCP tools. Use when the user wants a music bed, soundtrack, whoosh, or other freely licensed audio in the video.
---

# Free music and SFX (Openverse)

The editor is agent-first. Search and placement go through MCP tools, not a
panel. Catalog access is server-side (anonymous, or OAuth via
`OPENVERSE_CLIENT_ID` / `OPENVERSE_CLIENT_SECRET`).

**Made with Openverse.** Audio search powered by Openverse
(https://openverse.org/). Not endorsed or certified by Openverse.

## License (non-negotiable)

Only **CC0** and **CC BY**. The server enforces this: NC, SA, ND, PDM, sampling+
and anything else are refused even if you pass another filter or a direct URL.
Never use a paid library. Prefer CC0 when both fit; CC BY needs the attribution
`editor_list_credits` returns.

## Tools

1. `editor_search_audio` { query, kind?: "music"|"sfx", mood?, durationSeconds?, page? }
   — inspect duration, license, attribution, preview URL. Do not scrape pages.
2. `editor_inspect_audio` { id } — one work; still license-checked.
3. `editor_add_audio` { id, role: "music"|"sfx", sceneId?, startFrame?, replaceExisting? }
   — downloads (cached), `addAsset` + `addAudioClip` on the open project.
4. `editor_list_credits` — attribution lines; export writes `credits.txt` next to the MP4.

## Choosing a track

- **Mood:** match the picture. Calm product / finance: sparse pad, little percussion.
  Punchy launch: short rhythmic loop, not a full song with vocals fighting the VO.
  Playful consumer: light clicks and a warm bed. Dark / editorial: drones, no lyrics.
- **Tempo:** after the bed is on the timeline, `editor_get_beats`. Cut scenes on
  downbeats; land the hero settle on a beat and the biggest moment on a strong hit.
  Never shorten reading time to hit a beat — stretch to the next downbeat. If
  confidence < 0.2, use strong hits only.
- **Length:** pass `durationSeconds` as the video length for a bed. `editor_add_audio`
  trims the clip to the project and applies a 0.5 s fade-in and 1.5 s fade-out.
  If the file is longer, keep `trimStartFrames` at a clean downbeat. If shorter,
  let it end; do not loop.
- **SFX:** prefer the built-in CC0 set (whoosh, click, pop, rise, hit, tick) for
  generic hits. Use Openverse `kind: "sfx"` for a specific recorded sound. A few,
  on transitions and key entrances, 6–12 dB under the voice.
- **Ducking:** `volumeEnvelope` on the bed (recipe in `editor_guide`), not a lower
  clip volume. Same as "Duck under voice" in the Inspector.

Typical sequence: search → pick an id → add as bed → `editor_get_beats` →
`editor_list_credits`.
