export default function realHarnessReload(pi) {
	pi.registerCommand("real-harness-reload", {
		description: "Reload the real extension runtime for lifecycle tests",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});
}
