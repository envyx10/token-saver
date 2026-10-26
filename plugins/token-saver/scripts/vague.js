// Local, zero-token check for underspecified prompts. A vague prompt at the
// start of a task makes Claude guess, and a wrong guess on a big context is
// the most expensive kind of waste. Returns { vague, reasons } or null when
// the prompt shouldn't be judged (follow-ups, questions, light chores).

const { classify } = require("./classify");

const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// Anything that pins the task down to something concrete.
const SPECIFICS = [
  /[\w-]+\.(js|jsx|ts|tsx|py|go|rs|java|rb|php|css|scss|html|md|json|ya?ml|sql|sh|vue|svelte|astro|toml|env)\b/i, // files
  /[\w.-]+\/[\w./-]+/,                       // paths
  /`[^`]+`/,                                 // inline code
  /\b[a-z]+[A-Z]\w*\b|\b\w+_\w+\b|\w+\(\)/,  // identifiers: camelCase, snake_case, call()
  /https?:\/\//,                             // URLs
  /\b(error|exception|traceback|TypeError|undefined|null|404|500)\b/i, // error text
  /\[Image #?\d*\]|<pasted_content|```/,      // attachments, pasted blocks
  /"[^"]{3,}"|«[^»]{3,}»|'[^']{3,}'/,         // quoted strings
];

// Words that ask for an outcome without saying what it is.
const VAGUE_WORDS = /\b(mejora\w*|arregla(lo)?|haz que (funcione|vaya)|que funcione|algo|esto|eso|lo de|bonit\w*|mas (bonito|limpio|moderno)|mejor|optimizalo|improve|make it (better|work|nicer)|fix it|something|stuff|this thing|clean ?up|polish)\b/;

function checkVague(prompt) {
  const raw = String(prompt || "").trim();
  if (/#go\b/i.test(raw)) return null;            // explicit "just do it"
  const c = classify(raw);
  if (!c || c.tier === "light") return null;      // follow-ups and quick chores are fine short
  if (/\?\s*$/.test(raw)) return null;            // questions get answered, not executed
  if (raw.length > 400) return null;              // long prompts already carry detail

  const p = norm(raw);
  const words = p.split(/\s+/).filter(Boolean).length;
  if (words < 2) return null;                     // "clear", "tests": commands, not task briefs
  const reasons = [];
  let score = 0;
  if (words < 8) { score += 2; reasons.push("short"); }
  else if (words < 15) { score += 1; reasons.push("brief"); }
  if (!SPECIFICS.some((re) => re.test(raw))) { score += 2; reasons.push("nothing concrete"); }
  if (VAGUE_WORDS.test(p)) { score += 1; reasons.push("vague wording"); }
  if (c.tier === "deep") { score += 1; reasons.push("big task"); }

  return { vague: score >= 4, score, reasons };
}

module.exports = { checkVague };
