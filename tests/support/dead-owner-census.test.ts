/**
 * #5528: the per-file dead-owner census names the file behind a leaked managed
 * process. Recurrence it guards: shard-5 jobs ended with `ast-grep` children
 * whose `PI_LENS_OWNER` pid was reaped, and no line named the producing file
 * (#5146 closed without the census; #5267 only hid the symptom).
 *
 * The process table and the owner-tag read are the only fakes (the host
 * process boundary); the dead-owner decision, the managed-name match and the
 * liveness check are the production ones.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	CENSUS_MAX_LINES_PER_FILE,
	censusFile,
	type CensusSeams,
	DEAD_OWNER_CENSUS_FILE_ENV,
	loadActualCensusSeams,
	recordCensusWorker,
	resolveOwnerFile,
	runDeadOwnerCensus,
} from "./dead-owner-census.js";

/** A pid no process holds: above any Linux/macOS pid_max. */
const DEAD_PID = 2_147_483_000;
const START = "123@00000000-0000-0000-0000-000000000000";

type Row = { pid: number; ppid: number; ageMs?: number; command: string };

/** This worker's own row: a real `ps` table always lists the calling worker. */
const SELF_ROW: Row = { pid: process.pid, ppid: 1, command: "vitest-worker" };

async function seamsOver(
	rows: Row[],
	owners: Record<number, number>,
): Promise<CensusSeams> {
	const actual = await loadActualCensusSeams();
	return {
		...actual,
		listProcesses: async () => ({ rows, status: "ok" }),
		readOwnerTags: async (pids) => ({
			tags: new Map(
				pids.flatMap((pid) =>
					owners[pid] === undefined
						? []
						: [[pid, { pid: owners[pid] as number, start: START }] as const],
				),
			),
			status: "ok",
		}),
	};
}

/** The `scanfail` lines the log holds; none when no scan wrote one. */
function scanfailLines(log: string): string[] {
	if (!fs.existsSync(log)) return [];
	return fs
		.readFileSync(log, "utf8")
		.split("\n")
		.filter((line) => line.startsWith("scanfail "));
}

describe("#5528 dead-owner census", () => {
	let dir: string;
	let log: string;
	let lines: string[];
	const write = (line: string) => lines.push(line);

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5528-census-"));
		log = path.join(dir, "census.log");
		lines = [];
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("names the owner's test file for a managed process whose owner pid is dead", async () => {
		recordCensusWorker("clients/lsp/leaky.test.ts", DEAD_PID, log);
		const seams = await seamsOver(
			[
				SELF_ROW,
				{
					pid: 7001,
					ppid: 1,
					ageMs: 42_000,
					command: "ast-grep lsp --config x",
				},
			],
			{ 7001: DEAD_PID },
		);
		const printed = await runDeadOwnerCensus("tests/next.test.ts", {
			log,
			seams,
			write,
		});
		expect(printed).toEqual([
			`[dead-owner-census] pid=7001 owner=${DEAD_PID} age=42s owner_file=clients/lsp/leaky.test.ts seen_after=tests/next.test.ts cmd=ast-grep lsp --config x`,
		]);
	});

	it("spares a live owner, an untagged process, and an unmanaged one", async () => {
		const seams = await seamsOver(
			[
				SELF_ROW,
				{ pid: 7001, ppid: 1, ageMs: 9_000, command: "ast-grep lsp" },
				{ pid: 7002, ppid: 1, ageMs: 9_000, command: "ast-grep lsp" },
				{ pid: 7003, ppid: 1, ageMs: 9_000, command: "sleep 100" },
			],
			// 7001's owner is this live worker; 7002 has no tag; 7003 is not managed.
			{ 7001: process.pid, 7003: DEAD_PID },
		);
		expect(
			await runDeadOwnerCensus("a.test.ts", { log, seams, write }),
		).toEqual([]);
		expect(lines).toEqual([]);
	});

	it("reports an owner that is no recorded worker as unknown", async () => {
		const seams = await seamsOver(
			[SELF_ROW, { pid: 7001, ppid: 1, command: "ast-grep lsp" }],
			{ 7001: DEAD_PID },
		);
		const [line] = await runDeadOwnerCensus("a.test.ts", { log, seams, write });
		expect(line).toContain("owner_file=unknown");
		expect(line).toContain("age=?");
	});

	it("prints each leaked pid once per run, however many files see it", async () => {
		const seams = await seamsOver(
			[SELF_ROW, { pid: 7001, ppid: 1, command: "ast-grep lsp" }],
			{ 7001: DEAD_PID },
		);
		const first = await runDeadOwnerCensus("a.test.ts", { log, seams, write });
		const second = await runDeadOwnerCensus("b.test.ts", { log, seams, write });
		expect({ first: first.length, second: second.length }).toEqual({
			first: 1,
			second: 0,
		});
	});

	it("bounds one file's lines and counts the rest", async () => {
		const total = CENSUS_MAX_LINES_PER_FILE + 3;
		const rows = Array.from({ length: total }, (_, i) => ({
			pid: 8000 + i,
			ppid: 1,
			command: "ast-grep lsp",
		}));
		const owners = Object.fromEntries(rows.map((row) => [row.pid, DEAD_PID]));
		const seams = await seamsOver([SELF_ROW, ...rows], owners);
		const printed = await runDeadOwnerCensus("a.test.ts", {
			log,
			seams,
			write,
		});
		expect(printed).toHaveLength(CENSUS_MAX_LINES_PER_FILE);
		expect(lines.at(-1)).toBe(
			"[dead-owner-census] 3 more dead-owner process(es) after a.test.ts, not listed",
		);
		// The unlisted pids are logged too: a later file does not reprint them.
		expect(
			await runDeadOwnerCensus("b.test.ts", { log, seams, write }),
		).toEqual([]);
	});

	it("counts every failed scan in the log but says so on stderr once", async () => {
		const actual = await loadActualCensusSeams();
		const seams: CensusSeams = {
			...actual,
			listProcesses: async () => ({ rows: [], status: "timeout" }),
		};
		await runDeadOwnerCensus("a.test.ts", { log, seams, write });
		await runDeadOwnerCensus("b.test.ts", { log, seams, write });
		expect({
			stderr: lines,
			scanfail: fs
				.readFileSync(log, "utf8")
				.split("\n")
				.filter((line) => line.startsWith("scanfail ")),
		}).toEqual({
			stderr: [
				"[dead-owner-census] scan did not run: ps timeout (first after a.test.ts)",
			],
			scanfail: [
				"scanfail ps timeout after a.test.ts",
				"scanfail ps timeout after b.test.ts",
			],
		});
	});

	it("records a scan that threw as a failed scan, not a clean one", async () => {
		const actual = await loadActualCensusSeams();
		const seams: CensusSeams = {
			...actual,
			listProcesses: async () => {
				throw new Error("spawn ps ENOENT");
			},
		};
		await runDeadOwnerCensus("a.test.ts", { log, seams, write });
		expect(fs.readFileSync(log, "utf8")).toContain(
			"scanfail threw spawn ps ENOENT after a.test.ts",
		);
	});

	it("is off without its env var and off on Windows", async () => {
		expect(censusFile({}, "linux")).toBeUndefined();
		expect(
			censusFile({ [DEAD_OWNER_CENSUS_FILE_ENV]: log }, "win32"),
		).toBeUndefined();
		expect(censusFile({ [DEAD_OWNER_CENSUS_FILE_ENV]: log }, "linux")).toBe(
			log,
		);
		const seams = await seamsOver(
			[{ pid: 7001, ppid: 1, command: "ast-grep lsp" }],
			{ 7001: DEAD_PID },
		);
		const saved = process.env[DEAD_OWNER_CENSUS_FILE_ENV];
		delete process.env[DEAD_OWNER_CENSUS_FILE_ENV];
		try {
			expect(await runDeadOwnerCensus("a.test.ts", { seams, write })).toEqual(
				[],
			);
		} finally {
			if (saved !== undefined) process.env[DEAD_OWNER_CENSUS_FILE_ENV] = saved;
		}
		expect(lines).toEqual([]);
	});

	it("resolves an owner file from the worker lines only", () => {
		const text =
			"owner 11 a.test.ts\nleak 11 seen_after=x\nowner 111 b.test.ts\n";
		expect({
			a: resolveOwnerFile(text, 11),
			b: resolveOwnerFile(text, 111),
			none: resolveOwnerFile(text, 1),
		}).toEqual({ a: "a.test.ts", b: "b.test.ts", none: "unknown" });
	});

	// #5528 review r1 F1: seven test files that mock the process table answered
	// `ok` with no row for this worker, and the census read that as a clean scan
	// (CI shard 5 among them: `process-snapshot-owner-tags`,
	// `instance-reaper-registry-scan-escalation`). A real `ps` always lists the
	// calling worker, so a table without its row is not a scan that ran.
	it("counts a process table with no row for this worker as a failed scan, not a clean one", async () => {
		const emptyTable = await seamsOver([], {});
		const otherRowsOnly = await seamsOver(
			[{ pid: 7001, ppid: 1, command: "ast-grep lsp" }],
			{ 7001: DEAD_PID },
		);
		expect({
			printed: [
				await runDeadOwnerCensus("a.test.ts", {
					log,
					seams: emptyTable,
					write,
				}),
				await runDeadOwnerCensus("b.test.ts", {
					log,
					seams: otherRowsOnly,
					write,
				}),
			],
			stderr: lines,
			scanfail: scanfailLines(log),
		}).toEqual({
			printed: [[], []],
			stderr: [
				"[dead-owner-census] scan did not run: ps table without this worker (first after a.test.ts)",
			],
			scanfail: [
				"scanfail ps table without this worker after a.test.ts",
				"scanfail ps table without this worker after b.test.ts",
			],
		});
	});

	// #5528 review r1 F2: a failed owner-tag read must read as a failed scan, not
	// as untagged processes. Neutering this branch passed all ten cases.
	it("counts a failed owner-tag read as a failed scan, not as untagged processes", async () => {
		const base = await seamsOver(
			[SELF_ROW, { pid: 7001, ppid: 1, command: "ast-grep lsp" }],
			{ 7001: DEAD_PID },
		);
		const seams: CensusSeams = {
			...base,
			readOwnerTags: async () => ({ tags: new Map(), status: "timeout" }),
		};
		expect({
			printed: await runDeadOwnerCensus("a.test.ts", { log, seams, write }),
			scanfail: scanfailLines(log),
		}).toEqual({
			printed: [],
			scanfail: ["scanfail owner tags timeout after a.test.ts"],
		});
	});

	// #5528 review r1 F2: this worker's own process is never its own leak. The
	// row is managed and tagged with a dead owner, so only the self exclusion
	// keeps it out. Neutering that clause passed all ten cases.
	it("never reports this worker's own process as a leak", async () => {
		const seams = await seamsOver(
			[{ pid: process.pid, ppid: 1, command: "ast-grep lsp" }],
			{ [process.pid]: DEAD_PID },
		);
		expect(
			await runDeadOwnerCensus("a.test.ts", { log, seams, write }),
		).toEqual([]);
		expect(lines).toEqual([]);
	});

	// The setup answers every `Name`-filtered table query with an empty table
	// (#3917); the census must still reach the real `ps`, or it would report
	// nothing on every run and look clean.
	it("reads the real process table through the scope the setup installs", async (ctx) => {
		// The census is off on Windows (no owner tag is written there).
		if (process.platform === "win32") ctx.skip();
		const seams = await loadActualCensusSeams();
		const table = await seams.listProcesses();
		expect({
			status: table.status,
			hasThisWorker: table.rows.some((row) => row.pid === process.pid),
		}).toEqual({ status: "ok", hasThisWorker: true });
	});
});
