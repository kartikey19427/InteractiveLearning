// A small, safe expression language for lesson files.
// Generated lessons describe animation and simulation logic as expressions
// like "lerp(0, 300, ease(sub(t, 1, 3)))" instead of code, so nothing a model
// writes is ever executed with eval. Supports numbers, strings, identifiers,
// member access (a.b), calls to whitelisted functions, unary - and !,
// arithmetic (+ - * / % ^), comparisons, && || and the ternary operator.

export type Env = Record<string, unknown>;
type Node = (env: Env) => unknown;

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

export const BUILTINS: Env = {
  PI: Math.PI,
  TAU: Math.PI * 2,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  atan2: Math.atan2,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sqrt: Math.sqrt,
  exp: Math.exp,
  log: Math.log,
  pow: Math.pow,
  hypot: Math.hypot,
  clamp,
  lerp: (a: number, b: number, t: number) => a + (b - a) * t,
  // 0 before a, 1 after b, linear in between: the workhorse for timing.
  sub: (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1),
  ease: (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  fixed: (x: number, d: number) => Number(x).toFixed(d),
};

type Tok = { k: 'num' | 'str' | 'id' | 'op'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d*\.?\d+(?:e[+-]?\d+)?)/i.exec(src.slice(i));
      if (!m) throw new Error(`Bad number at ${i}`);
      out.push({ k: 'num', v: m[1] });
      i += m[1].length;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; continue; }
        s += src[j++];
      }
      if (j >= src.length) throw new Error('Unterminated string');
      out.push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))!;
      out.push({ k: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 3) === '===' || src.slice(i, i + 3) === '!==' ? src.slice(i, i + 3) : src.slice(i, i + 2);
    if (['===', '!==', '==', '!=', '<=', '>=', '&&', '||', '**'].includes(two)) {
      out.push({ k: 'op', v: two === '===' ? '==' : two === '!==' ? '!=' : two === '**' ? '^' : two });
      i += two.length;
      continue;
    }
    if ('+-*/%^!<>?:(),.[]'.includes(c)) { out.push({ k: 'op', v: c }); i++; continue; }
    throw new Error(`Unexpected '${c}' at ${i}`);
  }
  return out;
}

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

function lookup(env: Env, name: string): unknown {
  if (FORBIDDEN.has(name)) throw new Error(`'${name}' is not allowed`);
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  if (Object.prototype.hasOwnProperty.call(BUILTINS, name)) return BUILTINS[name];
  return undefined;
}

function member(obj: unknown, key: unknown): unknown {
  if (obj == null) return undefined;
  const k = String(key);
  if (FORBIDDEN.has(k)) throw new Error(`'${k}' is not allowed`);
  if (Array.isArray(obj)) return k === 'length' ? obj.length : obj[Number(k)];
  if (typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, k)) return (obj as Env)[k];
  return undefined;
}

function parse(toks: Tok[]): Node {
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => toks[p]?.k === 'op' && toks[p].v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected '${v}'`);
    p++;
  };

  const ternary = (): Node => {
    const cond = or();
    if (isOp('?')) {
      p++;
      const a = ternary();
      expect(':');
      const b = ternary();
      return (e) => (cond(e) ? a(e) : b(e));
    }
    return cond;
  };
  const or = (): Node => {
    let l = and();
    while (isOp('||')) { p++; const a = l, b = and(); l = (e) => a(e) || b(e); }
    return l;
  };
  const and = (): Node => {
    let l = eq();
    while (isOp('&&')) { p++; const a = l, b = eq(); l = (e) => a(e) && b(e); }
    return l;
  };
  const eq = (): Node => {
    let l = rel();
    while (isOp('==') || isOp('!=')) {
      const op = toks[p++].v, a = l, b = rel();
      // Loose on purpose so 1 == '1' behaves like a learner would expect.
      l = op === '==' ? (e) => a(e) == b(e) : (e) => a(e) != b(e);
    }
    return l;
  };
  const rel = (): Node => {
    let l = add();
    while (isOp('<') || isOp('>') || isOp('<=') || isOp('>=')) {
      const op = toks[p++].v, a = l, b = add();
      l = (e) => {
        const x = a(e) as number, y = b(e) as number;
        return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
      };
    }
    return l;
  };
  const add = (): Node => {
    let l = mul();
    while (isOp('+') || isOp('-')) {
      const op = toks[p++].v, a = l, b = mul();
      l = op === '+'
        ? (e) => {
            const x = a(e), y = b(e);
            return typeof x === 'string' || typeof y === 'string' ? `${x}${y}` : (x as number) + (y as number);
          }
        : (e) => (a(e) as number) - (b(e) as number);
    }
    return l;
  };
  const mul = (): Node => {
    let l = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = toks[p++].v, a = l, b = unary();
      l = (e) => {
        const x = a(e) as number, y = b(e) as number;
        return op === '*' ? x * y : op === '/' ? x / y : x % y;
      };
    }
    return l;
  };
  const unary = (): Node => {
    if (isOp('-')) { p++; const a = unary(); return (e) => -(a(e) as number); }
    if (isOp('+')) { p++; const a = unary(); return (e) => +(a(e) as number); }
    if (isOp('!')) { p++; const a = unary(); return (e) => !a(e); }
    return power();
  };
  const power = (): Node => {
    const base = postfix();
    if (isOp('^')) {
      p++;
      const ex = unary(); // right associative
      return (e) => Math.pow(base(e) as number, ex(e) as number);
    }
    return base;
  };
  const postfix = (): Node => {
    let n = primary();
    for (;;) {
      if (isOp('.')) {
        p++;
        const t = peek();
        if (t?.k !== 'id') throw new Error('Expected a name after "."');
        p++;
        const o = n, key = t.v;
        n = (e) => member(o(e), key);
      } else if (isOp('[')) {
        p++;
        const o = n, k = ternary();
        expect(']');
        n = (e) => member(o(e), k(e));
      } else if (isOp('(')) {
        p++;
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(ternary());
          while (isOp(',')) { p++; args.push(ternary()); }
        }
        expect(')');
        const f = n;
        n = (e) => {
          const fn = f(e);
          if (typeof fn !== 'function') throw new Error('Not a function');
          return (fn as (...a: unknown[]) => unknown)(...args.map((a) => a(e)));
        };
      } else return n;
    }
  };
  const primary = (): Node => {
    const t = toks[p++];
    if (!t) throw new Error('Unexpected end of expression');
    if (t.k === 'num') { const v = parseFloat(t.v); return () => v; }
    if (t.k === 'str') { const v = t.v; return () => v; }
    if (t.k === 'id') {
      if (t.v === 'true') return () => true;
      if (t.v === 'false') return () => false;
      if (t.v === 'null') return () => null;
      const name = t.v;
      return (e) => lookup(e, name);
    }
    if (t.v === '(') { const n = ternary(); expect(')'); return n; }
    throw new Error(`Unexpected '${t.v}'`);
  };

  const root = ternary();
  if (p < toks.length) throw new Error(`Unexpected '${toks[p].v}'`);
  return root;
}

const cache = new Map<string, Node>();
const warned = new Set<string>();

export function compile(src: string): Node {
  let fn = cache.get(src);
  if (!fn) {
    try {
      fn = parse(tokenize(src));
    } catch (err) {
      if (!warned.has(src)) { warned.add(src); console.warn(`Bad expression "${src}":`, err); }
      fn = () => undefined;
    }
    cache.set(src, fn);
  }
  return fn;
}

export function evaluate(src: string, env: Env): unknown {
  try {
    return compile(src)(env);
  } catch (err) {
    if (!warned.has(src)) { warned.add(src); console.warn(`Expression "${src}" failed:`, err); }
    return undefined;
  }
}

// Fill "{expr}" placeholders in a text template.
export function interpolate(template: string, env: Env): string {
  return template.replace(/\{([^{}]+)\}/g, (_, ex: string) => {
    const v = evaluate(ex, env);
    return v == null ? '' : String(v);
  });
}

// Lesson-level helper functions, e.g. { growth: { args: ["T"], expr: "..." } }.
export function defineFunctions(defs: Record<string, { args: string[]; expr: string }> | undefined): Env {
  const out: Env = {};
  for (const [name, def] of Object.entries(defs ?? {})) {
    out[name] = (...vals: unknown[]) => {
      const local: Env = { ...out };
      def.args.forEach((a, i) => { local[a] = vals[i]; });
      return evaluate(def.expr, local);
    };
  }
  return out;
}
