---
name: audit
description: Report where Claude Code tokens went (sessions, models, tool output, noisy commands) from local transcripts.
argument-hint: "[--days 7] [--project <name>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run the audit script and show its report. Pass through any arguments the user gave (default: last 7 days).

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/audit.js" $ARGUMENTS
```

Then give the user the report as-is, followed by at most 3 concrete actions ranked by expected savings, each tied to a number in the report. Reply in the user's language. Do not read transcript files yourself: the script already did, and reading them would cost the tokens this audit is meant to save.
