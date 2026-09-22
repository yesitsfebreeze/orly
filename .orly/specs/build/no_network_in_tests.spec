require: checks.net_in_tests.matches equals 0

No unit test calls fetch(); the suite must never hit the live API.
