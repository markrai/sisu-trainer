/**
 * WebGL2 particle-field renderer for Downregulation.
 * - 10k+ particles as gl.POINTS; position + seed attributes.
 * - Motion: 3D simplex noise (in shader) projected to 2D; coherence reduces noise amplitude
 *   and increases wave + central gravity. Point size and alpha modulated by coherence.
 * - Dark background (#05060A), alpha + additive blend, cool palette.
 */
import { getCoherenceFactor } from "./hrController.js";
const PARTICLE_COUNT = 12000;
// Embedded shaders (no fetch required)
const VERTEX_SOURCE = `#version 300 es
in vec2 a_position;
in float a_seed;
uniform float u_time;
uniform float u_coherence;
uniform float u_noiseAmplitude;
uniform float u_gravityStrength;
uniform vec2 u_resolution;
out float v_alpha;
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
void main() {
  vec2 uv = a_position;
  float t = u_time * 0.1;
  float seed = a_seed;
  float n1 = snoise(vec3(uv.x * 2.0 + seed * 0.1, uv.y * 2.0, t));
  float n2 = snoise(vec3(uv.x * 2.0 + 100.0 + seed * 0.1, uv.y * 2.0, t + 33.3));
  vec2 noiseFlow = vec2(n1, n2) * u_noiseAmplitude * (1.0 - u_coherence);
  float wavePhase = t + seed * 6.28;
  vec2 wave = vec2(sin(wavePhase), cos(wavePhase * 0.7)) * 0.15 * u_coherence;
  vec2 toCenter = -uv;
  float dist = length(toCenter) + 0.001;
  vec2 gravity = normalize(toCenter) * u_gravityStrength * u_coherence * 0.02 / (dist + 0.5);
  vec2 velocity = noiseFlow + wave + gravity;
  vec2 pos = uv + velocity * 0.08;
  gl_Position = vec4(pos.x, pos.y, 0.0, 1.0);
  float baseSize = 5.0 + 3.0 * u_coherence;
  // NOTE: gl_PointSize is in drawing-buffer pixels. We already scale the canvas by DPR,
  // so shrinking point size by aspect on tall/portrait screens makes particles too small to see.
  gl_PointSize = baseSize;
  v_alpha = 0.6 + 0.4 * u_coherence;
}
`;
const FRAGMENT_SOURCE = `#version 300 es
precision mediump float;
in float v_alpha;
out vec4 outColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float soft = 1.0 - smoothstep(0.0, 0.5, d);
  float a = soft * v_alpha;
  vec3 col = mix(vec3(0.35, 0.65, 0.75), vec3(0.4, 0.45, 0.7), 0.5);
  col = mix(col, vec3(0.5, 0.4, 0.65), 0.3);
  outColor = vec4(col, a);
}
`;
const BG_R = 5 / 255;
const BG_G = 6 / 255;
const BG_B = 10 / 255;
let gl = null;
let program = null;
let positionBuffer = null;
let seedBuffer = null;
let uTime = null;
let uCoherence = null;
let uNoiseAmplitude = null;
let uGravityStrength = null;
let uResolution = null;
function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader)
        return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error("Shader compile:", gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}
function createProgram(gl) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    if (!vs || !fs)
        return null;
    const prog = gl.createProgram();
    if (!prog)
        return null;
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
function createParticleBuffers(gl) {
    const positions = new Float32Array(PARTICLE_COUNT * 2);
    const seeds = new Float32Array(PARTICLE_COUNT);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
        const i2 = i * 2;
        const x = (Math.random() * 2 - 1) * 1.2;
        const y = (Math.random() * 2 - 1) * 1.2;
        positions[i2] = x;
        positions[i2 + 1] = y;
        seeds[i] = i / PARTICLE_COUNT;
    }
    positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    seedBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, seedBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return true;
}
export function initRenderer(canvas) {
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
    console.log("[Renderer] Particle buffers created:", PARTICLE_COUNT, "particles");
    uTime = gl.getUniformLocation(program, "u_time");
    uCoherence = gl.getUniformLocation(program, "u_coherence");
    uNoiseAmplitude = gl.getUniformLocation(program, "u_noiseAmplitude");
    uGravityStrength = gl.getUniformLocation(program, "u_gravityStrength");
    uResolution = gl.getUniformLocation(program, "u_resolution");
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    return true;
}
export function resize(canvas) {
    if (!gl)
        return;
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
let rafId = null;
const startTime = Date.now() / 1000;
function tick() {
    if (!gl || !program)
        return;
    const coherence = getCoherenceFactor();
    const time = Date.now() / 1000 - startTime;
    const noiseAmplitude = 0.4 * (1 - coherence) + 0.1;
    const gravityStrength = 0.5 + coherence * 1.5;
    gl.useProgram(program);
    gl.uniform1f(uTime, time);
    gl.uniform1f(uCoherence, coherence);
    gl.uniform1f(uNoiseAmplitude, noiseAmplitude);
    gl.uniform1f(uGravityStrength, gravityStrength);
    gl.uniform2f(uResolution, gl.drawingBufferWidth, gl.drawingBufferHeight);
    const posLoc = gl.getAttribLocation(program, "a_position");
    const seedLoc = gl.getAttribLocation(program, "a_seed");
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, seedBuffer);
    gl.enableVertexAttribArray(seedLoc);
    gl.vertexAttribPointer(seedLoc, 1, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(BG_R, BG_G, BG_B, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, PARTICLE_COUNT);
    const err = gl.getError();
    if (err !== gl.NO_ERROR && Math.random() < 0.01) {
        console.warn("[Renderer] WebGL error after draw:", err);
    }
    rafId = requestAnimationFrame(tick);
}
export function startRenderLoop(canvas) {
    console.log("[Renderer] Starting render loop");
    resize(canvas);
    console.log("[Renderer] Canvas resized to", canvas.width, "x", canvas.height);
    if (rafId != null)
        cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
}
export function stopRenderLoop() {
    if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
    }
}
export function disposeRenderer() {
    stopRenderLoop();
    if (gl && positionBuffer) {
        gl.deleteBuffer(positionBuffer);
        positionBuffer = null;
    }
    if (gl && seedBuffer) {
        gl.deleteBuffer(seedBuffer);
        seedBuffer = null;
    }
    if (gl && program) {
        gl.deleteProgram(program);
        program = null;
    }
    gl = null;
}
