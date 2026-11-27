// #5744: crash a real MCP host the way a host whose code throws from a timer
// dies, once its language server has started. Loaded with
// `NODE_OPTIONS=--import`, so every node child the host spawns loads it too;
// it arms only in the MCP server process itself.
//
// SIGUSR2 throws an uncaught exception from a timer. The host's exit code is
// written to PI_LENS_TEST_CRASH_EXIT_FILE from an `exit` listener, so the file
// exists only when the exit listeners ran.
import fs from "node:fs";

const exitFile = process.env.PI_LENS_TEST_CRASH_EXIT_FILE;
const isMcpServer = /[\\/]mcp[\\/]server\.js$/.test(process.argv[1] ?? "");

if (exitFile && isMcpServer) {
	process.on("SIGUSR2", () => {
		setTimeout(() => {
			throw new Error("mcp crash fixture");
		}, 0);
	});
	process.once("exit", (code) => {
		fs.writeFileSync(exitFile, String(code));
	});
}
