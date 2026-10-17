// Draws declarative scene elements onto the 800 x 450 stage canvas.
import { evaluate, type Env } from './expr';
import type { Num, SceneElement, Shot, Str, NetworkEl, ParticlesEl, ScatterEl, CycleEl } from './types';

export const STAGE_W = 800;
export const STAGE_H = 450;
export const DEFAULT_BG = '#0F1914';

export interface RenderCtx {
  ctx: CanvasRenderingContext2D;
  /** Canvas CSS width / 800; keeps label text a readable size on small screens. */
  k: number;
  palette: Record<string, string>;
  /** Label boxes drawn so far this frame (device pixels), so later labels can step aside. */
  placed?: [number, number, number, number][];
  /** How the 800x450 stage sits on the canvas (scale and offset in device pixels), to keep labels inside it. */
  stage?: { s: number; ox: number; oy: number };
  /** The look of the shot being drawn: on the warm "world" look, labels get a light box and dark text. */
  look?: 'blueprint' | 'world';
}

const TAU = Math.PI * 2;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function isExpr(v: unknown): v is { $: string } {
  return typeof v === 'object' && v !== null && typeof (v as { $?: unknown }).$ === 'string';
}

export function num(v: Num | undefined, env: Env, fallback = 0): number {
  if (v === undefined) return fallback;
  if (typeof v === 'number') return v;
  if (isExpr(v)) {
    const r = Number(evaluate(v.$, env));
    return Number.isFinite(r) ? r : fallback;
  }
  return fallback;
}

export function str(v: Str | undefined, env: Env, fallback = ''): string {
  if (v === undefined) return fallback;
  if (typeof v === 'string') return v;
  if (isExpr(v)) {
    const r = evaluate(v.$, env);
    return r == null ? fallback : String(r);
  }
  return fallback;
}

export function color(v: Str | undefined, env: Env, palette: Record<string, string>): string | undefined {
  if (v === undefined) return undefined;
  const c = str(v, env);
  if (!c) return undefined;
  return c.startsWith('@') ? palette[c.slice(1)] ?? '#E8F0E6' : c;
}

export function resolveColor(c: string, palette: Record<string, string>): string {
  return c.startsWith('@') ? palette[c.slice(1)] ?? '#E8F0E6' : c;
}

// ---------- cached geometry ----------

type Seg = [number, number, number, number, number];
const netCache = new Map<string, Seg[]>();

function buildNetwork(el: NetworkEl): Seg[] {
  const key = JSON.stringify([el.seed, el.x, el.y, el.angles, el.steps, el.stepLength, el.spread, el.branchChance, el.maxTips, el.pull, el.width, el.bounds]);
  const hit = netCache.get(key);
  if (hit) return hit;
  const r = rng(el.seed);
  const steps = el.steps ?? 60, len = el.stepLength ?? 3, spread = el.spread ?? 0.5;
  const bp = el.branchChance ?? 0.04, max = el.maxTips ?? 24, pull = el.pull ?? 0.05;
  const inside = (x: number, y: number) => {
    const b = el.bounds;
    if (!b) return true;
    if (b.circle && Math.hypot(x - b.circle[0], y - b.circle[1]) >= b.circle[2]) return false;
    if (b.rect && (x < b.rect[0] || y < b.rect[1] || x > b.rect[2] || y > b.rect[3])) return false;
    return true;
  };
  const tips = el.angles.map((a) => ({ x: el.x, y: el.y, a, b: a, w: el.width ?? 2.2, dead: false }));
  const segs: Seg[] = [];
  for (let i = 0; i < steps; i++) {
    const born: typeof tips = [];
    for (const t of tips) {
      if (t.dead) continue;
      const na = t.a + (r() - 0.5) * spread + (t.b - t.a) * pull;
      const nx = t.x + Math.cos(na) * len, ny = t.y + Math.sin(na) * len;
      if (!inside(nx, ny)) { t.dead = true; continue; }
      segs.push([t.x, t.y, nx, ny, t.w]);
      t.x = nx; t.y = ny; t.a = na;
      if (r() < bp && tips.length + born.length < max) {
        const ba = na + (r() < 0.5 ? -1 : 1) * (0.6 + r() * 0.5);
        born.push({ x: nx, y: ny, a: ba, b: ba, w: Math.max(0.9, t.w * 0.82), dead: false });
      }
    }
    tips.push(...born);
  }
  netCache.set(key, segs);
  return segs;
}

const ptCache = new Map<string, number[][]>();
function seeded(key: string, count: number, seed: number, dims: number): number[][] {
  const k = `${key}:${seed}:${count}:${dims}`;
  let pts = ptCache.get(k);
  if (!pts) {
    const r = rng(seed);
    pts = Array.from({ length: count }, () => Array.from({ length: dims }, () => r()));
    ptCache.set(k, pts);
  }
  return pts;
}

// ---------- drawing ----------

function fillStroke(rc: RenderCtx, el: { fill?: Str; stroke?: Str; lineWidth?: Num }, env: Env, path?: Path2D) {
  const { ctx, palette } = rc;
  const f = color(el.fill, env, palette), s = color(el.stroke, env, palette);
  if (f) { ctx.fillStyle = f; path ? ctx.fill(path) : ctx.fill(); }
  if (s) { ctx.strokeStyle = s; ctx.lineWidth = num(el.lineWidth, env, 2); path ? ctx.stroke(path) : ctx.stroke(); }
}

export function labelSize(k: number) {
  return clamp(13 / k, 12, 30);
}

type LabelOpts = { color?: string; bg?: boolean; align?: CanvasTextAlign; size?: number; weight?: number; placed?: boolean };

function labelBox(rc: RenderCtx, text: string, x: number, o: LabelOpts) {
  const fs = labelSize(rc.k) * (o.size ?? 1);
  rc.ctx.font = `${o.weight ?? 600} ${fs}px "Source Sans 3", system-ui, sans-serif`;
  const w = rc.ctx.measureText(text).width + 12;
  const x0 = (o.align === 'left' ? x : o.align === 'right' ? x - w + 12 : x - w / 2 + 6) - 6;
  return { fs, x0, w, h: fs * 1.6 };
}

/**
 * Find a y for a label that doesn't cover a label already drawn this frame,
 * stepping down then up by one line at a time. Generated scenes often put two
 * labels at nearly the same spot; this keeps them readable.
 */
export function placeLabel(rc: RenderCtx, text: string, x: number, y: number, o: LabelOpts = {}): number {
  const placed = rc.placed;
  // Plain text (numbers, pole letters, headings) stays exactly where it was put;
  // only labels with a backing box step aside from each other.
  if (!placed || !o.bg || rc.ctx.globalAlpha < 0.25) return y;
  const { x0, w, h } = labelBox(rc, text, x, o);
  const m = rc.ctx.getTransform();
  const toDevice = (yy: number): [number, number, number, number] => {
    const ax = m.a * x0 + m.e, ay = m.d * (yy - h / 2) + m.f;
    return [ax, ay, ax + m.a * w, ay + m.d * h];
  };
  // Only a real overlap counts (a quarter of the smaller box), not boxes that merely touch.
  const hits = (b: [number, number, number, number]) =>
    placed.some((p) => {
      const ow = Math.min(b[2], p[2]) - Math.max(b[0], p[0]);
      const oh = Math.min(b[3], p[3]) - Math.max(b[1], p[1]);
      if (ow <= 0 || oh <= 0) return false;
      const smaller = Math.min((b[2] - b[0]) * (b[3] - b[1]), (p[2] - p[0]) * (p[3] - p[1]));
      return ow * oh > 0.25 * smaller;
    });
  const offsets = [0, 1, -1, 2, -2, 3, -3];
  let best = y;
  for (const k of offsets) {
    const yy = y + k * (h + 2);
    if (yy - h / 2 < 0 || yy + h / 2 > STAGE_H) continue;
    if (!hits(toDevice(yy))) { best = yy; break; }
  }
  placed.push(toDevice(best));
  return best;
}

/** Shift a label sideways so its whole box stays inside the stage (with a small margin). */
export function clampX(rc: RenderCtx, text: string, x: number, o: LabelOpts = {}): number {
  const st = rc.stage;
  if (!st) return x;
  const { x0, w } = labelBox(rc, text, x, o);
  const m = rc.ctx.getTransform();
  if (!m.a) return x;
  const margin = 8 * st.s;
  const left = m.a * x0 + m.e, right = left + m.a * w;
  const minL = st.ox + margin, maxR = st.ox + STAGE_W * st.s - margin;
  if (right - left > maxR - minL) return x;
  if (left < minL) return x + (minL - left) / m.a;
  if (right > maxR) return x - (right - maxR) / m.a;
  return x;
}

export function drawLabel(rc: RenderCtx, text: string, x0_: number, y0_: number, o: LabelOpts = {}) {
  const { ctx } = rc;
  const x = clampX(rc, text, x0_, o);
  // Keep the whole box inside the stage vertically too (only labels with a box; plain text stays put).
  const half = o.bg ? labelBox(rc, text, x, o).h / 2 : 0;
  const y0 = o.bg && rc.stage ? Math.min(STAGE_H - 4 - half, Math.max(4 + half, y0_)) : y0_;
  const y = o.placed ? y0 : placeLabel(rc, text, x, y0, o);
  const fs = labelSize(rc.k) * (o.size ?? 1);
  ctx.font = `${o.weight ?? 600} ${fs}px "Source Sans 3", system-ui, sans-serif`;
  ctx.textAlign = o.align ?? 'center';
  ctx.textBaseline = 'middle';
  if (o.bg) {
    const m = ctx.measureText(text).width;
    const x0 = o.align === 'left' ? x : o.align === 'right' ? x - m : x - m / 2;
    ctx.fillStyle = rc.look === 'world' ? 'rgba(255,248,235,.92)' : 'rgba(15,25,20,.78)';
    ctx.fillRect(x0 - 6, y - fs * 0.8, m + 12, fs * 1.6);
  }
  ctx.fillStyle = o.color ?? (rc.look === 'world' ? '#3A2A1A' : '#E8F0E6');
  ctx.fillText(text, x, y);
  return y;
}

function drawNetwork(rc: RenderCtx, el: NetworkEl, env: Env) {
  const { ctx } = rc;
  const segs = buildNetwork(el);
  const n = Math.floor(clamp(num(el.progress, env, 1), 0, 1) * segs.length);
  const col = color(el.color, env, rc.palette) ?? '#F2EFE3';
  ctx.strokeStyle = col;
  ctx.lineCap = 'round';
  const buckets = new Map<number, Seg[]>();
  for (let i = 0; i < n; i++) {
    const k = Math.round(segs[i][4] * 2);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(segs[i]);
  }
  for (const [k, list] of buckets) {
    ctx.lineWidth = k / 2;
    ctx.beginPath();
    for (const s of list) { ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); }
    ctx.stroke();
  }
  if (el.connect && segs.length) {
    const p = clamp(num(el.connect.progress, env, 0), 0, 1);
    if (p > 0) {
      const [tx, ty] = el.connect.to;
      let best = segs[0];
      for (const s of segs) if (Math.hypot(s[2] - tx, s[3] - ty) < Math.hypot(best[2] - tx, best[3] - ty)) best = s;
      ctx.lineWidth = el.width ?? 2.2;
      ctx.beginPath();
      ctx.moveTo(best[2], best[3]);
      ctx.lineTo(best[2] + (tx - best[2]) * p, best[3] + (ty - best[3]) * p);
      ctx.stroke();
    }
  }
}

function drawParticles(rc: RenderCtx, el: ParticlesEl, env: Env) {
  const { ctx } = rc;
  const t = num({ $: 't' }, env, 0);
  const pts = seeded('p', el.count, el.seed, 5);
  const lerp = (r: [number, number], u: number) => r[0] + (r[1] - r[0]) * u;
  ctx.fillStyle = color(el.color, env, rc.palette) ?? '#CBB8F0';
  const rad = el.r ?? 3, g = el.gravity ?? 0;
  for (const q of pts) {
    const t0 = lerp(el.emit, q[0]);
    const u = t - t0;
    if (u < 0) continue;
    const x = lerp(el.x, q[1]) + lerp(el.vx, q[3]) * u;
    let y = lerp(el.y, q[2]) + lerp(el.vy, q[4]) * u + 0.5 * g * u * u;
    if (el.floor !== undefined && y > el.floor) y = el.floor;
    if (y < -20 || x < -20 || x > STAGE_W + 20) continue;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, TAU);
    ctx.fill();
  }
}

function drawScatter(rc: RenderCtx, el: ScatterEl, env: Env) {
  const { ctx } = rc;
  const pts = seeded('s', el.count, el.seed, 3);
  const n = Math.floor(clamp(num(el.fraction, env, 1), 0, 1) * pts.length);
  const [r0, r1] = el.r ?? [1.5, 3.5];
  ctx.fillStyle = color(el.color, env, rc.palette) ?? '#F2EFE3';
  for (let i = 0; i < n; i++) {
    const q = pts[i];
    ctx.beginPath();
    ctx.arc(el.x + q[0] * el.w, el.y + q[1] * el.h, r0 + (r1 - r0) * q[2], 0, TAU);
    ctx.fill();
  }
}

function drawCycle(rc: RenderCtx, el: CycleEl, env: Env) {
  const { ctx, palette } = rc;
  const done = env.done as ((id: string) => boolean) | undefined;
  ctx.strokeStyle = '#3B4B41';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(el.x, el.y, el.rx, el.ry, 0, 0, TAU);
  ctx.stroke();
  const n = el.nodes.length;
  el.nodes.forEach((node, i) => {
    const a = -Math.PI / 2 + (i / n) * TAU;
    const x = el.x + Math.cos(a) * el.rx, y = el.y + Math.sin(a) * el.ry;
    const filled = !!(node.step && done?.(node.step));
    ctx.beginPath();
    ctx.arc(x, y, 16, 0, TAU);
    ctx.fillStyle = filled ? palette.accent ?? '#E6A94B' : '#1C2822';
    ctx.fill();
    ctx.strokeStyle = filled ? '#FFF3D8' : '#6C7F72';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    const dy = Math.sin(a) < -0.2 ? -34 : Math.sin(a) > 0.2 ? 34 : 0;
    const dx = Math.cos(a) > 0.2 ? 96 : Math.cos(a) < -0.2 ? -96 : 0;
    drawLabel(rc, node.label, x + dx, y + dy, { bg: true });
  });
}

// ---------- shots: the two looks, and the camera ----------

const grain = (() => { const r = rng(7); return Array.from({ length: 260 }, () => [r() * STAGE_W, r() * STAGE_H, 0.6 + r() * 1.6, r()]); })();

/** Paint a shot's backdrop: dark navy blueprint, or warm illustrated paper. */
export function drawLook(rc: RenderCtx, look: 'blueprint' | 'world') {
  const { ctx } = rc;
  if (look === 'blueprint') {
    ctx.fillStyle = '#0A0B1E';
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    ctx.strokeStyle = 'rgba(130,160,255,.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= STAGE_W; x += 40) { ctx.moveTo(x, 0); ctx.lineTo(x, STAGE_H); }
    for (let y = 0; y <= STAGE_H; y += 40) { ctx.moveTo(0, y); ctx.lineTo(STAGE_W, y); }
    ctx.stroke();
    const g = ctx.createRadialGradient(STAGE_W / 2, STAGE_H / 2, 120, STAGE_W / 2, STAGE_H / 2, 520);
    g.addColorStop(0, 'rgba(60,70,160,.18)');
    g.addColorStop(1, 'rgba(0,0,0,.45)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    return;
  }
  const g = ctx.createLinearGradient(0, 0, STAGE_W, STAGE_H);
  g.addColorStop(0, '#F7ECD4');
  g.addColorStop(1, '#E8C79B');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.22)';
  ctx.lineWidth = 26;
  ctx.beginPath();
  for (let x = -STAGE_H; x < STAGE_W; x += 90) { ctx.moveTo(x, STAGE_H); ctx.lineTo(x + STAGE_H, 0); }
  ctx.stroke();
  ctx.restore();
  for (const [x, y, r, a] of grain) {
    ctx.fillStyle = `rgba(120,80,40,${0.05 + a * 0.08})`;
    ctx.fillRect(x, y, r, r);
  }
  const v = ctx.createRadialGradient(STAGE_W / 2, STAGE_H / 2, 200, STAGE_W / 2, STAGE_H / 2, 560);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(90,50,20,.28)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** Draw one shot at progress p (0..1, `s` seconds in): its look, a slow camera move, then its elements. */
export function drawShot(rc: RenderCtx, shot: Shot, env: Env, p: number, s: number) {
  const { ctx } = rc;
  drawLook(rc, shot.look);
  const prevLook = rc.look;
  rc.look = shot.look;
  const z0 = shot.camera?.zoom?.[0] ?? 1;
  const z1 = shot.camera?.zoom?.[1] ?? z0;
  const [px, py] = shot.camera?.pan ?? [0, 0];
  const e = easeInOut(clamp(p, 0, 1));
  const z = z0 + (z1 - z0) * e;
  ctx.save();
  ctx.translate(STAGE_W / 2 + px * e, STAGE_H / 2 + py * e);
  ctx.scale(z, z);
  ctx.translate(-STAGE_W / 2, -STAGE_H / 2);
  drawElements(rc, shot.elements, { ...env, t: s, p });
  rc.look = prevLook;
  ctx.restore();
  if (s < 0.2) {
    // A quick fade up from black makes the cut between shots read as a cut.
    ctx.fillStyle = `rgba(0,0,0,${(1 - s / 0.2) * 0.85})`;
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
  }
}

/** The shot playing at this moment: which sentence we're in, and how far through it. */
export function activeShot(shots: Shot[], sentence: number, frac: number): { shot: Shot; from: number; to: number } | null {
  let pick: { shot: Shot; from: number; to: number } | null = null;
  for (const sh of shots) {
    if (sh.sentence !== sentence) continue;
    const from = sh.from ?? 0, to = sh.to ?? 1;
    if (!pick || (frac >= from && frac <= to)) pick = { shot: sh, from, to };
    if (frac >= from && frac < to) break;
  }
  if (pick) return pick;
  // No shot for this sentence: hold the nearest earlier one.
  const before = shots.filter((sh) => sh.sentence < sentence).sort((a, b) => b.sentence - a.sentence)[0];
  const sh = before ?? shots[0];
  return sh ? { shot: sh, from: sh.from ?? 0, to: sh.to ?? 1 } : null;
}

export function drawElements(rc: RenderCtx, elements: SceneElement[], env: Env) {
  // Shapes first, then text on top, so a line or arrowhead drawn later never covers a label.
  const isText = (el: SceneElement) => el.type === 'label' || el.type === 'callout';
  for (const el of elements) if (!isText(el)) drawElement(rc, el, env);
  for (const el of elements) if (isText(el)) drawElement(rc, el, env);
}

function drawElement(rc: RenderCtx, el: SceneElement, env: Env) {
  const { ctx } = rc;
  if (el.type === 'group') {
    const as = el.as ?? 'item';
    const instances: Env[] = el.items
      ? el.items.map((item, i) => ({ ...env, [as]: item, i }))
      : el.repeat !== undefined
        ? Array.from({ length: el.repeat }, (_, i) => ({ ...env, i }))
        : [env];
    for (let local of instances) {
      if (el.vars) {
        local = { ...local };
        for (const [k, ex] of Object.entries(el.vars)) local[k] = evaluate(ex, local);
      }
      const a = num(el.alpha, local, 1);
      if (a <= 0) continue;
      ctx.save();
      ctx.globalAlpha *= Math.min(1, a);
      ctx.translate(num(el.x, local), num(el.y, local));
      if (el.rotate !== undefined) ctx.rotate(num(el.rotate, local));
      if (el.scale !== undefined) { const s = num(el.scale, local, 1); ctx.scale(s, s); }
      if (el.origin) ctx.translate(-num(el.origin[0], local), -num(el.origin[1], local));
      if (el.clip) {
        ctx.beginPath();
        ctx.rect(num(el.clip.x, local), num(el.clip.y, local), num(el.clip.w, local), num(el.clip.h, local));
        ctx.clip();
      }
      drawElements(rc, el.children, local);
      ctx.restore();
    }
    return;
  }

  const a = num(el.alpha, env, 1);
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha *= Math.min(1, a);
  switch (el.type) {
    case 'rect': {
      const x = num(el.x, env), y = num(el.y, env), w = num(el.w, env), h = num(el.h, env), r = num(el.r, env);
      ctx.beginPath();
      if (r > 0) ctx.roundRect(x, y, w, h, r);
      else ctx.rect(x, y, w, h);
      fillStroke(rc, el, env);
      break;
    }
    case 'ellipse': {
      const rx = Math.max(0, num(el.rx, env));
      const ry = Math.max(0, el.ry === undefined ? rx : num(el.ry, env));
      ctx.beginPath();
      ctx.ellipse(num(el.x, env), num(el.y, env), rx, ry, num(el.rotate, env, 0), num(el.start, env, 0), num(el.end, env, TAU));
      if (el.start !== undefined || el.end !== undefined) ctx.closePath();
      fillStroke(rc, el, env);
      break;
    }
    case 'line': {
      const x1 = num(el.x1, env), y1 = num(el.y1, env), x2 = num(el.x2, env), y2 = num(el.y2, env);
      const p = clamp(num(el.progress, env, 1), 0, 1);
      if (p <= 0) break;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 + (x2 - x1) * p, y1 + (y2 - y1) * p);
      ctx.lineCap = 'round';
      ctx.strokeStyle = color(el.stroke, env, rc.palette) ?? '#E8F0E6';
      ctx.lineWidth = num(el.lineWidth, env, 2);
      ctx.stroke();
      break;
    }
    case 'path': {
      const d = str(el.d, env);
      if (!d) break;
      let path: Path2D;
      try { path = new Path2D(d); } catch { break; }
      const p = clamp(num(el.progress, env, 1), 0, 1);
      if (p < 1) {
        // Approximate draw-on with a long dash; good enough for short strokes.
        ctx.setLineDash([2000 * p, 2000]);
      }
      ctx.lineCap = 'round';
      fillStroke(rc, el, env, path);
      break;
    }
    case 'label':
      drawLabel(rc, str(el.text, env), num(el.x, env), num(el.y, env), {
        color: color(el.color, env, rc.palette),
        bg: el.bg ?? true,
        align: el.align,
        size: num(el.size, env, 1),
        weight: el.weight,
      });
      break;
    case 'callout': {
      const x = num(el.x, env), y = num(el.y, env);
      const col = color(el.color, env, rc.palette) ?? (rc.look === 'world' ? '#3A2A1A' : '#E8F0E6');
      const text = str(el.text, env);
      const lx = clampX(rc, text, num(el.lx, env), { bg: true });
      const ly = placeLabel(rc, text, lx, num(el.ly, env), { bg: true });
      const fs = labelSize(rc.k);
      ctx.font = `600 ${fs}px "Source Sans 3", system-ui, sans-serif`;
      const half = ctx.measureText(text).width / 2 + 6;
      // Stop the pointer at the edge of the label box.
      const ex = lx + Math.max(-half, Math.min(half, x - lx));
      const ey = Math.abs(x - lx) <= half ? ly + Math.sign(y - ly) * fs * 0.8 : ly;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, TAU);
      ctx.fillStyle = col;
      ctx.fill();
      drawLabel(rc, text, lx, ly, { color: col, bg: true, placed: true });
      break;
    }
    case 'network': drawNetwork(rc, el, env); break;
    case 'particles': drawParticles(rc, el, env); break;
    case 'scatter': drawScatter(rc, el, env); break;
    case 'cycle': drawCycle(rc, el, env); break;
  }
  ctx.restore();
}
