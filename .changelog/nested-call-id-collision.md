---
section: Fixed
audience: user
---

- Keep parallel nested tool calls apart under a long parent call id: pi 0.99 codemode names nested calls `<parent>/<n>` and an OpenAI Responses parent id is about 80 characters, so the 64-character slice in `sanitizeCorrelationId` gave `<parent>/1` and `<parent>/2` one key, merged their path attributions and let turn_end report `clean` while both files held blockers. Ids over 64 characters now keep a readable prefix plus a hash of the full id; ids of 64 or fewer are unchanged. A read-guard sidecar written before this fix, holding the old sliced form of a long id, still parses and is dropped on resume, so that read is redone (closes #3833).
