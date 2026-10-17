# Lesson file format

A lesson is one JSON object that a web player turns into an interactive lesson: narrated animated "video" chapters drawn on a canvas, hands-on activities, and a closing quiz. You write only data. The player supplies all drawing and interaction code, so everything must be expressed with the elements and step kinds below.

## Top level

```
{
  "title": "Short, inviting lesson title",
  "eyebrow": "Interactive lesson · <Subject> · <Subtopic>",
  "summary": "One or two sentences on what the learner will see and do.",
  "palette": { "name": "#RRGGBB", ... },          // optional; colors usable as "@name"
  "functions": { "name": { "args": ["x"], "expr": "..." } },  // optional helpers for expressions
  "steps": [ ...video, simulation, match, process steps..., quiz ],
  "sources": [ { "title": "...", "url": "https://..." } ],
  "note": "optional caveat, e.g. that a simulation is a simplified model"
}
```

Default palette names always available: `ink` #E8F0E6, `muted` #9DB0A2, `accent` #E6A94B, `a` #E6A94B, `b` #5DB7BF, `c` #CBB8F0, `d` #D86A8A, `e` #8CC265, `soft` #F2EFE3. `accent` also fills finished nodes in a `cycle` diagram.

## The stage

- Every scene is drawn on an 800 × 450 stage. (0,0) is the top-left; y grows downward.
- Default background is very dark green-black (#0F1914). Scenes should stay dark with light, saturated foreground colors so labels (light text) read well.
- Keep important content inside x 20–780, y 20–430. Leave the top-left corner (about 0–220 × 0–40) free: a tag chip is drawn there.

## Expressions

Any numeric, color or text field can be an expression object instead of a literal: `{ "$": "lerp(0, 300, ease(sub(t, 1, 3)))" }`. Fields that are always expressions (`expr`, `when`, `pass`, `warn`, readout `value`, group `vars` values, function `expr`) are plain strings.

Syntax (a small safe language, not JavaScript): numbers, strings in single quotes, `true`/`false`, identifiers, `a.b` member access, `a[i]`, function calls, unary `-` `!`, `+ - * / %`, `^` for power, `< <= > >= == !=`, `&& ||`, and `cond ? a : b`. `+` joins strings. No assignment, no arrow functions, no `Math.` prefix, no template literals, no semicolons.

Built-ins: `PI`, `TAU`, `sin cos tan atan2 abs min max floor ceil round sqrt exp log pow hypot`, `clamp(x,a,b)`, `lerp(a,b,u)`, `sub(t,a,b)` (0 before a, 1 after b, linear between — use it for all timing), `ease(u)` (smooth 0→1), `fixed(x, digits)` (number to string).

In scope:
- Video scenes: `t` = seconds into the scene, running from 0 to the scene's `duration`.
- Simulations: each control value by its id, each state variable by name, `dt` inside `update`.
- Process stages: `t` = seconds since that stage began.
- Groups add `i` (repeat/items index), the item (as `item` or the group's `as` name), and their `vars`.
- Lesson `functions` everywhere.

Fade pattern: `"alpha": { "$": "sub(t, 2, 3) * (1 - sub(t, 6, 6.6))" }` fades in over 2–3 s and out over 6–6.6 s.

## Scene elements

All elements accept `alpha` (0–1). Colors are `#hex`, `rgba(...)`, or `@paletteName`.

| type | fields |
|---|---|
| `rect` | `x y w h`, `r` corner radius, `fill`, `stroke`, `lineWidth` |
| `ellipse` | `x y` center, `rx`, `ry` (defaults to rx: a circle), `rotate` (radians), optional `start`/`end` angles in radians (partial shapes are closed; `start: PI, end: TAU` gives the top half), `fill`, `stroke`, `lineWidth` |
| `line` | `x1 y1 x2 y2`, `stroke`, `lineWidth`, `progress` 0–1 (draw-on) |
| `path` | `d` SVG path data (M L C Q A Z, absolute or relative), `fill`, `stroke`, `lineWidth`, `progress` 0–1 |
| `label` | `text`, `x y`, `color`, `bg` (dark box behind the text, on by default; `false` to turn off), `align` left/center/right, `size` multiplier, `weight` |
| `callout` | a label with a pointer line to the thing it names: `text`, `x y` (the point on the object), `lx ly` (where the label sits, 40–120 px away in open space), `color`. Use this for naming objects. |
| `group` | `children`; transforms `x y` (translate), `rotate` (radians), `scale`, `origin: [ox, oy]` (children are drawn relative to this point after scaling); `repeat: n` (draws children n times with `i`), or `items: [ {...}, ... ]` with `as: "name"`; `vars: { "name": "expr" }` evaluated per instance before children; `clip: { x, y, w, h }` |
| `network` | a random branching network (roots, hyphae, neurons, rivers, lightning, cracks, blood vessels): `seed`, `x y` start, `angles` (radians, one per starting tip), `steps` (≤400), `stepLength`, `spread` (wiggle), `branchChance`, `maxTips`, `pull` (tendency back to the start angle), `width`, `bounds: { "circle": [cx, cy, r] }` or `{ "rect": [x0, y0, x1, y1] }`, `color`, `progress` 0–1 (how much has grown), `connect: { "to": [x, y], "progress": 0–1 }` (extend the nearest tip to a point) |
| `particles` | ballistic dots computed from `t` (spores, sparks, rain, bubbles, photons): `seed`, `count` (≤600), `emit: [t0, t1]` launch window, `x: [min, max]`, `y: [min, max]` start box, `vx`, `vy` velocity ranges (px/s), `gravity` (px/s², positive is down), `floor` (y where they stop and rest), `r`, `color`. Video scenes only (needs `t`). |
| `scatter` | random dots in a box, `fraction` 0–1 of them shown (coverage, concentration, density): `seed`, `count` (≤1500), `x y w h`, `r: [min, max]`, `color`, `fraction` |
| `cycle` | ring diagram of stages: `x y rx ry`, `nodes: [ { "label": "...", "step": "<step id>" } ]`; a node is filled once the learner finishes that step. Use it in the quiz scene for cyclical topics. |

### Clarity rules (scenes are judged on these)

A learner watching with the sound off must still understand each scene. So:

- **Name everything that matters.** Every object the narration mentions gets a `callout` (or a `label` placed right beside it) when it first appears, and keeps it while it is the focus. Unnamed blobs are the most common failure. Name parts, not just wholes (e.g. "chloroplast", "stomata", "CO₂ enters").
- **Label the change, not just the things.** When something moves, transforms or reacts, add a short label for what is happening ("water splits", "sugar is built", "spores launch") and an arrow (`path` with a small arrowhead, or a `line`) showing direction of movement or flow.
- **One idea at a time.** Each narration sentence has one visual beat. Bring its objects in, animate them, and fade out the previous beat's labels. Keep at most 3–4 labels visible at once.
- **Readable.** Labels in open space, never on top of each other or covering the object. Text 2–5 words. Keep labels inside x 40–760, y 40–420.
- **Recognizable.** Build objects from several shapes so they look like what they are, with consistent colors for the same thing across chapters (put them in the palette). Show scale or context where it helps (a "leaf" next to a zoomed "cell", a "×1000" tag when zooming in).
- **Smooth and slow enough to follow.** Use `ease(sub(t, a, b))` for motion, give each movement at least 1–2 seconds, and leave the final state on screen at the end of the scene.

Each video scene needs at least as many labels and callouts as it has narration sentences.

Elements draw in order; later elements are on top. Build recognizable objects from several shapes (a cell = ellipse + nucleus + organelles; a mushroom = stem rect + half-ellipse cap + gill lines). Prefer `group` with `repeat`/`items` over copying elements.

## Steps

Every step has `kind`, `id` (lowercase letters, digits, hyphens; unique), `title` (a few words), and `tag` (short chip text like "Photosynthesis" or "Try it · sliders").

### video

```
{ "kind": "video", "id": "...", "title": "...", "tag": "...",
  "narration": [ "sentence", ... ],        // 3–5 short sentences, one idea each, read aloud as captions
  "terms": [ { "term": "...", "definition": "..." } ],   // 2–3 key terms introduced here
  "scene": { "duration": 10, "background": "#hex", "elements": [ ... ] } }
```

Playback stretches the scene so its `duration` spans the narration (about 2.5–4 s per sentence), so time each visual beat to match its sentence in order: if there are 4 sentences and duration 12, beats land roughly at 0–3, 3–6, 6–9, 9–12. Every scene must actually move: things grow, travel, fade in, split, merge. Label each new thing as it appears and fade old labels out. Show the mechanism, not decoration.

### simulation — sliders

A small model the learner pokes at. Controls feed state variables updated every frame; the scene, readouts and checklist all read from them.

```
{ "kind": "simulation", "id", "title", "tag", "intro": "setup in 1–2 sentences", "caption": "Your turn: ...",
  "controls": [ { "id": "T", "label": "Temperature", "min": 0, "max": 45, "step": 1, "initial": 10, "unit": " °C" } ],
  "state": { "p": 0 },                                    // initial values
  "update": [ { "var": "p", "expr": "clamp(p + growth(T) * dt / 8, 0, 1)" } ],   // run in order each frame
  "predict": { "question": "...", "options": [ { "label", "correct": true/false, "feedback" } ] },   // optional, recommended
  "checks": [ { "label": "...", "detail": "why it matters", "pass": "expr", "warn": "optional expr" } ],   // optional checklist
  "readouts": [ { "label": "Growth rate", "kind": "bar", "value": "expr 0..1" },
                { "label": "Status", "kind": "text", "rules": [ { "when": "expr", "text": "..." }, { "when": "true", "text": "fallback" } ] },
                { "label": "Covered", "kind": "text", "value": "round(p * 100) + '%'" } ],
  "verdict": [ { "when": "expr", "text": "..." }, ... ],      // optional sentence; first true rule wins
  "presets": [ { "label": "Heat shock 42 °C", "set": { "T": 42 } }, { "label": "Reset", "reset": true } ],   // "Break it" buttons
  "goal": { "when": "p >= 1", "note": "What they achieved. Continue when ready." },
  "scene": { "background": "#hex", "elements": [ ...elements reading controls/state... ] } }
```

Rules: 1–3 controls. The goal must be reachable within about 10–25 seconds at good settings, and impossible or slow at bad ones, so the learner discovers the relationship. Base the model's shape on real ranges from the research (optimum values, thresholds) and say in `note` that it is simplified. Include presets that break it in instructive ways. Every rule list ends with a `"when": "true"` fallback.

### match — drag pairs

The learner drags one token onto another; rules over the pair decide what happens. Good for compatibility rules (mating types, blood types, enzyme–substrate, ion charges, base pairing).

```
{ "kind": "match", "id", "title", "tag", "intro", "caption",
  "question": "Rule to discover: ...",
  "legend": "optional key text drawn at the bottom of the stage",
  "tokens": [ { "id": "o-neg", "label": "O−", "attrs": { "A": 0, "B": 0, "Rh": 0 }, "colors": ["#hex"] or ["#left", "#right"], "x": 200, "y": 130 } ],
  "rules": [ { "when": "a.Rh <= b.Rh && a.A <= b.A && a.B <= b.B", "text": "{a.label} into {b.label}: compatible.", "success": true },
             { "when": "true", "text": "{a.label} into {b.label}: the antibodies attack. No." } ],
  "resultLabel": "{a.label} + {b.label}",
  "goal": { "successes": 1, "note": "..." },
  "scene": { "elements": [ ...background only... ] } }
```

`a` is the dragged token and `b` the target; each exposes its `attrs` plus `label` and `id`. `{expr}` in `text`/`resultLabel` is filled in. 3–6 tokens, radius 50 each, placed at least 140 px apart within x 80–720, y 80–330. Successful pairs merge and disappear, so make sure at least `goal.successes` disjoint successful pairs exist. Unsuccessful text should explain why.

### process — ordered actions

A fixed sequence the learner performs: drag two things together, then press buttons in order. The scene advances one stage per completed action.

```
{ "kind": "process", "id", "title", "tag", "intro", "caption",
  "prompt": "Instruction before the first action.",
  "steps": [
    { "label": "Fuse", "action": { "type": "merge", "tokens": [ { "x": 366, "y": 300, "color": "@a", "label": "+" }, { "x": 434, "y": 300, "color": "@b", "label": "−" } ] }, "done": "What just happened." },
    { "label": "Divide", "action": { "type": "button", "label": "Run meiosis" }, "early": "Message if pressed too early (optional; without it the button waits disabled).", "done": "..." }
  ],
  "base": [ ...always drawn... ],
  "stages": [ [ ...after 0 actions... ], [ ...after 1... ], ... ],   // exactly steps.length + 1 lists
  "goal": { "note": "..." } }
```

Only the first step may be a `merge` (two draggable circles, radius 30, labels of 1–3 characters). Stage lists animate with `t` (seconds since that stage started): use it to show the result of each action happening.

### quiz — always last

```
{ "kind": "quiz", "id": "quiz", "title": "Check understanding", "tag": "Quiz · 4 questions",
  "questions": [ { "question": "...", "options": ["...", "...", "..."], "answer": 1, "explanation": "..." } ],
  "scene": { "elements": [ ...e.g. a cycle diagram or summary visual... ] } }
```

3–6 questions testing understanding, not recall of wording. Include at least one question that applies an activity's lesson. `answer` is the 0-based index of the correct option. Vary the position of correct answers.

## Lesson shape

- About 8–11 steps: 4–5 video chapters telling the story in order, interleaved with 2–4 activities placed right after the chapter they let the learner test, then the quiz.
- Use the activity kind that fits the idea: simulation for cause-and-effect with continuous variables, match for compatibility rules, process for ordered events. Don't force a kind that doesn't fit; two simulations is fine.
- Plain, concrete language for a curious 14–18 year old. Narration sentences under about 20 words. Terms defined in one sentence.
- Facts, numbers and ranges must come from the research notes. `sources` lists 3–6 of the research URLs that support the lesson.
