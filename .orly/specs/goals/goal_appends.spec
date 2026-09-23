require: checks.goal_append.exit equals 0

In a fresh directory, two `orly goal` calls leave two goal lines in `.orly/goal`: the second appends, it does not overwrite.
