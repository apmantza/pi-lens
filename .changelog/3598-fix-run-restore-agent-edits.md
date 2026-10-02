---
section: Fixed
audience: user
---

- **An agent edit made while `cargo clippy --fix` or `dart fix --apply` runs is no longer erased (closes #3598)** — These two tools rewrite files across the whole crate or package, while pi-lens only holds the edited file's mutation queue, so an edit to a sibling file that landed during the run was overwritten by the tool's write. pi-lens now hashes the crate's `.rs` or the package's `.dart` files before the run, captures the bytes of any of them it sees the agent mutate, and writes those bytes back over the tool's write afterwards, recording one degradation for the run. Files the tool created are left alone. The restore never writes over a newer edit or recreates a file the agent deleted or renamed. If the tool overwrote the edit before pi-lens could read it, or pi-lens cannot confirm the edit survived, the tool result (or, for the deferred agent_end fix, the model's next context) names the file so the agent can re-apply the change.
