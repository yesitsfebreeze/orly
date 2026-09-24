require: checks.eval_statuses.exit equals 0

In a fresh project with a passing check, a failing check and a turn-only question, `orly eval` exits 2 and prints one satisfied, one violated and one unknown requirement.
