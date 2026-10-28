/**
 * The Orbit view: every live Claude Code session as a glyph around a
 * holographic reactor, coloured by what it is doing. Click one and its
 * terminal window comes to the front (POST /api/sessions/:id/focus).
 *
 * Same data and the same rules as the Sessions tab: /api/sessions is the
 * truth, and every string from a transcript reaches the DOM through
 * textContent. The scene only renders while the tab is showing.
 */
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import {
  listSessions, focusSession, FOCUS_MESSAGES, type SessionRow,
  listClosedSessions, reopenSession, type ClosedSession,
} from "./api";
import { el } from "./ui";

type Kind = "blocked" | "yourturn" | "working" | "dormant";

const KIND: Record<string, Kind> = {
  needs_you: "blocked", idle: "yourturn", working: "working", shell: "working",
  fresh: "dormant", unknown: "dormant",
};
// One blue family; the two states that want you are the only warm notes.
const COLOR: Record<Kind, number> = {
  working: 0x4da3ff, yourturn: 0xffd27a, blocked: 0xff4d6d, dormant: 0x2f4a73,
};
const LABEL: Record<Kind, string> = {
  working: "EN COURS", yourturn: "À TOI", blocked: "BLOQUÉE", dormant: "EN VEILLE",
};
const RANK: Record<Kind, number> = { blocked: 0, yourturn: 1, working: 2, dormant: 3 };
const BLUE = 0x4da3ff, ICE = 0xa9d4ff;
const ORBIT_RX = 11.5, ORBIT_RY = 6.6;
const CENTER = new THREE.Vector3(-3.2, 0, 0);
const POLL_MS = 1500;
const HISTORY = 120; // polls kept for the activity strip (~3 min)

const kindOf = (s: SessionRow): Kind => KIND[s.state] ?? "dormant";
const nameOf = (s: SessionRow): string => s.roster_name || s.voice_name;
const nowSec = (): number => Date.now() / 1000;

function ago(since: number | null): string {
  if (since === null) return "—";
  const s = Math.max(0, Math.round(nowSec() - since));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return `${Math.floor(s / 86400)} j`;
}

// ── geometry helpers ───────────────────────────────────────────────────────

function glowMat(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
}

function ring(r: number, w: number, color: number, opacity: number,
  start = 0, length = Math.PI * 2): THREE.Mesh {
  return new THREE.Mesh(new THREE.RingGeometry(r, r + w, Math.max(16, Math.round(160 * length / (Math.PI * 2))), 1, start, length),
    glowMat(color, opacity));
}

/** A ring broken into `n` equal segments with gaps: the HUD signature. */
function segmented(r: number, w: number, n: number, fill: number, color: number, opacity: number): THREE.Group {
  const g = new THREE.Group();
  const step = (Math.PI * 2) / n;
  for (let i = 0; i < n; i++) g.add(ring(r, w, color, opacity * (i % 5 === 0 ? 1 : 0.55), i * step, step * fill));
  return g;
}

function ticks(r: number, n: number, len: number, color: number, opacity: number): THREE.LineSegments {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, l = i % 10 === 0 ? len * 2.2 : len;
    pts.push(Math.cos(a) * r, Math.sin(a) * r, 0, Math.cos(a) * (r + l), Math.sin(a) * (r + l), 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
}

function dotted(r: number, n: number, size: number, color: number, opacity: number): THREE.Points {
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pos.set([Math.cos(a) * r, Math.sin(a) * r, 0], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({
    color, size, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
}

// ── state ──────────────────────────────────────────────────────────────────

interface Glyph {
  group: THREE.Group;
  dot: THREE.Mesh;
  frame: THREE.Mesh;
  arc: THREE.Mesh;
  ripple: THREE.Mesh;
  hit: THREE.Mesh;
  link: THREE.Line;
  pulses: THREE.Points;
  tag: CSS2DObject;
  tagName: HTMLElement;
  tagState: HTMLElement;
  angle: number;
  target: number;
  placed: boolean;
  seed: number;
  row: SessionRow;
}

let host: HTMLElement;
let renderer: THREE.WebGLRenderer;
let labels: CSS2DRenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let composer: EffectComposer;
let bloom: UnrealBloomPass;
let listEl: HTMLOListElement;
let toastEl: HTMLElement;
let barsEl: HTMLElement;
const counts: Partial<Record<Kind, HTMLElement>> = {};

const glyphs = new Map<string, Glyph>();
let rows: SessionRow[] = [];
const history: number[] = [];
let hovered: string | null = null;
let visible = false;
let built = false;
let frameId = 0;
let pollId = 0;
const lastKind = new Map<string, Kind>();
const spinners: { obj: THREE.Object3D; speed: number }[] = [];
let reactor: THREE.Group;
let coreDot: THREE.Mesh;
let coreShell: THREE.Mesh;
let coreHit: THREE.Mesh;
let listening = false;   // JARVIS is awake (heard his name, or the core was clicked)
let voiceState = "idle";
let act = 0;             // 0 asleep → 1 awake, eased so waking is a build-up, not a switch
let halo: THREE.Group;   // outer ring that unfolds as he wakes
const waves: { mesh: THREE.Mesh; t: number }[] = [];
let dust: THREE.Points;
let jump: { t: number; glyph: Glyph } | null = null;
const pointer = new THREE.Vector2();
const look = CENTER.clone().add(new THREE.Vector3(3.2, 0, 0));
const clock = new THREE.Clock();
const tmp = new THREE.Vector3();

// ── scene ──────────────────────────────────────────────────────────────────

function buildReactor(): THREE.Group {
  const g = new THREE.Group();
  const spin = (obj: THREE.Object3D, speed: number): THREE.Object3D => {
    spinners.push({ obj, speed });
    g.add(obj);
    return obj;
  };

  coreDot = new THREE.Mesh(new THREE.CircleGeometry(0.55, 48), glowMat(ICE, 0.95));
  coreShell = new THREE.Mesh(new THREE.IcosahedronGeometry(1.25, 1),
    new THREE.MeshBasicMaterial({ color: BLUE, wireframe: true, transparent: true, opacity: 0.35,
      blending: THREE.AdditiveBlending, depthWrite: false }));
  coreHit = new THREE.Mesh(new THREE.CircleGeometry(1.6, 24), new THREE.MeshBasicMaterial({ visible: false }));
  g.add(coreDot, coreShell, coreHit, ring(0.85, 0.03, ICE, 0.8));
  halo = segmented(3.85, 0.06, 48, 0.6, ICE, 0.9);
  halo.visible = false;
  g.add(halo);

  spin(segmented(1.75, 0.22, 36, 0.72, BLUE, 0.55), 0.12);
  spin(ring(2.2, 0.025, ICE, 0.6), 0);
  spin(ticks(2.45, 120, 0.12, BLUE, 0.55), -0.05);
  const arcs = new THREE.Group();
  [[0, 1.6], [2.1, 0.9], [3.4, 2.1]].forEach(([s, l]) => arcs.add(ring(3.05, 0.09, BLUE, 0.7, s, l)));
  spin(arcs, -0.22);
  const thin = new THREE.Group();
  [[0.4, 0.5], [2.6, 1.2], [4.6, 0.7]].forEach(([s, l]) => thin.add(ring(3.4, 0.03, ICE, 0.55, s, l)));
  spin(thin, 0.3);
  spin(segmented(3.9, 0.05, 4, 0.94, BLUE, 0.35), 0.03);
  spin(dotted(4.45, 180, 0.06, ICE, 0.5), -0.02);
  spin(segmented(5.1, 0.32, 72, 0.5, BLUE, 0.16), 0.015);
  g.add(ring(5.8, 0.012, BLUE, 0.25));
  return g;
}

function buildScene(): void {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  // Pixel ratio 1 and a 30 fps cap: bloom over a full Retina screen at 120 Hz
  // was enough to make the whole Mac lag.
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  host.append(renderer.domElement);

  labels = new CSS2DRenderer();
  labels.domElement.className = "orbit-labels";
  host.append(labels.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
  camera.position.set(0, 0, 30);

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.45, 0.05);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  reactor = buildReactor();
  reactor.position.copy(CENTER);
  scene.add(reactor);

  // The orbit path, as faint as a pencil line.
  const path = new THREE.EllipseCurve(0, 0, ORBIT_RX, ORBIT_RY).getPoints(200);
  const orbit = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(path),
    new THREE.LineDashedMaterial({ color: BLUE, transparent: true, opacity: 0.22, dashSize: 0.25, gapSize: 0.35 }));
  orbit.computeLineDistances();
  orbit.position.copy(CENTER);
  scene.add(orbit);

  // Projection rings far behind, the room the hologram is cast into.
  const back = new THREE.Group();
  [14, 19, 25].forEach((r, i) => back.add(ring(r, 0.04, BLUE, 0.07 - i * 0.015)));
  back.position.set(CENTER.x, CENTER.y, -18);
  scene.add(back);

  const n = 900, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) pos.set([(Math.random() - 0.5) * 80, (Math.random() - 0.5) * 46, -30 + Math.random() * 34], i * 3);
  const dg = new THREE.BufferGeometry();
  dg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  dust = new THREE.Points(dg, new THREE.PointsMaterial({ color: ICE, size: 0.07, transparent: true, opacity: 0.45,
    blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(dust);

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const aim = (e: PointerEvent): void => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  };
  const pick = (e: PointerEvent): string | null => {
    aim(e);
    const hit = ray.intersectObjects([...glyphs.values()].map((g) => g.hit))[0];
    return (hit?.object.userData.id as string | undefined) ?? null;
  };
  const onCore = (e: PointerEvent): boolean => { aim(e); return ray.intersectObject(coreHit).length > 0; };
  renderer.domElement.addEventListener("pointermove", (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
    const id = pick(e);
    setHover(id);
    if (!id && onCore(e)) renderer.domElement.style.cursor = "pointer";
  });
  renderer.domElement.addEventListener("click", (e) => {
    const id = pick(e as PointerEvent);
    if (id) void focus(id);
    else if (onCore(e as PointerEvent)) dispatchEvent(new Event("jarvis:wake"));
  });
  addEventListener("jarvis:awake", (e) => {
    const now = Boolean((e as CustomEvent<boolean>).detail);
    if (now && !listening) wake();
    listening = now;
  });
  addEventListener("jarvis:state", (e) => { voiceState = String((e as CustomEvent<string>).detail); });

  new ResizeObserver(resize).observe(host);
}

/** Three shockwaves rolling out of the core, a beat apart. */
function wake(): void {
  for (let i = 0; i < 3; i++) {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.9, 0.96, 96), glowMat(i ? BLUE : ICE, 0));
    reactor.add(mesh);
    waves.push({ mesh, t: -i * 0.14 });
  }
}

function animateWake(dt: number, t: number): void {
  // Ease toward the target: about a second up, a little slower back down.
  act += ((listening ? 1 : 0) - act) * Math.min(1, dt * (listening ? 2.6 : 1.4));
  const e = act * act * (3 - 2 * act);   // smoothstep: soft start, soft landing

  for (let i = waves.length - 1; i >= 0; i--) {
    const w = waves[i];
    w.t += dt;
    if (w.t < 0) continue;
    const p = Math.min(1, w.t / 1.3);
    const out = 1 - Math.pow(1 - p, 3);
    w.mesh.scale.setScalar(1 + out * 6);
    (w.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - p) * 0.9;
    if (p >= 1) {
      reactor.remove(w.mesh);
      w.mesh.geometry.dispose();
      (w.mesh.material as THREE.Material).dispose();
      waves.splice(i, 1);
    }
  }

  // Core: a calm breath asleep; awake it swells, and beats faster while he talks.
  const beat = voiceState === "speaking" ? Math.sin(t * 9) * 0.12
    : voiceState === "thinking" ? Math.sin(t * 3) * 0.08 : Math.sin(t * 4) * 0.06;
  coreDot.scale.setScalar(1 + Math.sin(t * 1.6) * 0.05 * (1 - e) + e * (0.3 + beat));
  (coreShell.material as THREE.MeshBasicMaterial).opacity = 0.35 + e * 0.45;
  coreShell.scale.setScalar(1 + e * 0.12);
  const think = voiceState === "thinking" ? 2 : 1;
  coreShell.rotation.x += dt * 0.15 * (1 + e * 2) * think;
  coreShell.rotation.y += dt * 0.22 * (1 + e * 2) * think;

  // The halo unfolds from inside the reactor and turns while he listens.
  halo.visible = e > 0.01;
  halo.scale.setScalar(0.7 + e * 0.3);
  halo.rotation.z -= dt * (0.2 + e * 0.6);
  halo.children.forEach((c, i) => {
    const m = (c as THREE.Mesh).material as THREE.MeshBasicMaterial;
    // segments light up one after another as `e` climbs
    m.opacity = Math.max(0, Math.min(1, e * 1.6 - i / halo.children.length * 0.6)) * 0.8;
  });

  if (!jump) bloom.strength = 0.85 + e * 0.55;
}

function resize(): void {
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  labels.setSize(w, h);
}

function makeGlyph(s: SessionRow): Glyph {
  const group = new THREE.Group();
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.2, 32), glowMat(BLUE, 1));
  const frame = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.66, 64), glowMat(BLUE, 0.6));
  const arc = new THREE.Mesh(new THREE.RingGeometry(0.8, 0.9, 48, 1, 0, Math.PI * 0.6), glowMat(BLUE, 0.9));
  const ripple = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.65, 64), glowMat(BLUE, 0.6));
  const hit = new THREE.Mesh(new THREE.CircleGeometry(1.5, 16), new THREE.MeshBasicMaterial({ visible: false }));
  hit.userData.id = s.session_id;
  group.add(dot, frame, arc, ripple, hit, ticks(0.95, 24, 0.07, BLUE, 0.35));

  const link = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: BLUE, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false }));
  const pg = new THREE.BufferGeometry();
  pg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6 * 3), 3));
  const pulses = new THREE.Points(pg, new THREE.PointsMaterial({ color: ICE, size: 0.14, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(link, pulses);

  const tagEl = el("div", "orbit-tag");
  const tagName = el("div", "orbit-tag-name");
  const tagState = el("div", "orbit-tag-state");
  tagEl.append(tagName, tagState);
  tagEl.addEventListener("click", () => void focus(s.session_id));
  tagEl.addEventListener("mouseenter", () => setHover(s.session_id));
  tagEl.addEventListener("mouseleave", () => setHover(null));
  const tag = new CSS2DObject(tagEl);
  tag.position.y = -1.25;
  group.add(tag);
  scene.add(group);

  const g: Glyph = { group, dot, frame, arc, ripple, hit, link, pulses, tag, tagName, tagState,
    angle: 0, target: 0, placed: false, seed: Math.random() * 10, row: s };
  glyphs.set(s.session_id, g);
  return g;
}

function paintGlyph(g: Glyph, s: SessionRow): void {
  const kind = kindOf(s);
  const c = new THREE.Color(COLOR[kind]);
  for (const m of [g.dot, g.frame, g.arc, g.ripple]) (m.material as THREE.MeshBasicMaterial).color.copy(c);
  (g.link.material as THREE.LineBasicMaterial).color.copy(c);
  g.tag.element.className = `orbit-tag is-${kind}${hovered === s.session_id ? " is-hover" : ""}`;
  g.tagName.textContent = s.number ? `${s.number} · ${nameOf(s)}` : nameOf(s);
  g.tagState.textContent = LABEL[kind];
  g.row = s;
}

function dropGlyph(id: string): void {
  const g = glyphs.get(id);
  if (!g) return;
  g.tag.element.remove();
  scene.remove(g.group, g.link, g.pulses);
  glyphs.delete(id);
}

// ── data ───────────────────────────────────────────────────────────────────

async function refresh(): Promise<void> {
  try {
    const snap = await listSessions();
    apply(snap.sessions.filter((s) => s.state !== "gone"));
  } catch {
    /* the Sessions tab already shows the link banner; keep the last frame */
  }
}

function apply(next: SessionRow[]): void {
  for (const s of next) {
    const k = kindOf(s), before = lastKind.get(s.session_id);
    if (before && before !== k && (k === "yourturn" || k === "blocked")) chime(k);
    lastKind.set(s.session_id, k);
  }
  rows = next;
  history.push(next.filter((s) => kindOf(s) === "working").length);
  if (history.length > HISTORY) history.shift();

  const live = new Set(next.map((s) => s.session_id));
  for (const id of [...glyphs.keys()]) if (!live.has(id)) dropGlyph(id);
  // Stable seats: by start time, so a glyph never jumps around the ring.
  const seats = [...next].sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
  seats.forEach((s, i) => {
    const g = glyphs.get(s.session_id) ?? makeGlyph(s);
    g.target = Math.PI / 2 - (i / seats.length) * Math.PI * 2;
    if (!g.placed) { g.angle = g.target; g.placed = true; }
    paintGlyph(g, s);
  });
  paintList();
  paintBars();
}

function ordered(): SessionRow[] {
  return [...rows].sort((a, b) => RANK[kindOf(a)] - RANK[kindOf(b)] || (b.since ?? 0) - (a.since ?? 0));
}

function paintList(): void {
  const items = ordered().map((s, i) => {
    const kind = kindOf(s);
    const li = el("li", `orbit-card is-${kind}${hovered === s.session_id ? " is-hover" : ""}`);
    li.dataset.id = s.session_id;
    const head = el("div", "orbit-row");
    head.append(el("span", "orbit-key", String(s.number ?? i + 1).padStart(2, "0")),
      el("span", "orbit-name", nameOf(s)), el("span", "orbit-state", LABEL[kind]));
    const topic = el("div", "orbit-topic", s.title || s.project || s.cwd);
    const text = kind === "blocked" ? (s.needs ?? "")
      : kind === "working" ? (s.last_prompt ?? "")
      : (s.last_text ?? s.last_prompt ?? "");
    const msg = el("div", "orbit-msg", text);
    const tool = kind === "working" && s.recent_tools.length ? ` · ${s.recent_tools[s.recent_tools.length - 1]}` : "";
    const meta = el("div", "orbit-meta", `${s.project} · ${ago(s.since)}${tool}`);
    li.append(head, topic, msg, meta);
    li.addEventListener("click", () => void focus(s.session_id));
    li.addEventListener("mouseenter", () => setHover(s.session_id));
    li.addEventListener("mouseleave", () => setHover(null));
    return li;
  });
  listEl.replaceChildren(...items);

  for (const k of ["working", "yourturn", "blocked"] as Kind[]) {
    const c = rows.filter((s) => kindOf(s) === k).length;
    const box = counts[k];
    if (!box) continue;
    box.querySelector("b")!.textContent = String(c).padStart(2, "0");
    box.classList.toggle("is-hot", k !== "working" && c > 0);
  }
}

function paintBars(): void {
  const max = Math.max(1, ...history);
  const padded = [...Array(HISTORY - history.length).fill(0), ...history];
  const bars = padded.map((v) => {
    const b = el("i");
    b.style.height = `${Math.max(3, (v / max) * 100)}%`;
    if (!v) b.className = "is-empty";
    return b;
  });
  barsEl.replaceChildren(...bars);
}

// ── interaction ────────────────────────────────────────────────────────────

function setHover(id: string | null): void {
  if (hovered === id) return;
  hovered = id;
  for (const [gid, g] of glyphs) g.tag.element.classList.toggle("is-hover", gid === id);
  for (const li of Array.from(listEl.children) as HTMLElement[]) {
    li.classList.toggle("is-hover", li.dataset.id === id);
  }
  renderer.domElement.style.cursor = id ? "pointer" : "";
}

// ── history: closed conversations, reopened with `claude --resume` ────────

let historyEl: HTMLElement;
let showingHistory = false;

async function paintHistory(): Promise<void> {
  let closed: ClosedSession[];
  try {
    closed = await listClosedSessions(15);
  } catch {
    historyEl.replaceChildren(el("li", "orbit-empty", "Historique indisponible"));
    return;
  }
  if (!closed.length) {
    historyEl.replaceChildren(el("li", "orbit-empty", "Aucune session fermée"));
    return;
  }
  historyEl.replaceChildren(...closed.map((c) => {
    const li = el("li", "orbit-card is-closed");
    const head = el("div", "orbit-row");
    head.append(el("span", "orbit-name", c.name || c.title || c.project),
      el("span", "orbit-state", "ROUVRIR"));
    const topic = el("div", "orbit-topic", c.name ? (c.title ?? c.project) : c.project);
    const msg = el("div", "orbit-msg", c.last_prompt ?? "");
    const meta = el("div", "orbit-meta", `${c.project} · fermée il y a ${ago(c.ended)}`);
    li.append(head, topic, msg, meta);
    li.addEventListener("click", () => void reopen(c, li));
    return li;
  }));
}

async function reopen(c: ClosedSession, li: HTMLElement): Promise<void> {
  if (li.classList.contains("is-busy")) return;
  li.classList.add("is-busy");
  blip(1320, 0.06);
  const ok = await reopenSession(c.session_id);
  toast(ok ? `${c.name || c.title || c.project} · rouverte` : "Impossible de rouvrir cette session", !ok);
  // It is live again now: the next poll moves it back to the queue.
  window.setTimeout(() => { if (showingHistory) void paintHistory(); }, 4000);
}

let toastTimer = 0;
function toast(text: string, bad: boolean): void {
  toastEl.textContent = text;
  toastEl.className = `orbit-toast is-show${bad ? " is-bad" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toastEl.className = "orbit-toast"; }, 3200);
}

async function focus(id: string): Promise<void> {
  const s = rows.find((r) => r.session_id === id);
  const g = glyphs.get(id);
  if (!s) return;
  if (g) jump = { t: 0, glyph: g };
  blip(1320, 0.06);
  const outcome = await focusSession(id);
  toast(outcome === "focused" ? `${nameOf(s)} · fenêtre ouverte` : FOCUS_MESSAGES[outcome], outcome !== "focused");
}

let audio: AudioContext | null = null;
let soundOn = true;
function blip(freq: number, dur: number, delay = 0): void {
  if (!soundOn || !audio) return;
  const o = audio.createOscillator(), gain = audio.createGain(), t = audio.currentTime + delay;
  o.type = "sine";
  o.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(gain).connect(audio.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
function chime(k: Kind): void {
  if (k === "blocked") { blip(740, 0.1); blip(740, 0.1, 0.16); }
  else { blip(988, 0.14); blip(1480, 0.22, 0.1); }
}

// ── loop ───────────────────────────────────────────────────────────────────

const FRAME_MS = 1000 / 30;
let lastFrame = 0;

function frame(now: number): void {
  frameId = requestAnimationFrame(frame);
  if (now - lastFrame < FRAME_MS) return;
  lastFrame = now;
  const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;

  const spinUp = 1 + act * act * 2.5;     // the rings wind up as he wakes
  for (const s of spinners) s.obj.rotation.z += dt * s.speed * spinUp;
  animateWake(dt, t);
  dust.rotation.y = Math.sin(t * 0.03) * 0.08;

  for (const g of glyphs.values()) {
    const kind = kindOf(g.row);
    let d = g.target - g.angle;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    g.angle += d * Math.min(1, dt * 3);
    const a = g.angle + Math.sin(t * 0.05) * 0.04;
    g.group.position.set(CENTER.x + Math.cos(a) * ORBIT_RX, CENTER.y + Math.sin(a) * ORBIT_RY, Math.sin(t * 0.9 + g.seed) * 0.25);

    const hot = hovered === g.row.session_id, working = kind === "working";
    g.arc.visible = working || hot;
    g.arc.rotation.z -= dt * (working ? 3.2 : 0.8);
    let k = 1;
    if (kind === "yourturn") k = 1 + Math.sin(t * 2.4 + g.seed) * 0.1;
    if (kind === "blocked") k = Math.sin(t * 10) > 0 ? 1.12 : 0.92;
    if (kind === "dormant") k = 0.75;
    g.group.scale.lerp(tmp.setScalar(k * (hot ? 1.35 : 1)), Math.min(1, dt * 10));

    const rp = (t * (kind === "blocked" ? 1.3 : 0.6) + g.seed) % 1;
    g.ripple.visible = kind === "yourturn" || kind === "blocked";
    g.ripple.scale.setScalar(1 + rp * 1.8);
    (g.ripple.material as THREE.MeshBasicMaterial).opacity = (1 - rp) * 0.7;

    // Link from the reactor's rim to the glyph, with data pulses when busy.
    const dir = tmp.copy(g.group.position).sub(CENTER).normalize();
    const from = CENTER.clone().addScaledVector(dir, 6.1);
    const to = g.group.position.clone().addScaledVector(dir, -1.1);
    const lp = g.link.geometry.attributes.position as THREE.BufferAttribute;
    lp.setXYZ(0, from.x, from.y, from.z);
    lp.setXYZ(1, to.x, to.y, to.z);
    lp.needsUpdate = true;
    (g.link.material as THREE.LineBasicMaterial).opacity = hot ? 0.6 : working ? 0.32 : 0.1;

    g.pulses.visible = working;
    if (working) {
      const pp = g.pulses.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pp.count; i++) {
        const u = (i / pp.count + t * 0.35 + g.seed) % 1;
        tmp.lerpVectors(from, to, u);
        pp.setXYZ(i, tmp.x, tmp.y, tmp.z);
      }
      pp.needsUpdate = true;
    }
  }

  // Gentle parallax toward the pointer; a lean toward a clicked glyph.
  let lean = new THREE.Vector3();
  if (jump) {
    jump.t += dt;
    const p = Math.sin(Math.min(1, jump.t / 1.4) * Math.PI);
    lean = jump.glyph.group.position.clone().sub(look).multiplyScalar(0.25 * p);
    bloom.strength = 0.85 + p * 0.9;
    if (jump.t > 1.4) { jump = null; bloom.strength = 0.85; }
  }
  camera.position.x += (look.x + pointer.x * 1.6 + lean.x - camera.position.x) * Math.min(1, dt * 2.5);
  camera.position.y += (look.y - pointer.y * 1.0 + lean.y - camera.position.y) * Math.min(1, dt * 2.5);
  camera.lookAt(look.x + lean.x, look.y + lean.y, 0);

  composer.render();
  labels.render(scene, camera);
}

// ── shell ──────────────────────────────────────────────────────────────────

function buildShell(view: HTMLElement): void {
  host = el("div", "orbit-stage");

  const stats = el("div", "orbit-stats");
  stats.append(el("div", "orbit-caption", "JARVIS · SESSIONS"));
  for (const k of ["working", "yourturn", "blocked"] as Kind[]) {
    const box = el("div", `orbit-stat is-${k}`);
    box.append(el("b", undefined, "00"), el("span", undefined, LABEL[k]));
    counts[k] = box;
    stats.append(box);
  }
  const activity = el("div", "orbit-activity");
  barsEl = el("div", "orbit-bars");
  activity.append(el("div", "orbit-caption", "ACTIVITÉ · 3 MIN"), barsEl);
  stats.append(activity);

  const side = el("aside", "orbit-panel");
  const head = el("div", "orbit-panel-head");
  const queueTab = el("button", "orbit-tab is-on", "FILE D'ATTENTION");
  const historyTab = el("button", "orbit-tab", "HISTORIQUE");
  head.append(queueTab, historyTab, el("i"));
  listEl = el("ol", "orbit-list");
  historyEl = el("ol", "orbit-list");
  historyEl.hidden = true;
  const show = (history: boolean) => {
    showingHistory = history;
    queueTab.classList.toggle("is-on", !history);
    historyTab.classList.toggle("is-on", history);
    listEl.hidden = history;
    historyEl.hidden = !history;
    if (history) void paintHistory();
  };
  queueTab.addEventListener("click", () => show(false));
  historyTab.addEventListener("click", () => show(true));
  side.append(head, listEl, historyEl);

  const hint = el("div", "orbit-hint", "1–9  sauter      clic  ouvrir la fenêtre      M  son");
  toastEl = el("div", "orbit-toast");
  view.append(host, el("div", "orbit-veil"), stats, side, hint, toastEl);
}

/** Called when the Orbit tab is shown or hidden. */
export function setOrbitVisible(on: boolean): void {
  visible = on;
  if (on) {
    if (!built) { buildScene(); built = true; }
    resize();
    void refresh();
    if (!pollId) pollId = window.setInterval(() => void refresh(), POLL_MS);
    if (!frameId) { clock.getDelta(); frame(performance.now()); }
  } else {
    cancelAnimationFrame(frameId);
    frameId = 0;
    clearInterval(pollId);
    pollId = 0;
  }
}

export function initOrbit(): void {
  const view = document.getElementById("orbit-view");
  if (!view) return;
  buildShell(view);
  addEventListener("pointerdown", () => { audio ??= new AudioContext(); }, { once: true });
  addEventListener("keydown", (e) => {
    if (!visible || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    const i = Number(e.key);
    if (i >= 1 && i <= 9) { const s = rows.find((r) => r.number === i); if (s) void focus(s.session_id); }
    if (e.key.toLowerCase() === "m") soundOn = !soundOn;
  });
}
