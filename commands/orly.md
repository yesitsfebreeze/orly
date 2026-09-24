---
description: Turn a goal into requirements the codebase is evaluated against and work until they hold, or turn a reported mistake into the requirement that catches it
argument-hint: <a goal> | <what went wrong>
allowed-tools: Read, Write, Bash, Glob, Grep
---

The user wrote: **$ARGUMENTS** (when nothing follows, use their last message).

Decide which this is. A goal ("add retries to the client") → *Setting a goal*. A report
that something went wrong ("it said tests pass but they didn't") → *When something went wrong*.

`orly` below means `bun "${CLAUDE_PLUGIN_ROOT}/bin/orly.ts"`; without that variable it is
`bin/orly.ts` in the orly checkout.

## Setting a goal

1. Read enough of the project to name its real commands, files and paths. Trace the code
   a requirement is about before writing it; existing code is evidence, not the requirement.
2. Append the goal to `.orly/goal` (`rounds: 6`, a blank line, then `- <group>: <text>` per
   goal) and write one requirement per check under `.orly/specs/<group>/`. Put everything a
   command can decide into `checks` in `.orly/config.json` and assert it with `require:`;
   name the files a question is about in `evidence:`.
3. Run `orly specs`. Rewrite every requirement it rejects and re-run until clean; an
   undecidable question yields a confident number that means nothing. If the judge cannot be
   reached, say so plainly: the word filter ran, decidability did not.
4. Run `orly eval` for the baseline and show the user the table in one short block. Then
   work the violated requirements, most important goal first, smallest coherent change
   each, and run `orly eval` again after each change to see what improved or regressed.

Every turn you try to end is judged: the requirements against the codebase, then four
built-in honesty questions on the turn. The loop ends when every requirement is satisfied,
when you state plainly what you could not do and why, or when the round cap runs out.

## Writing a requirement

One yes/no question about evidence: files read from disk, a command's result, or the
recorded turn (commands run, their output, what you said).

- **Observable.** "Does `src/http.ts` under `project.files` contain a retry loop with a
  bounded attempt count?", not "the client is resilient".
- **Output, not behaviour.** The judge cannot predict what code does at runtime; when a
  command can show it, use `require:` and let the command decide.
- **No taste words** (clean, readable, idiomatic, robust, proper): rejected. Ask which
  responsibility an abstraction serves, or whether two implementations duplicate one behaviour.
- **One thing per requirement**, 5 to 12 per goal.
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
`evidence: a, b` (files read at judging time), `cut: 0.6`. A question with neither
`require` nor `evidence` is about the turn and is judged only at the gate. A file that does
not parse is a violated requirement until fixed.

## When something went wrong

1. Write the question that would have caught it as a new requirement in its group, with
   `evidence:` when it is about file state.
2. Run `orly specs`; reword until it is accepted.
3. Fix the mistake itself in the work, and run `orly eval` to show the requirement satisfied.
4. Report in two lines: the requirement file, and what was fixed.

If a fine turn was blocked, reword the requirement that fired so it branches on when it
applies. Never lower its cut or delete it: the next stop is refused when the set got weaker.
A legitimate change of requirement is a new goal line and a reworded spec.
