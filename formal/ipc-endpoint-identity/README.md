# IPC endpoint identity

Model the bind and dial admission added for #5488's reproduced shared-name
collision. The name function abstracts the byte cut: a name either keeps
its owner token or collapses to a shared name. Runtime boundary tests pin the
108/104-byte arithmetic. This model does not cover framing, timeouts, or MCP
session resets.

| Family | Owner token | Bind | Dial |
| --- | --- | --- | --- |
| Workspace | Kept | Allowed | Allowed |
| Workspace | Lost | Refused before unlink | Refused |
| PID | Kept | Allowed | Allowed |
| PID | Lost | Allowed only while the name is free | Refused |

The PID row preserves the opt-in warm-attach behavior: its stale-unlink guard
refuses a shared name, so a second listener fails rather than replacing the
first. The server's workspace gate protects both unlink and bind. The client
gate covers diagnostics, code actions, analyze, and turn-end.

`Fixed.cfg` checks that no bind replaces another owner and no dial reaches
another owner. `PreFixServer.cfg` removes workspace admission and reproduces
replacement. `PreFixClients.cfg` removes client admission and reproduces a
cross-session answer through a shared PID name.

## Local cost measurement

Run on November 11, 2026, with the pinned TLC 2.19 jar, one worker, and an
isolated metadir per config. The command shape, from this model directory:

```text
time --format 'TLC elapsed: %e s' java -Djava.io.tmpdir=<metadir> -XX:+UseParallelGC -cp ../../.cache/tla2tools.jar tlc2.TLC -workers 1 -metadir <metadir> -config <config> IpcEndpointIdentity
```

Raw output excerpts, used by `local-5488` in `scripts/tla-model-costs.json`:

```text
Fixed.cfg
Model checking completed. No error has been found.
1989 states generated, 147 distinct states found, 0 states left on queue.
TLC elapsed: 0.62 s

PreFixServer.cfg
Error: Invariant NoForeignReplacement is violated.
35 states generated, 10 distinct states found, 7 states left on queue.
Command exited with non-zero status 12
TLC elapsed: 0.58 s

PreFixClients.cfg
Error: Invariant NoForeignAnswer is violated.
33 states generated, 13 distinct states found, 10 states left on queue.
Command exited with non-zero status 12
TLC elapsed: 0.59 s
```
