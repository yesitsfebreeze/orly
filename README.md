```
  , .  
 {@,@}  
 /) )   
  '"  

I have done what you asked, here is... oRly
```

# orly

**Your agent says "done". orly says "oh rly?"** A Claude Code plugin that keeps an
evidence-backed picture of the codebase against its requirements, and refuses to let a turn
end while one is violated.

```
requirement → source locations → evidence → satisfied | violated | unknown
```

## How it works

1. `/orly:orly <goal>` has the agent write one requirement per acceptance criterion into
   `.orly/specs/`: a yes/no question, the files it is about (`evidence:`), or a command that
   decides it (`require:`). `orly specs` rejects what could not be decided from evidence.
2. `orly eval` evaluates every requirement against the codebase now. Checks run in code.
   Questions about files go to [jev](https://console.typesafe.ai), a System One judge, in one
   request. Each requirement gets a status, its locations, one line of evidence and a next
   action. Results are reused while their inputs are unchanged, so an unchanged tree costs
   nothing; the run reports what improved or regressed since last time, and which tracked
   files no requirement names.
3. The Stop hook runs the same evaluation when the agent tries to end a turn. A violated
   requirement blocks the stop, with the gap named, before any question about the turn is
   asked. If the requirements hold, four built-in questions on the turn itself follow: an
   unverified claim, a stub left standing, a part never addressed, a failure never reported.

A probability is a judgment, not proof; a check establishes only what it checks; missing
evidence is unknown, never done. Every judgment prints its token count.

## Install

Needs [bun](https://bun.sh) and a [TypeSafe](https://console.typesafe.ai) key in `TYPESAFE_API_KEY`
(or a `keyCommand` in `.orly/config.json` that prints it).

```sh
claude plugin marketplace add yesitsfebreeze/orly && claude plugin install orly@orly
```

## Usage

```
/orly:orly add retries to the http client     writes the requirements, validates them, starts the work
/orly:orly it said tests pass but one failed  adds the requirement that would have caught it
orly eval                                     every requirement: status, where, evidence, next action
orly specs                                    is every question decidable from recorded evidence?
echo '{"messages":[…]}' | orly judge          any loop: exit 0 may stop, 2 not done, 1 could not run
```

A requirement is a file: optional `key: value` headers, a blank line, one question.

```
evidence: src/http.ts

Look at `src/http.ts` under `project.files`, the file's real content. Does every request
go through a retry loop with a bounded number of attempts?
```

It fails closed on your requirements: a file that does not parse is a violated requirement
until fixed, and the agent cannot delete one, lower its cut or remove its check without the
next stop being refused. It fails open on itself: a judge that is down never becomes a wall.
It cannot trap the agent: the loop ends when every requirement holds, when the agent says
plainly what it could not do and why, or at the round cap (`rounds: 6` in `.orly/goal`).

## Measured

`bun test/calibrate.ts` judges the twelve labelled turns in `test/fixtures/` live and prints
each built-in question's separation and the token total, so the numbers are regenerated
rather than quoted. `bun test` runs offline against a local fake judge.

Deeper: [writing requirements](docs/specs.txt) · [llms.txt](llms.txt)
