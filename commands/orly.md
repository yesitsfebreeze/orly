---
description: Turn a goal into checkable specs and work until they pass — or report a mistake and have it fixed, specced and replayed in one go
argument-hint: <a goal> | <what went wrong>
allowed-tools: Read, Write, Bash, Glob, Grep
---

The user wrote: **$ARGUMENTS**

Decide which this is. A goal ("add retries to the client") → *Setting a goal*. A report
that something went wrong ("it said tests pass but they didn't", "that block was wrong")
→ *When something went wrong*, done in one go without asking.

`orly` below means `bun "${CLAUDE_PLUGIN_ROOT}/bin/orly.ts"`.

## Setting a goal

1. Read enough of the project to name its real commands and paths.
2. Write `.orly/goal` and one spec file per check under `.orly/specs/<group>/`.
3. Run `orly specs`. Rewrite every spec it rejects and re-run until clean; an
   undecidable spec yields a confident number that means nothing.
4. Show the user the spec list in one short block, then start the work.

From then on every turn you try to end is judged against these specs. The loop ends when
every spec is met, when you state plainly what you could not do and why, or when the
round cap runs out.

## Writing a spec

A spec is one yes/no question about the recorded evidence of a turn: commands run, their
output, what you said, and evidence orly gathers itself.

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

Headers:

- `evidence: a, b`: files read at judging time into `project.files`. Use it for any spec
  about file state, so the answer never depends on what you printed.
- `require: <path> <op> <value>`: decided in code from a check in `.orly/config.json`,
  e.g. `require: checks.tests.exit equals 0` with
  `"checks": {"tests": {"command": "bun test"}}`. Use it whenever a command can decide.
- `context` sources in `.orly/config.json` (`"ticket": {"command": "…"}`), named in
  `evidence:`: output the judge reads under `project.context`, for a ticket or a deploy.
- `gather: <what to bring>`: for evidence nothing produces. The block asks for it.
- `optional: yes`: may stay unmet if you say why. `cut`, `true`, `false` also exist.

A file that does not parse blocks every turn until fixed. `orly tree` prints the index.

## When something went wrong

1. **Find the turn.** `orly turns`; `last` is the newest.
2. **Direction.** `block` if a mistake got through, `pass` if a fine turn was blocked.
3. **Freeze, spec and replay in one command.** For a missed mistake, write the question
   that would have caught it and file it in its group:

   ```
   orly case last block "<what went wrong, in the user's words>" --spec <group>/<id> --ask "<question>"
   ```

   Drop `--ask` when an existing spec should have caught it. For a wrong block:
   `orly case <turn> pass "<why it was fine>"`, then reword the spec that fired. Never
   lower its cut or delete it.
4. **Replay until every case is right.** If one is wrong, reword the spec or add
   `evidence:`, then `orly replay`. A fix that breaks an earlier case is not a fix.
5. **Fix the mistake itself** in the work, so the new spec passes this turn.
6. **Report in three lines:** spec file, case file, replay score.

Cases in `.orly/cases/` are committed and hold the turn verbatim: check for secrets first.
