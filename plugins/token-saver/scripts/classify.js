// Local, zero-token task classifier. Scores a prompt with keyword signals
// (Spanish and English) and its length, and returns a tier:
//   "light"    → Haiku/Sonnet, low effort
//   "standard" → Sonnet, medium effort
//   "deep"     → Opus, high effort
// null means "don't advise" (slash commands, short follow-ups like "ok").

const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// Each entry: [regex on the normalized prompt, weight]. Negative pulls toward
// light, positive toward deep.
const SIGNALS = [
  // light: mechanical or tiny changes, questions, git chores
  [/\b(typo|errata|falta de ortografia|renombra\w*|rename|cambia el (texto|color|nombre|titulo)|change the (text|color|name|title))\b/, -3],
  [/\b(traduce|traducir|translate|formatea|format|indenta|lint|prettier)\b/, -2],
  [/\b(haz|hazme|crea|make|create)? ?(un |el |a )?commit\b|\bgit (push|pull|status|log|add)\b|\b(push|pull request|pr|commitea|comitea|pushea|despliega|desplega|deploy)\b/, -2],
  [/^(que|qué|como|cómo|donde|dónde|cual|cuál|what|how|where|which|is|es|puedo|can i)\b.{0,140}\?$/, -2],
  [/\b(explica|explain|resume|resumen|summari[sz]e|que hace|what does)\b/, -1],
  [/\b(actualiza|update|bump|sube) (la )?(version|dependencia|dependency|readme)\b/, -1],
  [/\b(anade|agrega|add) (un |una |a )?(comentario|comment|log|console\.log|import|boton|button|icono|icon)\b/, -2],
  [/\b(pequen|small|minor|rapido|quick|simple|sencill)\w*/, -1],

  // standard: regular feature and bug work
  [/\b(implementa|implement|anade|add|crea|create|construye|build)\b/, 1],
  [/\b(arregla|fix|bug|error|falla|fails?|failing|roto|broken)\b/, 1],
  [/\b(tests?|pruebas?|endpoint|componente|component|formulario|form|pagina|page|api)\b/, 1],

  // deep: design, cross-cutting, hard debugging
  [/\b(arquitectura|architecture|disena|design|planifica|plan|estrategia|strategy)\b/, 3],
  [/\b(refactor\w*|reestructura\w*|restructur\w*|migra\w*|migration|reescrib\w*|rewrite)\b/, 3],
  [/\b(seguridad|security|vulnerab\w*|auditoria|audit|autenticacion|authentication|oauth|permisos)\b/, 3],
  [/\b(rendimiento|performance|optimiza\w*|memory leak|fuga de memoria|race condition|concurren\w*|deadlock|intermitente|intermittent|flaky)\b/, 3],
  [/\b(por que|why does|why is|investiga|investigate|root cause|causa raiz|depura|debug)\b/, 2],
  [/\b(todo el (proyecto|repo|codigo)|whole (project|repo|codebase)|end to end|e2e|de principio a fin|desde cero|from scratch)\b/, 2],
  [/\b(ultrathink|piensa (bien|a fondo)|think (hard|deeply))\b/, 4],
];

// Short follow-ups that continue the current task: never advise on these.
const CONTINUATION = /^(si|sí|no|ok|vale|dale|perfecto|genial|gracias|thanks|yes|go|sigue|continua|continúa|continue|hazlo|do it|adelante)\b[\s.!,]*\S{0,40}$/i;

function classify(prompt) {
  const raw = String(prompt || "").trim();
  if (!raw || raw.startsWith("/") || CONTINUATION.test(norm(raw))) return null;
  const p = norm(raw);
  let score = 0, hits = 0, light = 0, deep = 0;
  for (const [re, w] of SIGNALS) {
    if (!re.test(p)) continue;
    score += w;
    hits++;
    if (w < 0) light++;
    if (w >= 2) deep++;
  }
  // Long, detailed prompts usually describe bigger work; one-liners smaller,
  // unless they name something hard ("refactoriza X" is short but deep).
  if (raw.length > 1200) score += 2;
  else if (raw.length > 500) score += 1;
  else if (raw.length < 80 && !deep) score -= 1;
  // Several separate requests in one message (lists) mean more work.
  const items = (raw.match(/^\s*([-*•]|\d+[.)])\s+/gm) || []).length;
  if (items >= 4) score += 2;

  // "light" needs an explicit light signal: a short follow-up like "hazlo ya"
  // is part of the task in progress, not a light task.
  const tier = score >= 3 ? "deep" : score <= -1 && light ? "light" : "standard";
  // Confident = some keyword matched or the prompt is long enough to judge.
  const confident = hits > 0 || raw.length > 500;
  return { tier, score, confident };
}

module.exports = { classify };
