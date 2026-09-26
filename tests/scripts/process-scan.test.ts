/**
 * Tests for scripts/lib/process-scan.mjs — the LSP-marker matching used by
 * scripts/compat-smoke-behavioral.mjs (#476, Layer B assertion 3: zero
 * surviving LSP-server processes after pi exits, the #472 orphan class), and
 * the one platform process listing both that script and
 * scripts/prune-agent-worktrees.mjs now share (PR #2438 review round 3, F2).
 */

import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
	ageMsFromPosixEtime,
	buildProcessQuery,
	diffSurvivingLspProcesses,
	escapeWqlLikeValue,
	escapeWqlStringValue,
	evaluateNoSurvivingLspProcesses,
	isLspServerCommand,
	isoFromLstart,
	normalizeProcessFields,
	parseProcessTable,
	posixPsPath,
	readLinuxProcessStart,
	snapshotProcesses,
	windowsExe,
	ALL_PROCESS_FIELDS,
	LSP_PROCESS_MARKERS,
} from "../../scripts/lib/process-scan.mjs";

/**
 * Both branches of `buildProcessQuery` ship — the Windows one to every user
 * on Windows, the POSIX one to every user on Linux/macOS — and neither CI
 * runner covers both. The seam reads `process.platform` live for exactly this
 * reason, so the tests drive it.
 */
function withPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
	const original = process.platform;
	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
	});
	try {
		return body();
	} finally {
		Object.defineProperty(process, "platform", {
			value: original,
			configurable: true,
		});
	}
}

describe("LSP_PROCESS_MARKERS", () => {
	it("is a non-empty array of distinctive command fragments", () => {
		expect(Array.isArray(LSP_PROCESS_MARKERS)).toBe(true);
		expect(LSP_PROCESS_MARKERS.length).toBeGreaterThan(0);
	});
});

describe("isLspServerCommand", () => {
	it("matches typescript-language-server command lines", () => {
		expect(
			isLspServerCommand(
				"/usr/local/bin/node /usr/local/lib/node_modules/typescript-language-server/lib/cli.mjs --stdio",
			),
		).toBe(true);
	});

	it("matches ast-grep lsp invocations", () => {
		expect(
			isLspServerCommand("ast-grep lsp --sgconfig /tmp/sgconfig-1234.yml"),
		).toBe(true);
	});

	it("is case-insensitive (Windows command lines often differ in case)", () => {
		expect(
			isLspServerCommand(
				"C:\\Windows\\node.exe TYPESCRIPT-LANGUAGE-SERVER\\lib\\cli.mjs",
			),
		).toBe(true);
	});

	it("does not match an unrelated node process", () => {
		expect(
			isLspServerCommand("/usr/local/bin/node /home/user/app/server.js"),
		).toBe(false);
	});

	it("does not match a bare 'node' or 'language-server' fragment alone", () => {
		expect(isLspServerCommand("node --version")).toBe(false);
		expect(isLspServerCommand("some-other-language-server --stdio")).toBe(
			false,
		);
	});
});

describe("diffSurvivingLspProcesses", () => {
	it("returns LSP rows present in after but not before (new + still alive)", () => {
		const before = [{ pid: 100, command: "bash" }];
		const after = [
			{ pid: 100, command: "bash" },
			{
				pid: 200,
				command: "node .../typescript-language-server/cli.mjs --stdio",
			},
		];
		const surviving = diffSurvivingLspProcesses(before, after);
		expect(surviving).toEqual([
			{
				pid: 200,
				command: "node .../typescript-language-server/cli.mjs --stdio",
			},
		]);
	});

	it("excludes a pid present in both snapshots even if it looks like an LSP server", () => {
		// A pre-existing LSP server on the runner (unrelated to this run) must not
		// be misattributed as something this run leaked.
		const before = [
			{ pid: 200, command: "node .../typescript-language-server/cli.mjs" },
		];
		const after = [
			{ pid: 200, command: "node .../typescript-language-server/cli.mjs" },
		];
		expect(diffSurvivingLspProcesses(before, after)).toEqual([]);
	});

	it("excludes new non-LSP processes", () => {
		const before: Array<{ pid: number; command: string }> = [];
		const after = [{ pid: 300, command: "npm install" }];
		expect(diffSurvivingLspProcesses(before, after)).toEqual([]);
	});

	it("returns [] when nothing survived", () => {
		expect(diffSurvivingLspProcesses([], [])).toEqual([]);
	});
});

describe("evaluateNoSurvivingLspProcesses", () => {
	// PR #2438 review round 4, F-A: a failed/timed-out listing must never
	// read as "no leak" just because its (empty) table diffed clean.
	it("fails when the before-listing did not complete, even with an empty after diff", () => {
		const result = evaluateNoSurvivingLspProcesses(
			{ rows: [], ok: false },
			{ rows: [{ pid: 1, command: "bash" }], ok: true },
		);
		expect(result.pass).toBe(false);
		expect(result.detail).toMatch(/before\.ok=false/);
	});

	it("fails when the after-listing did not complete, even though it reported no rows", () => {
		// The exact shape of reviewer probe C2/C3: a live leaked LSP process
		// exists, but the after-listing times out and reports [] — an
		// unverified table must not be read as proof nothing survived.
		const result = evaluateNoSurvivingLspProcesses(
			{ rows: [], ok: true },
			{ rows: [], ok: false },
		);
		expect(result.pass).toBe(false);
		expect(result.id).toBe("no-surviving-lsp-processes");
		expect(result.detail).toMatch(/after\.ok=false/);
	});

	it("passes when both listings completed and nothing new survived", () => {
		const result = evaluateNoSurvivingLspProcesses(
			{ rows: [{ pid: 1, command: "bash" }], ok: true },
			{ rows: [{ pid: 1, command: "bash" }], ok: true },
		);
		expect(result.pass).toBe(true);
	});

	it("fails when both listings completed and a new LSP process survived", () => {
		const result = evaluateNoSurvivingLspProcesses(
			{ rows: [], ok: true },
			{
				rows: [
					{ pid: 2, command: "node .../typescript-language-server/cli.mjs" },
				],
				ok: true,
			},
		);
		expect(result.pass).toBe(false);
		expect(result.detail).toContain("pid=2");
	});
});

// ---------------------------------------------------------------------------
// The shared platform listing (PR #2438 review round 3, F2)
// ---------------------------------------------------------------------------
//
// scripts/prune-agent-worktrees.mjs and scripts/compat-smoke-behavioral.mjs
// each carried their own windowsExe + snapshotProcesses pair, differing only
// in which columns they asked for — so the exit-code hardening review S5 added
// to one never reached the other. These pin the single implementation.

describe("normalizeProcessFields", () => {
	it("always includes pid, whatever the caller asked for", () => {
		expect(normalizeProcessFields(["command"])).toEqual(["pid", "command"]);
		expect(normalizeProcessFields([])).toEqual(["pid"]);
	});

	it("returns fields in the canonical order, not the caller's", () => {
		expect(normalizeProcessFields(["command", "ppid", "pid"])).toEqual([
			"pid",
			"ppid",
			"command",
		]);
	});

	it("defaults to the full projection and drops unknown names", () => {
		expect(normalizeProcessFields(undefined)).toEqual([...ALL_PROCESS_FIELDS]);
		expect(normalizeProcessFields(null)).toEqual([...ALL_PROCESS_FIELDS]);
		expect(normalizeProcessFields(["pid", "elapsed" as never])).toEqual([
			"pid",
		]);
	});
});

describe("windowsExe", () => {
	it("resolves through System32 rather than PATH", () => {
		// The sweep spawns this interpreter to decide what to KILL; a bare
		// `powershell.exe` is resolvable through a PATH the caller controls.
		const resolved = windowsExe("WindowsPowerShell\\v1.0\\powershell.exe");
		expect(resolved).toContain("System32");
		expect(resolved.endsWith("powershell.exe")).toBe(true);
	});
});

describe("posixPsPath", () => {
	it("always resolves an ABSOLUTE ps, never a bare PATH-resolved name", async () => {
		// The listing decides what the sweep KILLS, so it must not resolve
		// through a PATH a caller can shadow — mirrors windowsExe's reasoning
		// (PR #2438 review round 4, F-D). #2443 adopted the reaper's stricter
		// form: /bin/ps, then /usr/bin/ps, and /bin/ps as the fail-closed
		// default, so a host with neither fails the spawn instead of silently
		// running whatever `ps` a PATH entry points at.
		const fs = await import("node:fs");
		const resolved = posixPsPath();
		expect(resolved.startsWith("/")).toBe(true);
		if (fs.existsSync("/bin/ps")) {
			expect(resolved).toBe("/bin/ps");
		} else {
			expect(["/bin/ps", "/usr/bin/ps"]).toContain(resolved);
		}
	});
});

describe("buildProcessQuery (#2443: the one composed platform listing)", () => {
	it("projects only the requested Windows columns, tab-joined", () => {
		const query = withPlatform("win32", () =>
			buildProcessQuery(["pid", "command"]),
		);
		expect(query.tabSeparated).toBe(true);
		expect(query.command.toLowerCase()).toContain("powershell.exe");
		const script = query.args.at(-1) ?? "";
		expect(script).toContain("SELECT ProcessId,CommandLine FROM");
		// Never the unprojected form: measured ~570ms vs ~316ms on the #2435 box.
		expect(script).not.toContain("SELECT * ");
		expect(script).not.toContain("ParentProcessId");
	});

	it("asks ps for the same projection with header-suppressed columns", () => {
		const query = withPlatform("linux", () =>
			buildProcessQuery(["command", "ppid", "pid"]),
		);
		expect(query.tabSeparated).toBe(false);
		expect(query.args).toEqual(["-eo", "pid=,ppid=,args="]);
		expect(query.serverSideFiltered).toBe(false);
	});

	it("computes the Windows age IN PowerShell, never from a local-time tick", () => {
		// #1857: CreationDate.Ticks is the LOCAL-time representation, so an age
		// differenced in JS was wrong by the host's UTC offset. The delta has to
		// be taken on one side of the boundary.
		const script =
			withPlatform("win32", () =>
				buildProcessQuery(["pid", "ageMs", "command"]),
			).args.at(-1) ?? "";
		expect(script).toContain("SELECT ProcessId,CreationDate,CommandLine FROM");
		expect(script).toContain("TotalMilliseconds");
		expect(script).toContain("-is [datetime]");
		expect(script).not.toContain("Ticks");
	});

	it("filters server-side by pid on both platforms", () => {
		const win = withPlatform("win32", () =>
			buildProcessQuery(["pid", "command"], {
				filter: { column: "ProcessId", op: "eq", values: [11, 22] },
			}),
		);
		expect(win.serverSideFiltered).toBe(true);
		expect(win.args.at(-1)).toContain("WHERE ProcessId=11 OR ProcessId=22");

		const posix = withPlatform("darwin", () =>
			buildProcessQuery(["pid", "command"], {
				filter: { column: "ProcessId", op: "eq", values: [11, 22] },
			}),
		);
		expect(posix.serverSideFiltered).toBe(true);
		expect(posix.args).toEqual(["-p", "11,22", "-o", "pid=,args="]);
	});

	it("reports an image-name filter as NOT applied on POSIX", () => {
		// ps has no server-side name filter, so the caller holds the whole table
		// and must narrow it itself. Saying so is the point: a caller that read
		// the rows as pre-filtered would kill unrelated processes.
		const posix = withPlatform("linux", () =>
			buildProcessQuery(["pid", "command"], {
				filter: { column: "Name", op: "eq", values: ["node"] },
			}),
		);
		expect(posix.serverSideFiltered).toBe(false);
		expect(posix.args).toEqual(["-eo", "pid=,args="]);
	});

	it("escapes WQL string and LIKE values, and rejects a non-pid pid", () => {
		expect(escapeWqlStringValue("o'brien.exe")).toBe("o''brien.exe");
		expect(escapeWqlLikeValue("a%b_c'd")).toBe("a[%]b[_]c''d");
		const script =
			withPlatform("win32", () =>
				buildProcessQuery(["pid"], {
					filter: {
						column: "CommandLine",
						op: "like",
						values: ["C:\\marker'%x"],
					},
					excludeSelfPid: true,
				}),
			).args.at(-1) ?? "";
		expect(script).toContain("CommandLine LIKE '%C:\\marker''[%]x%'");
		expect(script).toContain("$_.ProcessId -ne $PID");

		expect(() =>
			withPlatform("win32", () =>
				buildProcessQuery(["pid"], {
					filter: {
						column: "ProcessId",
						op: "eq",
						values: ["1 OR 1=1" as unknown as number],
					},
				}),
			),
		).toThrow(/invalid pid/);
	});

	it("throws rather than silently dropping a Windows-only column on POSIX", () => {
		// A ps invocation with an unknown column prints usage to stderr and
		// exits with an EMPTY table, which reads exactly like "no such process".
		expect(() =>
			withPlatform("linux", () => buildProcessQuery(["pid", "rssBytes"])),
		).toThrow(/no POSIX ps column/);
	});
});

describe("process start times (#3538)", () => {
	it("macOS asks ps for lstart in the C locale and UTC, so every reader prints one process the same way", () => {
		const query = withPlatform("darwin", () =>
			buildProcessQuery(["pid", "startedAt", "command"], {
				filter: { column: "ProcessId", op: "eq", values: [7] },
			}),
		);
		expect(query.args).toEqual(["-p", "7", "-o", "pid=,lstart=,args="]);
		expect(query.env).toMatchObject({ LC_ALL: "C", TZ: "UTC0" });
	});

	it("a query without a start time keeps the caller's environment", () => {
		const query = withPlatform("darwin", () =>
			buildProcessQuery(["pid", "command"]),
		);
		expect(query.env).toBeUndefined();
	});

	it("Linux never takes a start time from ps: procps derives lstart from a boot time that moves with the clock", () => {
		expect(() =>
			withPlatform("linux", () => buildProcessQuery(["pid", "startedAt"])),
		).toThrow(/read from \/proc/);
	});

	it("Windows emits CreationDate in UTC, ISO-8601, so starts compare across zones and order", () => {
		const query = withPlatform("win32", () =>
			buildProcessQuery(["pid", "startedAt"]),
		);
		const script = query.args[query.args.length - 1];
		expect(script).toContain(
			"$st = if ($_.CreationDate -is [datetime]) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }; ",
		);
		expect(script).toContain('"$($_.ProcessId)`t$st"');
	});

	it("parses a C-locale lstart row into an ISO start", () => {
		const rows = parseProcessTable(
			"  4242 Sat Sep  6 09:26:02 2026 /usr/bin/node x.js\n",
			false,
			["pid", "startedAt", "command"],
		);
		expect(rows).toEqual([
			{
				pid: 4242,
				ppid: 0,
				command: "/usr/bin/node x.js",
				startedAt: "2026-09-06T09:26:02.000Z",
			},
		]);
	});

	it("reads an lstart it cannot parse as unknown, never as a start", () => {
		expect(isoFromLstart("Sat Foo  6 09:26:02 2026")).toBeUndefined();
		expect(isoFromLstart("6 Sept 2026")).toBeUndefined();
	});

	it.skipIf(process.platform !== "linux")(
		// lane: Unit tests (ubuntu); the reader is /proc itself.
		"reads this process's start from /proc as the kernel's tick count, and nothing for a pid that is gone",
		() => {
			const stat = fs.readFileSync("/proc/self/stat", "utf8");
			expect(readLinuxProcessStart(process.pid)).toBe(
				stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
			);
			expect(readLinuxProcessStart(2 ** 22 + 1)).toBeUndefined();
		},
	);
});

describe("parseProcessTable: the extended projections (#2443)", () => {
	it("reads the Windows CPU/RSS row the resource sampler asks for", () => {
		const rows = parseProcessTable(
			"111\t4096\t10000000\t50000000\t2026-08-30T00:00:00Z",
			true,
			["pid", "rssBytes", "cpuKernel100ns", "cpuUser100ns", "startedAt"],
		);
		expect(rows).toEqual([
			{
				pid: 111,
				ppid: 0,
				command: "",
				rssBytes: 4096,
				cpuKernel100ns: 10_000_000,
				cpuUser100ns: 50_000_000,
				startedAt: "2026-08-30T00:00:00Z",
			},
		]);
	});

	it("reads an UNKNOWN age as undefined, never as zero", () => {
		// A zero age reads as "just spawned" and the spawn-grace guard spares
		// the process forever; undefined routes it to the unknownAge bucket.
		const windows = parseProcessTable("111\t7\t\tnode x", true, [
			"pid",
			"ppid",
			"ageMs",
			"command",
		]);
		expect(windows).toEqual([
			{ pid: 111, ppid: 7, ageMs: undefined, command: "node x" },
		]);

		const posix = parseProcessTable("  111     7 01:02:03 node x", false, [
			"pid",
			"ppid",
			"ageMs",
			"command",
		]);
		expect(posix[0]?.ageMs).toBe(ageMsFromPosixEtime("01:02:03"));
	});
});

describe("parseProcessTable", () => {
	it("parses the Windows CIM tab-joined layout, command lines with tabs included", () => {
		const rows = parseProcessTable(
			[
				"1234\t5678\tnode C:\\repo\\tests\\fixtures\\fake-lsp-server.mjs",
				"4\t0\tSystem",
				"", // trailing blank line
			].join("\n"),
			true,
		);
		expect(rows).toEqual([
			{
				pid: 1234,
				ppid: 5678,
				command: "node C:\\repo\\tests\\fixtures\\fake-lsp-server.mjs",
			},
			{ pid: 4, ppid: 0, command: "System" },
		]);
	});

	it("parses the POSIX `ps -eo pid,ppid,args` layout, keeping spaces in args", () => {
		const rows = parseProcessTable(
			[
				"  1234  5678 node /repo/tests/fixtures/fake-lsp-server.mjs --port 0",
			].join("\n"),
			false,
		);
		expect(rows).toEqual([
			{
				pid: 1234,
				ppid: 5678,
				command: "node /repo/tests/fixtures/fake-lsp-server.mjs --port 0",
			},
		]);
	});

	it("drops unparseable lines rather than inventing pid 0 or NaN", () => {
		// A row with a bogus pid that survived here would be handed to
		// process.kill.
		expect(parseProcessTable("header line\n\nnot-a-pid\tx\ty", true)).toEqual(
			[],
		);
		expect(parseProcessTable("", true)).toEqual([]);
	});

	it("parses the two-column projection compat-smoke asks for", () => {
		// No ppid column at all: the command must still be taken whole, and the
		// absent field must read 0 rather than swallowing the command's head.
		expect(
			parseProcessTable("1234\tnode /repo/x.mjs --port 0", true, [
				"pid",
				"command",
			]),
		).toEqual([{ pid: 1234, ppid: 0, command: "node /repo/x.mjs --port 0" }]);
		expect(
			parseProcessTable("  1234 node /repo/x.mjs --port 0", false, [
				"pid",
				"command",
			]),
		).toEqual([{ pid: 1234, ppid: 0, command: "node /repo/x.mjs --port 0" }]);
	});

	it("keeps one row shape regardless of the projection", () => {
		for (const row of parseProcessTable("1234\tnode x", true, [
			"pid",
			"command",
		])) {
			expect(Object.keys(row).sort()).toEqual(["command", "pid", "ppid"]);
		}
	});
});

describe("snapshotProcesses", () => {
	it("lists this process, with a usable parent pid and command line", async () => {
		const { rows, ok } = await snapshotProcesses();
		expect(ok, "the platform listing must exit 0").toBe(true);
		const self = rows.find((row) => row.pid === process.pid);
		expect(
			self,
			`pid ${process.pid} missing from a ${rows.length}-row listing`,
		).toBeTruthy();
		expect(self?.ppid).toBeGreaterThan(0);
		expect(self?.command.length).toBeGreaterThan(0);
	}, 30_000);

	it("honors the projection: no ppid asked for, no ppid reported", async () => {
		// The axis F2 is about. A shared listing that ignored `fields` would
		// still make both callers pass while quietly costing compat-smoke a
		// column it never wanted.
		const { rows, ok } = await snapshotProcesses(["pid", "command"]);
		expect(ok).toBe(true);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((row) => row.ppid === 0)).toBe(true);
		expect(rows.some((row) => row.command.length > 0)).toBe(true);
	}, 30_000);

	it("reports not-ok rather than an empty table when the listing cannot finish", async () => {
		// `ok: false` is the only evidence a caller has that an ABSENCE from
		// the table means nothing — the orphan predicate reads absence as
		// "parent exited".
		const { rows, ok } = await snapshotProcesses(ALL_PROCESS_FIELDS, 1);
		expect(ok).toBe(false);
		expect(rows).toEqual([]);
	}, 30_000);
});
