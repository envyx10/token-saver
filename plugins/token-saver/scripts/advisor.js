#!/usr/bin/env node
// UserPromptSubmit hook: before Claude works on your message, tells you
//   - which model and effort fit the task, at the start of every task, and
//     mid-task whenever the model you're on doesn't fit,
//   - when to /clear (new task on a big context) or /compact,
//   - when the prompt cache has expired after a long pause,
//   - when the context keeps growing past the warning threshold,
//   - when a task starts with a vague prompt (then Claude runs token-saver:prompter).
// Everything is decided locally (keyword classifier, transcript tail). The
// advice goes out as a systemMessage, which costs no tokens. The desktop app
// only shows that as an easy-to-miss toast, so there Claude also opens its
// reply with the advice as a markdown block (~80 tokens, only when there is
// advice). A vague prompt adds a one-line prompter instruction (~60 tokens).
//
// Env:
//   TOKEN_SAVER_ADVISOR   warn (default) | block | off
//                         block stops the message once so you can switch first;
//                         sending the same message again lets it through.
//   TOKEN_SAVER_WARN_AT   first context-size warning (default 150000)
//   TOKEN_SAVER_LANG      auto (default: replies in the language you write in) | es | en
//   TOKEN_SAVER_PROMPTER  auto (default) | off. Add #go to a prompt to skip it once.
//   TOKEN_SAVER_RELAY     auto (default: on the desktop app) | on | off

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { classify } = require("./classify");
const { checkVague } = require("./vague");

const MODE = (process.env.TOKEN_SAVER_ADVISOR || "warn").toLowerCase();
const PROMPTER = (process.env.TOKEN_SAVER_PROMPTER || "auto").toLowerCase();
const RELAY_ENV = (process.env.TOKEN_SAVER_RELAY || "auto").toLowerCase();
const RELAY = RELAY_ENV === "on" || (RELAY_ENV === "auto" && process.env.CLAUDE_CODE_ENTRYPOINT === "claude-desktop");
const WARN_AT = Number(process.env.TOKEN_SAVER_WARN_AT || 150000);
const STEP = 100000;
const BIG = 40000;          // context worth clearing before a new task
const IDLE_MIN = 60;        // 1h prompt-cache TTL
const REPEAT_AFTER = 8;     // prompts before repeating the same model advice
const FORCED_LANG = (process.env.TOKEN_SAVER_LANG || "auto").toLowerCase().slice(0, 2);

// What Claude reads. English on purpose: it's for Claude, not for you.
const PROMPTER_CONTEXT = 'token-saver: this request looks underspecified. Before doing any work, invoke the Skill tool with skill "token-saver:prompter" and follow it. Do not mention this note.';
const RELAY_CONTEXT = (md) => `IMPORTANT, from the user's token-saver plugin: their app shows its notices only as an easy-to-miss toast, so the user asked you to relay them. The first thing in your reply MUST be the markdown block between the markers, copied exactly (same language, emoji and formatting), followed by a blank line. Then answer the user as usual. Do not mention or explain the block.\n<<<\n${md}\n>>>`;

const TIER_ICON = { light: "🟢", standard: "🟡", deep: "🔴" };

// Each note is { icon, head, body, action }: one line in the toast and in chat.
const TEXT = {
  es: {
    tier: { light: "Tarea ligera", standard: "Tarea normal", deep: "Tarea compleja" },
    rec: { haiku: "Haiku · esfuerzo bajo", light: "Sonnet · esfuerzo bajo", standard: "Sonnet · esfuerzo medio", deep: "Opus · esfuerzo alto" },
    pick: "Elige ahora: con el contexto vacío, cambiar de modelo es gratis.",
    fits: (m) => `Ya estás en ${m}: encaja.`,
    over: (m) => `Estás en ${m}: gastarías de más.`,
    under: (m) => `Estás en ${m}: puede quedarse corto.`,
    switchNow: "Cámbialo con /model",
    switchAfterClear: (k) => `Con ~${k}k de contexto, cambiar ahora lo re-procesa todo: haz /clear y cambia con /model`,
    newTask: (k) => ({ icon: "🆕", head: "Tarea nueva", body: `Arrastras ~${k}k de contexto que cada mensaje vuelve a procesar.`, action: "Si es un tema distinto: Esc, /clear y reenvía el mensaje · Si sigues con lo mismo: no hagas nada" }),
    idle: (h, k) => ({ icon: "⏰", head: `${h} sin actividad`, body: `El caché ha caducado: este mensaje re-procesa ~${k}k a precio completo.`, action: "¿Otra tarea? /clear · ¿La misma? /compact" }),
    size: (k) => ({ icon: "🧹", head: `Contexto: ~${k}k tokens`, body: "Cada mensaje lo vuelve a procesar entero.", action: "¿Otra tarea? /clear · ¿La misma? /compact" }),
    vague: { icon: "✍️", head: "Prompt poco concreto", body: "Claude te hará 1–3 preguntas y lo afinará antes de empezar.", action: "Añade #go para saltártelo" },
    block: "Mensaje detenido para que cambies antes. Reenvíalo tal cual para seguir sin cambios.",
  },
  en: {
    tier: { light: "Light task", standard: "Regular task", deep: "Complex task" },
    rec: { haiku: "Haiku · low effort", light: "Sonnet · low effort", standard: "Sonnet · medium effort", deep: "Opus · high effort" },
    pick: "Pick it now: with an empty context, switching models is free.",
    fits: (m) => `You're already on ${m}: good fit.`,
    over: (m) => `You're on ${m}: that's overspending.`,
    under: (m) => `You're on ${m}: it may fall short.`,
    switchNow: "Switch with /model",
    switchAfterClear: (k) => `With ~${k}k of context, switching now re-processes it all: /clear, then /model`,
    newTask: (k) => ({ icon: "🆕", head: "New task", body: `You're carrying ~${k}k of context that every message re-processes.`, action: "If it's a different topic: Esc, /clear and resend · If you're continuing the same one: do nothing" }),
    idle: (h, k) => ({ icon: "⏰", head: `${h} idle`, body: `The prompt cache expired: this message re-processes ~${k}k at full price.`, action: "New task? /clear · Same one? /compact" }),
    size: (k) => ({ icon: "🧹", head: `Context: ~${k}k tokens`, body: "Every message re-processes all of it.", action: "New task? /clear · Same one? /compact" }),
    vague: { icon: "✍️", head: "Vague prompt", body: "Claude will ask 1–3 questions and sharpen it before starting.", action: "Add #go to skip" },
    block: "Message held so you can switch first. Send it again unchanged to continue as is.",
  },
};

// Toast: plain text. Headline, why, and what to do, each on its own line.
const renderPlain = (notes) => "🧭 token-saver\n\n" + notes.map((n) =>
  `${n.icon} ${n.head}\n    ${n.body}` + (n.action ? `\n    👉 ${n.action}` : "")).join("\n\n");

// Chat: a markdown blockquote with one list item per note, so it stands out
// from Claude's reply and each note keeps its own line.
const code = (s) => s.replace(/(#go|\/model|\/clear|\/compact)/g, "`$1`");
const renderMarkdown = (notes) => "> **🧭 token-saver**\n>\n" + notes.map((n) =>
  `> - ${n.icon} **${n.head}** · ${code(n.body)}` + (n.action ? ` 👉 **${code(n.action)}**` : "")).join("\n");

// Spanish if you write in Spanish, English otherwise. Short or ambiguous
// prompts ("ok", a code snippet) keep the last language seen in the session,
// then fall back to the system locale.
const ES_WORDS = /\b(que|de|el|la|los|las|para|con|por|una|un|es|esto|esta|como|pero|haz|hazme|arregla|quiero|puedes|anade|cambia|mira|tambien|donde|porque|ahora|vale|ya|muy|mas|todo|nuevo|nueva)\b/g;
const EN_WORDS = /\b(the|to|and|of|is|it|you|for|with|this|that|can|please|fix|add|make|change|what|why|how|now|new|all|should|would|could|my|your)\b/g;
function detectLang(prompt, prev) {
  if (FORCED_LANG === "es" || FORCED_LANG === "en") return FORCED_LANG;
  const p = prompt.toLowerCase();
  const plain = p.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const es = (plain.match(ES_WORDS) || []).length + (/[ñ¿¡áéíóú]/.test(p) ? 2 : 0);
  const en = (plain.match(EN_WORDS) || []).length;
  if (es >= 2 && es > en) return "es";
  if (en >= 2 && en > es) return "en";
  if (prev) return prev;
  let locale = "";
  try { locale = Intl.DateTimeFormat().resolvedOptions().locale; } catch {}
  locale = process.env.LC_ALL || process.env.LANG || locale || "";
  return locale.toLowerCase().startsWith("es") ? "es" : "en";
}

const RANK = { haiku: 1, sonnet: 2, opus: 3, fable: 3 };
const REC_RANK = { haiku: 1, light: 2, standard: 2, deep: 3 };
const NEW_TASK = /\b(otra cosa|otra tarea|nueva tarea|cambiando de tema|cambio de tema|pasemos a|siguiente tarea|ahora (quiero|vamos|necesito|toca)|por otro lado|new task|next task|something else|let'?s move on|switching gears|unrelated)\b/i;
// Only the user's own words count as a task switch: not pasted text or quotes.
const ownWords = (prompt) => prompt
  .replace(/<pasted_content[\s\S]*?<\/pasted_content[^>]*>/g, " ")
  .replace(/```[\s\S]*?```/g, " ")
  .replace(/^>.*$/gm, " ")
  .replace(/["“«][^"”»]*["”»]/g, " ");

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
const upper = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const ago = (min) => min >= 120 ? `${Math.round(min / 60)} h` : `${Math.round(min)} min`;

function main(input) {
  if (MODE === "off") return;
  const prompt = String(input.prompt || "");
  const stateFile = path.join(os.tmpdir(), `token-saver-${input.session_id || "nosession"}.json`);
  let state = { lang: "", prompts: 0, sizeStep: -1, lastAdvice: "", lastAdviceAt: -99, held: "" };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) }; } catch {}
  state.prompts++;
  const lang = detectLang(prompt, state.lang);
  state.lang = lang;
  const T = TEXT[lang];

  const hash = crypto.createHash("sha1").update(prompt).digest("hex");
  const resent = MODE === "block" && state.held === hash;
  state.held = "";

  const call = lastCall(input.transcript_path);
  const ctx = call ? call.ctx : 0;
  const k = Math.round(ctx / 1000);
  const switching = NEW_TASK.test(ownWords(prompt));
  const taskStart = !call || switching;
  const notes = [];
  let blocking = false;

  // 1. Model and effort. At the start of a task always; mid-task when it doesn't fit.
  const c = classify(prompt);
  if (c) {
    const recKey = c.tier === "light" && c.score <= -3 ? "haiku" : c.tier;
    const fam = call ? family(call.model) : "";
    const cur = RANK[fam];
    const need = REC_RANK[recKey];
    const head = `${T.tier[c.tier]} → ${T.rec[recKey]}`;
    let note = null;
    if (!call) {
      note = { icon: TIER_ICON[c.tier], head, body: T.pick, action: T.switchNow };
    } else if (cur && c.confident && cur !== need && (cur > need || c.tier === "deep")) {
      const action = cur < need || ctx < BIG ? T.switchNow : T.switchAfterClear(k);
      note = { icon: TIER_ICON[c.tier], head, body: cur > need ? T.over(upper(fam)) : T.under(upper(fam)), action };
    } else if (switching && cur) {
      note = { icon: TIER_ICON[c.tier], head, body: cur === need ? T.fits(upper(fam)) : cur > need ? T.over(upper(fam)) : T.under(upper(fam)), action: cur === need ? "" : T.switchAfterClear(k) };
    }
    // The same mismatch again only after a while, so it doesn't nag.
    const key = `${recKey}|${fam}`;
    if (note && (taskStart || key !== state.lastAdvice || state.prompts - state.lastAdviceAt >= REPEAT_AFTER)) {
      notes.push(note);
      state.lastAdvice = key; state.lastAdviceAt = state.prompts;
      if (call && note.action) blocking = true;
    }
  }

  // 2. Context hygiene.
  const idleMin = call && call.at ? (Date.now() - call.at) / 60000 : 0;
  if (ctx >= BIG && switching) {
    notes.push(T.newTask(k)); blocking = true;
  } else if (ctx >= BIG && idleMin >= IDLE_MIN) {
    notes.push(T.idle(ago(idleMin), k));
  } else if (ctx >= WARN_AT) {
    const step = Math.floor((ctx - WARN_AT) / STEP);
    if (step > state.sizeStep) { notes.push(T.size(k)); state.sizeStep = step; }
  }

  // 3. Vague prompt at the start of a task: sharpen it before any work.
  // Mid-task, short messages lean on the conversation and are fine.
  let sharpen = false;
  if (PROMPTER !== "off" && taskStart) {
    const v = checkVague(prompt);
    if (v && v.vague) { sharpen = true; notes.push(T.vague); }
  }

  let out = null;
  if (notes.length) {
    const plain = renderPlain(notes);
    // A vague prompt goes to the prompter instead of being held.
    if (MODE === "block" && blocking && !resent && !sharpen) {
      state.held = hash;
      out = { decision: "block", reason: plain + "\n\n" + T.block };
    } else {
      out = { systemMessage: plain };
      const context = [];
      if (RELAY) context.push(RELAY_CONTEXT(renderMarkdown(notes)));
      if (sharpen) context.push(PROMPTER_CONTEXT);
      if (context.length) out.hookSpecificOutput = { hookEventName: "UserPromptSubmit", additionalContext: context.join("\n\n") };
    }
  }
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch {}
  if (out) process.stdout.write(JSON.stringify(out));
}
