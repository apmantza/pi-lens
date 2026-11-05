// flake-shape: ungoverned-wait-for — the prime is a spawn started inside session_start whose only observable is the stand-in npm's own log line, so `until` joins that line.
/**
 * #5261: a session starts the global-bin-dir lookup at `session_start`, so the
 * first dispatch does not wait on `which npm` plus `npm config get prefix`.
 *
 * RECURRENCE THIS FILE PREVENTS. The lookup ran only when the first dispatch's
 * tool resolution reached the global rung, so the dispatch paid the whole spawn
 * chain (230-450 ms on the profiled run) even with tool installs disabled: the
 * rung is DISCOVERY of a tool installed with `npm -g` whose bin dir is off PATH,
 * not an install step. A real pi `AgentSession` (tier 2) with a stand-in `npm`
 * first on PATH shows when the query happens: the stand-in appends its argv to
 * a log, so the log is the read-back.
 *
 * The session is `quick`, the shape a real process's first `session_start`
 * takes: it runs no startup preinstall, so nothing but the prime can make the
 * query before the first prompt. (A `full` start queries through its own tool
 * resolution anyway, so it cannot show the prime.)
 *
 * Does not prove: Windows (the stand-in is a POSIX script), or a faster first
 * dispatch on a user's machine (the timing lives in the hot-path latency lane).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// A pass-through counter at the process boundary: every spawn still runs for
// real, the counter only reads which ones were the npm lookup's.
const spawned = vi.hoisted(() => ({ npmLookups: 0 }));
vi.mock("../clients/safe-spawn.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../clients/safe-spawn.js")>();
	return {
		...original,
		safeSpawnAsync: (
			...args: Parameters<typeof original.safeSpawnAsync>
		): ReturnType<typeof original.safeSpawnAsync> => {
			const [command, argv] = args;
			if (command === "npm" || argv.includes("npm")) spawned.npmLookups += 1;
			return original.safeSpawnAsync(...args);
		},
	};
});
import {
	PATH_PROBE_STUB_SUPPORTED,
	writeStandIn,
} from "./support/path-probe-stub.js";
import { piSessionFixture, startPiSession } from "./support/pi-session.js";
import { endTurn } from "./support/pi-session-commit-gate.js";
import { until } from "./support/marker-lsp-project.js";
import { withEnv } from "./support/with-env.js";

const fixture = piSessionFixture();
const QUERY = "config get prefix";

function project(slug: string): string {
	const proj = path.join(fixture.root, slug, "proj");
	fs.mkdirSync(proj, { recursive: true });
	fs.writeFileSync(
		path.join(proj, "package.json"),
		'{"name":"synthetic-5261","private":true}\n',
	);
	fs.writeFileSync(path.join(proj, "b.ts"), "export const b = 1;\n");
	return proj;
}

/** A stand-in `npm` first on PATH that logs every argv and answers the query. */
function plantNpm(slug: string): {
	queries: () => number;
	restore: () => void;
} {
	const dir = path.join(fixture.root, slug, "bin");
	const log = path.join(fixture.root, slug, "npm-queries.log");
	const prefix = path.join(fixture.root, slug, "npm-global");
	fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
	fs.writeFileSync(log, "");
	writeStandIn(
		dir,
		"npm",
		[
			`printf '%s\n' "$*" >> '${log}'`,
			`if [ "$*" = '${QUERY}' ]; then printf '%s\n' '${prefix}'; exit 0; fi`,
			"exit 1",
		].join("\n"),
	);
	const restore = withEnv({
		PATH: [dir, process.env.PATH ?? ""].join(path.delimiter),
	});
	return {
		queries: () =>
			fs
				.readFileSync(log, "utf8")
				.split("\n")
				.filter((line) => line === QUERY).length,
		restore,
	};
}

const restores: Array<() => void> = [];
afterAll(() => {
	for (const restore of restores.splice(0)) restore();
});

describe.skipIf(!PATH_PROBE_STUB_SUPPORTED)(
	"global-bin-dir prime at session_start (#5261)",
	{ timeout: 90_000 },
	() => {
		it("queries the npm prefix at a quick session start, before any prompt", async () => {
			const npm = plantNpm("quick");
			restores.push(npm.restore);
			const handle = await startPiSession({
				root: fixture.root,
				cwd: project("quick"),
				startupMode: "quick",
				responses: [endTurn("done")],
			});
			expect(
				await until(() => npm.queries() === 1, 10_000),
				"the npm prefix is queried with no prompt sent",
			).toBe(true);
			await handle.dispose();
		});

		// Recurrence: the prime ran inside the `session_start` handler, and its
		// first `which` spawn cost about 11 ms of synchronous work there
		// (hot-path latency lane: session_start +12 ms, REGRESSION). A handler
		// registered after pi-lens's own runs the moment its handler settles.
		it("starts the lookup after the session_start handler has settled, not inside it", async () => {
			const npm = plantNpm("deferred");
			restores.push(npm.restore);
			spawned.npmLookups = 0;
			let lookupsWhenHandlerSettled = -1;
			const handle = await startPiSession({
				root: fixture.root,
				cwd: project("deferred"),
				startupMode: "quick",
				inlineFactory: async () => {
					const lens = (await import("../index.js")).default;
					return (pi) => {
						lens(pi);
						pi.on("session_start", () => {
							lookupsWhenHandlerSettled = spawned.npmLookups;
						});
					};
				},
				responses: [endTurn("done")],
			});
			expect(
				lookupsWhenHandlerSettled,
				"no npm lookup spawn has been made when the handler settles",
			).toBe(0);
			expect(
				await until(() => npm.queries() === 1, 10_000),
				"the lookup still runs afterwards",
			).toBe(true);
			await handle.dispose();
		});

		it("queries nothing at session start under --no-lens", async () => {
			const npm = plantNpm("no-lens");
			restores.push(npm.restore);
			const handle = await startPiSession({
				root: fixture.root,
				cwd: project("no-lens"),
				startupMode: "quick",
				flags: new Map<string, boolean>([["no-lens", true]]),
				responses: [endTurn("done")],
			});
			await handle.prompt("hello");
			expect(
				await until(() => npm.queries() > 0, 3000),
				"no query appears within the window the lens-on case needs",
			).toBe(false);
			await handle.dispose();
		});
	},
);
