```
  ; ,
 {@.@}
 /) )  oRly?
  "'
```

**Your agent says it's done. Something should check.**

orly turns your goal into specifiers, then checks every one of them at the end of every
turn — in a single request, in under a second, for six thousandths of a cent. Any
that aren't true go back to the agent with the gap named. It keeps working until they hold.

```sh
claude plugin marketplace add /path/to/orly
claude plugin install orly@orly-local
```

Then `/orly:orly <your goal>`.

---

## What you get

**It catches what tests can't.** A test proves code works. It can't tell you the agent
claimed green without running anything, left a TODO where you asked for a feature, dropped
the third item of a three-item request, or quoted a number no command produced. Those are
the failures that ship.

**It reads the files itself.** A spec can name the files it depends on — they're read at
judging time, not taken from what the agent printed. Same transcript, one stub left on
disk: `0.04`, blocked. Stub actually gone: passes. The agent can't narrate its way past it.

**It can't be talked down.** The agent tuning the gate is the thing the gate judges.
Lowering a cut, deleting a spec or marking one optional is refused by the harness — at the
edit, and again at the turn's end for anything that routed around it. Tightening is always
allowed.

**It costs nothing to run.** ~800 ms and ~1,600 input tokens per turn — **$0.67 per
10,000 turns**, against $237 through a frontier model. 357× cheaper is why this can run on
*every* turn instead of being something you remember to invoke.

**It gets better as you use it.** Every judgment is logged. Specs and code hot-reload on
the next turn, no restart. A cut fitted once in one repo is inherited by all of them.

## Measured

12 fixtures against live `jev-1.13.0` — **12/12** block-vs-pass, and the "what next?"
question picks the right step **5/5** on blocked turns. The 0.70 cut is fitted, not
guessed: turns that should pass top out at 0.47, true positives start at 0.93. Those
endpoints move ±0.05 between runs, which is why the cut needs a gap and not just the
right ordering.

It found real problems in its own development: a refactor with no re-verification, a number
quoted from memory, and a fabricated justification — that last one written while
documenting the check that catches it.

## Honest limits

Ten apparent misjudgements during development traced to the state it was handed or a
mislabelled fixture — **none** to the model. Debug in that order: state, then wording, then
the cut. Wording moves the numbers far more than thresholds do.

The `coverage` Score separates real omissions from declared ones at a **negative** margin —
it ranks them the wrong way round. Kept only for extremes; the Nouls do the work.

The guard stops the easy paths, not a determined one. Specs are yours to own.

## Read more

Deeper notes live in [`docs/`](docs/), indexed for machines in [`llms.txt`](llms.txt):
[why the turn boundary](docs/why.txt) · [install](docs/install.txt) ·
[writing specs](docs/specs.txt) · [calibration](docs/calibration.txt) ·
[the state problem](docs/state.txt) · [the guard](docs/guard.txt) ·
[learning](docs/learning.txt) · [porting](docs/porting.txt)

MIT.
