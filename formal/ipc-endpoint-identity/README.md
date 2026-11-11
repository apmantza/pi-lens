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
