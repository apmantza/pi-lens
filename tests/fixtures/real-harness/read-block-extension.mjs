// A later extension that blocks every `read` (#4185 R3-2). pi loads it after
// pi-lens, so pi-lens's tool_call handler has already captured the read when
// this handler blocks it: pi then emits `tool_execution_end` for the call and
// no `tool_result`, and the agent never sees the file's bytes.
export default function realHarnessReadBlock(pi) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "read") return undefined;
		return { block: true, reason: "real-harness: read blocked" };
	});
}
