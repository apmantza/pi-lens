# Real pi harness

The real-harness lane runs the built extension inside a real `pi --mode rpc`
process. Use it when a host event, provider turn, or tool handler crosses a
process boundary that an in-process test cannot observe.

## Five-minute scenario recipe

1. Add `tests/fixtures/real-harness/<name>/project/` and a `script.json`.
2. Use `withRealPi({ fixture: "<name>", script: "script.json" }, ...)`.
3. Call `awaitAssistantTurn()` after each prompt.
4. Call `awaitToolResult("<tool>")` for every expected tool result.
5. Add the test to `realHarnessInclude` and the real-process-spawn ratchet.

## Persisted-session restart

Pass `persistedSession: true` when a scenario must cross a process boundary.
The harness creates `--session-dir <home>/sessions` and exposes `pi.resume()`;
that operation closes stdin on the first child and starts a second child with
the installed pi CLI's `--continue` flag. The RPC documentation defines
`new_session` and `clone`, but no resume RPC; `--continue` is therefore the
authoritative resume operation for this lane. `pi.quit()` closes stdin without
removing the probe home, so final shutdown records can be read before the
`withRealPi` cleanup.

Before either orderly stdin close, the harness waits for `latency.log` to keep
the same size and mtime for 250 ms, bounded by 5 seconds. This protects the
logger's intentional exit-flush replay trade (#935): closing while its last
async append is in flight can duplicate that final lifecycle row. A timeout is
an explicit harness failure, not a reason to proceed with an unstable log.

Scripts contain turns. Each turn contains text or typed tool-call actions.
Malformed scripts fail validation before the child starts.

## Run one file

Build first, then run one serialized file with the pinned probe home:

`PI_LENS_HOME=$PWD/.probe-home npm run test:real-harness -- tests/real-harness/scenario-1.test.ts`

The lane has a 60-second wall budget and one worker. Do not use it for tests
that can assert the same behavior through an in-process seam.

## Hermetic home contents

The harness pins `HOME`, `PI_LENS_HOME`, and the provider observation log to a
claimed scratch directory. It copies only the scenario project fixture. The
scratch seam records an owner PID, sweeps dead entries when a run starts, and
removes the project and home in `finally`. A killed run is therefore cleaned
by the next run before it claims new directories.

## Wall budget

Real provider startup, RPC traffic, tool execution, and teardown share the
60-second test budget. Keep assertions on events and durable sink rows. Avoid
elapsed-time assertions inside scenarios; scheduler-sensitive timing belongs
in the serialized wall-clock lane.

## Live mode

Live-provider mode remains a placeholder for #2826. The scripted provider is
hermetic and is the only supported provider for this lane until that issue
defines credentials, redaction, and replay rules.
