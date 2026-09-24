# ORLY — Vision and Engineering Direction

Build ORLY into a small, understandable system that continuously evaluates a codebase against its requirements and uses the remaining gaps to guide development.

The codebase—not merely the agent’s final response—is the object being evaluated.

At any point, we should be able to answer:
- What is required, and where is it implemented?
- What evidence supports that it works?
- What is missing, incorrect, unnecessarily complicated, or still unknown?

## Core mechanism

User intent → requirements → relevant code and evidence → evaluation
→ smallest justified change → fresh evidence → reevaluation

Claude interprets intent, formulates questions, investigates gaps, and changes code.
JEV answers narrow, typed semantic questions over relevant evidence.
Ordinary code runs deterministic checks and decides how evaluations affect the work.

Use one evaluation mechanism before and after changes. The difference should reveal
what improved, what regressed, and what remains unresolved.

Keep the conceptual model small:

requirement → source locations → evidence → satisfied | violated | unknown

Distinguish model judgments from executable check results. A probability is not proof.
A passing test establishes only what that test actually checks.

## Evaluate the whole implementation

Make every meaningful part of the codebase inspectable against requirements or a
justified supporting purpose. Also identify requirements with no implementation and
code that has not yet been assessed.

Every line may participate in an evaluation, but do not judge lines in isolation.
Use functions, modules, callers, dependencies, and execution results when necessary
to answer the question correctly. Cross-module requirements need cross-module evidence.

Extract requirements from explicit user intent and authoritative project specifications.
Treat inferred requirements as candidates, not established obligations. Existing code
and tests are evidence, not permission to redefine the intended behavior.

Translate vague goals into observable questions. “Is this clean?” is not sufficient.
Ask which responsibility an abstraction serves, whether implementations duplicate the
same behavior, and what contract a proposed simplification must preserve.

Missing evidence means unknown—not automatically broken, and never automatically done.
Investigate unknowns before making speculative changes.

Establish a repository-wide baseline, then reevaluate changed code and affected
requirements. Reuse results only while their relevant inputs remain unchanged.

## Engineering direction

Optimize for correct behavior with the least necessary complexity.

Inspect the repository and trace the existing implementation before changing it.
Reuse working components, standard libraries, and native tooling. Fix root causes.
Prefer subtraction over additional layers.

Do not introduce a general agent framework, unnecessary services, or one model request
per source line. Batch compatible questions over shared evidence where supported.

Small means understandable—not compressed or clever. Remove duplication and needless
indirection without deleting required behavior, weakening validation, or hiding errors.
Preserve security, accessibility, and public contracts where applicable.

Never weaken requirements, thresholds, or tests merely to obtain a passing evaluation.
Legitimate requirement changes must be explicit and trigger reevaluation.

## How to make progress

Start with the smallest working end-to-end slice in the existing repository.

For each iteration, establish the relevant baseline, select the highest-impact gap,
make the smallest coherent change, run appropriate checks, and reevaluate. Add runnable
tests for nontrivial logic. Check affected existing requirements for regressions.

Keep findings actionable: requirement, source location, evidence, and next action.
Do not build elaborate planning infrastructure before this loop works.

Measure evaluation cost and correctness rather than assuming either. Stop repeating
an evaluation when neither the implementation nor its evidence has changed.

Report verified progress separately from unresolved work and blockers.

The target is a trustworthy, evidence-backed picture of the codebase that helps agents
make it simpler and more correct—not another complex system they must maintain.