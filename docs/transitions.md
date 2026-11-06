# Scene transitions

## What exists today: entrance transitions

`scene.transitionIn = { type, durationInFrames }` is an **entrance**. It plays
over the scene's own first `durationInFrames` frames (validated to be at most
the scene's duration) as a style on the scene layer
(`sceneTransitionStyle()` in `src/composition/MainComposition.tsx`).

- **Scenes never overlap.** The previous scene has ended when the next one
  starts; during an entrance the incoming scene is composited over the project
  background (`project.backgroundColor`), not over the previous scene.
- **Timing is unchanged.** A transition never moves a scene, never changes its
  length, and never shifts element frames; elements play at their usual
  scene-relative frames underneath the transition style.
- **Audio is unaffected.** Music beds stay on the absolute timeline and
  scene-anchored clips start at their scene's start, with no implied crossfade.

| type  | over the transition frames (t = 0 → 1)                     |
| ----- | ---------------------------------------------------------- |
| none  | nothing                                                    |
| fade  | opacity t                                                  |
| slide | translateX 100% → 0 (easeOut)                              |
| wipe  | revealed left to right by a clip (easeInOut)               |
| zoom  | scale 1.08 → 1 (easeOut), opacity t                        |
| blur  | blur 24px → 0 (easeOut), opacity t                         |

## Not supported: overlapping (cross) transitions

A cross-dissolve, push or zoom *between* two visible scenes needs scenes that
overlap in time. That is a separate, explicitly scoped change, because it moves
frames. Proposed rules if it is ever taken on:

1. **Representation.** `transitionIn.overlap` (integer frames, default 0):
   the scene starts `overlap` frames before the previous one ends.
   `0 ≤ overlap ≤ min(previous scene duration, this scene duration, transition duration)`.
   The first scene's overlap is always 0.
2. **Timeline.** Scene starts and project duration subtract overlaps
   (`duration = Σ scene durations − Σ overlaps`). Frame lookups return both
   scenes inside an overlap window; the playhead, render ranges and agent frame
   references use the new starts.
3. **Rendering.** Inside the window both scenes render, each at its own
   scene-relative frame (the outgoing scene keeps playing its last frames; it is
   never frozen): outgoing below, incoming above with the transition style.
4. **Audio.** Absolute clips (music) never move. Scene-anchored clips start at
   their scene's shifted start and keep playing through the window. No
   automatic audio crossfade; fades stay explicit clip properties.
5. **Edits.** Changing an overlap shifts every later scene. Markers and
   absolute audio do not follow automatically; the editor must say so and offer
   to shift them. Overlap edits that would move a locked scene are refused.
6. **Migration.** Existing documents have overlap 0 everywhere, so their
   frames, renders and audio are unchanged.
