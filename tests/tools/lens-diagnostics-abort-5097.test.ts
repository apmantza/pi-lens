// flake-shape: raw-timer-wait — a killed real madge child and the cache write that must not follow it have no event to await; a bounded poll observes both.
/**
 * #5097 (r2, review F1): the tool-call abort scope reaches the analyzer
 * spawns behind `lens_diagnostics mode=full`, so Esc now kills madge. A killed
 * madge returns the same empty shape as "no cycles" (no `analyzed`), and the
 * madge task, which keeps running after the tool answers, cached that row and
 * erased the saved cycles.
 *
 * The built extension is loaded into pi's real `ExtensionRunner` (tier 1) and
 * the registered `lens_diagnostics` is called as pi calls it. madge is a
 * managed-tool double, the process boundary: the first scan reports one cycle
 * at once, the second records its pid and parks until killed (or until
 * PARK_LIMIT_S, so a run that never kills it still settles).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { startPiRunner, type PiRunner } from "../support/pi-runner.js";

const PARK_LIMIT_S = 20;

const MADGE = `#!/bin/sh
ctl="$PI_LENS_TEST_MADGE_CTL"
if [ "$1" = "--version" ]; then echo 6.0.0; exit 0; fi
n=$(cat "$ctl/count" 2>/dev/null || echo 0)
echo $((n + 1)) > "$ctl/count"
if [ "$n" -ge 1 ]; then
	echo $$ > "$ctl/scan.pid"
	sleep ${PARK_LIMIT_S}
fi
echo '[["a.ts","b.ts"]]'
`;

type ToolResult = { content?: Array<{ text?: string }>; isError?: boolean };

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Poll `probe` every 20 ms until it is true or `ms` pass; returns the last answer. */
async function pollFor(probe: () => boolean, ms: number): Promise<boolean> {
	const until = Date.now() + ms;
	while (!probe()) {
		if (Date.now() >= until) return false;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return true;
}

// lane: the Linux unit shards; the madge double is a POSIX shell script and
// the Windows leg runs tests/config only.
describe.skipIf(process.platform === "win32")(
	"#5097 lens_diagnostics full: an abort kills madge and keeps its saved row",
	{ timeout: 60_000 },
	() => {
		let pi: PiRunner;
		let ctl: string;

		beforeAll(async () => {
			pi = await startPiRunner();
			const bin = path.join(
				process.env.PI_LENS_HOME ?? "",
				"tools",
				"node_modules",
				".bin",
			);
			fs.mkdirSync(bin, { recursive: true });
			fs.writeFileSync(path.join(bin, "madge"), MADGE, { mode: 0o755 });
			ctl = path.join(pi.cwd, ".madge-ctl");
			fs.mkdirSync(ctl, { recursive: true });
			process.env.PI_LENS_TEST_MADGE_CTL = ctl;
			fs.writeFileSync(
				path.join(pi.cwd, "package.json"),
				JSON.stringify({ name: "mp", private: true }),
			);
			fs.writeFileSync(
				path.join(pi.cwd, "a.ts"),
				'import "./b";\nexport const a = 1;\n',
			);
			fs.writeFileSync(
				path.join(pi.cwd, "b.ts"),
				'import "./a";\nexport const b = 1;\n',
			);
		});

		afterAll(() => {
			delete process.env.PI_LENS_TEST_MADGE_CTL;
		});

		// The row as the cache manager reads it, from the project data dir.
		const madgeRow = (): string | null => {
			const row = new CacheManager().readCache("madge", pi.cwd);
			return row ? JSON.stringify(row.data) : null;
		};

		const call = (signal: AbortSignal): Promise<ToolResult> => {
			const tool = pi
				.getAllRegisteredTools()
				.find((t) => t.definition.name === "lens_diagnostics");
			if (!tool) throw new Error("missing lens_diagnostics");
			const execute = tool.definition.execute as unknown as (
				...args: unknown[]
			) => Promise<ToolResult>;
			return execute(
				"call-5097-d",
				{ mode: "full", refreshRunners: "all" },
				signal,
				undefined,
				{ cwd: pi.cwd, signal },
			);
		};

		// The pid the parked scan wrote; 0 until the file carries content, because
		// `echo $$ > scan.pid` creates the file before it writes.
		const pidOf = (file: string): number => {
			try {
				return Number(fs.readFileSync(file, "utf8").trim());
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
				return 0;
			}
		};

		it("kills madge in 2 s and keeps the saved row", async () => {
			// An empty scan.pid in place before the parked scan writes its pid, as
			// the producer's create-then-write leaves it.
			const pidFile = path.join(ctl, "scan.pid");
			fs.writeFileSync(pidFile, "");
			await call(new AbortController().signal);
			const saved = madgeRow();
			expect(saved).toContain("a.ts");

			const ac = new AbortController();
			const pending = call(ac.signal);
			expect(await pollFor(() => pidOf(pidFile) > 0, 20_000)).toBe(true);
			const pid = pidOf(pidFile);
			ac.abort();
			await pending;
			// Acceptance (d): no scan child 2 s after the abort.
			expect(await pollFor(() => !isAlive(pid), 2_000)).toBe(true);
			// The madge task settles once its killed spawn closes (no grandchild
			// holds the pipe), then writes or not; a write lands well inside this
			// window, and the pre-fix code reds here with an empty row.
			await pollFor(() => madgeRow() !== saved, 1_500);
			expect(madgeRow()).toBe(saved);
		});
	},
);
