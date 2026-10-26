<p align="center">
  <img src="assets/banner.svg" alt="token-saver: gasta menos tokens en Claude Code" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Claude_Code-plugin-10b981?style=flat-square" alt="Claude Code plugin">
  <img src="https://img.shields.io/badge/node-%E2%89%A518-3c873a?style=flat-square" alt="Node 18+">
  <img src="https://img.shields.io/badge/dependencias-0-10b981?style=flat-square" alt="Sin dependencias">
  <img src="https://img.shields.io/badge/licencia-MIT-10b981?style=flat-square" alt="MIT">
</p>

<p align="center">
  <b>Un plugin de Claude Code que, antes de cada tarea, te dice qué modelo y esfuerzo necesita y cuándo hacer <code>/clear</code> o <code>/compact</code>,<br>
  recorta las salidas ruidosas de la terminal, delega búsquedas a un modelo barato y te enseña con tus propios datos dónde se van los tokens.</b>
</p>

---

## Índice

- [El problema](#el-problema)
- [Qué incluye](#qué-incluye)
- [Cómo funciona](#cómo-funciona)
- [Instalación](#instalación)
- [Uso](#uso)
- [Configuración](#configuración)
- [Los hábitos que más ahorran](#los-hábitos-que-más-ahorran)
- [Estructura del repo](#estructura-del-repo)
- [Limitaciones](#limitaciones)

---

## El problema

En Claude Code, **cada mensaje vuelve a procesar toda la conversación**: tus mensajes, las respuestas, cada fichero leído y cada salida de terminal. Una sesión no cuesta lo que dice su último mensaje, sino la suma del contexto en cada turno.

<p align="center">
  <img src="assets/context-growth.svg" alt="El contexto crece en cada mensaje: 20k en el primero, 850k en el 80" width="100%">
</p>

Al medir 30 días de uso real con la auditoría de este plugin salió esto:

| Métrica | Valor |
|---|---|
| Contexto medio por llamada al modelo | **~350k tokens** |
| Pico de contexto en una sesión | **~970k tokens** |
| Salida media de un comando Bash | ~500 tokens |
| Uso que fue a Opus | 87 % |

La conclusión: **lo que más gasta es la longitud de las sesiones**, mucho más que cualquier comando concreto. Le sigue el modelo: usar Opus para un typo o un commit es pagar de más. Por eso la pieza central de token-saver es el **asesor**, que te avisa de las dos cosas antes de que Claude empiece. Las demás piezas atacan las fugas secundarias.

---

## Qué incluye

| | Pieza | Tipo | Qué hace | Coste en tokens |
|---|---|---|---|---|
| 🧭 | **Asesor** | Hook `UserPromptSubmit` | Clasifica tu mensaje (ligera, normal, compleja) y te dice qué **modelo y esfuerzo** pide: siempre al empezar una tarea, y a mitad de tarea si el que usas no encaja. Te dice cuándo hacer **`/clear`** (tarea nueva) o **`/compact`** (contexto grande, caché caducado). | **0** en la terminal: clasifica en local y el aviso lo ves tú, no entra en el contexto. En la app de escritorio, ~80 tokens por aviso |
| ✂️ | **Salidas compactas** | Hook `PostToolUse` | Si un comando Bash imprime más de 6000 caracteres, Claude recibe el principio, las líneas de error/warning y el final. La salida completa queda en un fichero temporal. | **Ahorra** (en la prueba, ~90 %) |
| ✍️ | **Prompter** | Skill + Asesor | Si una tarea empieza con un prompt vago («mejora la web», «haz que funcione»), Claude te hace 1–3 preguntas y arma un prompt completo **antes** de tocar nada. | ~60 tokens del aviso, frente a una tarea hecha a ciegas |
| 🔭 | **Agente `scout`** | Subagente (Haiku) | Explorador de solo lectura: busca en el código y devuelve solo la conclusión con `ruta:línea`. | Mucho más barato que Opus |
| 📊 | **`/token-saver:audit`** | Skill | Analiza tus transcripciones locales y genera un informe: sesiones más caras, reparto por modelo, herramientas y comandos que más ocupan. | Solo el informe |

---

## Cómo funciona

<p align="center">
  <img src="assets/how-it-works.svg" alt="Flujo: el asesor revisa cada mensaje antes de que Claude trabaje; scout y la compactación actúan durante el trabajo" width="100%">
</p>

### ✂️ Así queda una salida compactada

**Antes**: 800 líneas, ~29 500 caracteres

```text
  ✓ test case number 0 passed fine
  ✓ test case number 1 passed fine
  ✓ test case number 2 passed fine
  … 397 líneas más …
  FAIL src/app.test.ts > adds numbers
  … 399 líneas más …
  ✓ test case number 799 passed fine
```

**Después**: ~3 300 caracteres (−89 %)

```text
  ✓ test case number 0 passed fine
  … (primeras 30 líneas)
… [720 lines omitted; 1 error/warning lines kept below] …
  FAIL src/app.test.ts > adds numbers
… [end of kept lines] …
  ✓ test case number 750 passed fine
  … (últimas 50 líneas)
[token-saver: output compacted from 29508 chars.
 Full output: …/token-saver-….log]
```

Los comandos con los que Claude pide una salida concreta a propósito **no se tocan nunca**: `cat`, `sed`, `head`, `tail`, `less`, `type`, `Get-Content`, `grep`, `rg`, `awk`, `jq`, `git diff`, `git show`, `git blame`. Para saltarte el recorte en cualquier otro comando, añade `# full` al final.

---

## Instalación

> Requisitos: [Claude Code](https://code.claude.com) y Node 18 o superior.

**Desde GitHub** (recomendado):

```bash
claude plugin marketplace add envyx10/token-saver
```

```bash
claude plugin install token-saver@pgdiaz-tools
```

**Desde una copia local**, si quieres modificarlo:

```bash
git clone https://github.com/envyx10/token-saver.git
```

```bash
claude plugin marketplace add ./token-saver
```

```bash
claude plugin install token-saver@pgdiaz-tools
```

Después **abre una sesión nueva**: los hooks se cargan al arrancar. Para comprobar que está activo:

```bash
claude plugin list
```

<details>
<summary>Desinstalar</summary>

```bash
claude plugin uninstall token-saver@pgdiaz-tools
```

```bash
claude plugin marketplace remove pgdiaz-tools
```

</details>

---

## Uso

### 📊 Auditoría

```text
/token-saver:audit
/token-saver:audit --days 30
/token-saver:audit --days 14 --project mi-proyecto
```

| Opción | Por defecto | Qué hace |
|---|---|---|
| `--days N` | `7` | Ventana de tiempo a analizar |
| `--project texto` | todos | Solo proyectos cuya ruta contenga ese texto |
| `--top N` | `8` | Filas de cada tabla |

<details>
<summary>Ejemplo de informe</summary>

```text
# Token audit — last 30 days
29 sessions · 8993 model calls · 3111.9M context tokens processed · 6.9M output · avg context per call 346k

## By model (context + output)
- claude-opus-5-5: 2712.1M (87%)
- claude-opus-5: 406.3M (13%)

## Most expensive sessions
| session                    | calls          | context processed | peak context | tool output |
|----------------------------|----------------|-------------------|--------------|-------------|
| Proyecto A: nueva feature  | 1399 (162 sub) | 606.3M            | 888k         | ~729k tok   |
| Proyecto B: rediseño web   | 1788 (447 sub) | 600.9M            | 847k         | ~576k tok   |

## Noisiest shell commands
- sed -n: ~190k tok in 227 calls (avg ~837)
- python -: ~102k tok in 208 calls (avg ~491)

## Suggestions
- 12 session(s) went over 120k context. Every turn re-reads that: /clear between tasks, /compact on long ones.
- Over 80% of usage is Opus. Default to Sonnet for routine work and switch to Opus for hard problems.
```

</details>

El script lee los ficheros en disco y solo el informe entra en la conversación, así que la auditoría apenas gasta tokens. También puedes ejecutarlo fuera de Claude Code:

```bash
node plugins/token-saver/scripts/audit.js --days 30
```

### ✍️ Prompter

Se activa solo cuando **empiezas una tarea** (primer mensaje o cambio de tarea) con un prompt vago. Mide lo mismo que mirarías tú: si el mensaje es corto, si no nombra nada concreto (ficheros, funciones, errores, URLs, código, imágenes), si usa palabras vagas y si la tarea es grande.

| Prompt | ¿Se activa? |
|---|---|
| `mejora la web` | ✍️ Sí |
| `refactoriza el backend` | ✍️ Sí |
| `haz que funcione` | ✍️ Sí |
| `refactoriza src/auth/session.ts para usar el nuevo cliente de Supabase` | No: es concreto |
| `el botón de pagar da TypeError: cannot read 'id' of undefined` | No: trae el error |
| `arregla el typo del footer`, `haz commit` | No: tarea ligera |
| `¿qué hace esta función?` | No: es una pregunta |
| `mejora la web #go` | No: `#go` lo salta |

Cuando se activa, Claude:

1. Echa un vistazo rápido al proyecto (máximo 3 lecturas) para que las preguntas tengan sentido.
2. Te hace 1–3 preguntas con opciones: objetivo, alcance y cómo saber que está hecho.
3. Te enseña el prompt afinado (*Objetivo · Contexto · Restricciones · Hecho cuando*) y empieza cuando confirmas.

También puedes llamarlo a mano: `/token-saver:prompter mejora el onboarding`.

### 🔭 Agente scout

Claude lo usa solo cuando le encaja la tarea, pero puedes pedírselo directamente:

```text
Usa el agente scout para encontrar dónde se valida el token de sesión
```

### 🧭 Asesor

No hay que hacer nada: al enviar un mensaje, el asesor lo clasifica en local y te muestra un aviso: al empezar una tarea siempre te dice qué modelo y esfuerzo pide (aunque el tuyo ya encaje), y después solo habla cuando hay algo que mejorar.

**Qué modelo y esfuerzo recomienda**

| Tarea | Ejemplos | Recomendación |
|---|---|---|
| 🟢 Ligera | typo, renombrar, commit/push, traducir, «¿qué hace X?» | Haiku o Sonnet · esfuerzo bajo |
| 🟡 Normal | implementar un endpoint, arreglar un bug, un componente, tests | Sonnet · esfuerzo medio |
| 🔴 Compleja | arquitectura, refactor, migración, seguridad, rendimiento, bugs intermitentes | Opus · esfuerzo alto |

**Así se ve un aviso**

Por ejemplo, si estás en Opus a mitad de una sesión de 169k y pides «arregla el typo del footer», Claude abre su respuesta con esto:

> **🧭 token-saver**
>
> - 🟢 **Tarea ligera → Haiku · esfuerzo bajo** · Estás en Opus: gastarías de más. 👉 **Con ~169k de contexto, cambiar ahora lo re-procesa todo: haz `/clear` y cambia con `/model`**
> - 🧹 **Contexto: ~169k tokens** · Cada mensaje lo vuelve a procesar entero. 👉 **¿Otra tarea? `/clear` · ¿La misma? `/compact`**

Cada aviso tiene tres partes: **qué pasa**, **por qué importa** y 👉 **qué hacer**.

**Cuándo avisa**

| | Situación | Qué te dice |
|---|---|---|
| 🟢🟡🔴 | **Empiezas una tarea** (primer mensaje, cambio de tarea o tras `/clear`) | Qué modelo y esfuerzo pide la tarea, y si el tuyo encaja |
| 🟢🟡🔴 | **A mitad de tarea, el modelo no encaja** (Opus para un typo, Sonnet para una migración) | El modelo adecuado y cuándo cambiar: ya con `/model` si el contexto es pequeño, o tras `/clear` si es grande |
| 🆕 | **Cambias de tarea** con más de 40k de contexto | Si es un tema distinto: `Esc`, `/clear` y reenvía el mensaje. Si sigues con lo mismo, no hagas nada. En modo `warn` Claude ya ha empezado, por eso el `Esc` |
| ⏰ | **Vuelves tras más de 1 h** | Que el caché ha caducado y el mensaje se cobra entero |
| 🧹 | **El contexto pasa de 150k** (y cada 100k más) | `/clear` si es otra tarea, `/compact` si es la misma |
| ✍️ | **Empiezas con un prompt vago** | Que Claude va a afinarlo con el prompter |

**Dónde lo ves**

- **En la terminal**, como aviso de Claude Code. No gasta tokens.
- **En la app de escritorio**, el aviso nativo es un toast pequeño que se pasa por alto. Por eso Claude abre su respuesta con el bloque de arriba. Cuesta ~80 tokens, y solo en los mensajes que tienen aviso. Con `TOKEN_SAVER_RELAY` puedes activarlo (`on`) o quitarlo (`off`) en cualquier sitio.

**Habla tu idioma**: si escribes en español, los avisos salen en español. Si escribes en inglés, en inglés.

**Reglas para que no sea pesado**

- Los seguimientos cortos («sí», «dale», «hazlo ya», «continúa») y los comandos `/…` no se analizan nunca.
- A mitad de tarea solo opina sobre el modelo si el mensaje tiene señales claras y el modelo no encaja.
- No repite el mismo consejo hasta pasados 8 mensajes.
- El texto que pegas o citas no cuenta como «cambio de tarea».

**Modo `block`**: con `TOKEN_SAVER_ADVISOR=block`, el asesor detiene el mensaje para que cambies de modelo o hagas `/clear` **antes** de que Claude empiece. Solo lo hace a mitad de tarea cuando el modelo no encaja, o al cambiar de tarea con más de 40k de contexto; al empezar con el contexto vacío o con un prompt vago (que va al prompter) no detiene nada. Si reenvías el mismo mensaje, pasa sin más.

| Situación | Qué hacer |
|---|---|
| Vas a empezar otra tarea | `/clear` |
| Sigues con la misma tarea | `/compact` |
| Necesitas todo el historial | Sigue. El aviso de tamaño no vuelve hasta 100k más |

---

## Configuración

Todo se ajusta con variables de entorno. Lo más cómodo es ponerlas en el bloque `env` de `~/.claude/settings.json`:

```json
{
  "env": {
    "TOKEN_SAVER_ADVISOR": "block",
    "TOKEN_SAVER_WARN_AT": "120000",
    "TOKEN_SAVER_MAX_CHARS": "8000"
  }
}
```

| Variable | Por defecto | Qué controla |
|---|---|---|
| `TOKEN_SAVER_ADVISOR` | `warn` | `warn` avisa, `block` detiene el mensaje una vez (solo si hay un cambio de modelo o un `/clear` que hacer) para que cambies antes, `off` desactiva el asesor |
| `TOKEN_SAVER_RELAY` | `auto` | Si Claude repite el aviso al principio de su respuesta. `auto`: solo en la app de escritorio. `on`: siempre. `off`: nunca (0 tokens) |
| `TOKEN_SAVER_PROMPTER` | `auto` | `off` desactiva el prompter automático. Para saltarlo una vez, añade `#go` al mensaje |
| `TOKEN_SAVER_LANG` | `auto` | Idioma de los avisos. `auto` responde en el idioma en que escribes (español o inglés). `es` o `en` lo fijan |
| `TOKEN_SAVER_WARN_AT` | `150000` | Tokens de contexto a partir de los que llega el primer aviso de tamaño |
| `TOKEN_SAVER_MAX_CHARS` | `6000` | Caracteres de salida de Bash a partir de los que se compacta |
| `TOKEN_SAVER_COMPACT` | `1` | Pon `0` para desactivar la compactación |

---

## Los hábitos que más ahorran

El plugin avisa y mide, pero lo que más ahorra son estos hábitos:

| # | Hábito | Por qué |
|---|---|---|
| 1 | **Una sesión por tarea**, con `/clear` al terminar | El contexto se paga en cada mensaje |
| 2 | **Sonnet por defecto**, Opus solo para lo difícil | Opus consume el límite bastante más rápido |
| 3 | **Activa solo los MCP que usa cada proyecto** | Las definiciones de herramientas ocupan contexto en cada sesión |
| 4 | **CLAUDE.md corto** | Se carga entero en cada sesión |
| 5 | **Delega las búsquedas amplias a `scout`** | A tu sesión solo llega la conclusión |
| 6 | **Esfuerzo medio o bajo** para tareas sencillas | Pensar menos produce menos tokens de salida |

---

## Estructura del repo

```text
token-saver/
├── .claude-plugin/
│   └── marketplace.json         # marketplace "pgdiaz-tools"
├── assets/
│   ├── banner.svg
│   ├── context-growth.svg
│   └── how-it-works.svg
└── plugins/token-saver/
    ├── .claude-plugin/
    │   └── plugin.json          # manifiesto del plugin
    ├── hooks/
    │   └── hooks.json           # registra los dos hooks
    ├── scripts/
    │   ├── advisor.js           # 🧭 asesor de modelo, esfuerzo y contexto
    │   ├── classify.js          # 🧭 clasificador local de tareas
    │   ├── vague.js             # ✍️ detector de prompts vagos
    │   ├── compact-output.js    # ✂️ salidas compactas
    │   └── audit.js             # 📊 auditoría
    ├── agents/
    │   └── scout.md             # 🔭 agente Haiku
    └── skills/
        ├── audit/SKILL.md       # 📊 /token-saver:audit
        └── prompter/SKILL.md    # ✍️ /token-saver:prompter
```

Sin dependencias: solo Node y su librería estándar.

---

## Limitaciones

- **El formato de las transcripciones de Claude Code es interno** y puede cambiar entre versiones. Si la auditoría o el asesor dejan de funcionar tras una actualización, probablemente sea por eso.
- **El clasificador usa palabras clave** (español e inglés) y la longitud del mensaje, no un modelo: es instantáneo y gratis, pero puede equivocarse. Tómalo como una sugerencia.
- **Claude Code no le dice al hook qué esfuerzo tienes puesto.** El modelo se lee de la transcripción, pero el esfuerzo no: el asesor lo recomienda sin poder compararlo con el tuyo.
- La auditoría estima los tokens de las salidas de herramientas a razón de ~4 caracteres por token. Los totales de contexto y de salida, en cambio, son los que registra Claude Code.
- La compactación usa heurísticas: si alguna vez se pierde una línea importante, Claude puede leer la salida completa desde el fichero temporal, y tú puedes añadir `# full` al comando.
- Los avisos del asesor salen en el idioma en que escribes: español si escribes en español, inglés si no. En mensajes ambiguos («ok», código) usa el último idioma detectado o el de tu sistema. La nota de compactación va en inglés porque la lee Claude, no tú.

---

<p align="center">
  Licencia <a href="LICENSE">MIT</a> · Hecho para que la suscripción llegue a final de mes.
</p>
