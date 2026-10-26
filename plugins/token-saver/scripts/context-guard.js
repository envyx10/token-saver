#!/usr/bin/env node
// UserPromptSubmit hook: reads the context size of the last model call from the
// transcript and warns you (not Claude, so it costs no tokens) once per 100k
// step above the threshold. Every message re-processes the whole context, so a
// long session is the most expensive thing in Claude Code.
//
// Env: TOKEN_SAVER_WARN_AT sets the first warning (default 150000).

const fs = require("fs");
const os = require("os");
const path = require("path");

const WARN_AT = Number(process.env.TOKEN_SAVER_WARN_AT || 150000);
const STEP = 100000;

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try { main(JSON.parse(raw)); } catch { /* never block the prompt */ }
});

// Only the end of the transcript matters; avoid reading multi-MB files whole.
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

function main(input) {
  if (!input.transcript_path) return;
  const lines = tail(input.transcript_path).split("\n").reverse();
  let ctx = 0;
  for (const l of lines) {
    if (!l.includes('"usage"')) continue;
    try {
      const o = JSON.parse(l);
      if (o.type !== "assistant" || o.isSidechain) continue;
      const u = o.message.usage;
      ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      break;
    } catch { /* partial first line of the tail */ }
  }
  if (ctx < WARN_AT) return;

  const step = Math.floor((ctx - WARN_AT) / STEP);
  const stateFile = path.join(os.tmpdir(), `token-saver-guard-${input.session_id}.txt`);
  let last = -1;
  try { last = Number(fs.readFileSync(stateFile, "utf8")); } catch {}
  if (step <= last) return;
  fs.writeFileSync(stateFile, String(step));

  const k = Math.round(ctx / 1000);
  process.stdout.write(JSON.stringify({
    systemMessage: `token-saver: context is ~${k}k tokens and every message re-processes all of it. New task? /clear. Same task? /compact.`,
  }));
}
