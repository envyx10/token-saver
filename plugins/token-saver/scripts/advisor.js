#!/usr/bin/env node
// UserPromptSubmit hook: before Claude works on your message, tells you
//   - when to /clear (new task on a big context) or /compact,
//   - when the prompt cache has expired after a long pause,
//   - when the context keeps growing past the warning threshold.
// Everything is decided locally from the transcript tail. The advice goes out
// as a systemMessage, which costs no tokens.
//
// Env:
//   TOKEN_SAVER_ADVISOR   warn (default) | off
//   TOKEN_SAVER_WARN_AT   first context-size warning (default 150000)
//   TOKEN_SAVER_LANG      auto (default: replies in the language you write in) | es | en
//   TOKEN_SAVER_PROMPTER  off (default) | on. Checks for vague prompts at the start of a task
//                         and sends them to the prompter. Add #go to a prompt to skip it once.
//   TOKEN_SAVER_RELAY     off (default) | on. Makes Claude repeat the notice at the top of its
//                         reply, for the desktop app's easy-to-miss toast (~80 tokens per notice).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { checkVague } = require("./vague");

const MODE = (process.env.TOKEN_SAVER_ADVISOR || "warn").toLowerCase();
const PROMPTER = (process.env.TOKEN_SAVER_PROMPTER || "off").toLowerCase() === "on";
const RELAY = (process.env.TOKEN_SAVER_RELAY || "off").toLowerCase() === "on";
const WARN_AT = Number(process.env.TOKEN_SAVER_WARN_AT || 150000);
const STEP = 100000;
const BIG = 40000;          // context worth clearing before a new task
const IDLE_MIN = 60;        // 1h prompt-cache TTL
const FORCED_LANG = (process.env.TOKEN_SAVER_LANG || "auto").toLowerCase().slice(0, 2);

// What Claude reads. English on purpose: it's for Claude, not for you.
const PROMPTER_CONTEXT = 'token-saver: this request looks underspecified. Before doing any work, invoke the Skill tool with skill "token-saver:prompter" and follow it. Do not mention this note.';
const RELAY_CONTEXT = (md) => `IMPORTANT, from the user's token-saver plugin: their app shows its notices only as an easy-to-miss toast, so the user asked you to relay them. The first thing in your reply MUST be the markdown block between the markers, copied exactly (same language, emoji and formatting), followed by a blank line. Then answer the user as usual. Do not mention or explain the block.\n<<<\n${md}\n>>>`;

// Each note is { icon, head, body, action }: one line in the toast and in chat.
const TEXT = {
  es: {
    newTask: (k) => ({ icon: "🆕", head: "Tarea nueva", body: `Arrastras ~${k}k de contexto que cada mensaje vuelve a procesar.`, action: "¿Otra tarea? /clear · ¿La misma? /compact" }),
    idle: (h, k) => ({ icon: "⏰", head: `${h} sin actividad`, body: `El caché ha caducado: este mensaje re-procesa ~${k}k a precio completo.`, action: "¿Otra tarea? /clear · ¿La misma? /compact" }),
    size: (k) => ({ icon: "🧹", head: `Contexto: ~${k}k tokens`, body: "Cada mensaje lo vuelve a procesar entero.", action: "¿Otra tarea? /clear · ¿La misma? /compact" }),
    vague: { icon: "✍️", head: "Prompt poco concreto", body: "Claude te hará 1–3 preguntas y lo afinará antes de empezar.", action: "Añade #go para saltártelo" },
  },
  en: {
    newTask: (k) => ({ icon: "🆕", head: "New task", body: `You're carrying ~${k}k of context that every message re-processes.`, action: "New task? /clear · Same one? /compact" }),
    idle: (h, k) => ({ icon: "⏰", head: `${h} idle`, body: `The prompt cache expired: this message re-processes ~${k}k at full price.`, action: "New task? /clear · Same one? /compact" }),
    size: (k) => ({ icon: "🧹", head: `Context: ~${k}k tokens`, body: "Every message re-processes all of it.", action: "New task? /clear · Same one? /compact" }),
    vague: { icon: "✍️", head: "Vague prompt", body: "Claude will ask 1–3 questions and sharpen it before starting.", action: "Add #go to skip" },
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

// Last main-thread model call: how big the context was, and when.
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
        ctx: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        at: Date.parse(o.timestamp) || 0,
      };
    } catch { /* partial first line of the tail */ }
  }
  return null;
}

const ago = (min) => min >= 120 ? `${Math.round(min / 60)} h` : `${Math.round(min)} min`;

function main(input) {
  if (MODE === "off") return;
  const prompt = String(input.prompt || "");
  const stateFile = path.join(os.tmpdir(), `token-saver-${input.session_id || "nosession"}.json`);
  let state = { lang: "", sizeStep: -1 };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) }; } catch {}
  const lang = detectLang(prompt, state.lang);
  state.lang = lang;
  const T = TEXT[lang];

  const call = lastCall(input.transcript_path);
  const ctx = call ? call.ctx : 0;
  const k = Math.round(ctx / 1000);
  const switching = NEW_TASK.test(ownWords(prompt));
  const taskStart = !call || switching;
  const notes = [];

  // 1. Context hygiene.
  const idleMin = call && call.at ? (Date.now() - call.at) / 60000 : 0;
  if (ctx >= BIG && switching) {
    notes.push(T.newTask(k));
  } else if (ctx >= BIG && idleMin >= IDLE_MIN) {
    notes.push(T.idle(ago(idleMin), k));
  } else if (ctx >= WARN_AT) {
    const step = Math.floor((ctx - WARN_AT) / STEP);
    if (step > state.sizeStep) { notes.push(T.size(k)); state.sizeStep = step; }
  }

  // 2. Vague prompt at the start of a task (opt-in): sharpen it before any work.
  // Mid-task, short messages lean on the conversation and are fine.
  let sharpen = false;
  if (PROMPTER && taskStart) {
    const v = checkVague(prompt);
    if (v && v.vague) { sharpen = true; notes.push(T.vague); }
  }

  if (notes.length) {
    const out = { systemMessage: renderPlain(notes) };
    const context = [];
    if (RELAY) context.push(RELAY_CONTEXT(renderMarkdown(notes)));
    if (sharpen) context.push(PROMPTER_CONTEXT);
    if (context.length) out.hookSpecificOutput = { hookEventName: "UserPromptSubmit", additionalContext: context.join("\n\n") };
    process.stdout.write(JSON.stringify(out));
  }
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch {}
}
