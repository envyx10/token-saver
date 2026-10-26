---
name: prompter
description: Turn a vague or too-short request into a precise prompt before doing any work. Use when token-saver flags a prompt as underspecified, or when the user's request leaves the goal, scope or done criteria unclear.
argument-hint: "[the request to sharpen]"
---

The user's request is underspecified. Doing the work now means guessing, and a wrong guess costs far more tokens than one round of clarification. Do not edit files or run the task yet.

Reply in the language the user wrote in. Keep the whole exchange short.

1. **Look, cheaply.** Spend at most 3 quick tool calls to ground the questions: list the top-level files, read the first lines of a README or the file the request points at, grep one key term. Skip this if the request is clear about where to work.

2. **Ask 1 to 3 questions** that change what you would do, using AskUserQuestion with concrete options taken from what you saw (put your recommended option first). Good questions pin down:
   - **Goal**: what should be different when it's done.
   - **Scope**: which files, screens or modules, and what must not change.
   - **Done criteria**: how to tell it works (a test passes, a page looks like X, a command succeeds).
   Never ask what you can find out yourself.

3. **Write the sharpened prompt** in a short block:

   ```
   Goal: …
   Context: … (files, components, current behaviour)
   Constraints: … (what not to touch, style, stack)
   Done when: …
   ```

4. **Confirm and go.** Ask once whether to proceed with that prompt (an AskUserQuestion with "Go" first and "Adjust" second). On "Go", do the task exactly as written. On "Adjust", take their correction and go.

If the user says to just do it, stop asking and proceed with your best reading of the request.
