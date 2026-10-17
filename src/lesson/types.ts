// The lesson file format. The backend validates generated lessons against the
// same shape (backend/app/lesson_schema.py), so keep the two in sync.
//
// Coordinates are in an 800 x 450 stage. Any numeric, color or text field may
// be an expression object { "$": "..." } evaluated every frame (see expr.ts).
// In video scenes `t` is seconds since the scene started; in activities the
// simulation state and control values are in scope.

export type Expr = { $: string };
export type Num = number | Expr;
export type Str = string | Expr;

export interface Term { term: string; definition: string }
export interface Source { title: string; url: string }

// ---------- scene elements ----------

interface ElementBase {
  alpha?: Num;
}

export interface GroupEl extends ElementBase {
  type: 'group';
  children: SceneElement[];
  x?: Num;
  y?: Num;
  scale?: Num;
  rotate?: Num;
  origin?: [Num, Num];
  /** Draw the children `count` times with `i` = 0..count-1 in scope. */
  repeat?: number;
  /** Draw the children once per item, with the item in scope as `as` (default "item") and `i`. */
  items?: Record<string, unknown>[];
  as?: string;
  /** Local variables evaluated before the children, e.g. { "g": "clamp(p*2,0,1)" }. */
  vars?: Record<string, string>;
  clip?: { x: Num; y: Num; w: Num; h: Num };
}

export interface RectEl extends ElementBase {
  type: 'rect';
  x: Num; y: Num; w: Num; h: Num;
  r?: Num;
  fill?: Str; stroke?: Str; lineWidth?: Num;
}

export interface EllipseEl extends ElementBase {
  type: 'ellipse';
  x: Num; y: Num; rx: Num; ry?: Num;
  /** Rotation of the ellipse, radians. */
  rotate?: Num;
  /** Partial ellipse, radians. A partial shape is closed with a straight edge. */
  start?: Num; end?: Num;
  fill?: Str; stroke?: Str; lineWidth?: Num;
}

export interface LineEl extends ElementBase {
  type: 'line';
  x1: Num; y1: Num; x2: Num; y2: Num;
  stroke?: Str; lineWidth?: Num;
  /** 0..1 portion of the line drawn, for draw-on animation. */
  progress?: Num;
}

export interface PathEl extends ElementBase {
  type: 'path';
  /** SVG path data. */
  d: Str;
  fill?: Str; stroke?: Str; lineWidth?: Num;
  progress?: Num;
}

export interface LabelEl extends ElementBase {
  type: 'label';
  text: Str;
  x: Num; y: Num;
  color?: Str;
  /** Dark backing box so text reads over busy scenes (default on). */
  bg?: boolean;
  align?: 'left' | 'center' | 'right';
  size?: Num;
  weight?: number;
}

export interface CalloutEl extends ElementBase {
  type: 'callout';
  /** A label joined to the thing it names by a pointer line. */
  text: Str;
  /** The point being labeled. */
  x: Num; y: Num;
  /** Where the label sits. */
  lx: Num; ly: Num;
  color?: Str;
}

export interface NetworkEl extends ElementBase {
  type: 'network';
  /** A randomly branching network (roots, hyphae, neurons, rivers, cracks...). */
  seed: number;
  x: number; y: number;
  angles: number[];
  steps?: number;
  stepLength?: number;
  spread?: number;
  branchChance?: number;
  maxTips?: number;
  pull?: number;
  width?: number;
  bounds?: { circle?: [number, number, number]; rect?: [number, number, number, number] };
  color?: Str;
  /** 0..1 portion of the network grown. */
  progress?: Num;
  /** Extend the tip nearest `to` toward it, e.g. two networks meeting. */
  connect?: { to: [number, number]; progress: Num };
}

export interface ParticlesEl extends ElementBase {
  type: 'particles';
  /** Ballistic particles (spores, sparks, raindrops). Computed from t, no state. */
  seed: number;
  count: number;
  emit: [number, number];
  x: [number, number];
  y: [number, number];
  vx: [number, number];
  vy: [number, number];
  gravity?: number;
  floor?: number;
  r?: number;
  color?: Str;
}

export interface ScatterEl extends ElementBase {
  type: 'scatter';
  /** Random dots in a box; `fraction` of them shown (coverage, density). */
  seed: number;
  count: number;
  x: number; y: number; w: number; h: number;
  r?: [number, number];
  color?: Str;
  fraction?: Num;
}

export interface CycleEl extends ElementBase {
  type: 'cycle';
  /** A ring diagram of stages; nodes whose step is finished are filled. */
  x: number; y: number; rx: number; ry: number;
  nodes: { label: string; step?: string }[];
}

export type SceneElement =
  | GroupEl | RectEl | EllipseEl | LineEl | PathEl | LabelEl | CalloutEl
  | NetworkEl | ParticlesEl | ScatterEl | CycleEl;

export interface Scene {
  /** Nominal length in seconds that `t` runs over; playback stretches to fit narration. */
  duration: number;
  background?: string;
  elements: SceneElement[];
}

// ---------- steps ----------

export interface VideoStep {
  kind: 'video';
  id: string;
  title: string;
  tag: string;
  narration: string[];
  terms: Term[];
  scene: Scene;
}

export interface SliderControl {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  initial: number;
  unit?: string;
}

export interface Rule { when: string; text: string }

export interface SimulationStep {
  kind: 'simulation';
  id: string;
  title: string;
  tag: string;
  intro: string;
  caption?: string;
  controls: SliderControl[];
  /** Initial values of state variables. */
  state: Record<string, number>;
  /** Run in order every frame; `dt` (seconds) is in scope. */
  update: { var: string; expr: string }[];
  predict?: {
    question: string;
    options: { label: string; correct: boolean; feedback: string }[];
  };
  checks?: { label: string; detail?: string; pass: string; warn?: string }[];
  readouts?: { label: string; kind: 'bar' | 'text'; value?: string; rules?: Rule[] }[];
  verdict?: Rule[];
  presets?: { label: string; set?: Record<string, number>; reset?: boolean }[];
  goal: { when: string; note: string };
  scene: Omit<Scene, 'duration'>;
}

export interface MatchToken {
  id: string;
  label: string;
  /** Values the rules compare, e.g. { "A": 1, "B": 2 }. */
  attrs: Record<string, string | number>;
  /** One color, or two for a split token. */
  colors: string[];
  x: number;
  y: number;
}

export interface MatchStep {
  kind: 'match';
  id: string;
  title: string;
  tag: string;
  intro: string;
  caption?: string;
  question: string;
  legend?: string;
  tokens: MatchToken[];
  /** First matching rule wins. `a` and `b` are the two tokens (attrs plus label). */
  rules: { when: string; text: string; success?: boolean }[];
  /** Shown where a successful pair merged, e.g. "{a.label} + {b.label}". */
  resultLabel?: string;
  goal: { successes: number; note: string };
  scene?: Omit<Scene, 'duration'>;
}

export interface ProcessStep {
  kind: 'process';
  id: string;
  title: string;
  tag: string;
  intro: string;
  caption?: string;
  /** Instruction shown before the first action. */
  prompt: string;
  steps: {
    label: string;
    action:
      | { type: 'merge'; tokens: [MergeToken, MergeToken] }
      | { type: 'button'; label: string };
    /** Shown if this step's button is pressed too early; without it the button stays disabled. */
    early?: string;
    done: string;
  }[];
  /** Always drawn. */
  base: SceneElement[];
  /** stages[k] is drawn after k steps are complete, with `t` = seconds since that step finished. */
  stages: SceneElement[][];
  goal: { note: string };
}

export interface MergeToken { x: number; y: number; color: string; label: string }

export interface QuizStep {
  kind: 'quiz';
  id: string;
  title: string;
  tag: string;
  questions: { question: string; options: string[]; answer: number; explanation: string }[];
  scene?: Omit<Scene, 'duration'>;
}

/** A chapter that isn't loaded yet (still being written, or not fetched). */
export interface PendingStep {
  kind: 'pending';
  id: string;
  title: string;
  tag: string;
  plannedKind: string;
  /** Writing stopped with an error before this chapter. */
  stalled?: boolean;
}

export type Step = VideoStep | SimulationStep | MatchStep | ProcessStep | QuizStep | PendingStep;

export interface Lesson {
  title: string;
  eyebrow: string;
  summary: string;
  /** Named colors usable as "@name" anywhere a color is expected. */
  palette?: Record<string, string>;
  /** Helper functions usable in expressions. */
  functions?: Record<string, { args: string[]; expr: string }>;
  steps: Step[];
  sources: Source[];
  note?: string;
}
