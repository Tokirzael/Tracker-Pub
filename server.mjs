// deploy/server-entry.ts
import http from "node:http";
import fs3 from "node:fs";
import path3 from "node:path";
import { spawn } from "node:child_process";

// vite-shared-db.ts
import fs from "node:fs";
import path from "node:path";

// src/core/pipeline.ts
function round2(n) {
  return Math.round(n * 100) / 100;
}
var ALL_OPS = ["add", "multiply", "override", "rename", "setIcon", "setVisible", "setAccent", "setFormat", "setMin", "setMax"];
function num(v) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
}
function nodeById(nodes, id) {
  return nodes.find((n) => n.id === id);
}
function poolPct(node, modifiers, nodes) {
  const resolved = evaluateNode(node, modifiers, nodes);
  const stored = typeof node.max === "number" && node.max > 0 ? node.max : null;
  const eff = typeof resolved.max === "number" && resolved.max > 0 ? resolved.max : null;
  const top = stored ?? eff ?? 100;
  return Math.max(0, Math.min(100, resolved.value / top * 100));
}
function effectiveBounds(node, modifiers = [], nodes = [node]) {
  const r = evaluateNode(node, modifiers, nodes);
  return { min: r.min, max: r.max };
}
var GATE_LOW_DEFAULT_AT = 33.33;
var GATE_HIGH_DEFAULT_AT = 66.67;
function activeBandKind(bands, fillPct) {
  if (!bands || !bands.length) return null;
  const low = bands.find((b) => b.kind === "low");
  const high = bands.find((b) => b.kind === "high");
  const lowTop = low?.at ?? GATE_LOW_DEFAULT_AT;
  const highFloor = high?.at ?? GATE_HIGH_DEFAULT_AT;
  if (fillPct <= lowTop) return "low";
  if (fillPct >= highFloor) return "high";
  if (bands.some((b) => b.kind === "mid")) return "mid";
  return null;
}
function gateMode(mod) {
  return mod.gate?.mode === "value" ? "value" : "pool";
}
function gateCompare(mod) {
  return mod.gate?.compare === "lte" ? "lte" : "gte";
}
function satisfiesGate(mod, nodes, modifiers) {
  const gate = mod.gate;
  if (!gate) return true;
  if (gate.bands && gate.bands.length) return true;
  const node = nodeById(nodes, gate.poolId);
  if (!node || node.type === "text" || typeof node.baseValue !== "number") return true;
  if (gateMode(mod) === "value") {
    const level = gateValue(mod, nodes, modifiers);
    if (level === null) return true;
    const at = gate.at ?? 0;
    return gateCompare(mod) === "lte" ? level <= at : level >= at;
  }
  const others = modifiers.filter((m) => m.id !== mod.id);
  return poolPct(node, others, nodes) >= (gate.at ?? 0);
}
function gateLevel(mod, nodes, modifiers) {
  const gate = mod.gate;
  if (!gate) return null;
  const node = nodeById(nodes, gate.poolId);
  if (!node || node.type === "text" || typeof node.baseValue !== "number") return null;
  if (gateMode(mod) === "value") return gateValue(mod, nodes, modifiers);
  const others = modifiers.filter((m) => m.id !== mod.id);
  return poolPct(node, others, nodes);
}
function gateValue(mod, nodes, modifiers) {
  const gate = mod.gate;
  if (!gate) return null;
  const node = nodeById(nodes, gate.poolId);
  if (!node || node.type === "text" || typeof node.baseValue !== "number") return null;
  const others = modifiers.filter((m) => m.id !== mod.id);
  return evaluateNode(node, others, nodes).value;
}
function activeGateBand(mod, nodes, modifiers) {
  const gate = mod.gate;
  const bands = gate?.bands;
  if (!bands || !bands.length) return null;
  const level = gateLevel(mod, nodes, modifiers);
  if (level === null) return null;
  const kind = gateMode(mod) === "value" ? activeValueBandKind(bands, level) : activeBandKind(bands, level);
  return kind ? bands.find((b) => b.kind === kind) ?? null : null;
}
function activeValueBandKind(bands, value) {
  const low = bands.find((b) => b.kind === "low");
  const high = bands.find((b) => b.kind === "high");
  if (low?.at !== void 0 && value <= low.at) return "low";
  if (high?.at !== void 0 && value >= high.at) return "high";
  if (bands.some((b) => b.kind === "mid")) return "mid";
  return null;
}
function activeMutations(mod, nodes, modifiers) {
  const bands = mod.gate?.bands;
  if (!bands || !bands.length) return mod.mutations;
  const band = activeGateBand(mod, nodes, modifiers);
  if (!band || !band.mutations.length) return mod.mutations;
  return [...mod.mutations, ...band.mutations];
}
var evalScope = null;
var EVAL_MEMO_CAP = 1e5;
function evalKey(nodeId, modifiers) {
  return nodeId + "\0" + modifiers.map((m) => m.id).join("\0");
}
function isActive(mod, nodes, modifiers) {
  if (!mod.active) return false;
  if (mod.gate && !satisfiesGate(mod, nodes, modifiers)) return false;
  return true;
}
function evaluateNode(node, modifiers, nodes = [node]) {
  const topLevel = evalScope === null;
  if (topLevel) evalScope = /* @__PURE__ */ new Map();
  try {
    const cache = evalScope;
    const key = evalKey(node.id, modifiers);
    const hit = cache.get(key);
    if (hit) return hit;
    const active = modifiers.filter((m) => isActive(m, nodes, modifiers));
    const contributions = [];
    let value = num(node.baseValue);
    const baseValue = value;
    let label = node.display.label ?? node.name;
    let icon = node.display.icon;
    let visible = node.display.visible ?? true;
    let accent = node.display.accent;
    let format = node.display.format ?? (node.type === "resource" ? "bar" : node.category === "attributes" ? "score" : "plain");
    let min = node.min;
    let max = node.max;
    const push = (mod, kind, detail) => {
      contributions.push({ modifierId: mod.id, modifierName: mod.name, kind, detail });
    };
    const ordered = (op) => {
      const out = [];
      for (const mod of active) {
        for (const m of activeMutations(mod, nodes, modifiers)) {
          if (m.targetStatId === node.id && m.operator === op) out.push({ mod, m });
        }
      }
      return out;
    };
    const lastOf = (op) => {
      const all = ordered(op);
      return all.length ? all[all.length - 1] : null;
    };
    for (const { mod, m } of ordered("add")) {
      const d = num(m.value);
      value = round2(value + d);
      push(mod, "value", `${d >= 0 ? "+" : ""}${round2(d)}`);
    }
    for (const { mod, m } of ordered("multiply")) {
      const f = num(m.value);
      value = round2(value * f);
      push(mod, "value", `\xD7${round2(f)}`);
    }
    for (const { mod, m } of ordered("override")) {
      value = num(m.value);
      push(mod, "value", `set ${round2(value)}`);
    }
    const minOp = lastOf("setMin");
    if (minOp) {
      min = num(minOp.m.value);
      push(minOp.mod, "bounds", `min ${round2(min)}`);
    }
    const maxOp = lastOf("setMax");
    if (maxOp) {
      max = num(maxOp.m.value);
      push(maxOp.mod, "bounds", `max ${round2(max)}`);
    }
    const ren = lastOf("rename");
    if (ren) {
      label = String(ren.m.value);
      push(ren.mod, "display", `\u2192 ${label}`);
    }
    const ic = lastOf("setIcon");
    if (ic) {
      icon = String(ic.m.value);
      push(ic.mod, "display", `icon ${icon}`);
    }
    const vis = lastOf("setVisible");
    if (vis) {
      visible = Boolean(vis.m.value);
      push(vis.mod, "display", visible ? "shown" : "hidden");
    }
    const ac = lastOf("setAccent");
    if (ac) {
      accent = String(ac.m.value);
      push(ac.mod, "display", `accent ${accent}`);
    }
    const fo = lastOf("setFormat");
    if (fo) {
      format = String(fo.m.value);
      push(fo.mod, "display", `format ${format}`);
    }
    let clamped = false;
    if (typeof min === "number" && value < min) {
      value = min;
      clamped = true;
    }
    if (typeof max === "number" && value > max) {
      value = max;
      clamped = true;
    }
    value = round2(value);
    const valueModified = contributions.some((c) => c.kind === "value");
    const displayModified = contributions.some((c) => c.kind === "display");
    const boundsModified = contributions.some((c) => c.kind === "bounds");
    const resolved = {
      id: node.id,
      label,
      icon,
      visible,
      accent,
      format,
      value,
      baseValue,
      min,
      max,
      clamped,
      contributions,
      valueModified,
      displayModified,
      modified: valueModified || displayModified || boundsModified
    };
    if (cache.size < EVAL_MEMO_CAP) cache.set(key, resolved);
    return resolved;
  } finally {
    if (topLevel) evalScope = null;
  }
}

// src/core/uid.ts
var counter = 0;
function uid(prefix = "id") {
  counter = (counter + 1) % 65536;
  const rand = Math.floor(Math.random() * 65536).toString(36).padStart(3, "0");
  const seq = counter.toString(36).padStart(2, "0");
  return `${prefix}_${Date.now().toString(36)}${rand}${seq}`;
}

// src/core/ramp.ts
function rampRefName(c, ref) {
  if (ref.kind === "node") return c.nodes.find((n) => n.id === ref.id)?.name ?? ref.id;
  if (ref.kind === "toggle") return c.modifiers.find((m) => m.id === ref.id)?.name ?? ref.id;
  const list = c.lists.find((l) => l.id === ref.listId);
  const item = list?.items.find((i) => i.id === ref.itemId);
  return item && list ? `${item.name} (${list.name})` : ref.itemId ?? ref.id;
}
function validateRampRef(ctx, ref) {
  if (typeof ref !== "object" || ref === null) return "ref must be an object {kind, id, listId?, itemId?}";
  const o = ref;
  const id = typeof o.id === "string" ? o.id : "";
  if (o.kind === "node") {
    if (!id) return "node ref needs an id (a stat/pool id from the sheet)";
    if (!ctx.nodes.some((n) => n.id === id)) return `no node with id "${id}" on this sheet`;
    return null;
  }
  if (o.kind === "item") {
    const listId = typeof o.listId === "string" ? o.listId : "";
    const itemId = typeof o.itemId === "string" ? o.itemId : "";
    if (!listId || !itemId) return "item ref needs listId + itemId";
    const list = ctx.lists.find((l) => l.id === listId);
    if (!list) return `no list with id "${listId}"`;
    if (!list.items.some((i) => i.id === itemId)) return `no item "${itemId}" in ${list.name}`;
    return null;
  }
  if (o.kind === "toggle") {
    if (!id) return "toggle ref needs an id (an effect id from the sheet)";
    if (!ctx.modifiers?.some((m) => m.id === id)) return `no effect with id "${id}"`;
    return null;
  }
  return `ref kind must be 'node', 'item', or 'toggle' (got ${JSON.stringify(o.kind)})`;
}
function normalizeRampRef(ctx, v) {
  if (typeof v !== "object" || v === null) return null;
  const o = v;
  const id = typeof o.id === "string" ? o.id : "";
  const listId = typeof o.listId === "string" ? o.listId : void 0;
  const itemId = typeof o.itemId === "string" ? o.itemId : void 0;
  if (o.kind === "node") {
    if (!id || !ctx.nodes.some((n) => n.id === id)) return null;
    return { kind: "node", id };
  }
  if (o.kind === "item") {
    if (!listId || !itemId) return null;
    if (!ctx.lists.find((l) => l.id === listId)?.items.find((i) => i.id === itemId)) return null;
    return { kind: "item", id: itemId, listId, itemId };
  }
  if (o.kind === "toggle") {
    if (!id || !ctx.modifiers?.some((m) => m.id === id)) return null;
    return { kind: "toggle", id };
  }
  return null;
}
function normalizeRampLink(ctx, v) {
  if (typeof v !== "object" || v === null) return null;
  const o = v;
  const watch = normalizeRampRef(ctx, o.watch);
  const target = normalizeRampRef(ctx, o.target);
  if (!watch || !target || target.kind === "toggle") return null;
  const step = Number(o.step);
  if (!Number.isFinite(step)) return null;
  let watchFrom;
  if (typeof o.watchFrom === "boolean") watchFrom = o.watchFrom;
  else if (typeof o.watchFrom === "number" && Number.isFinite(o.watchFrom)) watchFrom = round2(o.watchFrom);
  return {
    id: typeof o.id === "string" && o.id ? o.id : uid("ramp"),
    name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 80) : "Ramp",
    watch,
    target,
    direction: o.direction === "down" ? "down" : "up",
    step: round2(step),
    ...watchFrom !== void 0 ? { watchFrom } : {},
    active: typeof o.active === "boolean" ? o.active : true
  };
}
function normalizeRampCounter(ctx, v) {
  if (typeof v !== "object" || v === null) return null;
  const o = v;
  const target = normalizeRampRef(ctx, o.target);
  if (!target || target.kind === "toggle") return null;
  const delta = Number(o.delta);
  if (!Number.isFinite(delta)) return null;
  const out = { target, delta: round2(delta) };
  if (typeof o.offOn === "boolean") out.offOn = o.offOn;
  if (typeof o.onOff === "boolean") out.onOff = o.onOff;
  return out;
}

// src/core/theme.ts
var THEME_ROLES = ["background", "surface", "border", "text", "accent"];

// src/core/types.ts
var FX_RATE_MIN = 0.5;
var FX_RATE_MAX = 1.5;
var SHEET_SEGMENT_IDS = ["header", "stats", "pools", "conditions", "lists", "ramps"];

// src/core/io.ts
function str(v, fallback = "") {
  return typeof v === "string" ? v : fallback;
}
function num2(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function optNum(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : void 0;
}
var CATEGORIES = ["attributes", "pools", "misc", "custom"];
function asCategory(v) {
  return CATEGORIES.includes(v) ? v : "custom";
}
function normalizeDecay(v, fallbackTarget) {
  if (typeof v !== "object" || v === null) return void 0;
  const o = v;
  const target = str(o.statTarget, fallbackTarget);
  return {
    statTarget: target,
    decayRatePerMinute: Math.abs(num2(o.decayRatePerMinute)),
    kind: o.kind === "regen" ? "regen" : "decay"
  };
}
var FX_EFFECTS = ["dribble", "text", "hearts", "orbs", "spiral"];
function parseWords(v) {
  if (typeof v !== "string") return void 0;
  const words = v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return words.length > 0 ? words.slice(0, 24) : void 0;
}
function normalizeFxSide(v, defaultAt) {
  if (typeof v !== "object" || v === null) return void 0;
  const o = v;
  const effect = FX_EFFECTS.includes(o.effect) ? o.effect : void 0;
  if (!effect) return void 0;
  const at = Number(o.at);
  const words = effect === "text" ? parseWords(typeof o.words === "string" ? o.words : Array.isArray(o.words) ? o.words.join(", ") : void 0) : void 0;
  let rate;
  if (typeof o.rate === "number" && Number.isFinite(o.rate)) {
    const clamped = Math.max(FX_RATE_MIN, Math.min(FX_RATE_MAX, o.rate));
    if (clamped !== 1) rate = Math.round(clamped * 100) / 100;
  }
  return {
    effect,
    at: Number.isFinite(at) ? Math.max(0, Math.min(100, at)) : defaultAt,
    ...words ? { words } : {},
    ...rate !== void 0 ? { rate } : {}
  };
}
function normalizeFx(v) {
  if (typeof v !== "object" || v === null) return void 0;
  const o = v;
  const high = normalizeFxSide(o.high, 90);
  const low = normalizeFxSide(o.low, 15);
  return high || low ? { high, low } : void 0;
}
var HEX_COLOR = /^(?:#[0-9a-f]{6}|[0-9a-f]{6})$/i;
var LOCK_HASH = /^[0-9a-f]{64}$/i;
var LOCK_SALT = /^[0-9a-f]{16}$/i;
function normalizeSegments(v) {
  if (typeof v !== "object" || v === null) return void 0;
  const out = {};
  for (const seg of SHEET_SEGMENT_IDS) {
    const raw = v[seg];
    if (raw === null) {
      out[seg] = null;
      continue;
    }
    if (typeof raw === "object" && raw !== null) {
      const o = raw;
      const hash = typeof o.hash === "string" ? o.hash : void 0;
      const salt = typeof o.salt === "string" ? o.salt : void 0;
      if (hash && salt && LOCK_HASH.test(hash) && LOCK_SALT.test(salt)) {
        out[seg] = { hash: hash.toLowerCase(), salt: salt.toLowerCase() };
        continue;
      }
    }
  }
  return Object.keys(out).length ? out : void 0;
}
function normalizeLock(v) {
  if (typeof v !== "object" || v === null) return void 0;
  const o = v;
  const hash = typeof o.hash === "string" ? o.hash : void 0;
  const salt = typeof o.salt === "string" ? o.salt : void 0;
  if (!hash || !salt || !LOCK_HASH.test(hash) || !LOCK_SALT.test(salt)) return void 0;
  const segments = normalizeSegments(o.segments);
  return segments ? { hash: hash.toLowerCase(), salt: salt.toLowerCase(), segments } : { hash: hash.toLowerCase(), salt: salt.toLowerCase() };
}
function def(out, key, value) {
  if (value !== void 0) out[key] = value;
}
function plainFxSpec(fx) {
  return {
    high: fx.high ? { ...fx.high, words: fx.high.words ? [...fx.high.words] : void 0 } : void 0,
    low: fx.low ? { ...fx.low, words: fx.low.words ? [...fx.low.words] : void 0 } : void 0
  };
}
function plainLock(lock) {
  if (!lock) return void 0;
  return lock.segments ? {
    salt: lock.salt,
    hash: lock.hash,
    segments: Object.fromEntries(
      Object.entries(lock.segments).map(([k, v]) => [k, v ? { salt: v.salt, hash: v.hash } : null])
    )
  } : { salt: lock.salt, hash: lock.hash };
}
function cloneCharacter(c) {
  const out = {
    id: c.id,
    name: c.name,
    tags: [...c.tags],
    cardOrder: [...c.cardOrder],
    nodes: c.nodes.map((n) => {
      const o = { ...n, display: { ...n.display } };
      if (n.decay) o.decay = { ...n.decay };
      o.fx = n.fx ? plainFxSpec(n.fx) : void 0;
      o.bgFx = n.bgFx ? plainFxSpec(n.bgFx) : void 0;
      if (n.colors) o.colors = { ...n.colors };
      if (n.pictures) {
        o.pictures = {
          low: n.pictures.low ? { ...n.pictures.low } : void 0,
          mid: n.pictures.mid ? { ...n.pictures.mid } : void 0,
          high: n.pictures.high ? { ...n.pictures.high } : void 0
        };
      }
      for (const k of Object.keys(o)) if (o[k] === void 0) delete o[k];
      return o;
    }),
    modifiers: c.modifiers.map((m) => {
      const o = {
        ...m,
        mutations: m.mutations.map((mu) => ({ ...mu })),
        theme: m.theme ? { ...m.theme } : void 0,
        picture: m.picture ? { ...m.picture } : void 0,
        gate: m.gate ? { ...m.gate, bands: m.gate.bands?.map((b) => ({ ...b, mutations: b.mutations.map((mu) => ({ ...mu })) })) } : void 0
      };
      if (m.decay) o.decay = { ...m.decay };
      if (m.counter) o.counter = { ...m.counter, target: { ...m.counter.target } };
      for (const k of Object.keys(o)) if (o[k] === void 0) delete o[k];
      return o;
    }),
    lists: c.lists.map((l) => ({ ...l, items: l.items.map((i) => ({ ...i })) })),
    // deep-copy ramps (refs are nested objects — a shallow spread would share them)
    ...c.ramps ? { ramps: c.ramps.map((r) => ({ ...r, watch: { ...r.watch }, target: { ...r.target } })) } : {}
  };
  def(out, "race", c.race);
  def(out, "class", c.class);
  def(out, "level", c.level);
  def(out, "portrait", c.portrait);
  def(out, "lock", plainLock(c.lock));
  def(out, "theme", c.theme ? { ...c.theme } : void 0);
  def(out, "background", c.background ? { ...c.background } : void 0);
  def(out, "images", c.images ? {
    portraits: c.images.portraits.map((i) => ({ ...i })),
    backgrounds: c.images.backgrounds.map((i) => ({ ...i })),
    activePortraitId: c.images.activePortraitId,
    activeBackgroundId: c.images.activeBackgroundId
  } : void 0);
  def(out, "backdropFx", c.backdropFx ? { ...c.backdropFx } : void 0);
  def(out, "focal", c.focal ? { ...c.focal } : void 0);
  def(out, "lastEditAt", c.lastEditAt);
  out.createdAt = c.createdAt;
  out.updatedAt = c.updatedAt;
  return out;
}
function parseColor(v) {
  if (typeof v !== "string") return void 0;
  const s = v.trim().replace(/^#/, "");
  return HEX_COLOR.test(s) ? `#${s.toLowerCase()}` : void 0;
}
function normalizeColors(v) {
  if (typeof v !== "object" || v === null) return void 0;
  const o = v;
  const full = parseColor(o.full);
  const empty = parseColor(o.empty);
  return full || empty ? { full, empty } : void 0;
}
function normalizeThemeRoles(v) {
  if (typeof v !== "object" || v === null) return void 0;
  const o = v;
  const out = {};
  for (const role of THEME_ROLES) {
    const c = parseColor(o[role]);
    if (!c) return void 0;
    out[role] = c;
  }
  return out;
}
function normalizeBackdrop(v) {
  if (typeof v !== "object" || v === null) return void 0;
  const o = v;
  if (typeof o.image !== "string" || !o.image.startsWith("data:image/")) return void 0;
  const dim = Number(o.dim);
  const blur = Number(o.blur);
  return {
    image: o.image,
    dim: Number.isFinite(dim) ? Math.round(Math.min(100, Math.max(0, dim))) : 38,
    blur: Number.isFinite(blur) ? Math.round(Math.min(40, Math.max(0, blur))) : 3
  };
}
var DATA_URL = /^data:image\/\w+/;
function normalizeSheetImage(v) {
  if (typeof v !== "object" || v === null) return null;
  const o = v;
  if (typeof o.image !== "string" || !DATA_URL.test(o.image)) return null;
  const id = typeof o.id === "string" && o.id ? o.id : uid("img");
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 60) : "Image";
  return { id, name, image: o.image };
}
function normalizeImageList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const e of v) {
    const img = normalizeSheetImage(e);
    if (!img || seen.has(img.id)) continue;
    seen.add(img.id);
    out.push(img);
  }
  return out;
}
function normalizeSheetImages(v) {
  if (typeof v !== "object" || v === null) return void 0;
  const o = v;
  const portraits = normalizeImageList(o.portraits);
  const backgrounds = normalizeImageList(o.backgrounds);
  if (!portraits.length && !backgrounds.length) return void 0;
  const activePortraitId = typeof o.activePortraitId === "string" && portraits.some((i) => i.id === o.activePortraitId) ? o.activePortraitId : portraits[0]?.id ?? void 0;
  const activeBackgroundId = typeof o.activeBackgroundId === "string" && backgrounds.some((i) => i.id === o.activeBackgroundId) ? o.activeBackgroundId : backgrounds[0]?.id ?? void 0;
  return { portraits, backgrounds, activePortraitId, activeBackgroundId };
}
function normalizeBackdropFx(v) {
  if (typeof v !== "object" || v === null) return void 0;
  const o = v;
  const dim = Number(o.dim);
  const blur = Number(o.blur);
  if (!Number.isFinite(dim) && !Number.isFinite(blur)) return void 0;
  return {
    dim: Number.isFinite(dim) ? Math.round(Math.min(100, Math.max(0, dim))) : 38,
    blur: Number.isFinite(blur) ? Math.round(Math.min(40, Math.max(0, blur))) : 3
  };
}
function normalizePictureOverride(v) {
  if (typeof v !== "object" || v === null) return void 0;
  const o = v;
  const portraitId = typeof o.portraitId === "string" && o.portraitId ? o.portraitId : void 0;
  const backgroundId = typeof o.backgroundId === "string" && o.backgroundId ? o.backgroundId : void 0;
  if (!portraitId && !backgroundId) return void 0;
  return { portraitId, backgroundId };
}
function normalizePoolPictures(v) {
  if (typeof v !== "object" || v === null) return void 0;
  const o = v;
  const out = {};
  for (const kind of ["low", "mid", "high"]) {
    const ov = normalizePictureOverride(o[kind]);
    if (ov) out[kind] = ov;
  }
  return out.low || out.mid || out.high ? out : void 0;
}
function normalizeGateBand(v, mode) {
  if (typeof v !== "object" || v === null) return null;
  const b = v;
  const kind = b.kind === "low" || b.kind === "mid" || b.kind === "high" ? b.kind : null;
  if (!kind) return null;
  const rawAt = Number(b.at);
  let at;
  if (Number.isFinite(rawAt)) {
    at = mode === "pool" ? Math.max(0, Math.min(100, rawAt)) : round2(rawAt);
  }
  const mutations = (Array.isArray(b.mutations) ? b.mutations : []).map(normalizeMutation).filter((x) => x !== null);
  return at !== void 0 ? { kind, at, mutations } : { kind, mutations };
}
function normalizeGate(v) {
  if (typeof v !== "object" || v === null) return void 0;
  const o = v;
  const poolId = str(o.poolId);
  if (!poolId) return void 0;
  const mode = o.mode === "value" ? "value" : "pool";
  const compare = o.compare === "lte" ? "lte" : "gte";
  const bands = (Array.isArray(o.bands) ? o.bands : []).map((x) => normalizeGateBand(x, mode)).filter((x) => x !== null);
  const seen = /* @__PURE__ */ new Set();
  const cleanBands = bands.filter((b) => seen.has(b.kind) ? false : (seen.add(b.kind), true));
  const at = Number(o.at);
  const singleAt = Number.isFinite(at) ? mode === "pool" ? Math.max(0, Math.min(100, at)) : round2(at) : void 0;
  const out = { poolId };
  if (mode === "value") {
    out.mode = "value";
    if (compare !== "gte") out.compare = compare;
  }
  if (cleanBands.length) {
    out.bands = cleanBands;
    if (singleAt !== void 0) out.at = singleAt;
    return out;
  }
  if (singleAt !== void 0) {
    out.at = singleAt;
    return out;
  }
  return void 0;
}
function normalizeNode(v) {
  if (typeof v !== "object" || v === null) return null;
  const n = v;
  if (typeof n.id !== "string" || !n.id) return null;
  const type = n.type === "resource" || n.type === "text" ? n.type : "numeric";
  const d = typeof n.display === "object" && n.display !== null ? n.display : {};
  return {
    id: n.id,
    category: asCategory(n.category),
    name: str(n.name, "Custom Stat"),
    type,
    baseValue: type === "text" ? str(n.baseValue) : num2(n.baseValue),
    min: optNum(n.min),
    max: optNum(n.max),
    section: n.section === "pools" ? "pools" : "stats",
    display: {
      label: typeof d.label === "string" ? d.label : void 0,
      icon: typeof d.icon === "string" ? d.icon : void 0,
      visible: typeof d.visible === "boolean" ? d.visible : void 0,
      format: d.format === "score" || d.format === "bar" || d.format === "plain" ? d.format : void 0,
      accent: typeof d.accent === "string" ? d.accent : void 0
    },
    decay: normalizeDecay(n.decay, n.id),
    fx: normalizeFx(n.fx),
    // dedicated background effect — separate entity, same spec shape/normalizer
    bgFx: normalizeFx(n.bgFx),
    colors: normalizeColors(n.colors),
    // per-level picture swaps are a POOL concept (they key off the fill
    // level) — a non-resource node can't have a level, so drop them there.
    pictures: type === "resource" ? normalizePoolPictures(n.pictures) : void 0
  };
}
var OPERATORS = new Set(ALL_OPS);
function normalizeMutation(v) {
  if (typeof v !== "object" || v === null) return null;
  const m = v;
  if (typeof m.targetStatId !== "string" || !m.targetStatId) return null;
  if (typeof m.operator !== "string" || !OPERATORS.has(m.operator)) return null;
  const value = m.value;
  if (typeof value !== "number" && typeof value !== "string" && typeof value !== "boolean") return null;
  return { targetStatId: m.targetStatId, operator: m.operator, value };
}
var KINDS = ["condition", "buff", "curse", "enchantment", "equipment"];
function normalizeModifier(v, ctx) {
  if (typeof v !== "object" || v === null) return null;
  const m = v;
  if (typeof m.id !== "string" || !m.id) return null;
  const mutations = (Array.isArray(m.mutations) ? m.mutations : []).map(normalizeMutation).filter((x) => x !== null);
  const out = {
    id: m.id,
    name: str(m.name, "Effect"),
    description: typeof m.description === "string" ? m.description : void 0,
    kind: KINDS.includes(m.kind) ? m.kind : "condition",
    icon: typeof m.icon === "string" ? m.icon : void 0,
    active: typeof m.active === "boolean" ? m.active : true,
    mutations,
    decay: normalizeDecay(m.decay, ""),
    gate: normalizeGate(m.gate),
    theme: normalizeThemeRoles(m.theme),
    picture: normalizePictureOverride(m.picture)
  };
  if (ctx) {
    const counter2 = normalizeRampCounter({ nodes: ctx.nodes, lists: ctx.lists }, m.counter);
    if (counter2) out.counter = counter2;
  }
  return out;
}
function normalizeItem(v) {
  if (typeof v !== "object" || v === null) return null;
  const i = v;
  return {
    id: str(i.id, uid("item")),
    name: str(i.name, "Item"),
    qty: Math.max(1, Math.floor(num2(i.qty, 1)))
  };
}
function normalizeList(v) {
  if (typeof v !== "object" || v === null) return null;
  const l = v;
  return {
    id: str(l.id, uid("list")),
    name: str(l.name, "List"),
    capacity: optNum(l.capacity),
    icon: typeof l.icon === "string" ? l.icon : void 0,
    items: (Array.isArray(l.items) ? l.items : []).map(normalizeItem).filter((x) => x !== null)
  };
}
var DEFAULT_CARDS = ["stats", "conditions", "lists", "pools", "ramps", "activity"];
function reconcileCardOrder(stored) {
  if (!stored?.length) return [...DEFAULT_CARDS];
  const kept = stored.filter((id) => DEFAULT_CARDS.includes(id));
  for (const id of DEFAULT_CARDS) {
    if (kept.includes(id)) continue;
    const idx = DEFAULT_CARDS.indexOf(id);
    let insertAt = -1;
    for (let i = idx - 1; i >= 0; i--) {
      const p = kept.indexOf(DEFAULT_CARDS[i]);
      if (p >= 0) {
        insertAt = p + 1;
        break;
      }
    }
    if (insertAt < 0) {
      for (let i = idx + 1; i < DEFAULT_CARDS.length; i++) {
        const p = kept.indexOf(DEFAULT_CARDS[i]);
        if (p >= 0) {
          insertAt = p;
          break;
        }
      }
    }
    kept.splice(insertAt >= 0 ? insertAt : kept.length, 0, id);
  }
  return kept;
}
var PORTRAIT_DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+\/=]+$/i;
function normalizeCharacter(v) {
  if (typeof v !== "object" || v === null) return null;
  const c = v;
  if (!Array.isArray(c.nodes)) return null;
  const nodes = c.nodes.map(normalizeNode).filter((x) => x !== null);
  const lists = (Array.isArray(c.lists) ? c.lists : []).map(normalizeList).filter((x) => x !== null);
  const modifiers = (Array.isArray(c.modifiers) ? c.modifiers : []).map((v2) => normalizeModifier(v2, { nodes, lists })).filter((x) => x !== null);
  const dedupeIds = (arr) => {
    const seen = /* @__PURE__ */ new Set();
    return arr.filter((x) => seen.has(x.id) ? false : (seen.add(x.id), true));
  };
  const nodesU = dedupeIds(nodes);
  const listsU = dedupeIds(lists).map((l) => ({ ...l, items: dedupeIds(l.items) }));
  const modifiersU = dedupeIds(modifiers);
  const rampCtxFull = { nodes: nodesU, lists: listsU, modifiers: modifiersU.map((m) => ({ id: m.id })) };
  const rampsU = dedupeIds(
    (Array.isArray(c.ramps) ? c.ramps : []).map((v2) => normalizeRampLink(rampCtxFull, v2)).filter((x) => x !== null)
  );
  const focal = typeof c.focal === "object" && c.focal !== null ? (() => {
    const f = c.focal;
    return { x: num2(f.x, 0.5), y: num2(f.y, 0.5), zoom: num2(f.zoom, 100) };
  })() : void 0;
  const now = Date.now();
  return {
    id: str(c.id, uid("char")),
    name: str(c.name, "Imported Character"),
    race: c.race ? str(c.race) : void 0,
    class: c.class ? str(c.class) : void 0,
    level: optNum(c.level),
    tags: Array.isArray(c.tags) ? c.tags.filter((t) => typeof t === "string") : [],
    cardOrder: reconcileCardOrder(
      Array.isArray(c.cardOrder) ? c.cardOrder.filter((s) => typeof s === "string") : void 0
    ),
    nodes: nodesU,
    modifiers: modifiersU,
    lists: listsU,
    ...rampsU.length ? { ramps: rampsU } : {},
    theme: normalizeThemeRoles(c.theme),
    lock: normalizeLock(c.lock),
    portrait: typeof c.portrait === "string" && PORTRAIT_DATA_URL.test(c.portrait) ? c.portrait : void 0,
    background: normalizeBackdrop(c.background),
    images: normalizeSheetImages(c.images),
    backdropFx: normalizeBackdropFx(c.backdropFx),
    focal,
    createdAt: num2(c.createdAt, now),
    updatedAt: num2(c.updatedAt, now),
    // Absent (legacy docs) → undefined → consumers fall back to updatedAt.
    lastEditAt: typeof c.lastEditAt === "number" && Number.isFinite(c.lastEditAt) ? c.lastEditAt : void 0
  };
}

// deploy/http-body.ts
var BodyTooLarge = class extends Error {
  constructor(maxBytes) {
    super(`body too large (max ${maxBytes} bytes)`);
    this.name = "BodyTooLarge";
  }
};
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    if (!req || typeof req.on !== "function") return resolve("");
    const chunks = [];
    let bytes = 0;
    let dead = false;
    req.on("data", (d) => {
      if (dead) return;
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(typeof d === "string" ? d : String(d), "utf8");
      chunks.push(buf);
      bytes += buf.length;
      if (bytes > maxBytes) {
        dead = true;
        try {
          req.removeAllListeners("data");
          req.removeAllListeners("end");
          req.pause?.();
        } catch {
        }
        reject(new BodyTooLarge(maxBytes));
      }
    });
    req.on("end", () => {
      if (dead) return;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (e) => {
      if (dead) return;
      dead = true;
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

// vite-shared-db.ts
var MAX_BODY_BYTES = 25 * 1024 * 1024;
var EMPTY_DOC = { app: "character-tracker-shared", version: 1, updatedAt: 0, characters: [] };
function putShared(id, body, readDoc, writeDoc) {
  const character = body?.character;
  const stored = normalizeCharacter(character);
  if (!stored) {
    return { status: 400, body: { error: "invalid character" } };
  }
  const doc = readDoc() ?? { ...EMPTY_DOC, characters: [] };
  const idx = doc.characters.findIndex((c) => c.id === id);
  const existing = idx >= 0 ? doc.characters[idx] : void 0;
  if (existing && typeof body?.baseSavedAt === "number" && body.baseSavedAt !== existing.savedAt) {
    return { status: 409, body: { error: "conflict", savedAt: existing.savedAt } };
  }
  const now = Date.now();
  const entry = { id, savedAt: now, character: stored };
  if (idx >= 0) doc.characters[idx] = entry;
  else doc.characters.push(entry);
  doc.updatedAt = now;
  writeDoc(doc);
  return { status: 200, body: { savedAt: now } };
}
function sharedDbPlugin(root = process.cwd()) {
  const dataDir = path.join(root, "data");
  const file = path.join(dataDir, "characters.json");
  const readDoc = () => {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const doc = JSON.parse(raw);
      if (!doc || !Array.isArray(doc.characters)) return null;
      return doc;
    } catch {
      return null;
    }
  };
  const writeDoc = (doc) => {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, file);
  };
  const send = (res, result) => {
    if (!res || res.destroyed === true || res.writableEnded === true) return;
    res.statusCode = result.status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result.body));
  };
  const middleware = (req, res, next) => {
    const url = (req.url ?? "").split("?")[0];
    if (!url.startsWith("/api/shared/")) return next();
    if (url === "/api/shared/list" && req.method === "GET") {
      const doc = readDoc();
      const items = (doc?.characters ?? []).map((c) => {
        const char = c.character;
        return {
          id: c.id,
          name: char?.name ?? "Untitled",
          updatedAt: Number(char?.updatedAt ?? 0),
          lastEditAt: typeof char?.lastEditAt === "number" ? char.lastEditAt : void 0,
          savedAt: c.savedAt
        };
      });
      return send(res, { status: 200, body: { updatedAt: doc?.updatedAt ?? 0, items } });
    }
    const m = url.match(/^\/api\/shared\/characters\/([^/]+)$/);
    if (!m) return send(res, { status: 404, body: { error: "not found" } });
    let id;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      return send(res, { status: 400, body: { error: "bad id" } });
    }
    if (req.method === "GET") {
      const c = readDoc()?.characters.find((x) => x.id === id);
      return send(res, c ? { status: 200, body: c } : { status: 404, body: { error: "not found" } });
    }
    if (req.method === "DELETE") {
      const doc = readDoc();
      if (doc) {
        const nextChars = doc.characters.filter((c) => c.id !== id);
        if (nextChars.length !== doc.characters.length) {
          doc.characters = nextChars;
          doc.updatedAt = Date.now();
          writeDoc(doc);
        }
      }
      return send(res, { status: 200, body: { ok: true } });
    }
    if (req.method === "PUT") {
      readRawBody(req, MAX_BODY_BYTES).then((raw) => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, { status: 400, body: { error: "bad request" } });
        }
        if (readDoc() === null && fs.existsSync(file)) {
          const backup = `${file}.corrupt-${Date.now()}`;
          try {
            fs.copyFileSync(file, backup);
          } catch {
          }
          console.error(`[shared-db] unreadable shared DB \u2014 original backed up as ${path.basename(backup)}`);
          return send(res, {
            status: 500,
            body: { error: "shared DB unreadable (parse error) \u2014 the operator has been told" }
          });
        }
        const result = putShared(id, body, readDoc, writeDoc);
        return send(res, result);
      }).catch(() => send(res, { status: 413, body: { error: "too large" } }));
      return;
    }
    return send(res, { status: 405, body: { error: "method not allowed" } });
  };
  return {
    name: "character-tracker-shared-db",
    configureServer(server2) {
      server2.middlewares.use(middleware);
    },
    configurePreviewServer(server2) {
      server2.middlewares.use(middleware);
    }
  };
}

// vite-owner.ts
import fs2 from "node:fs";
import path2 from "node:path";
import crypto from "node:crypto";

// src/core/owner-config.ts
function normalizeBrainUrl(raw) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, url: "", error: "empty" };
  let candidate = trimmed;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(candidate);
  if (hasScheme) {
    if (!/^https?:\/\//i.test(candidate)) {
      return { ok: false, url: "", error: "use http:// or https://" };
    }
  } else {
    candidate = `http://${candidate}`;
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, url: "", error: "not a valid link" };
  }
  if (!parsed.hostname) return { ok: false, url: "", error: "missing a host" };
  const pathname = parsed.pathname.replace(/\/+$/, "");
  const url = `${parsed.protocol}//${parsed.host}${pathname}`;
  return { ok: true, url };
}
var DEFAULT_BRAIN_URL = "";
var DEFAULT_BRAIN_MODEL = "";
function parseBrainConfigFile(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw;
  if (typeof o.url !== "string" || !o.url.trim()) return null;
  const url = normalizeBrainUrl(o.url).url;
  if (!url) return null;
  const model = typeof o.model === "string" && o.model.trim() ? o.model.trim() : void 0;
  const apiKey = typeof o.apiKey === "string" && o.apiKey.trim() ? o.apiKey.trim() : void 0;
  return { url, model, apiKey };
}
function masterPinLengthError(pin) {
  const v = (pin ?? "").trim();
  if (v.length < 4 || v.length > 64) return "Use 4\u201364 characters for the PIN.";
  return null;
}

// src/core/rate-limiter.ts
var MAX_ATTEMPTS = 3;
var LOCKOUT_MS = 5 * 60 * 1e3;
var freshLimiter = () => ({ failures: 0, lockedUntil: 0 });
function allowed(state, now) {
  if (state.lockedUntil > now) return false;
  clearOnExpiry(state, now);
  return true;
}
function clearOnExpiry(state, now = Date.now()) {
  if (state.lockedUntil !== 0 && now >= state.lockedUntil) {
    state.lockedUntil = 0;
    state.failures = 0;
  }
}
function recordFailure(state, now, lockoutMs = LOCKOUT_MS) {
  if (state.lockedUntil > now) return false;
  state.failures += 1;
  if (state.failures >= MAX_ATTEMPTS) state.lockedUntil = now + lockoutMs;
  return state.failures >= MAX_ATTEMPTS;
}
function recordSuccess(state) {
  state.failures = 0;
  state.lockedUntil = 0;
}
function remainingMs(state, now) {
  return Math.max(0, state.lockedUntil - now);
}
function minutesLeft(ms) {
  return Math.max(1, Math.ceil(ms / 6e4));
}

// vite-owner.ts
var LLM_TIMEOUT_MS = 8e3;
function hexSha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}
function readMasterFile(root) {
  const file = path2.join(root, "data", "master.json");
  try {
    const doc = JSON.parse(fs2.readFileSync(file, "utf8"));
    if (typeof doc.salt === "string" && /^[0-9a-f]{16}$/i.test(doc.salt) && typeof doc.hash === "string" && /^[0-9a-f]{64}$/i.test(doc.hash)) {
      return { salt: doc.salt.toLowerCase(), hash: doc.hash.toLowerCase() };
    }
    return null;
  } catch {
    return null;
  }
}
function writeJson(root, name, doc) {
  const dataDir = path2.join(root, "data");
  if (!fs2.existsSync(dataDir)) fs2.mkdirSync(dataDir, { recursive: true });
  const file = path2.join(dataDir, name);
  const tmp = `${file}.tmp`;
  fs2.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs2.renameSync(tmp, file);
}
function envBootstrapHash() {
  const pin = (process.env.CT_OWNER_BOOTSTRAP_PIN ?? "").trim();
  return pin ? hexSha256(pin) : null;
}
function masterSecret(root) {
  const stored = readMasterFile(root);
  if (stored) return { kind: "stored", salt: stored.salt, hash: stored.hash };
  const boot = envBootstrapHash();
  if (boot) return { kind: "bootstrap", hash: boot };
  return { kind: "none" };
}
function masterSealed(secret) {
  return secret.kind !== "none";
}
function digestEq(a, b) {
  const ba = Buffer.from(a.toLowerCase(), "utf8");
  const bb = Buffer.from(b.toLowerCase(), "utf8");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function secretSatisfies(secret, pin) {
  if (!pin || secret.kind === "none") return false;
  if (secret.kind === "stored") return digestEq(hexSha256(`${secret.salt}:${pin}`), secret.hash);
  return digestEq(hexSha256(pin), secret.hash);
}
function masterPublicState(secret) {
  if (secret.kind === "stored") return { configured: true, fp: hexSha256(`fp:${secret.salt}:${secret.hash}`) };
  if (secret.kind === "bootstrap") return { configured: true, fp: hexSha256(`fp:env:${secret.hash}`) };
  return { configured: false };
}
function resolveBrain(root) {
  const brainFile = path2.join(root, "data", "llm-config.json");
  let fromFile = null;
  try {
    fromFile = parseBrainConfigFile(JSON.parse(fs2.readFileSync(brainFile, "utf8")));
  } catch {
    fromFile = null;
  }
  if (fromFile) {
    return {
      url: fromFile.url,
      model: fromFile.model ?? DEFAULT_BRAIN_MODEL,
      apiKey: fromFile.apiKey,
      source: "file",
      configured: true
    };
  }
  const envUrl = process.env.CT_LLM_URL;
  if (envUrl && envUrl.trim()) {
    const n = normalizeBrainUrl(envUrl);
    if (n.ok) {
      const envModel = process.env.CT_LLM_MODEL;
      return {
        url: n.url,
        model: envModel && envModel.trim() ? envModel.trim() : DEFAULT_BRAIN_MODEL,
        apiKey: process.env.CT_LLM_API_KEY || void 0,
        source: "env",
        configured: true
      };
    }
  }
  return { url: DEFAULT_BRAIN_URL, model: DEFAULT_BRAIN_MODEL, source: "default", configured: false };
}
var PROBE_CACHE_TTL_MS = 3e3;
var probeInflight = /* @__PURE__ */ new Map();
var probeCache = /* @__PURE__ */ new Map();
function probeKey(b) {
  return [b.url, b.model, b.apiKey ?? ""].join("\0");
}
function probeBrain(b) {
  if (!b.url) {
    return Promise.resolve({ ...brainStatus(b, false, null), error: "No brain link configured yet." });
  }
  const key = probeKey(b);
  const cached = probeCache.get(key);
  if (cached && Date.now() - cached.at < PROBE_CACHE_TTL_MS) {
    return Promise.resolve(cached.status);
  }
  const inFlight = probeInflight.get(key);
  if (inFlight) return inFlight;
  const p = probeBrainOnce(b).then((status) => {
    probeCache.set(key, { at: Date.now(), status });
    return status;
  }).finally(() => {
    probeInflight.delete(key);
  });
  probeInflight.set(key, p);
  if (probeCache.size > 32) probeCache.clear();
  return p;
}
async function probeBrainOnce(b) {
  const base = b.url.replace(/\/+$/, "");
  const headers = { Accept: "application/json" };
  if (b.apiKey) headers.Authorization = `Bearer ${b.apiKey}`;
  try {
    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(LLM_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(`[owner] brain probe ${base}/models -> HTTP ${res.status}`);
      return { ...brainStatus(b, false, null), error: `The brain replied HTTP ${res.status}.` };
    }
    const d = await res.json().catch(() => null);
    const ids = Array.isArray(d?.data) ? d.data.map((m) => m.id) : [];
    return { ...brainStatus(b, true, ids[0] ?? null) };
  } catch (e) {
    console.warn(`[owner] brain probe ${base}/models failed:`, e instanceof Error ? e.message : e);
    return { ...brainStatus(b, false, null), error: "The brain could not be reached." };
  }
}
function brainStatus(b, reachable, modelId) {
  return {
    url: b.url,
    model: b.model,
    hasKey: !!b.apiKey,
    configured: b.configured,
    source: b.source,
    reachable,
    modelId
  };
}
function ownerPlugin() {
  const root = process.cwd();
  const send = (res, status, body) => {
    if (!res || res.destroyed === true || res.writableEnded === true) return;
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
  const lockPath = () => path2.join(root, "data", "master-lock.json");
  const readLimiter = () => {
    try {
      const doc = JSON.parse(fs2.readFileSync(lockPath(), "utf8"));
      const failures = Number(doc.failures);
      const lockedUntil = Number(doc.lockedUntil);
      return {
        failures: Number.isFinite(failures) && failures > 0 ? Math.min(MAX_ATTEMPTS, Math.floor(failures)) : 0,
        lockedUntil: Number.isFinite(lockedUntil) && lockedUntil > Date.now() ? Math.floor(lockedUntil) : 0
      };
    } catch {
      return freshLimiter();
    }
  };
  const saveLimiter = (state) => {
    try {
      if (state.failures === 0 && state.lockedUntil === 0) fs2.rmSync(lockPath(), { force: true });
      else writeJson(root, "master-lock.json", { failures: state.failures, lockedUntil: state.lockedUntil });
    } catch {
    }
  };
  const lockedBody = (ms) => ({
    ok: false,
    error: `Too many attempts \u2014 try again in ${minutesLeft(ms)} min.`,
    remainingMs: ms
  });
  const checkPin = (pin) => {
    const secret = masterSecret(root);
    if (secret.kind === "none") return null;
    const now = Date.now();
    const was = readLimiter();
    const limiter = { ...was };
    const sync = () => {
      if (limiter.failures !== was.failures || limiter.lockedUntil !== was.lockedUntil) saveLimiter(limiter);
    };
    if (!allowed(limiter, now)) {
      sync();
      return { status: 429, body: lockedBody(remainingMs(limiter, now)) };
    }
    if (!secretSatisfies(secret, typeof pin === "string" ? pin : "")) {
      const armed = recordFailure(limiter, now);
      sync();
      return {
        status: 401,
        body: {
          ok: false,
          error: armed ? "Too many attempts \u2014 master surfaces locked for 5 minutes." : "That is not the current master PIN.",
          remainingAttempts: Math.max(0, MAX_ATTEMPTS - limiter.failures)
        }
      };
    }
    recordSuccess(limiter);
    sync();
    return null;
  };
  const authorizeMaster = (pin) => checkPin(pin);
  const authorizeClaim = (pin) => checkPin(pin);
  const readBody = (req) => readRawBody(req, 64 * 1024);
  const middleware = (req, res, next) => {
    const url = (req.url ?? "").split("?")[0];
    if (!url.startsWith("/api/owner/")) return next();
    if (url === "/api/owner/status" && req.method === "GET") {
      const brain = resolveBrain(root);
      void probeBrain(brain).then((status) => {
        send(res, 200, { brain: status, masterConfigured: masterSealed(masterSecret(root)) });
      }).catch((e) => {
        console.error("[owner] status probe failed:", e instanceof Error ? e.message : e);
        send(res, 500, {
          brain: brainStatus(brain, false, null),
          error: "The brain could not be reached.",
          masterConfigured: masterSealed(masterSecret(root))
        });
      });
      return;
    }
    if (url === "/api/owner/brain" && req.method === "PUT") {
      void (async () => {
        try {
          const body = JSON.parse(await readBody(req));
          const deny = authorizeMaster(body?.master);
          if (deny) return send(res, deny.status, deny.body);
          const check = normalizeBrainUrl(typeof body.url === "string" ? body.url : "");
          if (!check.ok) return send(res, 400, { error: `invalid brain link: ${check.error}` });
          let prevUrl;
          let prevKey;
          try {
            const prev = parseBrainConfigFile(JSON.parse(fs2.readFileSync(path2.join(root, "data", "llm-config.json"), "utf8")));
            prevUrl = prev?.url;
            prevKey = prev?.apiKey;
          } catch {
            prevUrl = void 0;
            prevKey = void 0;
          }
          const newKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : void 0;
          const sameHost = !!prevUrl && (() => {
            try {
              return new URL(prevUrl).host === new URL(check.url).host;
            } catch {
              return false;
            }
          })();
          const key = newKey || (sameHost ? prevKey : void 0);
          const doc = { url: check.url };
          if (typeof body.model === "string" && body.model.trim()) doc.model = body.model.trim();
          if (key) doc.apiKey = key;
          writeJson(root, "llm-config.json", doc);
          const status = await probeBrain(resolveBrain(root));
          send(res, 200, { brain: status });
        } catch (e) {
          send(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      })();
      return;
    }
    if (url === "/api/owner/brain" && req.method === "DELETE") {
      void (async () => {
        try {
          let body = {};
          try {
            const raw = await readBody(req);
            if (raw && raw.trim()) body = JSON.parse(raw);
          } catch {
          }
          const deny = authorizeMaster(body?.master);
          if (deny) return send(res, deny.status, deny.body);
          fs2.rmSync(path2.join(root, "data", "llm-config.json"), { force: true });
          const brain = resolveBrain(root);
          void probeBrain(brain).then((status) => send(res, 200, { brain: status })).catch((e) => {
            console.error("[owner] brain reset probe failed:", e instanceof Error ? e.message : e);
            send(res, 500, { brain: brainStatus(brain, false, null), error: "The brain could not be reached." });
          });
        } catch (e) {
          send(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      })();
      return;
    }
    if (url === "/api/owner/master" && req.method === "GET") {
      return send(res, 200, masterPublicState(masterSecret(root)));
    }
    if (url === "/api/owner/verify" && req.method === "POST") {
      void (async () => {
        const secret = masterSecret(root);
        if (!masterSealed(secret)) {
          return send(res, 403, { ok: false, configured: false, error: "No master secret is configured on this server." });
        }
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return send(res, 400, { ok: false, error: "bad request" });
        }
        const deny = authorizeMaster(body?.pin);
        if (deny) return send(res, deny.status, deny.body);
        send(res, 200, { ok: true, ...masterPublicState(secret) });
      })();
      return;
    }
    if (url === "/api/owner/master" && req.method === "PUT") {
      void (async () => {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return send(res, 400, { error: "bad request" });
        }
        const deny = authorizeClaim(body?.current);
        if (deny) return send(res, deny.status, deny.body);
        const newPin = typeof body.newPin === "string" ? body.newPin.trim() : "";
        const lenErr = masterPinLengthError(newPin);
        if (lenErr) return send(res, 400, { error: lenErr });
        const hadMaster = !!readMasterFile(root);
        const salt = crypto.randomBytes(8).toString("hex");
        const hash = hexSha256(`${salt}:${newPin}`);
        writeJson(root, "master.json", { salt, hash });
        console.log(
          `[owner] ${hadMaster ? "MASTER ROTATED" : "SERVER CLAIMED"} at ${(/* @__PURE__ */ new Date()).toISOString()} \u2014 a new master PIN now owns this deployment`
        );
        send(res, 200, masterPublicState({ kind: "stored", salt, hash }));
      })();
      return;
    }
    send(res, 405, { error: "method not allowed" });
  };
  return {
    name: "character-tracker-owner",
    configureServer(server2) {
      server2.middlewares.use(middleware);
    },
    configurePreviewServer(server2) {
      server2.middlewares.use(middleware);
    }
  };
}

// src/core/apply.ts
var str2 = (v, fallback = "") => typeof v === "string" ? v : fallback;
var num3 = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
var bool = (v) => typeof v === "boolean" ? v : void 0;
var optStr = (v) => typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : void 0;
var CATEGORIES2 = ["attributes", "pools", "misc", "custom"];
var KINDS2 = ["condition", "buff", "curse", "enchantment", "equipment"];
var FORMATS = ["score", "bar", "plain"];
var OPS = ["add", "multiply", "override", "rename", "setIcon", "setVisible", "setAccent", "setFormat", "setMin", "setMax"];
var TEXT_OPS = /* @__PURE__ */ new Set(["rename", "setIcon", "setAccent", "setFormat"]);
var FX_EFFECTS2 = ["dribble", "text", "hearts", "orbs", "spiral"];
var FX_SIDES = ["high", "low"];
function argError(msg) {
  throw new Error(msg);
}
function ensureImageLibrary(c, legacyPortrait) {
  const empty = !c.images || !c.images.portraits.length && !c.images.backgrounds.length;
  if (!empty) return;
  const portraits = [];
  if (legacyPortrait && legacyPortrait.startsWith("data:image/")) {
    portraits.push({ id: "img_default", name: "Default", image: legacyPortrait });
  }
  c.images = { portraits, backgrounds: [], activePortraitId: portraits[0]?.id };
}
function parseArgs(args) {
  let v = args;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      v = {};
    }
  }
  if (typeof v !== "object" || v === null) return {};
  return v;
}
function findNode(c, nodeId) {
  const n = c.nodes.find((x) => x.id === nodeId);
  if (!n) argError(`no node with id "${nodeId}"`);
  return n;
}
function findMod(c, id) {
  const m = c.modifiers.find((x) => x.id === id);
  if (!m) argError(`no effect with id "${id}"`);
  return m;
}
function findList(c, id) {
  const l = c.lists.find((x) => x.id === id);
  if (!l) argError(`no list with id "${id}"`);
  return l;
}
function normalizeDecaySpec(c, a, fallbackTarget, prefix) {
  if (a.decay === void 0 && a.regen === void 0) return void 0;
  const rate = num3(a.decay);
  if (rate === void 0 || rate <= 0 || rate > 100) {
    argError(`${prefix} decay must be a positive number \u2264 100 per minute (0 or clearDecay removes it)`);
  }
  let target = fallbackTarget;
  if (a.statTarget !== void 0) {
    const t = str2(a.statTarget);
    if (t !== "SELF" && !c.nodes.some((n) => n.id === t)) {
      argError(`${prefix} statTarget "${t}" does not exist on this sheet`);
    }
    if (t !== "SELF") target = t;
  }
  return { statTarget: target, decayRatePerMinute: round2(rate), kind: a.regen === true ? "regen" : "decay" };
}
function findFxNode(c, nodeId) {
  const n = findNode(c, nodeId);
  if (n.type !== "resource") argError(`${nodeId} is not a resource pool \u2014 threshold effects only exist on pools`);
  return n;
}
var THEME_ROLE_KEYS = ["background", "surface", "border", "text", "accent"];
function normalizeThemeSpec(raw, prefix) {
  if (typeof raw !== "object" || raw === null) argError(`${prefix} theme must be an object with the five roles: ${THEME_ROLE_KEYS.join(", ")}`);
  const o = raw;
  const out = {};
  for (const role of THEME_ROLE_KEYS) {
    const hex = parseColor(o[role]);
    if (!hex) argError(`${prefix} theme.${role} must be a #rrggbb color (got ${JSON.stringify(o[role] ?? null)})`);
    out[role] = hex;
  }
  return out;
}
function normalizeGateBandSpec(c, raw, prefix, mode) {
  if (typeof raw !== "object" || raw === null) argError(`${prefix} bands[] entry must be an object {kind, at?, mutations?}`);
  const o = raw;
  const kind = o.kind;
  if (kind !== "low" && kind !== "mid" && kind !== "high") argError(`${prefix} bands[] kind must be 'low', 'mid', or 'high' (got ${JSON.stringify(kind)})`);
  let at;
  if (o.at !== void 0) {
    at = num3(o.at);
    if (at === void 0) argError(`${prefix} bands[] ${kind}.at must be a finite number`);
    if (mode === "pool" && (at < 0 || at > 100)) argError(`${prefix} bands[] ${kind}.at must be 0\u2013100 (percent of the pool)`);
    at = round2(at);
  }
  const mutations = (Array.isArray(o.mutations) ? o.mutations : []).map((mu) => normalizeMutation2(c, mu, `${prefix}.bands[] ${kind}.mutations[]`));
  return kind === "low" || kind === "mid" || kind === "high" ? { kind, ...at !== void 0 ? { at } : {}, mutations } : { never: true };
}
function normalizeGateSpec(c, raw, prefix) {
  if (raw === null) return null;
  if (typeof raw !== "object") argError(`${prefix} gate must be an object ({poolId, at} / {poolId, bands: [...]} / {poolId, mode:'value', ...}) or null (clear)`);
  const o = raw;
  const poolId = str2(o.poolId).trim();
  if (!poolId) argError(`${prefix} gate poolId is empty`);
  const n = c.nodes.find((x) => x.id === poolId);
  if (!n) argError(`${prefix} gate poolId "${poolId}" does not exist on this sheet`);
  if (n.type === "text" || typeof n.baseValue !== "number") argError(`${prefix} gate pool "${n.name}" is not a numeric node`);
  const mode = o.mode === "value" ? "value" : "pool";
  const compare = o.compare === "lte" ? "lte" : "gte";
  if (o.mode !== void 0 && o.mode !== "value" && o.mode !== "pool") argError(`${prefix} gate mode must be 'pool' or 'value' (got ${JSON.stringify(o.mode)})`);
  if (o.compare !== void 0 && o.compare !== "gte" && o.compare !== "lte") argError(`${prefix} gate compare must be 'gte' or 'lte' (got ${JSON.stringify(o.compare)})`);
  if (o.bands !== void 0) {
    if (!Array.isArray(o.bands)) argError(`${prefix} gate bands must be an array of {kind, at?, mutations?}`);
    const seen = /* @__PURE__ */ new Set();
    const bands = [];
    for (const b of o.bands) {
      const band = normalizeGateBandSpec(c, b, `${prefix} gate`, mode);
      if (seen.has(band.kind)) argError(`${prefix} gate has duplicate band kind "${band.kind}" (one entry per level)`);
      seen.add(band.kind);
      bands.push(band);
    }
    if (!bands.length) argError(`${prefix} gate bands is empty \u2014 pass at least one {kind, at?, mutations?} entry, or use {poolId, at}`);
    return mode === "value" ? { poolId, mode: "value", ...compare !== "gte" ? { compare } : {}, bands } : { poolId, bands };
  }
  const at = num3(o.at);
  if (at === void 0) argError(`${prefix} gate at must be a finite number (a percent in pool mode, an absolute value in value mode)`);
  if (mode === "pool" && (at < 0 || at > 100)) argError(`${prefix} gate at must be 0\u2013100 (percent of the pool)`);
  return mode === "value" ? { poolId, mode: "value", ...compare !== "gte" ? { compare } : {}, at: round2(at) } : { poolId, at: round2(at) };
}
function gateSummary(c, gate) {
  const name = c.nodes.find((x) => x.id === gate.poolId)?.name ?? gate.poolId;
  const value = gate.mode === "value";
  if (gate.bands?.length) {
    const order = ["low", "mid", "high"];
    const parts = order.map((k) => gate.bands?.find((b) => b.kind === k)).filter(Boolean).map((b) => {
      const op = b.kind === "high" ? "\u2265" : b.kind === "low" ? "\u2264" : "\xB7";
      const range = `${b.kind}${b.at !== void 0 ? ` ${op} ${b.at}` : ""}${b.mutations?.length ? `: ${b.mutations.length} mut(s)` : " (none)"}`;
      return range;
    });
    return value ? `gated by ${name}'s VALUE levels [${parts.join(", ")}]` : `gated by ${name} levels [${parts.join(", ")}]`;
  }
  if (value) {
    const op = gate.compare === "lte" ? "\u2264" : "\u2265";
    return `gated by ${name} ${op} ${gate.at ?? 0} (its value)`;
  }
  return `gated by ${name} \u2265 ${gate.at ?? 0}%`;
}
function normalizeFxSide2(side, raw) {
  if (raw === void 0) return void 0;
  if (raw === null) return null;
  if (typeof raw !== "object") argError(`fx ${side} must be an object or null`);
  const o = raw;
  const effect = str2(o.effect).trim().toLowerCase();
  if (!FX_EFFECTS2.includes(effect)) argError(`fx ${side} effect must be one of ${FX_EFFECTS2.join(", ")}`);
  const at = num3(o.at);
  if (at === void 0 || at < 0 || at > 100) argError(`fx ${side} at must be 0\u2013100 (percent of the bar)`);
  let words;
  if (effect === "text") {
    const w = Array.isArray(o.words) ? o.words.map((x) => str2(x).trim()).filter(Boolean).slice(0, 24) : str2(o.words).split(",").map((x) => x.trim()).filter(Boolean).slice(0, 24);
    if (!w.length) argError(`fx ${side} text effect needs at least one word`);
    words = w;
  }
  let rate;
  if (o.rate !== void 0) {
    const r = num3(o.rate);
    if (r === void 0 || r < FX_RATE_MIN || r > FX_RATE_MAX)
      argError(`fx ${side} rate must be a number from ${FX_RATE_MIN} to ${FX_RATE_MAX} (a multiple of the effect's default spawn rate; 1 = default)`);
    if (r !== 1) rate = Math.round(r * 100) / 100;
  }
  return {
    effect,
    at: round2(at),
    ...words ? { words } : {},
    ...rate !== void 0 ? { rate } : {}
  };
}
function normalizeMutation2(c, raw, where) {
  if (typeof raw !== "object" || raw === null) argError(`${where} must be an object`);
  const o = raw;
  const target = str2(o.targetStatId).trim();
  if (!target) argError(`${where} targetStatId is empty`);
  if (target.startsWith("capacity:")) {
    const lid = target.slice("capacity:".length);
    if (!c.lists.some((l) => l.id === lid)) argError(`${where} capacity target "lid" does not exist`);
  } else if (!c.nodes.some((n) => n.id === target)) {
    argError(`${where} targetStatId "${target}" does not exist on this sheet`);
  }
  const operator = str2(o.operator).trim();
  if (!OPS.includes(operator)) argError(`${where} operator must be one of ${OPS.join(", ")}`);
  let value;
  if (TEXT_OPS.has(operator)) {
    value = str2(o.value).trim();
    if (!value) argError(`${where} ${operator} needs a string value`);
  } else if (operator === "setVisible") {
    if (typeof o.value !== "boolean") argError(`${where} setVisible needs true or false`);
    value = o.value;
  } else {
    const n = num3(o.value);
    if (n === void 0) argError(`${where} ${operator} needs a finite number`);
    value = n;
  }
  return { targetStatId: target, operator, value };
}
function rampCtxOf(c) {
  return { nodes: c.nodes, lists: c.lists, modifiers: c.modifiers.map((m) => ({ id: m.id })) };
}
function normalizeRampRefArg(c, raw, where) {
  const err = validateRampRef(rampCtxOf(c), raw);
  if (err) argError(`${where}: ${err}`);
  const ref = normalizeRampRef(rampCtxOf(c), raw);
  if (!ref) argError(`${where}: could not resolve that ref against the sheet`);
  return ref;
}
function normalizeCounterArg(c, raw, where) {
  if (raw === null) return null;
  if (typeof raw !== "object") argError(`${where} counter must be an object {target, delta, offOn?, onOff?} or null (clear)`);
  const o = raw;
  const target = normalizeRampRefArg(c, o.target, `${where} counter`);
  if (target.kind === "toggle") argError(`${where} counter target cannot be a toggle (the target must be a stat/pool or a list item)`);
  const delta = num3(o.delta);
  if (delta === void 0) argError(`${where} counter delta must be a finite number (e.g. 1 or -1)`);
  const out = { target, delta: round2(delta) };
  if (typeof o.offOn === "boolean") out.offOn = o.offOn;
  if (typeof o.onOff === "boolean") out.onOff = o.onOff;
  return out;
}
function rampLine(c, r) {
  const watch = rampRefName(c, r.watch);
  const target = rampRefName(c, r.target);
  const watchFrom = r.watchFrom !== void 0 ? typeof r.watchFrom === "boolean" ? r.watchFrom ? "on" : "off" : ` from ${r.watchFrom}` : "";
  return `when ${watch} ${r.direction === "down" ? "goes DOWN" : "goes UP"}${watchFrom}, ${target} ${r.step >= 0 ? "+" : ""}${r.step}`;
}
function pruneRamps(c) {
  if (c.ramps?.length) {
    const ctx = rampCtxOf(c);
    const kept = c.ramps.filter((r) => normalizeRampRef(ctx, r.watch) && normalizeRampRef(ctx, r.target));
    c.ramps = kept.length ? kept : void 0;
  }
  if (c.modifiers.some((m) => m.counter)) {
    const ctx = rampCtxOf(c);
    for (const m of c.modifiers) if (m.counter && !normalizeRampRef(ctx, m.counter.target)) m.counter = void 0;
  }
}
var HANDLERS = {
  set_header(c, a) {
    const parts = [];
    if (a.name !== void 0) {
      const n = str2(a.name).trim();
      if (!n) argError("set_header name is empty");
      c.name = n.slice(0, 80);
      parts.push(`name \u2192 "${c.name}"`);
    }
    if (a.race !== void 0) {
      c.race = str2(a.race).trim().slice(0, 80) || void 0;
      parts.push(`race \u2192 ${c.race ?? "cleared"}`);
    }
    if (a.class !== void 0) {
      c.class = str2(a.class).trim().slice(0, 80) || void 0;
      parts.push(`class \u2192 ${c.class ?? "cleared"}`);
    }
    if (a.level !== void 0) {
      const l = num3(a.level);
      if (l === void 0 || l < 1 || l > 1e3) argError("set_header level must be 1\u20131000");
      c.level = Math.floor(l);
      parts.push(`level \u2192 ${c.level}`);
    }
    if (a.tags !== void 0) {
      const list = Array.isArray(a.tags) ? a.tags : str2(a.tags).split(",");
      const next = [];
      for (const t of list) {
        const s = str2(t).trim().slice(0, 40);
        if (s && !next.includes(s)) next.push(s);
      }
      c.tags = next;
      parts.push(`tags \u2192 ${next.join(", ") || "(none)"}`);
    }
    if (!parts.length) argError("set_header received no fields to set");
    return `header: ${parts.join(", ")}`;
  },
  add_node(c, a) {
    const section = a.section === "pools" ? "pools" : "stats";
    const name = str2(a.name).trim();
    if (!name) argError("add_node name is empty");
    const isPool = section === "pools";
    const type = a.type === "text" ? "text" : isPool ? "resource" : "numeric";
    if (type === "text" && isPool) argError("add_node: text entries go in the stats section");
    const category = isPool ? "pools" : CATEGORIES2.includes(a.category) ? a.category : "custom";
    let baseValue;
    if (type === "text") {
      baseValue = str2(a.value).trim().slice(0, 240);
    } else {
      const value = num3(a.value) ?? (isPool ? 0 : 10);
      const min = isPool ? num3(a.min) ?? 0 : num3(a.min);
      const max = isPool ? num3(a.max) ?? 100 : num3(a.max);
      if (min !== void 0 && max !== void 0 && min > max) argError(`add_node min ${min} exceeds max ${max}`);
      baseValue = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, value));
    }
    const node = {
      id: uid("stat"),
      category,
      name: name.slice(0, 80),
      type,
      baseValue,
      min: type === "text" ? void 0 : num3(a.min) ?? (isPool ? 0 : void 0),
      max: type === "text" ? void 0 : num3(a.max) ?? (isPool ? 100 : void 0),
      section,
      display: {
        icon: typeof a.icon === "string" && a.icon.trim() ? a.icon.trim().slice(0, 24) : isPool ? "flask" : "star",
        format: FORMATS.includes(a.format) ? a.format : isPool ? "bar" : type === "text" ? "plain" : void 0
      }
    };
    const decay = num3(a.decay) ? normalizeDecaySpec(c, a, node.id, "add_node") : void 0;
    if (decay) node.decay = decay;
    c.nodes.push(node);
    const shown = typeof baseValue === "string" ? JSON.stringify(baseValue) : String(baseValue);
    return `added ${type === "text" ? "text stat" : isPool ? "resource" : "stat"} "${node.name}" = ${shown} (id ${node.id}${node.min !== void 0 || node.max !== void 0 ? `, ${node.min ?? 0}\u2013${node.max ?? "\u221E"}` : ""})`;
  },
  update_node(c, a) {
    const node = findNode(c, str2(a.id));
    const parts = [];
    if (a.name !== void 0) {
      const n = str2(a.name).trim();
      if (!n) argError("update_node name is empty");
      node.name = n.slice(0, 80);
      parts.push(`name \u2192 "${node.name}"`);
    }
    if (a.baseValue !== void 0) {
      if (node.type === "text") {
        if (typeof a.baseValue !== "string") argError("update_node baseValue must be a string for a text node");
        node.baseValue = str2(a.baseValue).slice(0, 240);
        parts.push(`${node.name} \u2192 ${JSON.stringify(node.baseValue)}`);
      } else {
        const v = num3(a.baseValue);
        if (v === void 0) argError("update_node baseValue is not a finite number");
        const prev = typeof node.baseValue === "number" ? node.baseValue : void 0;
        node.baseValue = Math.max(node.min ?? -Infinity, Math.min(node.max ?? Infinity, round2(v)));
        if (typeof node.baseValue === "number" && prev !== void 0 && prev !== node.baseValue) {
          parts.push(`${node.name} ${prev} \u2192 ${node.baseValue}`);
        }
      }
    }
    if (a.min !== void 0 || a.max !== void 0) {
      const min = a.min !== void 0 ? num3(a.min) : node.min;
      const max = a.max !== void 0 ? num3(a.max) : node.max;
      if (min !== void 0 && !Number.isFinite(min)) argError("update_node min is not a finite number");
      if (max !== void 0 && !Number.isFinite(max)) argError("update_node max is not a finite number");
      if (min !== void 0 && max !== void 0 && min > max) argError(`update_node min ${min} exceeds max ${max}`);
      node.min = min;
      node.max = max;
      if (typeof node.baseValue === "number" && (min !== void 0 || max !== void 0)) {
        node.baseValue = round2(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, node.baseValue)));
      }
      parts.push(`bounds \u2192 ${min ?? 0}\u2013${max ?? "\u221E"}`);
    }
    if (a.icon !== void 0) {
      const ic = optStr(a.icon);
      if (!ic) argError("update_node icon is empty");
      node.display.icon = ic;
      parts.push(`icon \u2192 ${ic}`);
    }
    if (a.format !== void 0) {
      if (!FORMATS.includes(a.format)) argError(`update_node format must be one of ${FORMATS.join(", ")}`);
      node.display.format = a.format;
      parts.push(`format \u2192 ${a.format}`);
    }
    if (a.color !== void 0 || a.colorFull !== void 0 || a.colorEmpty !== void 0) {
      const givenFull = a.colorFull !== void 0 || a.color !== void 0;
      const givenEmpty = a.colorEmpty !== void 0 || a.color !== void 0;
      const full = givenFull ? parseColor(a.colorFull !== void 0 ? a.colorFull : a.color) : void 0;
      const empty = givenEmpty ? parseColor(a.colorEmpty !== void 0 ? a.colorEmpty : a.color) : void 0;
      if (givenFull && !full) argError("update_node color/colorFull must be #rrggbb");
      if (givenEmpty && !empty) argError("update_node color/colorEmpty must be #rrggbb");
      const next = { ...node.colors ?? {} };
      if (full) next.full = full;
      if (empty) next.empty = empty;
      node.colors = next.full || next.empty ? next : void 0;
      const bits = [];
      if (full) bits.push(`full ${full}`);
      if (empty) bits.push(`empty ${empty}`);
      parts.push(`bar colors: ${bits.join(", ")}`);
    }
    if (a.visible !== void 0) {
      const vis = bool(a.visible);
      if (vis === void 0) argError("update_node visible must be true/false");
      node.display = { ...node.display, visible: vis };
      parts.push(vis ? "shown" : "hidden");
    }
    if (a.accent !== void 0) {
      const ac = optStr(a.accent);
      if (ac) {
        node.display = { ...node.display, accent: ac };
        parts.push(`accent \u2192 ${ac}`);
      } else {
        const d = { ...node.display };
        delete d.accent;
        node.display = d;
        parts.push("accent cleared");
      }
    }
    if (a.decay !== void 0 || a.regen !== void 0) {
      if (num3(a.decay) === 0) {
        node.decay = void 0;
        parts.push("decay cleared");
      } else {
        const decay = normalizeDecaySpec(c, a, node.id, "update_node");
        if (!decay) argError("update_node decay must be a positive number \u2264 100 per minute");
        node.decay = decay;
        parts.push(decay.kind === "regen" ? `regen +${decay.decayRatePerMinute}/min` : `decay \u2212${decay.decayRatePerMinute}/min`);
      }
    }
    if (a.clearDecay === true) {
      node.decay = void 0;
      parts.push("decay cleared");
    }
    if (!parts.length) argError("update_node received no fields to set");
    return `${node.name}: ${parts.join(", ")}`;
  },
  remove_node(c, a) {
    const node = findNode(c, str2(a.id));
    c.nodes = c.nodes.filter((n) => n.id !== node.id);
    c.modifiers = c.modifiers.map((m) => ({
      ...m,
      mutations: m.mutations.filter((mu) => mu.targetStatId !== node.id)
    }));
    pruneRamps(c);
    return `removed ${node.type === "resource" ? "resource" : "stat"} "${node.name}"`;
  },
  set_theme(c, a) {
    if (a.theme === void 0) argError('set_theme needs a "theme" object (the five colors) or null (clear \u2192 stock palette)');
    if (a.theme === null) {
      c.theme = void 0;
      return "sheet theme cleared (back to the stock palette)";
    }
    c.theme = normalizeThemeSpec(a.theme, "set_theme");
    return `sheet theme \u2192 bg ${c.theme.background} / surface ${c.theme.surface} / border ${c.theme.border} / text ${c.theme.text} / accent ${c.theme.accent}`;
  },
  set_node_fx(c, a) {
    const node = findFxNode(c, str2(a.id));
    const parts = [];
    for (const side of FX_SIDES) {
      const spec = normalizeFxSide2(side, a[side]);
      if (spec === void 0) continue;
      node.fx = { ...node.fx ?? {} };
      if (spec === null) {
        delete node.fx[side];
        parts.push(`${side} effect cleared`);
      } else {
        node.fx[side] = spec;
        parts.push(`${side} effect: ${spec.effect} at ${spec.at}%${spec.words ? ` (${spec.words.join(", ")}\u2026)` : ""}`);
      }
    }
    if (!node.fx || !node.fx.high && !node.fx.low) node.fx = void 0;
    if (!parts.length) argError("set_node_fx received no sides to set (pass {high: \u2026} and/or {low: \u2026}; null clears a side)");
    return `${node.name}: ${parts.join(", ")}`;
  },
  set_node_bg_fx(c, a) {
    const node = findFxNode(c, str2(a.id));
    const parts = [];
    for (const side of FX_SIDES) {
      const spec = normalizeFxSide2(side, a[side]);
      if (spec === void 0) continue;
      node.bgFx = { ...node.bgFx ?? {} };
      if (spec === null) {
        delete node.bgFx[side];
        parts.push(`${side} background effect cleared`);
      } else {
        node.bgFx[side] = spec;
        parts.push(`${side} background effect: ${spec.effect} at ${spec.at}%${spec.words ? ` (${spec.words.join(", ")}\u2026)` : ""}`);
      }
    }
    if (!node.bgFx || !node.bgFx.high && !node.bgFx.low) node.bgFx = void 0;
    if (!parts.length) argError("set_node_bg_fx received no sides to set (pass {high: \u2026} and/or {low: \u2026}; null clears a side)");
    return `${node.name}: ${parts.join(", ")}`;
  },
  /* ============ sheet image library + picture swaps ============
   * The image BYTES travel with the request (the client sends the library
   * + a legacy `__legacyPortrait` so the first library built by AI keeps the
   * current picture). The AI can't upload pixels — it adds a NAMED slot
   * (image: "" = "upload this one in the Images dialog") and BINDS slots to
   * resource levels / conditions via set_pictures. Only slots that have an
   * actual data URL are ever resolved for display.
   */
  set_image(c, a) {
    const slot = a.slot === "background" ? "backgrounds" : "portraits";
    const parts = [];
    ensureImageLibrary(c);
    const lib = c.images;
    const list = lib[slot];
    const action = a.action === void 0 ? "add" : str2(a.action);
    if (action === "add") {
      const name = str2(a.name).trim().slice(0, 60) || `Image ${list.length + 1}`;
      const id = str2(a.id).trim() || uid("img");
      if (list.some((i) => i.id === id)) argError(`set_image: an image with id "${id}" already exists in ${slot}`);
      const hasBytes = typeof a.image === "string" && a.image.startsWith("data:image/");
      list.push({ id, name, image: hasBytes ? a.image : "" });
      if (slot === "backgrounds") lib.activeBackgroundId = lib.activeBackgroundId ?? id;
      else lib.activePortraitId = lib.activePortraitId ?? id;
      parts.push(`added a ${slot === "backgrounds" ? "background" : "portrait"} slot "${name}" (id ${id})${hasBytes ? "" : " \u2014 the user should upload its image in the Images dialog"}`);
    } else if (action === "remove") {
      const id = str2(a.id).trim();
      if (!id) argError("set_image remove needs an id");
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) argError(`set_image: no ${slot === "backgrounds" ? "background" : "portrait"} with id "${id}"`);
      const [gone] = list.splice(i, 1);
      if (slot === "backgrounds" && lib.activeBackgroundId === id) lib.activeBackgroundId = list[0]?.id;
      if (slot === "portraits" && lib.activePortraitId === id) lib.activePortraitId = list[0]?.id;
      parts.push(`removed ${slot === "backgrounds" ? "background" : "portrait"} "${gone.name}" (id ${id})`);
    } else if (action === "rename") {
      const id = str2(a.id).trim();
      const name = str2(a.name).trim().slice(0, 60);
      if (!id || !name) argError("set_image rename needs an id and a name");
      const img = list.find((x) => x.id === id);
      if (!img) argError(`set_image: no ${slot === "backgrounds" ? "background" : "portrait"} with id "${id}"`);
      img.name = name;
      parts.push(`renamed ${slot === "backgrounds" ? "background" : "portrait"} to "${name}" (id ${id})`);
    } else if (action === "set-active") {
      const id = str2(a.id).trim();
      const img = list.find((x) => x.id === id);
      if (!img) argError(`set_image set-active: no ${slot === "backgrounds" ? "background" : "portrait"} with id "${id}"`);
      if (slot === "backgrounds") lib.activeBackgroundId = id;
      else lib.activePortraitId = id;
      parts.push(`set active ${slot === "backgrounds" ? "background" : "portrait"} to "${img.name}" (id ${id})`);
    } else {
      argError(`set_image action must be add | remove | rename | set-active (got "${action}")`);
    }
    if (!lib.portraits.length && !lib.backgrounds.length) c.images = void 0;
    if (!parts.length) argError("set_image received no fields");
    return `images: ${parts.join(", ")}`;
  },
  /**
   * Bind library images to a RESOURCE's levels and/or a CONDITION's picture.
   * `poolId` + `levels` = the pool's per-level swaps (each level a
   * `{portraitId?, backgroundId?}` object, or null to clear that level, or
   * `levels: null` to clear all). `conditionId` + `picture` = a condition's
   * override (same shape; applies while the condition is armed — on + its
   * gate met — and WINS over a resource's level for the same slot).
   * Every reference must name an EXISTING library image id (the model sees
   * the ids + names in the sheet summary).
   */
  set_pictures(c, a) {
    const parts = [];
    const byId = (slot, id) => {
      if (typeof id !== "string" || !id) argError(`set_pictures: ${slot} reference must be a non-empty image id`);
      const found = c.images?.[slot]?.find((i) => i.id === id);
      if (!found) argError(`set_pictures: no ${slot === "portraits" ? "portrait" : "background"} with id "${id}" on this sheet`);
      return id;
    };
    const readOverride = (raw, where) => {
      if (raw === null) return null;
      if (typeof raw !== "object") argError(`${where} must be {portraitId?, backgroundId?} or null`);
      const o = raw;
      const ov = {};
      if (o.portraitId !== void 0) ov.portraitId = byId("portraits", o.portraitId);
      if (o.backgroundId !== void 0) ov.backgroundId = byId("backgrounds", o.backgroundId);
      if (!ov.portraitId && !ov.backgroundId) argError(`${where} needs at least a portraitId or a backgroundId (pass null to clear)`);
      return ov;
    };
    if (a.poolId !== void 0) {
      const node = c.nodes.find((n) => n.id === str2(a.poolId));
      if (!node) argError(`set_pictures: no node with id "${str2(a.poolId)}"`);
      if (node.type !== "resource") argError(`set_pictures: "${node.name}" is not a resource pool (per-level pictures need a pool)`);
      const levels = a.levels;
      if (levels === null) {
        node.pictures = void 0;
        parts.push(`${node.name}: all level pictures cleared`);
      } else if (levels && typeof levels === "object" && !Array.isArray(levels)) {
        const next = { ...node.pictures ?? {} };
        let touched = false;
        for (const kind of ["low", "mid", "high"]) {
          const raw = levels[kind];
          if (raw === void 0) continue;
          touched = true;
          const ov = readOverride(raw, `levels.${kind}`);
          if (ov) next[kind] = ov;
          else delete next[kind];
        }
        node.pictures = next.low || next.mid || next.high ? next : void 0;
        if (touched) {
          const set = ["low", "mid", "high"].filter((k) => next[k]);
          parts.push(`${node.name}: level pictures \u2192 ${set.length ? set.join(", ") : "none"}`);
        }
      } else {
        argError("set_pictures levels must be an object {low?, mid?, high?} or null");
      }
    }
    if (a.conditionId !== void 0) {
      const m = c.modifiers.find((x) => x.id === str2(a.conditionId));
      if (!m) argError(`set_pictures: no effect with id "${str2(a.conditionId)}"`);
      if (a.picture === void 0) argError(`set_pictures: conditionId needs a "picture" ({portraitId?, backgroundId?} or null)`);
      const ov = readOverride(a.picture, "picture");
      m.picture = ov ?? void 0;
      parts.push(`${m.name}: ${ov ? `picture \u2192 ${[ov.portraitId ? "portrait" : null, ov.backgroundId ? "background" : null].filter(Boolean).join(" + ")}` : "picture override cleared"}`);
    }
    if (!parts.length) argError("set_pictures: give poolId + levels and/or conditionId + picture");
    return `pictures: ${parts.join(", ")}`;
  },
  add_modifier(c, a) {
    const name = str2(a.name).trim();
    if (!name) argError("add_modifier name is empty");
    const kind = KINDS2.includes(a.kind) ? a.kind : "condition";
    const mod = {
      id: uid("mod"),
      name: name.slice(0, 80),
      description: optStr(a.description),
      kind,
      icon: optStr(a.icon),
      active: bool(a.active) ?? true,
      mutations: Array.isArray(a.mutations) ? a.mutations.map((mu) => normalizeMutation2(c, mu, "add_modifier.mutations[]")) : []
    };
    const decay = normalizeDecaySpec(c, a, "", "add_modifier");
    if (decay) mod.decay = decay;
    if (a.gate !== void 0) {
      const gate = normalizeGateSpec(c, a.gate, "add_modifier");
      if (gate) mod.gate = gate;
    }
    if (a.counter !== void 0) {
      const counter2 = normalizeCounterArg(c, a.counter, "add_modifier");
      if (counter2) mod.counter = counter2;
    }
    if (a.theme !== void 0) {
      if (a.theme === null) argError("add_modifier theme must be the five-color object (a brand-new effect has nothing to clear)");
      mod.theme = normalizeThemeSpec(a.theme, "add_modifier");
    }
    c.modifiers.push(mod);
    const muts = mod.mutations.length ? `, ${mod.mutations.length} mutation(s)` : "";
    const gateNote = mod.gate ? `, ${gateSummary(c, mod.gate)}` : "";
    const counterNote = mod.counter ? `, ${mod.counter.delta >= 0 ? "+" : ""}${mod.counter.delta} to ${rampRefName(c, mod.counter.target)} on ${[mod.counter.offOn !== false ? "on" : null, mod.counter.onOff === true ? "off" : null].filter(Boolean).join(" + ")} (counter)` : "";
    const themeNote = mod.theme ? `, themes the sheet while armed (accent ${mod.theme.accent})` : "";
    return `added ${kind} "${mod.name}" (id ${mod.id}${decay ? `, ${decay.kind} ${decay.decayRatePerMinute}/min on ${decay.statTarget}` : ""}${muts}${gateNote}${counterNote}${themeNote})`;
  },
  set_modifier(c, a) {
    const m = findMod(c, str2(a.id));
    const parts = [];
    if (a.name !== void 0) {
      const n = str2(a.name).trim();
      if (!n) argError("set_modifier name is empty");
      m.name = n.slice(0, 80);
      parts.push(`name \u2192 "${m.name}"`);
    }
    if (a.kind !== void 0) {
      const k = str2(a.kind).trim();
      if (!KINDS2.includes(k)) argError(`set_modifier kind must be one of ${KINDS2.join(", ")}`);
      m.kind = k;
      parts.push(`kind \u2192 ${k}`);
    }
    if (a.description !== void 0) {
      m.description = optStr(a.description);
      parts.push(`description \u2192 ${m.description ?? "cleared"}`);
    }
    if (a.icon !== void 0) {
      m.icon = optStr(a.icon);
      parts.push(`icon \u2192 ${m.icon ?? "cleared"}`);
    }
    if (a.active !== void 0) {
      const on = bool(a.active);
      if (on === void 0) argError("set_modifier active must be true/false");
      m.active = on;
      parts.push(on ? "enabled" : "disabled");
    }
    if (Array.isArray(a.mutations)) {
      const next = a.mutations.map((mu) => normalizeMutation2(c, mu, "set_modifier.mutations[]"));
      m.mutations = next;
      parts.push(`mutations \u2192 ${next.map((mu) => `${mu.operator} ${mu.targetStatId}=${String(mu.value)}`).join("; ") || "(none)"}`);
    }
    if (a.addMutation !== void 0) {
      const mu = normalizeMutation2(c, a.addMutation, "set_modifier.addMutation");
      m.mutations.push(mu);
      parts.push(`mutation + ${mu.operator} ${mu.targetStatId}=${String(mu.value)}`);
    }
    if (a.setMutation !== void 0) {
      const i = num3(a.mutationIndex);
      if (i === void 0 || !Number.isInteger(i) || i < 0 || i >= m.mutations.length) argError(`set_modifier mutationIndex must be an integer 0\u2013${m.mutations.length - 1} (got ${a.mutationIndex})`);
      const mu = normalizeMutation2(c, a.setMutation, "set_modifier.setMutation");
      m.mutations[i] = mu;
      parts.push(`mutation #${i} \u2192 ${mu.operator} ${mu.targetStatId}=${String(mu.value)}`);
    } else if (a.mutationIndex !== void 0) {
      const i = num3(a.mutationIndex);
      if (i === void 0 || !Number.isInteger(i) || i < 0 || i >= m.mutations.length) argError(`set_modifier mutationIndex must be an integer 0\u2013${m.mutations.length - 1} (got ${a.mutationIndex})`);
      const [gone] = m.mutations.splice(i, 1);
      parts.push(`mutation #${i} (${gone.operator} ${gone.targetStatId}) removed`);
    }
    if (a.gate !== void 0) {
      const gate = normalizeGateSpec(c, a.gate, "set_modifier");
      if (gate === null) {
        m.gate = void 0;
        parts.push("gate cleared");
      } else {
        m.gate = gate;
        parts.push(`gate: ${gateSummary(c, gate)}`);
      }
    }
    if (a.counter !== void 0) {
      const counter2 = normalizeCounterArg(c, a.counter, "set_modifier");
      m.counter = counter2 ?? void 0;
      parts.push(counter2 ? `counter: ${counter2.delta >= 0 ? "+" : ""}${counter2.delta} to ${rampRefName(c, counter2.target)} on ${[counter2.offOn !== false ? "on" : null, counter2.onOff === true ? "off" : null].filter(Boolean).join(" + ")}` : "counter cleared");
    }
    if (a.theme !== void 0) {
      if (a.theme === null) {
        m.theme = void 0;
        parts.push("theme cleared");
      } else {
        m.theme = normalizeThemeSpec(a.theme, "set_modifier");
        parts.push(`theme \u2192 accent ${m.theme.accent}`);
      }
    }
    if (!parts.length) argError("set_modifier received no fields to set");
    return `effect "${m.name}": ${parts.join(", ")}`;
  },
  remove_modifier(c, a) {
    const m = findMod(c, str2(a.id));
    c.modifiers = c.modifiers.filter((x) => x.id !== m.id);
    pruneRamps(c);
    return `removed effect "${m.name}"`;
  },
  /**
   * Add or edit a sheet-level RAMP link: "when <watch> changes, shift
   * <target> by step." `watch` and `target` are refs ({kind, id} for a
   * node/toggle; {kind:'item', listId, itemId} for a list item); a TARGET
   * can never be a toggle. `add` (default) creates one (a `name` is
   * optional); `set` edits one by id (name / direction / step / watch /
   * target / watchFrom / active); `remove` deletes by id; `clear` drops
   * every ramp on the sheet. A node target shifts its BASE value (clamped
   * to its min/max); an item target shifts its quantity (whole number,
   * min 1).
   */
  set_ramp(c, a) {
    const action = a.action === void 0 ? "add" : str2(a.action);
    const refOf = (side) => normalizeRampRefArg(c, a[side], `set_ramp ${side}`);
    if (action === "clear") {
      c.ramps = void 0;
      return "ramps cleared (none left on the sheet)";
    }
    if (action === "remove") {
      const id = str2(a.id).trim();
      if (!id) argError("set_ramp remove needs an id");
      const i = (c.ramps ?? []).findIndex((r) => r.id === id);
      if (i < 0) argError(`no ramp with id "${id}" on this sheet`);
      const [gone] = c.ramps.splice(i, 1);
      if (!c.ramps.length) c.ramps = void 0;
      return `removed ramp "${gone.name}"`;
    }
    if (action === "set") {
      const id = str2(a.id).trim();
      if (!id) argError("set_ramp set needs an id");
      const r = (c.ramps ?? []).find((x) => x.id === id);
      if (!r) argError(`no ramp with id "${id}" on this sheet`);
      const parts = [];
      if (a.name !== void 0) {
        const n = str2(a.name).trim();
        if (!n) argError("set_ramp set name is empty");
        r.name = n.slice(0, 80);
        parts.push(`name \u2192 "${r.name}"`);
      }
      if (a.watch !== void 0) {
        r.watch = refOf("watch");
        parts.push(`watch \u2192 ${rampRefName(c, r.watch)}`);
      }
      if (a.target !== void 0) {
        const t = refOf("target");
        if (t.kind === "toggle") argError("set_ramp target cannot be a toggle (the target must be a stat/pool or a list item)");
        r.target = t;
        parts.push(`target \u2192 ${rampRefName(c, r.target)}`);
      }
      if (a.direction !== void 0) {
        if (a.direction !== "up" && a.direction !== "down") argError(`set_ramp direction must be 'up' or 'down' (got ${JSON.stringify(a.direction)})`);
        r.direction = a.direction;
        parts.push(`direction \u2192 ${a.direction}`);
      }
      if (a.step !== void 0) {
        const s = num3(a.step);
        if (s === void 0) argError("set_ramp step must be a finite number");
        r.step = round2(s);
        parts.push(`step \u2192 ${r.step}`);
      }
      if (a.watchFrom !== void 0) {
        if (a.watchFrom === null) {
          delete r.watchFrom;
          parts.push("watchFrom cleared");
        } else if (typeof a.watchFrom === "boolean" || typeof a.watchFrom === "number" && Number.isFinite(a.watchFrom)) {
          r.watchFrom = typeof a.watchFrom === "boolean" ? a.watchFrom : round2(a.watchFrom);
          parts.push(`watchFrom \u2192 ${typeof r.watchFrom === "boolean" ? r.watchFrom ? "on" : "off" : r.watchFrom}`);
        } else {
          argError("set_ramp watchFrom must be a number, a boolean, or null (clear)");
        }
      }
      if (a.active !== void 0) {
        if (typeof a.active !== "boolean") argError("set_ramp active must be true or false");
        r.active = a.active;
        parts.push(a.active ? "enabled" : "disabled");
      }
      if (!parts.length) argError("set_ramp set received no fields to change");
      return `ramp "${r.name}": ${parts.join(", ")}`;
    }
    if (action !== "add") argError(`set_ramp action must be add | set | remove | clear (got "${action}")`);
    const watch = refOf("watch");
    const target = refOf("target");
    if (target.kind === "toggle") argError("set_ramp target cannot be a toggle (the target must be a stat/pool or a list item)");
    const step = num3(a.step);
    if (step === void 0) argError("set_ramp step must be a finite number (e.g. 1 or -2)");
    const direction = a.direction === "down" ? "down" : "up";
    let watchFrom;
    if (typeof a.watchFrom === "boolean") watchFrom = a.watchFrom;
    else if (typeof a.watchFrom === "number" && Number.isFinite(a.watchFrom)) watchFrom = round2(a.watchFrom);
    const name = str2(a.name).trim().slice(0, 80) || `${rampRefName(c, watch)} \u2192 ${rampRefName(c, target)}`;
    const ramp = { id: uid("ramp"), name, watch, target, direction, step: round2(step), ...watchFrom !== void 0 ? { watchFrom } : {}, active: typeof a.active === "boolean" ? a.active : true };
    if (!c.ramps) c.ramps = [];
    c.ramps.push(ramp);
    return `added ramp "${ramp.name}" (id ${ramp.id}): ${rampLine(c, ramp)}`;
  },
  add_list(c, a) {
    const name = str2(a.name).trim();
    if (!name) argError("add_list name is empty");
    const capacity = num3(a.capacity) ?? 10;
    if (capacity < 0 || capacity > 1e4) argError("add_list capacity must be 0\u201310000");
    const list = {
      id: uid("list"),
      name: name.slice(0, 80),
      capacity,
      icon: optStr(a.icon),
      items: []
    };
    c.lists.push(list);
    return `added list "${list.name}" (capacity ${capacity}, id ${list.id})`;
  },
  update_list(c, a) {
    const l = findList(c, str2(a.id));
    const parts = [];
    if (a.name !== void 0) {
      const n = str2(a.name).trim();
      if (!n) argError("update_list name is empty");
      l.name = n.slice(0, 80);
      parts.push(`name \u2192 "${l.name}"`);
    }
    if (a.capacity !== void 0) {
      const cap = num3(a.capacity);
      if (cap === void 0 || cap < 0 || cap > 1e4) argError("update_list capacity must be 0\u201310000");
      l.capacity = cap;
      parts.push(`capacity \u2192 ${cap}`);
    }
    if (a.icon !== void 0) {
      l.icon = optStr(a.icon);
      parts.push(`icon \u2192 ${l.icon ?? "cleared"}`);
    }
    if (!parts.length) argError("update_list received no fields to set");
    return `list "${l.name}": ${parts.join(", ")}`;
  },
  remove_list(c, a) {
    const l = findList(c, str2(a.id));
    c.lists = c.lists.filter((x) => x.id !== l.id);
    c.modifiers = c.modifiers.map((m) => ({
      ...m,
      mutations: m.mutations.filter((mu) => mu.targetStatId !== `capacity:${l.id}`)
    }));
    pruneRamps(c);
    return `removed list "${l.name}"`;
  },
  add_item(c, a) {
    const l = findList(c, str2(a.listId));
    const name = str2(a.name).trim();
    if (!name) argError("add_item name is empty");
    const qty = num3(a.qty) ?? 1;
    if (qty < 1 || qty > 1e4) argError("add_item qty must be 1\u201310000");
    l.items.push({ id: uid("item"), name: name.slice(0, 80), qty: Math.floor(qty) });
    return `added "${l.items[l.items.length - 1].name} \xD7${l.items[l.items.length - 1].qty}" to ${l.name}`;
  },
  set_item(c, a) {
    const l = findList(c, str2(a.listId));
    const it = l.items.find((i) => i.id === str2(a.itemId));
    if (!it) argError(`no item with id "${str2(a.itemId)}" in ${l.name}`);
    const parts = [];
    if (a.name !== void 0) {
      const n = str2(a.name).trim();
      if (!n) argError("set_item name is empty");
      it.name = n.slice(0, 80);
      parts.push(`name \u2192 "${it.name}"`);
    }
    if (a.qty !== void 0) {
      const q = num3(a.qty);
      if (q === void 0 || q < 1 || q > 1e4) argError("set_item qty must be 1\u201310000");
      it.qty = Math.floor(q);
      parts.push(`qty \u2192 ${it.qty}`);
    }
    if (!parts.length) argError("set_item received no fields to set");
    return `item "${it.name}": ${parts.join(", ")}`;
  },
  remove_item(c, a) {
    const l = findList(c, str2(a.listId));
    const it = l.items.find((i) => i.id === str2(a.itemId));
    if (!it) argError(`no item with id "${str2(a.itemId)}" in ${l.name}`);
    l.items = l.items.filter((i) => i.id !== it.id);
    pruneRamps(c);
    return `removed "${it.name}" from ${l.name}`;
  }
};
var TOOL_NAMES = Object.keys(HANDLERS);
function applyToolCalls(character, calls) {
  const c = cloneCharacter(character);
  const legacyPortrait = character.__legacyPortrait;
  ensureImageLibrary(c, typeof legacyPortrait === "string" ? legacyPortrait : void 0);
  const applied = [];
  const errors = [];
  for (const call of calls) {
    const handler = HANDLERS[call.name];
    if (!handler) {
      errors.push(`unknown tool "${call.name}"`);
      continue;
    }
    try {
      applied.push(handler(c, parseArgs(call.arguments)));
    } catch (e) {
      errors.push(`${call.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { character: c, applied, errors };
}
function characterSummary(c) {
  const tags = c.tags?.length ? ` [tags: ${c.tags.join(", ")}]` : "";
  const themeLine = c.theme ? `Theme (sheet base): background ${c.theme.background} / surface ${c.theme.surface} / border ${c.theme.border} / text ${c.theme.text} / accent ${c.theme.accent}` : 'Theme (sheet base): stock "tome" palette (no custom theme set)';
  const lines = [`Character: ${c.name}${c.race ? ` (${c.race})` : ""}${c.class ? ` the ${c.class}` : ""}${c.level ? `, level ${c.level}` : ""}${tags}`];
  lines.push(themeLine);
  lines.push("");
  const imgLine = (list, activeId) => list.map((i) => `${i.id}="${i.name}"${i.image ? "" : " (no image yet \u2014 user must upload)"}${i.id === activeId ? " *active" : ""}`).join(", ");
  const picRef = (o) => [o.portraitId ? `portrait ${o.portraitId}` : null, o.backgroundId ? `background ${o.backgroundId}` : null].filter(Boolean).join(" + ");
  const picsLine = (p) => ["low", "mid", "high"].filter((k) => p[k]).map((k) => `${k}\u2192${picRef(p[k])}`).join(", ");
  if (c.images?.portraits.length || c.images?.backgrounds.length) {
    lines.push("Image library (reference these ids in set_pictures):");
    lines.push(`  portraits: ${c.images.portraits.length ? imgLine(c.images.portraits, c.images.activePortraitId) : "(none)"}`);
    lines.push(`  backgrounds: ${c.images.backgrounds.length ? imgLine(c.images.backgrounds, c.images.activeBackgroundId) : "(none)"}`);
    lines.push("");
  }
  lines.push("Stats / Resources:");
  for (const n of c.nodes) {
    const v = typeof n.baseValue === "number" ? String(n.baseValue) : JSON.stringify(n.baseValue);
    const eb = effectiveBounds(n, c.modifiers, c.nodes);
    const bounds = eb.min !== void 0 || eb.max !== void 0 ? ` [${eb.min ?? 0}\u2013${eb.max ?? "\u221E"}]` : "";
    const decay = n.decay ? ` (${n.decay.kind} ${n.decay.decayRatePerMinute}/min)` : "";
    const fx = n.fx ? [
      n.fx.high ? `fx-high: ${n.fx.high.effect} at ${n.fx.high.at}%${n.fx.high.words ? ` [${n.fx.high.words.join(", ")}]` : ""}${n.fx.high.rate ? ` [rate ${Math.round(n.fx.high.rate * 100)}%]` : ""}` : null,
      n.fx.low ? `fx-low: ${n.fx.low.effect} at ${n.fx.low.at}%${n.fx.low.words ? ` [${n.fx.low.words.join(", ")}]` : ""}${n.fx.low.rate ? ` [rate ${Math.round(n.fx.low.rate * 100)}%]` : ""}` : null
    ].filter(Boolean).join(" ") : "";
    const bgFx = n.bgFx ? [
      n.bgFx.high ? `bgfx-high: ${n.bgFx.high.effect} at ${n.bgFx.high.at}%${n.bgFx.high.words ? ` [${n.bgFx.high.words.join(", ")}]` : ""}${n.bgFx.high.rate ? ` [rate ${Math.round(n.bgFx.high.rate * 100)}%]` : ""}` : null,
      n.bgFx.low ? `bgfx-low: ${n.bgFx.low.effect} at ${n.bgFx.low.at}%${n.bgFx.low.words ? ` [${n.bgFx.low.words.join(", ")}]` : ""}${n.bgFx.low.rate ? ` [rate ${Math.round(n.bgFx.low.rate * 100)}%]` : ""}` : null
    ].filter(Boolean).join(" ") : "";
    const colors = n.colors ? ` [colors: full ${n.colors.full ?? "\u2014"} / empty ${n.colors.empty ?? "\u2014"}]` : "";
    const hidden = n.display.visible === false ? " [hidden]" : "";
    const pics = n.pictures && (n.pictures.low || n.pictures.mid || n.pictures.high) ? ` [pictures: ${picsLine(n.pictures)}]` : "";
    lines.push(`  - ${n.name} = ${v}${bounds}${decay}  (id: ${n.id}, ${n.section}, type: ${n.type}${fx ? `, ${fx}` : ""}${bgFx ? `, ${bgFx}` : ""}${colors}${pics}${hidden})`);
  }
  if (c.modifiers.length) {
    lines.push("");
    lines.push("Effects (conditions/buffs/curses/enchantments/equipment):");
    for (const m of c.modifiers) {
      const muts = m.mutations.map((mu, i) => `#${i} ${mu.operator} ${mu.targetStatId}=${String(mu.value)}`).join("; ");
      const decay = m.decay ? ` (ticking ${m.decay.kind} ${m.decay.decayRatePerMinute}/min on ${m.decay.statTarget})` : "";
      const gateNode = m.gate ? c.nodes.find((n) => n.id === m.gate.poolId)?.name ?? m.gate.poolId : "";
      const gate = m.gate ? ` (${(() => {
        const g = m.gate;
        const name = gateNode;
        const value = g.mode === "value";
        if (g.bands?.length) {
          const lvl = g.bands.map((b) => `${b.kind}${b.at !== void 0 ? ` ${b.kind === "high" ? "\u2265" : b.kind === "low" ? "\u2264" : "\xB7"} ${b.at}` : ""}${b.mutations.length ? `: ${b.mutations.length} mutation(s)` : ": nothing"}`).join(", ");
          return `${value ? "value" : "pool"} gate: applies per level while ${name} is in that band \u2014 ${lvl}`;
        }
        if (value) return `value gate: applies only while ${name} is ${g.compare === "lte" ? "\u2264" : "\u2265"} ${g.at ?? 0}`;
        return `pool gate: applies only while ${name} \u2265 ${g.at ?? 0}% full`;
      })()})` : "";
      const counterNote = m.counter ? ` (counter: ${m.counter.delta >= 0 ? "+" : ""}${m.counter.delta} to ${rampRefName(c, m.counter.target)} on ${[m.counter.offOn !== false ? "on" : null, m.counter.onOff === true ? "off" : null].filter(Boolean).join(" + ")})` : "";
      const mpic = m.picture ? ` [picture override while armed: ${picRef(m.picture)}]` : "";
      lines.push(`  - ${m.name} [${m.kind}, ${m.active ? "active" : "inactive"}]${decay}${gate}${muts ? ` \u2014 ${muts}` : ""}${mpic}${counterNote}${m.theme ? ` (themes the sheet while armed: accent ${m.theme.accent})` : ""}  (id: ${m.id})`);
    }
  }
  if (c.lists.length) {
    lines.push("");
    lines.push("Lists:");
    for (const l of c.lists) {
      const items = l.items.map((i) => `${i.name}\xD7${i.qty}`).join(", ") || "empty";
      lines.push(`  - ${l.name} (capacity ${l.capacity ?? "\u2014"}): ${items}  (id: ${l.id}, items: ${l.items.map((i) => i.id).join(", ") || "\u2014"})`);
    }
  }
  if (c.ramps?.length) {
    lines.push("");
    lines.push("Ramps (sheet-level links: when one value changes, another shifts \u2014 edit via set_ramp):");
    for (const r of c.ramps) {
      const watchFrom = r.watchFrom !== void 0 ? typeof r.watchFrom === "boolean" ? r.watchFrom ? " from ON" : " from OFF" : ` from ${r.watchFrom}` : "";
      lines.push(
        `  - ${r.name} [${r.active ? "on" : "off"}]: when ${rampRefName(c, r.watch)} ${r.direction === "down" ? "decreases" : "increases"}${watchFrom} \u2192 ${rampRefName(c, r.target)} ${r.step >= 0 ? "+" : ""}${r.step}  (id: ${r.id}, watch: ${JSON.stringify(r.watch)}, target: ${JSON.stringify(r.target)})`
      );
    }
  }
  return lines.join("\n");
}
function characterForServer(c) {
  const { portrait, ...rest } = c;
  return { ...rest, nodes: c.nodes, modifiers: c.modifiers, lists: c.lists };
}
function isApplyableCharacterJson(v) {
  if (typeof v !== "object" || v === null) return false;
  const c = v;
  return typeof c.id === "string" && typeof c.name === "string" && Array.isArray(c.nodes) && Array.isArray(c.modifiers) && Array.isArray(c.lists) && // tags/cardOrder: cloneCharacter (the next step) spreads both — a
  // partial payload without them threw a TypeError inside applyToolCalls.
  Array.isArray(c.tags) && Array.isArray(c.cardOrder);
}

// src/core/llm-round.ts
var MAX_ROUNDS = 2;
var toCharacter = (c) => ({ ...c, portrait: void 0 });
var SYSTEM_PROMPT = (sheet) => `You are the data-entry assistant inside a character-tracker web app. The user describes sheet changes in plain language; you turn them into tool calls.

CURRENT SHEET (ground truth \u2014 the ONLY ids that exist):
${sheet}

RULES:
- Only reference ids that appear on the sheet above. Never invent an id.
- MULTI-STEP: a request often needs several tool calls (e.g. "create a pool, then an effect that references it"). Emit EVERY call you need in one response \u2014 they run in order on the same sheet. If a later call must reference an entry that an earlier call creates, you do not know that entry's id yet; use your best name for it. If it fails, I will show you the created entry's REAL id and ask you to reissue ONLY the failed call.
- "Add <thing>" \u2192 add_node (stats/pools), add_modifier (effects), add_list, or add_item, whichever fits.
- Setting a value: use update_node with the ABSOLUTE value (current + delta if the user said "by N").
- "I take 8 damage to <pool>" / "drain" \u2192 update_node baseValue = current \u2212 amount.
- "Give me a <condition/buff/curse/enchantment/equipment>" \u2192 add_modifier with that kind.
- "Remove/cure/drop <thing>" \u2192 the matching remove_* tool.
- "Cure X" when X is a ticking effect \u2192 set_modifier active:false (or remove if the user says remove).
- Effect stat changes ("while poisoned, Strength \u22122", "double my max Mana", "this enchantment makes it invisible") \u2192 set_modifier with addMutation (or setMutation/mutationIndex for a specific existing one). The sheet shows each mutation's index (#0, #1, \u2026).
- Pool-conditional effects ("Strength +4 while Mana is at least 70%", "haste only while the pool is above 50", "stop this when the pool drops below 25") \u2192 add_modifier / set_modifier with a "gate" object holding poolId and at. The at value is the fill PERCENT the pool must reach (0-100); a pool "full" = 100, "half" = 50. Remove the gate with gate: null.
- Pool-LEVEL effects ("when the pool is low I get weak, when it's full I get strong", "at mid pool I regenerate", "low = nothing, high = +4 Str") \u2192 gate with "bands": one entry per level, {"kind":"low"|"mid"|"high", "at": <optional boundary %>, "mutations": [ ... ]}. Defaults without at: low = fill \u2264 33.33%, high = fill \u2265 66.67%, mid = in between. A level with no/empty mutations applies nothing. Multiple mutations per level are fine.
- VALUE-conditional effects ("when my Strength hits 14", "when HP is 5 or less", "once my Mana reaches 200") \u2192 gate with "mode":"value" and poolId pointing at that node, plus a single "at": use "compare":"gte" (default) for "reaches / at least N" (value \u2265 at) or "compare":"lte" for "drops below / at most N" (value \u2264 at). This is the node's ABSOLUTE number, NOT a percent of the bar. For value LEVELS ("strength below 10 X, 10-19 Y, 20+ Z") \u2192 mode:value with "bands": each {"kind","at","mutations"} where at is an absolute value boundary (low = value \u2264 at, high = value \u2265 at, mid between); multiple mutations per level are fine.
- RAMPS ("when <A> goes up, <B> also goes up", "every time I spend one, another drops", "when my Health rises, add to my Stamina") \u2192 a sheet-level NUMBER LINK, NOT an effect (an effect shifts a value WHILE ON; a ramp shifts a value when ANOTHER value MOVES). Use set_ramp action:add with watch (the value being tracked) + target (the value that shifts) + direction (up = watch increases / toggle turns on; down = watch decreases / toggle turns off) + step (points to move, negative = down). A watch/target is a ref: {"kind":"node","id":"<id>"} for a stat/pool, {"kind":"item","listId":"<listId>","itemId":"<itemId>"} for a list item, {"kind":"toggle","id":"<effectId>"} to watch an effect turning on/off (targets can be a node or item, never a toggle). "When Health goes up, Stamina +1" \u2192 {watch:{kind:"node",id:"<health>"},target:{kind:"node",id:"<stamina>"},direction:"up",step:1}. "Each time I use a potion, lose 2 Mana" \u2192 watch the potion item (kind:item) direction:down, target the Mana node, step:2. "When I turn off the curse, restore 5 Health" \u2192 watch {kind:"toggle",id:"<curse>"} direction:down (turning OFF), target the Health node, step:5.
- COUNTERS ("each time I activate <condition>, <pool/item> goes down by one", "every time this buff is toggled on, my Stamina \u22121") \u2192 a rule on THAT effect: add_modifier / set_modifier with a "counter" object {target: <ref>, delta: <points>, offOn?: true, onOff?: true}. It fires whenever the effect toggles: offOn (default true) = when it turns ON, onOff (default false) = when it turns OFF. The target is a stat/pool (kind:node) or list item (kind:item) \u2014 never a toggle. "Each time Heroism is turned on, lose 1 Mana" \u2192 on the Heroism effect, counter:{target:{kind:"node",id:"<mana>"},delta:-1}. Remove a counter with counter:null.
- "Make the pool turn <color> at full / when low" \u2192 update_node colorFull / colorEmpty (TWO separate colors \u2014 one for 100%, one for 0%). "Color the whole bar <color>" \u2192 update_node color (sets both).
- "Show floating words/hearts/dribble when the bar is low/high" \u2192 set_node_fx with a low/high side object; "stop the <effect> when <low/full>" \u2192 set_node_fx that side as null.
- "Play <effect> in the BACKGROUND / across the whole screen / behind the scene (big hearts and sparks rising from the BOTTOM of the screen, drips from the top, words floating anywhere)" \u2192 set_node_bg_fx with the side object \u2014 the dedicated background effect, a SEPARATE entity from the on-bar effect (set_node_fx). Its particles are larger and it keeps playing even when the pool bar is off-screen. "Stop the background <effect>" \u2192 set_node_bg_fx that side as null.
- "Hypnosis / mind control / swirling / spiraling / hypnotic / trance background" \u2192 the "spiral" effect on set_node_bg_fx: a large rotating hypnotic swirl behind the panels across the whole screen, tinted by the bar's color (use update_node colorEmpty/colorFull to pick the hypno hue); the rate (0.5\u20131.5) sets its intensity (spin speed + brightness + mote density). "spiral" also works on set_node_fx (a smaller swirl anchored to the bar).
- "Make the page/sheet <color>-themed / change the theme" \u2192 set_theme with the five colors {background, surface, border, text, accent} (always all five, #rrggbb); "back to the normal theme" \u2192 set_theme theme:null. A theme that depends on a condition ("green while HP is low") is an EFFECT's theme: add_modifier / set_modifier with the gate AND a theme.
- "Show a different PICTURE when <pool> is low / mid / high", or "show <name> while <pool> is low" \u2192 set_pictures with poolId + levels (levels.low/mid/high each = {portraitId?, backgroundId?}; e.g. show the Injured portrait at low \u2192 levels.low = {portraitId: "<id>"}). "When the pool is full, show the <name> background" \u2192 levels.high = {backgroundId}.
- "Show <picture> while I'm <condition> / while poisoned / while buffed" \u2192 set_pictures with conditionId + picture = {portraitId?/backgroundId?} (applies while that effect is ON + its gate met).
- PICTURE PRIORITY: a condition's picture WINS over a pool-level picture for the SAME slot; a condition's portrait and a pool's background can show at the same time. The user uploads the actual image files in the Images dialog \u2014 you only NAME slots (set_image) and BIND them (set_pictures). If a slot still has no image, tell the user to upload it in the Images dialog.
- "Add a portrait/background called <name>" \u2192 set_image (slot + action:add + name). "Make <name> the default portrait/background" \u2192 set_image action:set-active. "Remove the <name> picture" \u2192 set_image action:remove.
- "Add a note field / label called X" \u2192 add_node section stats, type text, value the string.
- If a number or name is ambiguous, pick the most sensible reading and state it in your reply.
- Change ONLY what the user asked. Never touch unrelated sheet entries.
- If the request is unclear, or needs something the tools cannot express, do NOT call tools \u2014 say specifically WHY in one or two sentences. Name the gap rather than guessing (e.g. "there is no stat called X on the sheet", or "I can't set a per-hour timer \u2014 decay is per-minute only"). A bare "no changes" is not acceptable.
- When you do call tools, also write a one-line confirmation of what changed.`;
async function runApply(character, userMessage, signal, complete) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT(characterSummary(toCharacter(character))) },
    { role: "user", content: userMessage }
  ];
  let applied = [];
  let errors = [];
  let reply = "";
  let rounds = 0;
  let current = character;
  let sheet = characterSummary(toCharacter(character));
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    rounds = round;
    const choice = await complete(messages, signal);
    reply = choice.content ?? reply;
    const calls = choice.toolCalls.map((tc) => ({ name: tc.name, arguments: tc.arguments }));
    if (!calls.length) break;
    messages.push({
      role: "assistant",
      content: choice.content,
      tool_calls: choice.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments }
      }))
    });
    const result = applyToolCalls(toCharacter(current), calls);
    current = characterForServer(result.character);
    applied = applied.concat(result.applied);
    errors = result.errors;
    sheet = characterSummary(toCharacter(current));
    if (errors.length) {
      if (round >= MAX_ROUNDS) break;
      for (const tc of choice.toolCalls) {
        messages.push({ role: "tool", tool_call_id: tc.id, content: "FAILED \u2014 see the note below" });
      }
      const landed = applied.length ? `So far applied: ${applied.join(" | ")}.` : "Nothing has been applied yet.";
      messages.push({
        role: "user",
        content: `Some tool calls failed validation: ${errors.join(" | ")}. ${landed} The sheet's CURRENT state is below \u2014 it includes the REAL ids of anything an earlier call just created, so reference those ids (not invented ones) for any follow-up call.

CURRENT SHEET (ground truth \u2014 the ONLY ids that exist):
${sheet}`
      });
      continue;
    }
    break;
  }
  return { character: current, applied, errors, reply, rounds };
}

// vite-llm.ts
var LLM_TIMEOUT_MS2 = 12e4;
function brainErrorStatus(msg) {
  if (/timed out|abort/i.test(msg)) return 504;
  if (/HTTP 40\d|unauthorized|forbidden/i.test(msg)) return 502;
  return 500;
}
function genericBrainError(msg) {
  if (/timed out|abort/i.test(msg)) return "The brain timed out.";
  const http2 = /HTTP (\d{3})/i.exec(msg);
  if (http2) return `The brain endpoint replied HTTP ${http2[1]}.`;
  if (/no choice/i.test(msg)) return "The brain returned no answer.";
  return "The brain could not be reached.";
}
var MAX_BODY_BYTES2 = 8 * 1024 * 1024;
var ROOT = process.cwd();
var T = (name, description, properties, required) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required: required ?? [] } }
});
var ICON_ENUM_NOTE = "one of: user, heart, drop, shield, bolt, flask, star, eye, paw, skull, moon, book, crown, tag, bag, gear, scroll, clock, edit, x, check";
var REF_PROP = {
  type: "object",
  description: `A ref to a value on this sheet. Three shapes: {"kind":"node","id":"<nodeId>"} (a stat/pool's value) \xB7 {"kind":"item","listId":"<listId>","itemId":"<itemId>"} (a list item's quantity) \xB7 {"kind":"toggle","id":"<effectId>"} (an effect's on/off state). Use ONLY ids that appear in the CURRENT SHEET. A TARGET can be a node or an item (never a toggle).`
};
var COUNTER_PROP = {
  type: ["object", "null"],
  description: 'A COUNTER: every time THIS effect toggles, shift a stat/pool or list item by a fixed amount. {target: <ref>, delta: <number>, offOn?: true/false, onOff?: true/false}. offOn (default true) = fire when it turns ON; onOff (default false) = fire when it turns OFF. e.g. "each time this buff is turned on, Stamina \u22121" \u2192 {target:{kind:"node",id:"<stamina id>"},delta:-1}. null clears the counter.'
};
var TOOLS = [
  T("set_header", "Change the character header (name, race, class, level, tags). Omit fields you do not change; passing tags replaces the whole tag list.", {
    name: { type: "string", description: "Character name" },
    race: { type: "string" },
    class: { type: "string" },
    level: { type: "number" },
    tags: { type: "array", items: { type: "string" }, description: "replace the tag list; [] clears all" }
  }),
  T("add_node", "Add a new stat, resource pool, or text field to the sheet.", {
    name: { type: "string" },
    section: { type: "string", enum: ["stats", "pools"], description: "stats = plain numeric stat or text field; pools = resource bar with min/max" },
    type: { type: "string", enum: ["text", "numeric", "resource"], description: "optional; default numeric (resource auto for pools). text = a string value, not a number" },
    value: { oneOf: [{ type: "number" }, { type: "string" }], description: "starting value (number, or the string itself for text)" },
    min: { type: "number", description: "resource pools: minimum (default 0)" },
    max: { type: "number", description: "resource pools: capacity (default 100)" },
    icon: { type: "string", description: ICON_ENUM_NOTE },
    decay: { type: "number", description: "optional: value lost per minute while away" },
    regen: { type: "boolean", description: "optional: true if the rate is gained per minute instead of lost" }
  }, ["name", "section"]),
  T("update_node", "Change an existing stat or resource: value, name, bounds, icon, format, display, bar colors, or per-minute decay/regen rate.", {
    id: { type: "string", description: "node id from the sheet (e.g. stat_str, pool_hp)" },
    name: { type: "string", description: "rename the stat" },
    baseValue: { oneOf: [{ type: "number" }, { type: "string" }], description: "set the current value (absolute, not a delta; string for text nodes)" },
    min: { type: "number" },
    max: { type: "number", description: "capacity for resource pools" },
    icon: { type: "string", description: ICON_ENUM_NOTE },
    format: { type: "string", enum: ["score", "bar", "plain"] },
    color: { type: "string", description: "#rrggbb \u2014 set BOTH the full and empty bar colors at once (use when the user means one color for the whole bar)" },
    colorFull: { type: "string", description: '#rrggbb \u2014 color at 100% (the "at full" end of the bar) only' },
    colorEmpty: { type: "string", description: '#rrggbb \u2014 color at 0% (the "at low"/empty end of the bar) only' },
    visible: { type: "boolean", description: "true = show, false = hide from the grid" },
    accent: { type: "string", description: "display accent color #rrggbb for the card; empty string clears it" },
    decay: { type: "number", description: "value lost per minute while away; 0 removes any decay" },
    regen: { type: "boolean", description: "true if the rate is gained per minute" },
    statTarget: { type: "string", description: "id of the node the rate applies to; defaults to this node" },
    clearDecay: { type: "boolean", description: "true to remove any existing decay/regen" }
  }, ["id"]),
  T("set_node_fx", `Set the threshold visual effects on a resource pool. The bar has two ends: "high" = at full (triggers when the bar fills to at% or more), "low" = at low (triggers when it drains to at% or less). Each side is an object { effect, at, words?, rate? } or null to clear that side. rate (optional, a number from 0.5 to 1.5) is the particle spawn rate as a multiple of the effect's default (1 = default, 0.5 = half as many particles, 1.5 = 50% more); omit it for the default. Effects: dribble (drips when low / sparkles when high), text (floating words, needs "words"), hearts (floating hearts when low), orbs (small magical glowing orbs that rise and twinkle), spiral (a rotating hypnotic swirl centered on screen, tinted by the bar's color \u2014 a mind-control / hypnosis look; the rate sets its intensity).`, {
    id: { type: "string", description: "resource pool id from the sheet" },
    high: { type: ["object", "null"], description: 'effect at the full end, e.g. {"effect":"dribble","at":90,"rate":1.5}; null clears it' },
    low: { type: ["object", "null"], description: 'effect at the empty end, e.g. {"effect":"text","at":25,"words":["hungry","feed me"]}; null clears it' }
  }, ["id"]),
  T("set_node_bg_fx", `Set the BACKGROUND threshold visual effects on a resource pool \u2014 the dedicated whole-screen effect that plays BEHIND the panels across the entire view (hearts/orbs rise from the bottom of the screen, drips fall in from the top edge, text floats in at random positions; particles are LARGER than the on-bar effect, and it keeps running even when the pool bar is scrolled off-screen). This is a SEPARATE effect from set_node_fx (the one hugging the bar): use it when the user wants the effect in the background / across the whole screen / behind the scene. Same bar ends ("high" = at full, "low" = at low) and same side shapes, including the optional rate (0.5\u20131.5, a multiple of the default spawn rate). The "spiral" effect is a great whole-screen choice here: a large rotating hypnotic swirl behind the panels (mind-control / hypnosis theme), tinted by the bar's color; the rate (0.5\u20131.5) sets its intensity (spin speed + brightness + mote density).`, {
    id: { type: "string", description: "resource pool id from the sheet" },
    high: { type: ["object", "null"], description: 'background effect at the full end, e.g. {"effect":"orbs","at":80}; null clears it' },
    low: { type: ["object", "null"], description: 'background effect at the empty end, e.g. {"effect":"hearts","at":25,"words":["cold","so cold"]}; null clears it' }
  }, ["id"]),
  T("remove_node", "Delete a stat or resource from the sheet.", {
    id: { type: "string", description: "node id from the sheet" }
  }, ["id"]),
  T("set_theme", `Change the sheet's BASE theme \u2014 the page's five colors (recolors the whole page). Pass "theme" as an object with ALL FIVE roles, each a #rrggbb color: {background, surface, border, text, accent}. background = page, surface = cards, border = lines, text = primary text, accent = the signature highlight color. Omitting a role is an error \u2014 always give all five. Pass "theme": null to clear the custom theme (back to the stock dark "tome" palette). To make a THEME that only applies while a condition holds (e.g. "make the sheet green while HP is low"), instead give that EFFECT a "theme" via add_modifier / set_modifier.`, {
    theme: { type: ["object", "null"], description: "the five colors {background, surface, border, text, accent}, each #rrggbb; null clears \u2192 stock palette" }
  }, ["theme"]),
  T("add_modifier", 'Add a condition, buff, curse, enchantment, or equipment effect. If the effect changes stats, pass the stat changes in "mutations" (you cannot use set_modifier on a brand-new effect in the same turn, because its id does not exist yet).', {
    name: { type: "string" },
    kind: { type: "string", enum: ["condition", "buff", "curse", "enchantment", "equipment"] },
    description: { type: "string" },
    icon: { type: "string", description: ICON_ENUM_NOTE },
    active: { type: "boolean" },
    mutations: { type: "array", items: { type: "object" }, description: "optional stat changes this effect applies, each {targetStatId, operator, value}; targetStatId must already exist on the sheet" },
    decay: { type: "number", description: "optional: value this effect causes to be lost per minute while active" },
    regen: { type: "boolean", description: "true if the tick gains value instead" },
    statTarget: { type: "string", description: "id of the node the tick affects (e.g. pool_hp)" },
    gate: { type: ["object", "null"], description: "optional condition. THREE shapes: (1) pool {poolId, at} \u2014 applies only while the pool is at least at% FULL (at = 0-100; use for while X is above N / only when full); (2) pool-levels {poolId, bands: [{kind, at?, mutations?}]} \u2014 kind is low | mid | high, at is the boundary % (low = its top, high = its floor, mid = ignore; omit at for defaults low \u2264 33.33 / high \u2265 66.67 / mid between); (3) VALUE {poolId, mode: value, compare?, at?, bands?} \u2014 applies when the node absolute value (not % of the bar) crosses a number: with a single at, compare gte = value \u2265 at (when X reaches N) or lte = value \u2264 at (when X drops below N); with bands, each kind gets its own absolute at boundary (low = value \u2264 at, high = value \u2265 at, mid between) and its own mutations. Use the value shape for when my Strength hits 14 / when HP is 5 or less / low strength X mid Y high Z. One entry per level, no duplicate kinds. null clears the gate" },
    counter: COUNTER_PROP,
    theme: { type: ["object", "null"], description: 'optional: recolor the WHOLE sheet while this effect is armed (on + gate met). The five colors {background, surface, border, text, accent}, each #rrggbb. Use for "make the sheet green while HP is low" \u2014 set the effects gate to HP low AND give it this theme.' }
  }, ["name", "kind"]),
  T("set_modifier", 'Change an existing effect: name, kind, description, icon, enable/disable, or its stat mutations. Mutations are the stat changes the effect applies, e.g. {targetStatId, operator, value}. Operators: add (flat), multiply (x), override (set to), setMin, setMax, rename, setIcon, setAccent, setFormat, setVisible. To add one mutation use addMutation; to replace one use setMutation + mutationIndex; to drop one pass only mutationIndex; to reset all at once pass the full "mutations" array.', {
    id: { type: "string", description: "effect id from the sheet" },
    name: { type: "string" },
    kind: { type: "string", enum: ["condition", "buff", "curse", "enchantment", "equipment"] },
    description: { type: "string" },
    icon: { type: "string" },
    active: { type: "boolean", description: "enable (true) or disable (false)" },
    mutations: { type: "array", items: { type: "object" }, description: "full replacement of the mutation list" },
    addMutation: { type: "object", description: 'one mutation object to append, e.g. {"targetStatId":"stat_str","operator":"add","value":2}' },
    setMutation: { type: "object", description: "one mutation object to replace at mutationIndex" },
    mutationIndex: { type: "number", description: "index into the mutation list of that effect (0-based; indices are shown on the sheet). With setMutation: replace that slot. Alone: delete that slot." },
    gate: { type: ["object", "null"], description: "conditional, three shapes: {poolId, at} (applies while the pool is at least at% full) | {poolId, bands: [{kind, at?, mutations?}]} (per pool level, at = boundary %) | {poolId, mode: value, compare?, at?, bands?} (gated by the node absolute value: single at with compare gte/lte, or per-level absolute boundaries). null clears the gate" },
    counter: COUNTER_PROP,
    theme: { type: ["object", "null"], description: "recolor the whole sheet while this effect is armed \u2014 the five colors {background, surface, border, text, accent}, each #rrggbb. null removes the effects theme override." }
  }, ["id"]),
  T("set_ramp", 'Manage the sheets RAMPS \u2014 sheet-level number links: "when one value MOVES, another moves with it" (a ramp), distinct from an effect (which shifts a value WHILE ON). A ramp watches a value (a stat/pool, a list item, or an effects on/off) and shifts a TARGET (a stat/pool or list item) by its step PER POINT the watch moves the right way (a +20 move shifts the target by 20 x step, and the return move shifts it back; a toggle watch shifts by the plain step per flip). action:add (default) creates one; action:set edits one by id (name/direction/step/watch/target/watchFrom/active); action:remove deletes one by id; action:clear drops every ramp on the sheet. e.g. "when Health goes up, Stamina +1" \u2192 add {watch:{kind:"node",id:"<health>"},target:{kind:"node",id:"<stamina>"},direction:"up",step:1}. "each time I lose a ration, drop my HP by 2" \u2192 watch the item (kind:item) direction:down step:2 on an HP node target.', {
    action: { type: "string", enum: ["add", "set", "remove", "clear"], description: "default add" },
    id: { type: "string", description: "set/remove: the ramp id (listed in the sheet summary's Ramps section)" },
    name: { type: "string", description: `add/set: the ramp's name (default: "Watch \u2192 Target")` },
    watch: REF_PROP,
    target: REF_PROP,
    direction: { type: "string", enum: ["up", "down"], description: 'which movement of the watched value fires the shift (default up); "up" = it increases (or, for a toggle watch, turns ON)' },
    step: { type: "number", description: "add: how many points the target moves PER POINT the watch moves (the sign is the target's direction: negative = down; 0.5 allowed)" },
    watchFrom: { oneOf: [{ type: "number" }, { type: "boolean" }, { type: "null" }], description: "optional: only fire when the change STARTS at exactly this value (a number for node/item, true/false for a toggle); null clears it" },
    active: { type: "boolean", description: "add/set: enable (default true) or disable the ramp" }
  }),
  T("remove_modifier", "Remove an effect from the sheet.", {
    id: { type: "string", description: "effect id from the sheet" }
  }, ["id"]),
  T("add_list", "Add a new list (inventory, spell slots, \u2026).", {
    name: { type: "string" },
    capacity: { type: "number" },
    icon: { type: "string", description: ICON_ENUM_NOTE }
  }, ["name"]),
  T("update_list", "Rename a list, change its capacity, or set its icon.", {
    id: { type: "string", description: "list id from the sheet" },
    name: { type: "string" },
    capacity: { type: "number" },
    icon: { type: "string", description: ICON_ENUM_NOTE }
  }, ["id"]),
  T("remove_list", "Delete a list and all its items.", {
    id: { type: "string", description: "list id from the sheet" }
  }, ["id"]),
  T("add_item", "Add an item to a list.", {
    listId: { type: "string", description: "list id from the sheet" },
    name: { type: "string" },
    qty: { type: "number" }
  }, ["listId", "name"]),
  T("set_item", "Rename an item or change its quantity.", {
    listId: { type: "string", description: "list id from the sheet" },
    itemId: { type: "string", description: "item id from the sheet" },
    name: { type: "string" },
    qty: { type: "number" }
  }, ["listId", "itemId"]),
  T("remove_item", "Remove an item from a list.", {
    listId: { type: "string", description: "list id from the sheet" },
    itemId: { type: "string", description: "item id from the sheet" }
  }, ["listId", "itemId"]),
  T("set_image", "Manage the sheet's IMAGE LIBRARY (the portrait / background pictures the user uploads; you reference these by id). 'add' creates a NAMED slot the user then uploads an image to (you cannot upload pixels \u2014 say to the user to upload it in the Images dialog); 'remove' deletes a slot; 'rename' renames one; 'set-active' sets the manual base picture. The sheet summary lists every slot's id + name.", {
    slot: { type: "string", enum: ["portrait", "background"], description: "which library" },
    action: { type: "string", enum: ["add", "remove", "rename", "set-active"], description: "default add" },
    name: { type: "string", description: 'add/rename: the slot name (e.g. "Injured", "Battlefield")' },
    id: { type: "string", description: "remove/rename/set-active: the slot id (or an id to assign on add)" }
  }, ["slot"]),
  T("set_pictures", "Swap the displayed pictures. Bind library image ids to a RESOURCE's levels (its fill bar's low/mid/high) and/or to a CONDITION (applies while the condition is ON + its gate met). Conditions WIN over a resource's level for the same slot (per slot: a condition's portrait + a resource's background apply at the same time). 'levels' maps low/mid/high to {portraitId?, backgroundId?} (or null to clear that level); 'picture' is one {portraitId?, backgroundId?} (or null to clear). Reference only ids that exist in the sheet's image library.", {
    poolId: { type: "string", description: "resource pool id to set per-level pictures on (optional)" },
    levels: { type: ["object", "null"], description: "{low?: {portraitId?, backgroundId?}, mid?: \u2026, high?: \u2026}; null clears all levels (use with poolId)" },
    conditionId: { type: "string", description: "effect id to set a picture override on (optional)" },
    picture: { type: ["object", "null"], description: "{portraitId?, backgroundId?}; null clears the condition's override (use with conditionId)" }
  })
];
async function chatCompletion(brain, messages, signal) {
  if (!brain.url.trim()) throw new Error("No brain link configured \u2014 connect one in Settings.");
  const base = brain.url.replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json" };
  if (brain.apiKey) headers.Authorization = `Bearer ${brain.apiKey}`;
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: brain.model || void 0,
      messages,
      tools: TOOLS,
      temperature: 0.2,
      max_tokens: 2048,
      stream: false
    }),
    signal
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return await res.json();
}
var vllmComplete = async (messages, signal) => {
  const data = await chatCompletion(resolveBrain(ROOT), messages, signal);
  const choice = data.choices?.[0]?.message;
  if (!choice) throw new Error("LLM returned no choice");
  return {
    content: typeof choice.content === "string" ? choice.content : null,
    toolCalls: (choice.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments
    }))
  };
};
function llmPlugin() {
  const send = (res, status, body) => {
    if (!res || res.destroyed === true || res.writableEnded === true) return;
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
  const middleware = (req, res, next) => {
    const url = (req.url ?? "").split("?")[0];
    if (url !== "/api/llm/health" && url !== "/api/llm/apply") return next();
    if (url === "/api/llm/health" && req.method === "GET") {
      void probeBrain(resolveBrain(ROOT)).then((brain) => {
        const modelOk = brain.reachable && !!brain.modelId && (brain.modelId === brain.model || !brain.model);
        send(res, 200, { ok: brain.reachable, model: modelOk ? brain.model : brain.modelId ?? null, brain });
      }).catch((e) => send(res, 502, { ok: false, error: String(e?.message ?? e) }));
      return;
    }
    if (url !== "/api/llm/apply" || req.method !== "POST") {
      return send(res, 405, { error: "method not allowed" });
    }
    void readRawBody(req, MAX_BODY_BYTES2).then((raw) => runApplyRequest(res, raw)).catch(() => send(res, 413, { error: "character payload too large" }));
  };
  const runApplyRequest = async (res, raw) => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: "bad request" });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("brain timed out")), LLM_TIMEOUT_MS2);
    try {
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) return send(res, 400, { error: "message required" });
      if (message.length > 2e3) return send(res, 400, { error: "message too long (max 2000 chars)" });
      if (!isApplyableCharacterJson(body.character)) return send(res, 400, { error: "invalid character" });
      const out = await runApply(body.character, message, controller.signal, vllmComplete);
      send(res, 200, {
        character: out.character,
        applied: out.applied,
        errors: out.errors,
        reply: out.reply || (out.applied.length ? "Done." : "No changes made.")
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[llm] apply failed:", msg);
      send(res, brainErrorStatus(msg), { error: genericBrainError(msg) });
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    name: "character-tracker-llm",
    configureServer(server2) {
      server2.middlewares.use(middleware);
    },
    configurePreviewServer(server2) {
      server2.middlewares.use(middleware);
    }
  };
}

// vite-hearts.ts
var HEART_MAX = 999999;
var HEART_MAX_PROFILES = 512;
var HEART_BODY_MAX = 4 * 1024;
var HOLD_MS = 25e3;
var ID_MAX = 128;
function heartsPlugin(opts = {}) {
  const validId = (id) => typeof id === "string" && id.length >= 1 && id.length <= ID_MAX;
  const counts = /* @__PURE__ */ new Map();
  for (const [id, n] of Object.entries(opts.initialCounts ?? {})) {
    if (validId(id)) counts.set(id, Math.max(0, Math.min(HEART_MAX, Math.trunc(n))));
  }
  let rev = counts.size;
  const holdMs = opts.holdMs ?? HOLD_MS;
  const waiters = /* @__PURE__ */ new Set();
  const snapshot = () => Object.fromEntries(counts);
  const notify = () => {
    for (const wake of [...waiters]) wake();
    waiters.clear();
  };
  const middleware = (req, res, next) => {
    let url;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return next();
    }
    if (url.pathname !== "/api/heart") return next();
    const send = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST") {
      const finishPost = (raw) => {
        let id;
        try {
          id = JSON.parse(raw || "{}").id;
        } catch {
          id = void 0;
        }
        if (!validId(id)) return send(400, { error: "bad id" });
        if (!counts.has(id) && counts.size >= HEART_MAX_PROFILES) {
          return send(403, { error: "too many profiles on this server" });
        }
        const cur = counts.get(id) ?? 0;
        if (cur < HEART_MAX) {
          counts.set(id, cur + 1);
          rev += 1;
          notify();
        }
        send(200, { rev, count: counts.get(id) ?? 0 });
      };
      void readRawBody(req, HEART_BODY_MAX).then((raw) => finishPost(raw)).catch(() => send(413, { error: "body too large" }));
      return;
    }
    if (req.method !== "GET") return send(405, { error: "method not allowed" });
    const since = Number(url.searchParams.get("since") ?? rev);
    if (rev > since) return send(200, { rev, counts: snapshot(), state: "immediate" });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waiters.delete(finish);
      send(200, { rev, counts: snapshot(), state: "held" });
    };
    const timer = setTimeout(finish, holdMs);
    waiters.add(finish);
    req.on?.("close", finish);
  };
  return {
    name: "ct-hearts",
    configureServer(server2) {
      server2.middlewares.use(middleware);
    },
    configurePreviewServer(server2) {
      server2.middlewares.use(middleware);
    }
  };
}

// deploy/server-entry.ts
var ROOT2 = process.cwd();
var DIST = path3.join(ROOT2, "dist");
var middlewares = [];
var grab = (plugin) => {
  plugin.configurePreviewServer({ middlewares: { use: (fn) => middlewares.push(fn) } });
};
grab(sharedDbPlugin(ROOT2));
grab(ownerPlugin());
grab(llmPlugin());
grab(heartsPlugin());
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8"
};
function serveStatic(req, res, urlPath) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end("method not allowed");
    return;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    res.statusCode = 400;
    res.end("bad request");
    return;
  }
  let resolved = path3.normalize(path3.join(DIST, decoded));
  if (resolved !== DIST && !resolved.startsWith(DIST + path3.sep)) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }
  let target = resolved;
  try {
    const st = fs3.statSync(target);
    if (st.isDirectory()) target = path3.join(target, "index.html");
  } catch {
    target = path3.join(DIST, "index.html");
  }
  fs3.readFile(target, (err, buf) => {
    if (err) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("not found");
      return;
    }
    const ext = path3.extname(target).toLowerCase();
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
    res.setHeader("Cache-Control", ext === ".html" ? "no-cache" : "public, max-age=3600");
    if (req.method === "HEAD") res.end();
    else res.end(buf);
  });
}
var EXTRA_HOSTS = (process.env.CT_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
var ANY_HOST = EXTRA_HOSTS.includes("*");
var TUNNEL_SUFFIX = ".trycloudflare.com";
var HOST_PORT = /^(.*?)(?::(\d*))?$/;
var IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
var IPV6 = /^\[?[0-9a-f]*:?[0-9a-f:.]+\]?$/i;
function hostAllowed(header) {
  if (ANY_HOST) return true;
  if (!header) return false;
  const bare = (header.match(HOST_PORT)?.[1] ?? header).toLowerCase();
  if (!bare) return false;
  if (bare === "localhost") return true;
  if (IPV4.test(bare)) return true;
  if (bare.includes(":") && IPV6.test(bare)) return true;
  if (bare.endsWith(TUNNEL_SUFFIX)) return true;
  return EXTRA_HOSTS.some((h) => h.startsWith(".") ? bare.endsWith(h) : bare === h);
}
var server = http.createServer((req, res) => {
  const urlPath = (req.url ?? "/").split("?")[0];
  if (!hostAllowed(req.headers.host)) {
    console.warn(`[server] refused Host "${req.headers.host ?? ""}" \u2014 add it to CT_ALLOWED_HOSTS if this is your domain`);
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("forbidden host \u2014 this server only answers its own address (see CT_ALLOWED_HOSTS)");
    return;
  }
  if (urlPath.startsWith("/api/")) {
    let i = 0;
    const next = () => {
      const mw = middlewares[i++];
      if (!mw) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      try {
        mw(req, res, next);
      } catch (e) {
        console.error("[server] middleware threw:", e);
        if (!res.writableEnded && !res.destroyed) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "internal error" }));
        }
      }
    };
    next();
    return;
  }
  serveStatic(req, res, urlPath);
});
process.on("uncaughtException", (e) => {
  console.error("[server] UNCAUGHT EXCEPTION (kept alive):", e);
});
process.on("unhandledRejection", (e) => {
  console.error("[server] unhandled rejection:", e);
});
function argPort(argv) {
  const at = argv.indexOf("--port");
  if (at >= 0 && Number.isFinite(Number(argv[at + 1]))) return Number(argv[at + 1]);
  return void 0;
}
function resolvePort() {
  const raw = argPort(process.argv.slice(2)) ?? Number(process.env.CT_PORT ?? 5173);
  if (Number.isInteger(raw) && raw >= 0 && raw <= 65535) return raw;
  console.warn(`[server] ignoring invalid port "${raw}" \u2014 using 5173 (set CT_PORT or --port to a number 0-65535)`);
  return 5173;
}
var port = resolvePort();
var host = process.env.CT_HOST ?? "127.0.0.1";
var strictPort = process.env.CT_STRICT_PORT === "1";
function startListening(portToTry, triesLeft) {
  const onErr = (err) => {
    server.removeListener("error", onErr);
    if (err.code === "EADDRINUSE" && triesLeft > 0 && !strictPort) {
      console.log(`Port ${portToTry} is busy, trying ${portToTry + 1} ...`);
      startListening(portToTry + 1, triesLeft - 1);
    } else {
      console.error("Could not start the server:", err.message);
      process.exit(1);
    }
  };
  server.on("error", onErr);
  server.listen(portToTry, host, () => {
    const base = `http://localhost:${portToTry}`;
    const loopbackOnly = host === "127.0.0.1" || host === "localhost" || host === "::1";
    const unsealed = !process.env.CT_OWNER_BOOTSTRAP_PIN;
    console.log([
      "=============================================",
      "  Character Tracker - self-hosted",
      `  URL : ${base}`,
      `  Data: ${path3.join(ROOT2, "data")} (created on first save)`,
      "  Stop: close this window, or Ctrl+C",
      loopbackOnly ? "" : [
        `  ! Bound to ${host} \u2014 reachable from other machines.`,
        unsealed ? "  ! Not claimed yet: open the app and set a master PIN, or set\n    CT_OWNER_BOOTSTRAP_PIN before startup to seal the claim." : "  Owner key: CT_OWNER_BOOTSTRAP_PIN is set \u2014 the claim must satisfy it."
      ].filter(Boolean).join("\n"),
      "============================================="
    ].filter(Boolean).join("\n"));
    if (!process.env.CT_NO_BROWSER) {
      try {
        if (process.platform === "win32") {
          spawn("cmd.exe", ["/c", "start", "", base], { stdio: "ignore", detached: true }).unref();
        } else if (process.platform === "darwin") {
          spawn("open", [base], { stdio: "ignore", detached: true }).unref();
        } else {
          spawn("xdg-open", [base], { stdio: "ignore", detached: true }).unref();
        }
      } catch {
      }
    }
  });
}
startListening(port, 10);
var shutdown = () => {
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
