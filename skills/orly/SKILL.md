---
name: orly
description: Guard check for the session. Turn the user's request into guards (one yes/no question each, a shell command where one decides it); every stop is checked against them and refused until all are upheld. Use when the user asks for work, when "/orly" is typed, or when a stop was refused.
---

The user wrote: **$ARGUMENTS** (when nothing follows, use their last message).

`orly` below means `bun "${CLAUDE_PLUGIN_ROOT}/orly.ts"`; the session is `$CLAUDE_CODE_SESSION_ID`
(set in your shell; pass `--session` when it is not). The prompt hook prints the exact command.

## Writing guards

Before the work starts, one guard per thing the request must deliver, 2 to 6 in all:

```sh
orly guard "Do command_results show bun test exiting 0 after the last edit?" --check "bun test"
orly guard "Does README.md list every plugin in exactly one tier?" --file README.md
orly guard "Does assistant_final_message name the file that was changed and how to verify it?"
```

- **One yes/no question about evidence**: a command result, a file's content, the final message.
  Not "is the code good": taste words are rejected.
- **`--check` when a command decides it.** Exit 0 upholds the guard. A check runs at every stop,
  so a regression reopens it.
- **`--file` when the question is about file state.** The judge sees the file's real content.
- A question or a one-line answer needs no guard. The user's follow-up that adds work adds guards.

`orly guards` lists them. `orly drop <id>` only when the user says to drop one.

## When a stop is refused

The message names the guards not upheld and where the full verdict is. Fix what they name, then
stop again; that stop is not checked. A guard that cannot be met: say so to the user and name why.
Never drop or reword a guard to get past a block.
