import * as path from "node:path";

// A same-process third-party read producer (#4169): it resolves the v1 bridge
// at call time, so the witness exercises the bridge pi-lens mounted after the
// reload rather than a captured object from the old activation.
export default function realHarnessBridgeRead(pi) {
	pi.registerCommand("real-harness-bridge-read", {
		description: "Record a whole-file read through the pi-lens read bridge",
		handler: async (args, ctx) => {
			const bridge = globalThis[Symbol.for("pi-lens:read-bridge")];
			if (bridge?.version !== 1) throw new Error("pi-lens read bridge absent");
			bridge.recordRead({
				filePath: path.resolve(ctx.cwd, String(args).trim()),
				requestedOffset: 1,
				requestedLimit: undefined,
				consumer: "real-harness",
			});
		},
	});
}
