require: checks.spec_crashes.matches equals 0

Every spec in .orly/specs.json passes validateSpecs and evaluates without throwing, so the Stop hook cannot fail open on it.
