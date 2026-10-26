#!/usr/bin/env node
// token-saver audit: reads Claude Code transcripts locally and prints a compact
// report of where tokens went. Runs entirely on disk, so it costs no tokens
// except the report itself.
//
// Usage: node audit.js [--days 7] [--project <substring>] [--top 8]

const fs = require("fs");
const path = require("path");
const os = require("os");

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const DAYS = Number(opt("days", 7));
const PROJECT = (opt("project", "") || "").toLowerCase();
const TOP = Number(opt("top", 8));
const since = Date.now() - DAYS * 86400e3;

const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "k" : String(Math.round(n));
// ~4 chars per token is the usual rough estimate for English/code.
const charsToTok = (c) => c / 4;

// Subagent transcripts live in <project>/<session>/subagents/*.jsonl.
const projectOf = (f) => path.relative(root, f).split(path.sep)[0];
const sessions = new Map(); // sessionId -> stats
const toolOut = new Map();  // tool name -> {chars, calls}
const cmdOut = new Map();   // bash command head -> {chars, calls}
const readOut = new Map();  // file path -> {chars, calls}
const models = new Map();   // model -> processed tokens

const files = walk(root).filter((f) => {
  if (PROJECT && !f.toLowerCase().includes(PROJECT)) return false;
  try { return fs.statSync(f).mtimeMs >= since; } catch { return false; }
});

for (const file of files) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
  const seenMsg = new Set();
  const toolUses = new Map(); // tool_use_id -> {name, input}
  for (const line of text.split("\n")) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.timestamp && Date.parse(o.timestamp) < since) continue;
    const sid = o.sessionId;
    if (!sid) continue;
    let s = sessions.get(sid);
    if (!s) {
      s = { id: sid, project: projectOf(file), title: "", calls: 0, input: 0, output: 0, peak: 0, toolChars: 0, sub: 0 };
      sessions.set(sid, s);
    }
    if (o.type === "ai-title" && o.aiTitle) s.title = o.aiTitle;
    const m = o.message;
    if (!m) continue;

    if (o.type === "assistant" && m.usage && m.id && !seenMsg.has(m.id)) {
      seenMsg.add(m.id);
      const u = m.usage;
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      s.calls++;
      s.input += ctx;
      s.output += u.output_tokens || 0;
      if (o.isSidechain) s.sub++;
      else s.peak = Math.max(s.peak, ctx);
      models.set(m.model, (models.get(m.model) || 0) + ctx + (u.output_tokens || 0));
    }
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c.type === "tool_use") toolUses.set(c.id, { name: c.name, input: c.input || {} });
      if (c.type === "tool_result") {
        const body = typeof c.content === "string" ? c.content
          : Array.isArray(c.content) ? c.content.map((x) => x.text || "").join("") : "";
        const chars = body.length;
        const tu = toolUses.get(c.tool_use_id) || { name: "?", input: {} };
        s.toolChars += chars;
        const add = (map, key) => {
          const v = map.get(key) || { chars: 0, calls: 0 };
          v.chars += chars; v.calls++; map.set(key, v);
        };
        add(toolOut, tu.name);
        if ((tu.name === "Bash" || tu.name === "PowerShell") && tu.input.command) {
          // Skip a leading "cd <dir> &&" so the real command is what gets grouped.
          const cmd = String(tu.input.command).trim().replace(/^cd\s+("[^"]*"|\S+)\s*(&&|;)\s*/, "");
          const head = cmd.split(/\s+/).slice(0, 2).join(" ").slice(0, 40);
          add(cmdOut, head);
        }
        if (tu.name === "Read" && tu.input.file_path) add(readOut, tu.input.file_path);
      }
    }
  }
}

const all = [...sessions.values()].filter((s) => s.calls > 0);
if (!all.length) {
  console.log(`No sessions with usage in the last ${DAYS} days${PROJECT ? ` matching "${PROJECT}"` : ""}.`);
  process.exit(0);
}

const tot = all.reduce((a, s) => ({ input: a.input + s.input, output: a.output + s.output, calls: a.calls + s.calls }), { input: 0, output: 0, calls: 0 });
const avgCtx = tot.input / tot.calls;

const out = [];
out.push(`# Token audit — last ${DAYS} days${PROJECT ? ` (project ~ "${PROJECT}")` : ""}`);
out.push(`${all.length} sessions · ${tot.calls} model calls · ${fmt(tot.input)} context tokens processed · ${fmt(tot.output)} output · avg context per call ${fmt(avgCtx)}`);
out.push("");
out.push("## By model (context + output)");
for (const [m, v] of [...models].sort((a, b) => b[1] - a[1])) out.push(`- ${m}: ${fmt(v)} (${(100 * v / (tot.input + tot.output)).toFixed(0)}%)`);
out.push("");
out.push("## Most expensive sessions");
out.push("| session | calls | context processed | peak context | tool output |");
out.push("|---|---|---|---|---|");
for (const s of all.sort((a, b) => b.input - a.input).slice(0, TOP)) {
  const name = (s.title || s.project.replace(/^C--Users-[^-]+-/, "")).slice(0, 50);
  out.push(`| ${name} | ${s.calls}${s.sub ? ` (${s.sub} sub)` : ""} | ${fmt(s.input)} | ${fmt(s.peak)} | ~${fmt(charsToTok(s.toolChars))} tok |`);
}
const table = (title, map) => {
  out.push("");
  out.push(`## ${title}`);
  for (const [k, v] of [...map].sort((a, b) => b[1].chars - a[1].chars).slice(0, TOP)) {
    out.push(`- ${k}: ~${fmt(charsToTok(v.chars))} tok in ${v.calls} calls (avg ~${fmt(charsToTok(v.chars / v.calls))})`);
  }
};
table("Tool output by tool", toolOut);
if (cmdOut.size) table("Noisiest shell commands", cmdOut);
if (readOut.size) table("Files read most (by volume)", readOut);

// Heuristic advice, only when the data supports it.
const tips = [];
const longOnes = all.filter((s) => s.peak > 120e3).length;
if (longOnes) tips.push(`${longOnes} session(s) went over 120k context. Every turn re-reads that: /clear between tasks, /compact on long ones.`);
if (avgCtx > 60e3) tips.push(`Average context per call is ${fmt(avgCtx)}. Shorter sessions are the biggest single saving.`);
const opus = [...models].filter(([m]) => /opus/i.test(m)).reduce((a, [, v]) => a + v, 0);
if (opus / (tot.input + tot.output) > 0.8) tips.push("Over 80% of usage is Opus. Default to Sonnet for routine work and switch to Opus for hard problems.");
const subCalls = all.reduce((a, s) => a + s.sub, 0);
if (subCalls / tot.calls < 0.05) tips.push("Subagents are barely used. Delegate broad searches to the token-saver:scout agent (Haiku) so only its summary enters your context.");
const reads = toolOut.get("Read");
if (reads && charsToTok(reads.chars / reads.calls) > 4e3) tips.push("Reads average over 4k tokens. Prefer Grep and partial reads (offset/limit) for big files.");
if (tips.length) {
  out.push("");
  out.push("## Suggestions");
  for (const t of tips) out.push("- " + t);
}
console.log(out.join("\n"));
