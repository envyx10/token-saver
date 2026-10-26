#!/usr/bin/env node
// PostToolUse hook for Bash: when a command prints a lot, Claude sees a compact
// version (head, error/warning lines, tail) and the full output is saved to a
// temp file it can read if it really needs it.
//
// Env: TOKEN_SAVER_COMPACT=0 disables it, TOKEN_SAVER_MAX_CHARS sets the
// threshold (default 6000 chars, ~1.5k tokens).

const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX = Number(process.env.TOKEN_SAVER_MAX_CHARS || 6000);
const HEAD = 30, TAIL = 50, SIGNAL = 40;

// Commands whose output Claude asked for on purpose: never touch them.
const PASSTHROUGH = /^(cat|sed|head|tail|grep|rg|awk|jq|less|type|Get-Content|git\s+(diff|show|blame))\b/;
const SIGNAL_RE = /\b(error|errors|failed|failure|fail|exception|traceback|panic|warn|warning|assert|expected|✗|✕|×)\b/i;

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try { main(JSON.parse(raw)); } catch { /* never break the tool call */ }
});

function compact(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length <= HEAD + TAIL + SIGNAL) {
    // Few but very long lines (minified JSON, etc.): cut by characters.
    return text.slice(0, MAX / 2) + `\n… [${text.length - MAX} chars omitted] …\n` + text.slice(-MAX / 2);
  }
  const middle = lines.slice(HEAD, -TAIL);
  const signals = middle.filter((l) => SIGNAL_RE.test(l)).slice(0, SIGNAL);
  return [
    ...lines.slice(0, HEAD),
    `… [${middle.length} lines omitted${signals.length ? `; ${signals.length} error/warning lines kept below` : ""}] …`,
    ...signals,
    signals.length ? "… [end of kept lines] …" : null,
    ...lines.slice(-TAIL),
  ].filter((l) => l !== null).join("\n");
}

function main(input) {
  if (process.env.TOKEN_SAVER_COMPACT === "0") return;
  if (input.tool_name !== "Bash") return;
  const cmd = String((input.tool_input && input.tool_input.command) || "")
    .trim().replace(/^cd\s+("[^"]*"|\S+)\s*(&&|;)\s*/, "");
  if (PASSTHROUGH.test(cmd) || /#\s*full\b/.test(cmd)) return;

  const res = input.tool_response;
  if (!res || typeof res !== "object" || typeof res.stdout !== "string") return;
  const stdout = res.stdout, stderr = res.stderr || "";
  if (stdout.length + stderr.length <= MAX) return;

  const file = path.join(os.tmpdir(), `token-saver-${Date.now()}-${process.pid}.log`);
  fs.writeFileSync(file, stdout + (stderr ? "\n--- stderr ---\n" + stderr : ""));
  const note = `\n[token-saver: output compacted from ${stdout.length + stderr.length} chars. Full output: ${file} — read it only if the kept lines are not enough. Add "# full" to the command to skip compaction.]`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: {
        ...res,
        stdout: (stdout.length > MAX ? compact(stdout) : stdout) + note,
        stderr: stderr.length > MAX ? compact(stderr) : stderr,
      },
    },
  }));
}
