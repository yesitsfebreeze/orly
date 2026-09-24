<!-- /goal /orly:orly @RUN.md --!>

Continuously improve this repository toward a simple, reliable, fast, and straightforward implementation of its intended purpose. Prefer subtraction, direct control flow, and proven existing capabilities over new machinery.

Do the work—not merely an audit or a plan.

Repeat this cycle:

1. UNDERSTAND
   Read repository instructions, architecture, existing specifications, and tests.
   Trace actual execution paths before proposing changes.
   Identify concrete defects, unnecessary complexity, and measured bottlenecks.
   Distinguish existing failures from regressions introduced by your work.

2. DEFINE INVARIANTS
   Establish or refine concise, repository-specific guarantees:
   - Correct behavior and explicit, predictable failure handling.
   - Clear component boundaries and ownership of state.
   - Consistent data and safe handling of concurrency where applicable.
   - Bounded resource use and justified performance requirements.

   Each invariant must describe what must hold, under which conditions, and how
   it is verified. Prefer executable tests; reuse existing specification files.
   Do not turn subjective preferences into fake guarantees or invent requirements.

3. SELECT ONE IMPROVEMENT
   Choose the highest-value, tightly scoped task supported by repository evidence.
   Prioritize correctness and security, then simplification, then measured speed.
   State the problem, affected invariant, and observable completion criteria.
   Avoid unrelated cleanup and speculative work.

4. IMPLEMENT COMPLETELY
   Fix the root cause with the smallest coherent change.
   Reuse existing code, standard libraries, and native platform features.
   Remove obsolete code when safely replacing it.
   Add a regression test that exposes the original defect where applicable.
   Preserve intended public behavior and unrelated user changes.

5. VERIFY
   Run relevant tests, static checks, and builds.
   Check failure paths and affected integration boundaries—not only happy paths.
   Measure before and after when claiming a performance improvement.
   Inspect the final diff for unnecessary complexity and accidental scope.
   Never claim completion or successful verification without evidence.

6. RESTART
   Briefly report what changed, what was verified, and any remaining limitations.
   Reinspect the repository from step 1 and select the next justified improvement.
   Do not stop after producing specifications or identifying the next task.

Constraints:
- No unnecessary dependencies, abstractions, configuration, or frameworks.
- No weakened tests, validation, security, or error handling to make checks pass.
- No broad rewrites when a focused change solves the problem.
- No invented benchmarks, results, or completion claims.
- Do not manufacture work. Stop when no worthwhile, evidence-backed improvement
  remains or a genuine blocker requires user input.
```
