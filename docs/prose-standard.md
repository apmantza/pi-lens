# Prose standard

Apply this standard to PR and issue bodies, review comments, commit messages, documentation, and changelog entries. Every agent and every role contract follows it. Roles do not carry their own copy.

## Sources

ASD-STE100 (Simplified Technical English) is the default. Where it is too strict for a passage, such as design rationale or the explanation of a trade-off, use the Google developer documentation style guide instead. Review comments also follow Google's engineering practices for code review comments: comment on the code, explain the reason, and say what you expect the author to do. This file states the rules in short form, so you do not need to read the sources to apply it.

## House rules

Lead with the outcome. Remove words that do no work. Use active voice and present tense. Use second person for instructions, and use the imperative for steps. Keep one idea per sentence, with about 20–25 words and no more than 30 words. Use consistent terminology and sentence-case headings. Define acronyms on first use. Prefer plain words over jargon. Avoid `please`, filler, noun piles, nested parentheticals, and em-dash chains. Use the Oxford comma.

## What the checker covers

`scripts/check-prose.mjs` checks the mechanical rules. The checker ignores fenced code, inline code, URLs, quoted log lines, blockquotes, and tables. It warns on long sentences, filler, and passive voice, and it blocks title-case headings (#5110). The heading check reads inline code too, so a capitalised name in backticks counts toward title case. The CLI accepts a body file or standard input and supports `--json`.

```
node scripts/check-prose.mjs --body-file docs/prose-standard.md
```

A clean result is necessary, not sufficient. Reviewers judge the rules below and the rules above that the checker cannot see.

## Judgement-only rules

The checker does not check these ASD-STE100 rules. Reviewers judge them.

- **One meaning per word, one word per meaning.** Pick one term for one thing and keep it. Do not use "lane", "worker" and "task" for the same thing. Do not use one word for two different things.
- **Verbs, not nominalisations.** Write "validate the input", not "perform validation of the input". Write "the cache expires", not "the expiration of the cache occurs".
- **Noun clusters of three words at most.** Write "the cache for LSP diagnostics", not "the LSP diagnostics cache entry lookup". Break a long cluster with a preposition.
- **Procedure steps as one imperative instruction each.** Give each numbered step one command to the reader. Put a condition or a warning in its own sentence or step, not inside the instruction.

Reviewers also judge clarity, terminology, sentence structure, and whether each list uses parallel grammar. Report prose that obscures the outcome or makes a user infer the action.

## Comment layout

This layout applies to posted triage, review, verify, and status comments on issues and PRs. It also applies to a thread reply of more than a few lines. PR bodies keep their linted sections (`.github/PULL_REQUEST_TEMPLATE.md`) and do not use it.

Open with a short visible part: the outcome, the decision or ask, and who acts next. Then fold the detail into a collapsed block. Readers skip long agent comments, so the line that matters must stay visible without a click. The pattern comes from <https://simonwillison.net/2026/Nov/9/details-summary/>.

```html
<details>
<summary>Claude Opus 5.5 (high): full triage</summary>

...evidence, file references, probes...

</details>
```

### What the checker enforces

Run the checker on the comment file before every `gh issue comment`, `gh pr comment`, and thread reply of more than 12 non-blank lines. Roles do not post a long comment that has not passed.

```
node scripts/check-prose.mjs --comment --body-file <file>
```

A comment of 13 or more non-blank lines passes only when all of these hold:

- At most 8 non-blank lines sit outside the folds (the visible part). A code fence outside a fold counts as visible.
- Each `<details>` has a one-line `<summary>...</summary>` on the same line or the next non-blank line, with nothing after `</summary>`.
- A blank line follows the `</summary>` line.
- Each fold closes with `</details>` on its own line. Folds do not nest.
- The summary names a model in one of two forms: `<Model name> (<effort>): <what is inside>` or `<Model name>: <what is inside>`. The model name starts with a known family (Claude, Opus, Sonnet, Haiku, GPT, Codex, Sol, Luna, DeepSeek, Qwen, GLM, Gemini, Muse, Kimi, Mistral, Llama, Grok). The effort is low, medium, high, xhigh, max, minimal, or default, and may follow `thinking`. Add a new family to `MODEL_FAMILIES` in `scripts/check-prose.mjs`.

A comment of 12 non-blank lines or fewer needs no fold. A fold in a short comment still follows the structure rules. The checker also runs the prose checks above in this mode.

The one escape is `--long-ok "<reason>"`, a reason of 12 or more characters. It waives only the fold and visible-part rules for a long comment that cannot fold, for example a verbatim quote. The checker prints the reason, and a bare flag fails.

### Reply shape for review and verify

The visible part says, in this order:

1. The verdict, with the head sha it covers.
2. What the author must do, or "nothing".
3. Who acts next.

Findings, probes, what held up, and bot dispositions go inside the fold. A hand-back is never posted as a comment. Post a summary in this layout, and link or attach nothing private, such as a local path under `/home`.

### Worked example

This is the #5394 review rewritten into the shape. The visible part is three short paragraphs, and the detail sits in the fold. The test `tests/scripts/check-prose.test.ts` runs this block through the checker.

```markdown
Verdict at head 1145734f3 (merged with master 011b5420a): needs changes, nothing high severity.

Author: say what the digests enable (F1), cover the four `retireScope` mutants (F3), and fold the duplicate reader (F5).

Next: we re-review after your push.

<details>
<summary>Claude Opus 5.5 (high): review findings and what held up</summary>

**Premises**

- **(a) MCP bootstrap reset race.** `_resetMcpSessionContext` has no production callers, so the guard protects a test hook only.
- **(b) Config digests.** No production code reads `contributingConfigSources`.

**Findings**

- **F1 (medium): the digests have no consumer.** The field also lists absent, unparseable and unreadable candidates. Probe: a `{ not json` file and seven missing paths all appear in it.
- **F2 (medium): a hand-rolled epoch counter.** Addressed in 233efdbf1 with `createGenerationSource`.
- **F3 (medium): mutation survivors.** We mutated each of the four `retireScope` calls in the built output. `session-context-eviction` stayed green for all four.
- **F5 (low): near-duplicate reader.** `readConfigDocumentAndDigest` nearly copies `readConfigDocument`.

**What held up**

- The digest hashes the exact buffer that gets parsed.
- Across 6 walk scenarios, resolution matched master exactly.
- Red first: with `clients/` reverted and your tests kept, both new tests fail.

</details>
```
