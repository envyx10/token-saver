#!/usr/bin/env node
// UserPromptSubmit hook: before Claude works on your message, tells you when
//   - the task doesn't match the model you're on (and which effort fits it),
//   - it's time to /clear (new task on a big context) or /compact,
//   - the prompt cache has expired after a long pause,
//   - the context keeps growing past the warning threshold.
// Everything runs locally: the classifier is keyword-based and the advice is a
// systemMessage shown to you, not added to Claude's context. Zero tokens.
//
// Env:
//   TOKEN_SAVER_ADVISOR   warn (default) | block | off
//                         block stops the message once so you can switch first;
//                         sending the same message again lets it through.
//   TOKEN_SAVER_WARN_AT   first context-size warning (default 150000)
//   TOKEN_SAVER_LANG      es (default) | en

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { classify } = require("./classify");

const MODE = (process.env.TOKEN_SAVER_ADVISOR || "warn").toLowerCase();
const WARN_AT = Number(process.env.TOKEN_SAVER_WARN_AT || 150000);
const STEP = 100000;
const BIG = 40000;          // context worth clearing before a new task
const IDLE_MIN = 60;        // 1h prompt-cache TTL
const REPEAT_AFTER = 8;     // prompts before repeating the same model advice
const LANG = (process.env.TOKEN_SAVER_LANG || "es").toLowerCase().startsWith("en") ? "en" : "es";

const T = {
  es: {
    tier: { light: "ligera", standard: "normal", deep: "compleja" },
    rec: { haiku: "Haiku · esfuerzo bajo", light: "Sonnet · esfuerzo bajo", standard: "Sonnet · esfuerzo medio", deep: "Opus · esfuerzo alto" },
    first: (t, r) => `Tarea ${t} → recomendado: ${r}. Es el mejor momento para elegir: el contexto está vacío.`,
    down: (t, r, m) => `Tarea ${t} → basta con ${r}. Estás en ${m}: gastarías de más.`,
    up: (t, r, m) => `Tarea ${t} → mejor ${r}. Estás en ${m}: puede quedarse corto.`,
    switchHint: (k) => k >= BIG ? " Cambiar de modelo re-procesa el contexto: hazlo tras /clear." : " Cámbialo con /model.",
    newTask: (k) => `Parece una tarea nueva y arrastras ~${k}k de contexto que se re-procesan en cada mensaje. /clear antes de empezar.`,
    idle: (h, k) => `${h} sin actividad: el caché ha caducado y este mensaje re-procesa ~${k}k a precio completo. ¿Otra tarea? /clear. ¿La misma? /compact.`,
    size: (k) => `El contexto va por ~${k}k y cada mensaje lo re-procesa entero. ¿Otra tarea? /clear. ¿La misma? /compact.`,
    block: "Mensaje detenido para que puedas cambiar antes. Envíalo otra vez tal cual para seguir sin cambios.",
  },
  en: {
    tier: { light: "light", standard: "regular", deep: "complex" },
    rec: { haiku: "Haiku · low effort", light: "Sonnet · low effort", standard: "Sonnet · medium effort", deep: "Opus · high effort" },
    first: (t, r) => `${t} task → recommended: ${r}. Best moment to choose: the context is empty.`,
    down: (t, r, m) => `${t} task → ${r} is enough. You're on ${m}: that's overspending.`,
    up: (t, r, m) => `${t} task → ${r} fits better. You're on ${m}: it may fall short.`,
    switchHint: (k) => k >= BIG ? " Switching models re-processes the context: do it after /clear." : " Switch with /model.",
    newTask: (k) => `Looks like a new task and you're carrying ~${k}k of context that every message re-processes. /clear before starting.`,
    idle: (h, k) => `${h} idle: the prompt cache expired and this message re-processes ~${k}k at full price. New task? /clear. Same one? /compact.`,
    size: (k) => `Context is at ~${k}k and every message re-processes all of it. New task? /clear. Same one? /compact.`,
    block: "Message held so you can switch first. Send it again unchanged to continue as is.",
  },
}[LANG];

const RANK = { haiku: 1, sonnet: 2, opus: 3, fable: 3 };
const REC_RANK = { haiku: 1, light: 2, standard: 2, deep: 3 };
const NEW_TASK = /\b(otra cosa|otra tarea|nueva tarea|cambiando de tema|cambio de tema|pasemos a|siguiente tarea|ahora (quiero|vamos|necesito|toca)|por otro lado|new task|next task|something else|let'?s move on|switching gears|unrelated)\b/i;

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try { main(JSON.parse(raw)); } catch { /* never block the prompt on our own errors */ }
});

function tail(file, bytes = 512 * 1024) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally { fs.closeSync(fd); }
}

// Last main-thread model call: which model, how big the context was, and when.
function lastCall(transcript) {
  if (!transcript) return null;
  let text;
  try { text = tail(transcript); } catch { return null; }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    try {
      const o = JSON.parse(lines[i]);
      if (o.type !== "assistant" || o.isSidechain || !o.message || !o.message.usage) continue;
      const u = o.message.usage;
      return {
        model: String(o.message.model || ""),
        ctx: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        at: Date.parse(o.timestamp) || 0,
      };
    } catch { /* partial first line of the tail */ }
  }
  return null;
}

const family = (model) => (model.match(/haiku|sonnet|opus|fable/i) || [""])[0].toLowerCase();
// Spanish messages put the tier mid-sentence ("Tarea ligera"); English leads with it.
const cap = (s) => LANG === "en" ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const ago = (min) => min >= 120 ? `${Math.round(min / 60)} h` : `${Math.round(min)} min`;

function main(input) {
  if (MODE === "off") return;
  const prompt = String(input.prompt || "");
  const stateFile = path.join(os.tmpdir(), `token-saver-${input.session_id || "nosession"}.json`);
  let state = { prompts: 0, sizeStep: -1, lastAdvice: "", lastAdviceAt: -99, held: "" };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) }; } catch {}
  state.prompts++;

  const hash = crypto.createHash("sha1").update(prompt).digest("hex");
  const resent = MODE === "block" && state.held === hash;
  state.held = "";

  const call = lastCall(input.transcript_path);
  const ctx = call ? call.ctx : 0;
  const k = Math.round(ctx / 1000);
  const notes = [];
  let blocking = false;

  // 1. Context hygiene: the biggest saving, so it goes first.
  const idleMin = call && call.at ? (Date.now() - call.at) / 60000 : 0;
  if (ctx >= BIG && NEW_TASK.test(prompt)) {
    notes.push(T.newTask(k)); blocking = true;
  } else if (ctx >= BIG && idleMin >= IDLE_MIN) {
    notes.push(T.idle(ago(idleMin), k));
  } else if (ctx >= WARN_AT) {
    const step = Math.floor((ctx - WARN_AT) / STEP);
    if (step > state.sizeStep) { notes.push(T.size(k)); state.sizeStep = step; }
  }

  // 2. Model and effort for this task.
  const c = classify(prompt);
  if (c) {
    const recKey = c.tier === "light" && c.score <= -3 ? "haiku" : c.tier;
    const tier = T.tier[c.tier];
    const rec = T.rec[recKey];
    const fam = call ? family(call.model) : "";
    const cur = RANK[fam];
    let advice = "";
    if (!call) advice = T.first(cap(tier), rec);
    else if (!c.confident) advice = "";
    // Downgrading mid-task only pays off while the context is small.
    else if (cur && cur > REC_RANK[recKey] && ctx < BIG) advice = T.down(cap(tier), rec, cap(fam)) + T.switchHint(ctx);
    else if (cur && cur < REC_RANK[recKey] && c.tier === "deep") advice = T.up(cap(tier), rec, cap(fam)) + T.switchHint(ctx);
    // Same advice again only after a while, so it doesn't nag.
    const key = `${recKey}|${fam}`;
    if (advice && (key !== state.lastAdvice || state.prompts - state.lastAdviceAt >= REPEAT_AFTER)) {
      notes.push(advice);
      state.lastAdvice = key; state.lastAdviceAt = state.prompts;
      if (call) blocking = true;
    }
  }

  let out = null;
  if (notes.length) {
    const msg = "token-saver · " + notes.join("\n              ");
    if (MODE === "block" && blocking && !resent) {
      state.held = hash;
      out = { decision: "block", reason: msg + "\n" + T.block };
    } else {
      out = { systemMessage: msg };
    }
  }
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch {}
  if (out) process.stdout.write(JSON.stringify(out));
}
