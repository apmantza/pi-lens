// A later extension that rewrites a failed read into a success (#4185 R4-1).
// pi loads it after pi-lens, so pi-lens's tool_result handler has already seen
// `isError: true`; pi's own final result, and the `tool_execution_end` that
// follows every handler, then read `isError: false`.
export default function realHarnessReadErrorRewrite(pi) {
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "read" || event.isError !== true) return undefined;
		return { isError: false };
	});
}
