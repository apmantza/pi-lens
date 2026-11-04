# Test-runner delivery model

A TLA+ model of automatic test-runner delivery
(`clients/test-runner-delivery.ts`) over the `test-runner-findings` record
that turn_end writes (`clients/runtime-turn.ts`). Every config states its
expected verdict on its first line, and the `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks them all.

Issue: #5259 (a failing result reached the model one agent run late).

## What the model covers

- **Three views of one fact.** The in-memory pending delivery (generation and
  `eligible`), the persisted `deliveryEligible` marker, and the record's two
  generations: `launched` is `testRunGeneration`, the launch high-water mark,
  and `content` is the generation whose batch published the record's content
  (`provenance.revision.generation`), 0 once a delivery retired it.
- **Launch.** The turn_end pre-run write bumps `testRunGeneration` and keeps
  the older batch's content and marker.
- **Publish.** The newest in-flight batch writes its failing content as a fresh
  record, which drops the marker. With `own`, it stages under this delivery's
  key; otherwise another activation or session on the same cwd published it.
  An older batch finishing after a newer launch is superseded and never
  writes (`DropOlder`, `supersededByNewerGeneration`).
- **Settle.** `agent_settled` makes the host idle. The delivery is dropped
  when a newer generation published, or marked eligible and persisted when the
  record still holds its content.
- **Prompt.** The next prompt's context build delivers an eligible delivery
  whose generation still matches, rehydrating it from the marker after a
  restart, and retires the content.
- **Restart.** A primary session replacement clears the in-memory map; the
  marker survives.
- **Identity.** `"content"` compares a delivery with the content's
  generation (shipped, #5259). `"launch"` compares it with
  `testRunGeneration` (pre-fix). `"none"` compares nothing (mutant).

## Invariants

- `NoLateDelivery`: content that was staged and pending when the host settled,
  and is still the record's content at the next prompt, is delivered at that
  prompt.
- `NoStaleDelivery`: a delivery never hands over content another generation
  published.

## Configs

| Config | Expect | What it proves |
|---|---|---|
| `Shipped` | pass | The content identity delivers the staged failure at the next prompt and never delivers another generation's content. |
| `LaunchIdentity` | violated `NoLateDelivery` | The pre-fix identity: Launch, Publish, Launch, Settle drops the staged failure, and the next prompt gets nothing (#5259). |
| `NoIdentity` | violated `NoStaleDelivery` | The generation comparison is load-bearing: without it, another activation's newer content goes out under the older generation. |

## What the model cannot see

- The idle rechecks inside `deliverTestRunnerFindings` (a prompt racing the
  settle) and the provenance validation `peekTestFindings` applies.
- A result that publishes after the settle: it waits for the next idle
  boundary by design (#2366 "carried to the next safe idle boundary").
- Clean results and the zero-test branch of #5257, which stage
  `hasFindings: false`.

## Replay on the real code

`tests/clients/test-runner-delivery.test.ts`: "delivers a staged failure at
the next prompt when a newer run has launched but not published (#5259)"
drives the real `handleTurnEnd` through the `LaunchIdentity` trace, and
"rehydrates an eligible failure across a run that launched but has not
published (#5259)" drives the marker across a launch and a restart.
