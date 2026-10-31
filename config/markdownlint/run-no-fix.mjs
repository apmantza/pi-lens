// Child entry for the markdownlint runner (#5119): runs markdownlint-cli2's
// exported `main` with `fix` forced off. cli2 has no CLI switch that turns a
// project's `"fix": true` off, and a directory config beats `--config`, so the
// runner spawns this file instead of the cli2 bin. It is a child so the
// 15 s spawn budget can kill it, so a rule's late throw cannot reach the host,
// and so an edited .cjs/.mjs config or custom rule is imported fresh.
//
// argv: <cli2 entry module> <directory> <cli2 argv...>
// Output and exit codes follow the cli2 bin: findings on stdout/stderr, exit
// 0/1 from `main`, exit 2 for anything that went wrong before or inside it.
import { pathToFileURL } from "node:url";

const [entry, directory, ...argv] = process.argv.slice(2);

function fail(thrown) {
	process.stderr.write(
		`${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}\n`,
		() => process.exit(2),
	);
}

process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

try {
	const { main } = await import(pathToFileURL(entry).href);
	if (typeof main !== "function") fail(new Error(`${entry} exports no main`));
	process.exitCode = await main({
		directory,
		argv,
		optionsOverride: { fix: false },
		logMessage: (message) => process.stdout.write(`${message}\n`),
		logError: (message) => process.stderr.write(`${message}\n`),
	});
} catch (thrown) {
	fail(thrown);
}
