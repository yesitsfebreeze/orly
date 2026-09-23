require: checks.goal_tests.matches gte 3

`bun test test/goals.test.ts` reports at least three passing tests covering goal parsing, goal-order ranking and the guard baseline surviving an appended goal.
