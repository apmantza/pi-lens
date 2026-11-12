# Prose standard

Apply this standard to PR and issue bodies, review comments, commit messages, documentation, and changelog entries. Every agent and every role contract follows it. Roles do not carry their own copy.

## Sources

ASD-STE100 (Simplified Technical English) is the default. Where it is too strict for a passage, such as design rationale or the explanation of a trade-off, use the Google developer documentation style guide instead. Review comments also follow Google's engineering practices for code review comments: comment on the code, explain the reason, and say what you expect the author to do. This file states the rules in short form, so you do not need to read the sources to apply it.

## House rules

Lead with the outcome. Remove words that do no work. Use active voice and present tense. Use second person for instructions, and use the imperative for steps. Keep one idea per sentence, with about 20–25 words and no more than 30 words. Use consistent terminology and sentence-case headings. Define acronyms on first use. Prefer plain words over jargon. Avoid `please`, filler, noun piles, nested parentheticals, and em-dash chains. Use the Oxford comma.

## What the checker covers

`scripts/check-prose.mjs` checks the mechanical rules. The checker ignores fenced code, inline code, URLs, quoted log lines, blockquotes, and tables. It warns on long sentences, filler, and passive voice, and it blocks title-case headings (#5110). The CLI accepts a body file or standard input and supports `--json`.

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

Open with a short visible part of a few lines: the outcome, the decision or ask, and who acts next. Then fold the detail into a collapsed block. The summary names the model and effort, then says what is inside. Leave a blank line after `</summary>`, or the Markdown inside the block does not render.

```html
<details>
<summary>Claude Opus 5.5 (high): full triage</summary>

...evidence, file references, probes...

</details>
```

The pattern comes from <https://simonwillison.net/2026/Nov/9/details-summary/>. Readers skip long agent comments, so the line that matters (the verdict, the ask, the decision) must stay visible without a click.
