---
name: orly
description: Turn a goal into checkable specs and work until they pass, or turn a reported mistake into the spec that catches it. Use when the user states a goal for this session, or says something the agent did was wrong.
---

The user wrote: **$ARGUMENTS** (when nothing follows, use their last message).

Decide which this is. A goal ("add retries to the client") → *Setting a goal*. A report
that something went wrong ("it said tests pass but they didn't") → *When something went wrong*.

`orly` below means `bun "${CLAUDE_PLUGIN_ROOT}/bin/orly.ts"`; without that variable it is
`bin/orly.ts` in the orly checkout.

## Setting a goal

1. Read enough of the project to name its real commands and paths.
2. Write `.orly/goal` (`rounds: 6`, a blank line, then `- <group>: <text>` per goal) and one
   spec file per check under `.orly/specs/<group>/`. Put every check a command can decide
   into `checks` in `.orly/config.json` and assert it with `require:`.
3. Run `orly specs`. Rewrite every spec it rejects and re-run until clean; an undecidable
   spec yields a confident number that means nothing. If the judge cannot be reached, say
   so plainly: the word filter ran, decidability did not.
4. Show the user the spec list in one short block (`orly tree`), then start the work.

From then on every turn you try to end is judged against these specs. The loop ends when
every spec is met, when you state plainly what you could not do and why, or when the
round cap runs out.

## Writing a spec

A spec is one yes/no question about the recorded evidence of a turn: commands run, their
output, what you said, and files orly reads from disk itself.

- **Observable.** "Do `command_results` show a test run reporting zero failures after the
  last edit?", not "the tests are good".
- **Output, not behaviour.** The judge cannot predict what code does at runtime.
- **No taste words** (clean, readable, idiomatic, robust, proper): rejected.
- **One thing per spec**, 5 to 12 specs.
- **Branch when it only sometimes applies:** "First check whether `actions_taken` edits X.
  If NOT, answer yes. If it does, answer yes only when …".

A file is optional `key: value` headers, a blank line, then the question. The file name
is the id.

```
evidence: duration.js

Look at the `duration.js` entry under `project.files`, which is the file's real current
content. Is the `throw new Error("not implemented")` stub gone?
```

Headers: `require: <path> <op> <value>` (decided in code from a check, e.g.
`require: checks.tests.exit equals 0` with `"checks": {"tests": {"command": "bun test"}}`),
`evidence: a, b` (files read at judging time), `cut: 0.6`, `optional: yes`, `true:` and
`false:` (what met and unmet look like). A file that does not parse blocks every turn
until fixed.

## When something went wrong

1. Write the question that would have caught it as a new spec in its group, with
   `evidence:` when it is about file state.
2. Run `orly specs`; reword until it is accepted.
3. Fix the mistake itself in the work, so the new spec is met this turn.
4. Report in two lines: the spec file, and what was fixed.

If a fine turn was blocked, reword the spec that fired so it branches on when it applies.
Never lower its cut or delete it: the next stop is refused when the spec set got weaker.
