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
			[{ pid: 7001, ppid: 1, command: "ast-grep lsp" }],
			{ 7001: DEAD_PID },
		);
		const [line] = await runDeadOwnerCensus("a.test.ts", { log, seams, write });
		expect(line).toContain("owner_file=unknown");
		expect(line).toContain("age=?");
	});

	it("prints each leaked pid once per run, however many files see it", async () => {
		const seams = await seamsOver(
			[{ pid: 7001, ppid: 1, command: "ast-grep lsp" }],
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
		const seams = await seamsOver(rows, owners);
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

	it("says once, not per file, that the scan could not run", async () => {
		const actual = await loadActualCensusSeams();
		const seams: CensusSeams = {
			...actual,
			listProcesses: async () => ({ rows: [], status: "timeout" }),
		};
		await runDeadOwnerCensus("a.test.ts", { log, seams, write });
		await runDeadOwnerCensus("b.test.ts", { log, seams, write });
		expect(lines).toEqual([
			"[dead-owner-census] scan did not run (first after a.test.ts)",
		]);
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

	// The setup answers every `Name`-filtered table query with an empty table
	// (#3917); the census must still reach the real `ps`, or it would report
	// nothing on every run and look clean.
	it.skipIf(process.platform === "win32")(
		"reads the real process table through the scope the setup installs",
		async () => {
			const seams = await loadActualCensusSeams();
			const table = await seams.listProcesses();
			expect({
				status: table.status,
				hasThisWorker: table.rows.some((row) => row.pid === process.pid),
			}).toEqual({ status: "ok", hasThisWorker: true });
		},
	);
});
