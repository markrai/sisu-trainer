/**
 * WebGL2 particle-field renderer for Downregulation.
 * - Center circle: blue-green (hue 180–200°, low-med sat, mid-low luminance). Soft halo that
 *   breathes slowly; lower HR = slower expansion/contraction cycle and slightly tighter halo.
 *   No snapping, no brightness spikes (nervous system mirror).
 * - Starfield: particles as gl.POINTS; coherence reduces noise, adds wave (no center pull).
 * - Baseline = first 30s (hrController). Dark background (#05060A).
 */

import { getCurrentBpm } from "../hrMonitor.js";
import { getCoherenceFactor, getSmoothedHR } from "./hrController.js";
import {
  getParticleCount,
  getPositions,
  getSeeds,
  initParticleSim,
  stepParticleSim,
} from "./particleSim.js";

// Particle count comes from sim (CPU collision); vertex shader only uses position
const VERTEX_SOURCE = `#version 300 es
in vec2 a_position;
in float a_seed;
uniform float u_coherence;
uniform float u_particleSizeScale;
out float v_alpha;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  float baseSize = (5.0 + 3.0 * u_coherence) * u_particleSizeScale;
  gl_PointSize = baseSize;
  v_alpha = 0.6 + 0.4 * u_coherence;
}
`;

const FRAGMENT_SOURCE = `#version 300 es
precision mediump float;
in float v_alpha;
uniform sampler2D u_pointTexture;
out vec4 outColor;
void main() {
  vec4 tex = texture(u_pointTexture, gl_PointCoord);
  float a = tex.a * v_alpha;
  vec3 col = mix(vec3(0.35, 0.65, 0.75), vec3(0.4, 0.45, 0.7), 0.5);
  col = mix(col, vec3(0.5, 0.4, 0.65), 0.3);
  outColor = vec4(col, a);
}
`;

// Center circle: blue-green soft halo; lower HR = slower breath, slightly tighter (no snap, no brightness spikes)
const CIRCLE_VERTEX = `#version 300 es
in vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const CIRCLE_FRAGMENT = `#version 300 es
precision mediump float;
uniform float u_time;
uniform float u_coherence;
uniform vec2 u_resolution;
out vec4 outColor;
const vec3 circleColor = vec3(0.14, 0.32, 0.34);
void main() {
  vec2 ndc = (gl_FragCoord.xy / u_resolution) * 2.0 - 1.0;
  float aspect = u_resolution.x / u_resolution.y;
  vec2 uv = vec2(ndc.x * aspect, ndc.y);
  float dist = length(uv);
  float breathSpeed = 0.10 * (1.0 - 0.70 * u_coherence);
  float phase = u_time * breathSpeed;
  float breath = sin(phase) * 0.04;
  float innerR = 0.10;
  float baseOuter = 0.42 - 0.06 * u_coherence;
  float outerR = baseOuter + breath;
  float alpha = 1.0 - smoothstep(innerR, outerR, dist);
  alpha *= 0.55;
  outColor = vec4(circleColor, alpha);
}
`;

const BG_R = 5 / 255;
const BG_G = 6 / 255;
const BG_B = 10 / 255;

let gl: WebGL2RenderingContext | null = null;
let program: WebGLProgram | null = null;
let positionBuffer: WebGLBuffer | null = null;
let seedBuffer: WebGLBuffer | null = null;
let uCoherence: WebGLUniformLocation | null = null;
let uParticleSizeScale: WebGLUniformLocation | null = null;
let uPointTexture: WebGLUniformLocation | null = null;
let uResolution: WebGLUniformLocation | null = null;
let pointTexture: WebGLTexture | null = null;

const PARTICLE_SIZE_STORAGE_KEY = "downregulationParticleSizeScale";
const PARTICLE_SIZE_DEFAULT = 1.0;
let particleSizeScale = PARTICLE_SIZE_DEFAULT;
(function loadParticleSizePreference() {
  try {
    const stored = localStorage.getItem(PARTICLE_SIZE_STORAGE_KEY);
    if (stored != null) {
      const v = parseFloat(stored);
      if (Number.isFinite(v) && v >= 1 && v <= 3) particleSizeScale = v;
    }
  } catch {
    /* ignore */
  }
})();

let circleProgram: WebGLProgram | null = null;
let circleQuadBuffer: WebGLBuffer | null = null;
let circleUTime: WebGLUniformLocation | null = null;
let circleUCoherence: WebGLUniformLocation | null = null;
let circleUResolution: WebGLUniformLocation | null = null;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("Shader compile:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error("Program link:", gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

function createCircleProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, CIRCLE_VERTEX);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, CIRCLE_FRAGMENT);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error("Circle program link:", gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

function createCircleQuad(gl: WebGL2RenderingContext): WebGLBuffer | null {
  const buf = gl.createBuffer();
  if (!buf) return null;
  const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  return buf;
}

const POINT_TEX_SIZE = 128;

function createPointTexture(gl: WebGL2RenderingContext): WebGLTexture | null {
  const size = POINT_TEX_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const center = size / 2;
  // Sharp circle: solid to ~90% radius, then thin antialiased edge (so scaled points stay crisp)
  const solidRadius = 0.88 * center;
  const edgeStart = 0.92 * center;
  const gradient = ctx.createRadialGradient(center, center, 0, center, center, center);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(solidRadius / center, "rgba(255,255,255,1)");
  gradient.addColorStop(edgeStart / center, "rgba(255,255,255,0.85)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function createParticleBuffers(gl: WebGL2RenderingContext): boolean {
  initParticleSim();
  const positions = getPositions();
  const seeds = getSeeds();
  positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
  seedBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, seedBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  return true;
}

export function initRenderer(canvas: HTMLCanvasElement): boolean {
  console.log("[Renderer] Attempting to get WebGL2 context...");
  const ctx = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
  });
  if (!ctx) {
    console.error("[Renderer] WebGL2 not available");
    return false;
  }
  console.log("[Renderer] WebGL2 context acquired");
  gl = ctx;

  program = createProgram(gl);
  if (!program) {
    console.error("[Renderer] Failed to create program");
    return false;
  }
  console.log("[Renderer] Shader program created");

  if (!createParticleBuffers(gl)) {
    console.error("[Renderer] Failed to create particle buffers");
    return false;
  }
  console.log("[Renderer] Particle buffers created:", getParticleCount(), "particles");

  uCoherence = gl.getUniformLocation(program, "u_coherence");
  uParticleSizeScale = gl.getUniformLocation(program, "u_particleSizeScale");
  uPointTexture = gl.getUniformLocation(program, "u_pointTexture");
  uResolution = gl.getUniformLocation(program, "u_resolution");

  pointTexture = createPointTexture(gl);
  if (!pointTexture) {
    console.warn("[Renderer] Failed to create point texture, particles may look soft");
  }

  circleProgram = createCircleProgram(gl);
  circleQuadBuffer = createCircleQuad(gl);
  if (!circleProgram || !circleQuadBuffer) {
    console.error("[Renderer] Failed to create circle program/quad");
    return false;
  }
  circleUTime = gl.getUniformLocation(circleProgram, "u_time");
  circleUCoherence = gl.getUniformLocation(circleProgram, "u_coherence");
  circleUResolution = gl.getUniformLocation(circleProgram, "u_resolution");

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  return true;
}

export function resize(canvas: HTMLCanvasElement): void {
  if (!gl) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.floor(window.innerWidth * dpr);
  const h = Math.floor(window.innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    gl.viewport(0, 0, w, h);
  }
}

let rafId: number | null = null;
const startTime = Date.now() / 1000;
let smoothedTimeSpeed = 1.0;
let smoothedMovementScale = 0.0;
let scaledTime = 0.0;
let lastFrameTime = Date.now() / 1000;
const SPEED_SMOOTH_ALPHA = 0.12; // Balance: smooth but visible response to HR within a few seconds

function tick(): void {
  if (!gl || !program) return;
  const coherence = getCoherenceFactor();
  const now = Date.now() / 1000;
  const deltaTime = Math.min(0.1, now - lastFrameTime); // Clamp to avoid big jumps when tab backgrounded
  lastFrameTime = now;

  // Speed modulation based on HR: 40 bpm → 0.25 (min), 120 bpm → 1.0 (cap)
  const currentHR = getSmoothedHR() ?? getCurrentBpm() ?? null;
  let targetTimeSpeed = 0.5; // Default when no HR
  if (currentHR != null && currentHR > 0) {
    const rawSpeed = 0.25 + (0.75 * (currentHR - 40)) / 80; // 40→0.25, 120→1.0
    targetTimeSpeed = Math.max(0.25, Math.min(1, rawSpeed));
  }
  smoothedTimeSpeed = smoothedTimeSpeed + (targetTimeSpeed - smoothedTimeSpeed) * SPEED_SMOOTH_ALPHA;

  // Movement scale: particles have no motion of their own; only move when HR is present. 40 bpm → 0, 120 bpm → 1.
  let targetMovementScale = 0;
  if (currentHR != null && currentHR > 40) {
    targetMovementScale = Math.min(1, (currentHR - 40) / 80);
  }
  smoothedMovementScale = smoothedMovementScale + (targetMovementScale - smoothedMovementScale) * SPEED_SMOOTH_ALPHA;

  // Accumulate scaled time based on current speed (prevents "catch-up" jumps)
  scaledTime += smoothedTimeSpeed * deltaTime;
  const time = scaledTime;

  const noiseAmplitude = 0.4 * (1 - coherence) + 0.1;
  stepParticleSim(time, coherence, noiseAmplitude, smoothedTimeSpeed, deltaTime, smoothedMovementScale);

  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  gl.clearColor(BG_R, BG_G, BG_B, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  if (circleProgram && circleQuadBuffer) {
    gl.useProgram(circleProgram);
    gl.uniform1f(circleUTime!, time);
    gl.uniform1f(circleUCoherence!, coherence);
    gl.uniform2f(circleUResolution!, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const circlePosLoc = gl.getAttribLocation(circleProgram, "a_position");
    gl.bindBuffer(gl.ARRAY_BUFFER, circleQuadBuffer);
    gl.enableVertexAttribArray(circlePosLoc);
    gl.vertexAttribPointer(circlePosLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer!);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, getPositions());
  gl.useProgram(program);
  gl.uniform1f(uCoherence!, coherence);
  if (uParticleSizeScale) gl.uniform1f(uParticleSizeScale, particleSizeScale);
  if (uResolution) gl.uniform2f(uResolution, gl.drawingBufferWidth, gl.drawingBufferHeight);
  if (pointTexture && uPointTexture != null) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, pointTexture);
    gl.uniform1i(uPointTexture, 0);
  }
  const posLoc = gl.getAttribLocation(program, "a_position");
  const seedLoc = gl.getAttribLocation(program, "a_seed");
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer!);
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, seedBuffer!);
  gl.enableVertexAttribArray(seedLoc);
  gl.vertexAttribPointer(seedLoc, 1, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.POINTS, 0, getParticleCount());

  const err = gl.getError();
  if (err !== gl.NO_ERROR && Math.random() < 0.01) {
    console.warn("[Renderer] WebGL error after draw:", err);
  }
  rafId = requestAnimationFrame(tick);
}

export function startRenderLoop(canvas: HTMLCanvasElement): void {
  console.log("[Renderer] Starting render loop");
  resize(canvas);
  console.log("[Renderer] Canvas resized to", canvas.width, "x", canvas.height);
  scaledTime = 0.0;
  smoothedMovementScale = 0.0;
  lastFrameTime = Date.now() / 1000;
  if (rafId != null) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}

export function stopRenderLoop(): void {
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

export function disposeRenderer(): void {
  stopRenderLoop();
  smoothedTimeSpeed = 1.0;
  smoothedMovementScale = 0.0;
  scaledTime = 0.0;
  lastFrameTime = Date.now() / 1000;
  if (gl && positionBuffer) {
    gl.deleteBuffer(positionBuffer);
    positionBuffer = null;
  }
  if (gl && seedBuffer) {
    gl.deleteBuffer(seedBuffer);
    seedBuffer = null;
  }
  if (gl && circleQuadBuffer) {
    gl.deleteBuffer(circleQuadBuffer);
    circleQuadBuffer = null;
  }
  if (gl && circleProgram) {
    gl.deleteProgram(circleProgram);
    circleProgram = null;
  }
  if (gl && program) {
    gl.deleteProgram(program);
    program = null;
  }
  if (gl && pointTexture) {
    gl.deleteTexture(pointTexture);
    pointTexture = null;
  }
  gl = null;
}

export function getParticleSizeScale(): number {
  return particleSizeScale;
}

export function setParticleSizeScale(value: number): void {
  const v = Math.max(1, Math.min(3, value));
  particleSizeScale = v;
  try {
    localStorage.setItem(PARTICLE_SIZE_STORAGE_KEY, String(v));
  } catch {
    /* ignore */
  }
}
