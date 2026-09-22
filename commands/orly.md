---
description: Turn a goal into checkable specs, then work until orly? says they all pass
argument-hint: <the goal, in your own words>
allowed-tools: Read, Write, Bash, Glob, Grep
---

The user's goal: **$ARGUMENTS**

Write `.orly/specs.json` in the project root, then start working toward the goal. From
that point on every turn you try to end is checked against these specs by Jev, and you
will be blocked until they pass.

## The contract a spec has to meet

A spec becomes one yes/no question asked about **the recorded evidence of a turn** —
which commands ran, what they printed, and what you told the user. Nothing else is
visible to the judge. So:

- **Write what would be observable.** "Do `command_results` show a test run reporting
  zero failures after the last edit?" — not "the tests are good".
- **Never make the judge simulate execution.** It is confidently wrong at reasoning about
  what code would do. Anchor to a command's *output*, not to the code's behaviour.
- **No judgements of taste.** Clean, elegant, readable, idiomatic, robust, proper — a spec
  containing any of these is rejected before it runs.
- **One thing per spec.** Split anything with an "and" in it.
- **5 to 12 specs.** Fewer misses the goal; more makes every turn a negotiation.

**Name the files a spec depends on.** A spec about file state is otherwise only answerable
from what you happened to print, which makes it unfalsifiable — you could edit nothing, say
"done", and pass. Listing `"evidence": ["duration.js"]` makes the checker read that file
itself at judging time and put its real contents in front of the judge, under `project.files`.
Point the spec's wording at that entry.

**Evidence does not have to be a file.** If something outside the repository decides
whether the work is done — a ticket's acceptance criteria, a staging deploy, a migration
status — declare one command for it under `context` in `.orly/config.json` and name it in
`evidence` exactly as you would a path. Its output is put in front of the judge under
`project.context`, and you ask about it in words.

```json
"context": { "ticket": { "command": "jira issue view $TICKET --plain" } }
```

Use a `require` check when a command can decide the answer, and a context source when
someone has to read it.

**And when nothing can produce it** — a design review, a screenshot, an answer only a
search will find — name it in `evidence` anyway and add `"gather": "<what to do>"`. The
block will ask for it in those words, and the next turn is judged on what you bring back.

Mark a spec `"optional": true` when it is desirable but you should be allowed to end the
turn by explaining why it was skipped.

## Shape

```json
{
  "goal": "<the goal, restated in one sentence>",
  "maxRounds": 6,
  "specs": [
    {
      "id": "tests_green",
      "instructions": "Do `command_results` show a test run that reported zero failures, executed after the last edit in `actions_taken`?",
      "criteria": {
        "true": "A test command ran after the final edit and its output reports no failures.",
        "false": "No test run is recorded after the last edit, or the last recorded run reports failures."
      }
    },
    {
      "id": "no_stub",
      "instructions": "Look at the `duration.js` entry under `project.files`, which is the file's real current content. Is the `throw new Error(\"not implemented\")` stub gone and replaced by a working implementation?",
      "evidence": ["duration.js"]
    }
  ]
}
```

## Do this in order

1. Read enough of the project to write specs that refer to its real commands and paths.
2. Write `.orly/specs.json`.
3. Run `bun "${CLAUDE_PLUGIN_ROOT}/bin/orly.ts" specs` — it word-filters for taste
   judgements and asks Jev whether each spec is decidable from recorded evidence. Rewrite
   every spec it rejects and re-run until it is clean. Do not start work on a spec list
   that has not passed this check; an unfalsifiable spec produces a confident number that
   means nothing, and you will be looping against noise.
4. Tell the user the spec list in one short block, then begin the work.

The loop ends when every spec is met, when you state plainly what you could not do and
why, or when the round cap runs out — whichever comes first.
