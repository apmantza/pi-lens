---
section: Fixed
audience: user
area: blockers
---

- **The commit gate now sees a commit run through a substitution inside `bash -c` or `eval`.** The gate read a `bash -c` or `eval` string as words and never scanned it for `$(...)` or backticks, and it read `#` after a substitution's closing `)` as a comment. A `git commit` written either way went unseen, and so did one nested more than three command strings deep or run through `bash -ce`. (refs #5652)
