// #5394: `--import` preload for the real MCP server child. It rewrites the
// global config between two reads the server makes, at the filesystem seam, and
// records what the real RuntimeCoordinator did. Nothing in the server is faked.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isMainThread } from "node:worker_threads";

const eventLog = process.env.PI_LENS_TEST_RACE_LOG;
const isServer = /[\\/]mcp[\\/]server\.js$/.test(process.argv[1] ?? "");

if (eventLog && isMainThread && isServer) {
	const configPath = process.env.PI_LENS_CONFIG_PATH;
	const read = fs.readFileSync;
	const record = (event) =>
		fs.appendFileSync(eventLog, `${JSON.stringify(event)}\n`);
	// Undefined until the chunk carrying session_start arrives.
	let reads;

	fs.readFileSync = function (file, ...rest) {
		const content = read.call(this, file, ...rest);
		if (reads === undefined || file !== configPath) return content;
		const limit = Error.stackTraceLimit;
		Error.stackTraceLimit = 40;
		const stack = new Error().stack ?? "";
		Error.stackTraceLimit = limit;
		const caller =
			/at invalidateMcpSessionIfConfigChanged .*\n\s+at (?:async )?(\w+)/.exec(
				stack,
			)?.[1];
		if (!caller) return content;
		reads += 1;
		record({ read: caller });
		if (reads === 3) {
			fs.writeFileSync(
				configPath,
				JSON.stringify({ lsp: { disabledServers: ["typos"] } }),
			);
		}
		return content;
	};
	syncBuiltinESMExports();

	const on = process.stdin.on;
	process.stdin.on = function (event, listener) {
		if (event !== "data") return on.call(this, event, listener);
		return on.call(this, event, (chunk) => {
			if (!chunk.includes("pilens_session_start")) return listener(chunk);
			reads = 0;
			if (!process.env.PI_LENS_TEST_RACE_DEFER_SECOND) return listener(chunk);
			const split = chunk.indexOf("\n") + 1;
			listener(chunk.slice(0, split));
			setImmediate(listener, chunk.slice(split));
		});
	};

	const { RuntimeCoordinator } = await import(
		"../../clients/runtime-coordinator.js"
	);
	const reset = RuntimeCoordinator.prototype.resetForSession;
	RuntimeCoordinator.prototype.resetForSession = function (...args) {
		const retiredBy = this.sessionScope.retiredBy() ?? null;
		reset.apply(this, args);
		record({ reset: { retiredBy, liveAfter: this.sessionScope.isLive() } });
	};
}
