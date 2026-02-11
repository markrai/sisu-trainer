# Prompt: Fix Downregulation Blank Screen

Use this prompt with a capable LLM to debug and fix the issue. Copy everything below the line.

---

## Task

Fix the **Downregulation** workout view so the WebGL2 particle visualization is visible instead of a blank screen.

## Problem

- Selecting "Downregulation" from the workout day dropdown shows a **blank screen** (no particles, no visible effect).
- Console logs show **successful initialization**: WebGL2 context acquired, shader program created, 12000 particle buffers, render loop started, canvas resized (e.g. 750×1334). No errors.
- So the failure is **not** in init or context creation; something is wrong with **visibility**, **layout**, or **what is actually drawn**.

## What’s already in place

- **Entry**: `src/downregulation/index.ts` — starts/stops the view, HR subscription, simulated HR; calls `initRenderer` and `startRenderLoop` on the canvas.
- **Rendering**: `src/downregulation/renderer.ts` — WebGL2 init, embedded GLSL (vertex + fragment), particle buffers, `tick()` loop with uniforms: `u_time`, `u_coherence`, `u_noiseAmplitude`, `u_gravityStrength`, `u_resolution`. Blend: `SRC_ALPHA`, `ONE`. Clear color dark (#05060A).
- **UI integration**: `src/uiControls.ts` — when `state.screen === "downregulation"`: hide `workoutMainContent` and `workoutBlocks`, set `workoutMainSection` background to transparent, show `#downregulationContainer`, call `startDownregulationView(container, canvas)`.
- **HTML**: `#downregulationContainer` is first child of `<body>`, `position: fixed; inset: 0; z-index: 5; background: #05060a; pointer-events: none`. It contains `#downregulationCanvas` (block, 100% width/height). `#workoutMainSection` has `z-index: 10` and transparent background when Downregulation is active so the dropdown stays on top and the canvas should show behind/through it.

## What to do

1. **Confirm why nothing is visible**  
   Consider and check:
   - **Layout/visibility**: Is the container or canvas actually in the viewport and visible? (DOM order, computed styles, `getBoundingClientRect()`, `clientWidth`/`clientHeight`, stacking/overlays.)
   - **WebGL drawing**: Is the first frame (and subsequent frames) actually drawing? Add or inspect `gl.getError()` after `clear` and after `drawArrays` in the render loop. Ensure viewport matches canvas size.
   - **Clip space / point visibility**: Are particle positions in a valid NDC range? Is `gl_PointSize` in the vertex shader > 0? Is the fragment shader outputting non-zero alpha? Could clear color or blend make the result invisible?

2. **Apply a minimal fix**  
   - If the canvas is covered or has zero display size: fix CSS/DOM so the canvas is on-screen and has non-zero size when Downregulation is selected.
   - If drawing is wrong or missing: fix the render path (viewport, draw call, shader, or blend) so particles are visibly drawn.
   - Prefer small, targeted changes over large refactors.

3. **Verify**  
   - With "Downregulation" selected, the user must see the particle field (moving dots/cloud) on the dark background, with the workout dropdown still usable on top.

## Constraints

- Keep the existing architecture (downregulation module, renderer, uiControls integration).
- Do not remove the Downregulation option or the WebGL2 path; fix why it doesn’t show.
- Build command: `npm run build` (TypeScript → `dist/`). Ensure the app is tested with the built output.

## Relevant files

- `src/downregulation/index.ts` — view lifecycle, HR, init/render loop wiring
- `src/downregulation/renderer.ts` — WebGL2 init, shaders, buffers, `tick()`, resize
- `src/downregulation/hrController.ts` — coherence factor
- `src/uiControls.ts` — `renderWorkout()`, show/hide container, `startDownregulationView` / `stopDownregulationView`
- `index.html` — `#downregulationContainer`, `#downregulationCanvas`, `#workoutMainSection`
- `styles.css` — `.section`, `.container` (if they affect layout)

End of prompt.
