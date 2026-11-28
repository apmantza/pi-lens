/**
 * #5814: the LSP root walks awaited one `stat` per marker per directory, so a
 * markerless python file cost a chain of about 200 sequential round trips
 * (2855 ms for 130 of them on a stalled Windows runner, #5802). A directory's
 * markers are now probed together. These cells guard both halves: the number
 * of sequential rounds, and the precedence the one-at-a-time loops defined.
 * `hasProjectBoundaryMarker` stays serial: it only asks whether any marker
 * exists, so probing past the first hit costs CPU and gains nothing.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LSPService } from "../../../clients/lsp/index.js";
import {
	declinesProjectlessRoot,
	hasProjectBoundaryMarker,
	LSP_SERVERS,
	type LSPServerInfo,
	NearestRoot,
} from "../../../clients/lsp/server.js";
import {
	flushSessionStartLog,
	SESSIONSTART_LOG_FILE,
} from "../../../clients/sessionstart-logger.js";
import { removeTempDirSync } from "../test-utils.js";

/**
 * A pass-through recorder over the real filesystem calls. A "round" is the
 * calls started in one synchronous stretch: a caller that awaits each call
 * before starting the next makes one round per call. It counts call starts, not
 * waits: libuv's thread pool bounds how many run at once. `fault` lets a cell fail
 * or delay one path's `stat`.
 */
const probes = vi.hoisted(() => ({
	recording: false,
	calls: 0,
	rounds: 0,
	roundOpen: false,
	fault: undefined as
		| ((target: string) => Promise<never> | undefined)
		| undefined,
	record(): void {
		if (!this.recording) return;
		this.calls++;
		if (this.roundOpen) return;
		this.roundOpen = true;
		this.rounds++;
		queueMicrotask(() => {
			this.roundOpen = false;
		});
	},
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		stat: ((...args: Parameters<typeof actual.stat>) => {
			probes.record();
			return probes.fault?.(String(args[0])) ?? actual.stat(...args);
		}) as typeof actual.stat,
		readdir: ((...args: Parameters<typeof actual.readdir>) => {
			probes.record();
			return actual.readdir(...args);
		}) as typeof actual.readdir,
	};
});
let sandbox: string;

beforeEach(() => {
	sandbox = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5814-")),
	);
	// The directory mtime reads go through `fs.promises.stat`, not the named
	// `node:fs/promises` binding the marker probes use.
	const realStat = fs.promises.stat;
	vi.spyOn(fs.promises, "stat").mockImplementation(((
		...args: Parameters<typeof realStat>
	) => {
		probes.record();
		return realStat(...args);
	}) as typeof realStat);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	probes.recording = false;
	probes.fault = undefined;
	probes.calls = 0;
	probes.rounds = 0;
	removeTempDirSync(sandbox);
});

function write(...segments: string[]): string {
	const target = path.join(sandbox, ...segments);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, "");
	return target;
}

function server(id: string): LSPServerInfo {
	const found = LSP_SERVERS.find((entry) => entry.id === id);
	if (!found) throw new Error(`${id} server missing from registry`);
	return found;
}

function resolveThroughRegistry(
	id: string,
	file: string,
): Promise<string | undefined> {
	const service = new LSPService(undefined, path.join(sandbox, "repo"));
	const { clientRegistry } = service as unknown as {
		clientRegistry: {
			resolveServerRoot(
				server: LSPServerInfo,
				file: string,
			): Promise<string | undefined>;
		};
	};
	return clientRegistry.resolveServerRoot(server(id), file);
}

/** Turns the real session-start sink on and returns a reader for its new lines. */
async function sessionStartTail(): Promise<() => Promise<string[]>> {
	vi.stubEnv("PI_LENS_TEST_MODE", "0");
	await flushSessionStartLog();
	const from = fs.existsSync(SESSIONSTART_LOG_FILE)
		? fs.statSync(SESSIONSTART_LOG_FILE).size
		: 0;
	return async () => {
		await flushSessionStartLog();
		const added = fs.existsSync(SESSIONSTART_LOG_FILE)
			? fs.readFileSync(SESSIONSTART_LOG_FILE).subarray(from).toString()
			: "";
		// Drop the `[timestamp] ` prefix; keep this cell's sandbox only.
		return added
			.split("\n")
			.filter((line) => line.includes(sandbox))
			.map((line) => line.slice(line.indexOf("] ") + 2));
	};
}

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

describe("LSP root walk rounds (#5814)", () => {
	it("resolves a markerless python file in rounds per directory, not per marker", async () => {
		const file = write("repo", "nested", "src", "main.py");
		const levels = path.dirname(file).split(path.sep).length;

		probes.recording = true;
		const root = await resolveThroughRegistry("python", file);
		probes.recording = false;

		expect(root).toBe(path.dirname(file));
		// Two walks (the marker walk, then the file-directory fallback), each
		// two rounds per directory: the directory mtime and the markers; the
		// `.git` boundary climb and the markers.
		expect(probes.rounds).toBe(4 * levels);
		// The same probes still run; they overlap.
		expect(probes.calls).toBeGreaterThan(4 * probes.rounds);
	});

	it("stops probing boundary markers at the first hit", async () => {
		// `.git` is probed first. Probing the rest of the list after it cost many
		// times the CPU on every early hit (PR #5820 review).
		write("repo", ".git", "HEAD");
		const repo = path.join(sandbox, "repo");

		probes.recording = true;
		expect(await hasProjectBoundaryMarker(repo, server("python"))).toBe(true);
		probes.recording = false;
		expect(probes.calls).toBe(1);
	});

	it("probes one directory's project markers in one round", async () => {
		const dir = path.dirname(write("repo", "empty", "keep.txt"));

		probes.recording = true;
		expect(await declinesProjectlessRoot(server("csharp"), dir)).toBe(true);
		probes.recording = false;
		// The csharp markers are globs: one `readdir` each, all in one round.
		expect(probes.rounds).toBe(1);
		expect(probes.calls).toBeGreaterThan(1);
	});
});

describe("LSP root marker precedence (#5814)", () => {
	it("picks the nearest directory over an earlier-listed marker above it", async () => {
		write("repo", ".git", "HEAD");
		write("repo", "nested", "poetry.lock");
		const file = write("repo", "nested", "src", "main.py");

		expect(await resolveThroughRegistry("python", file)).toBe(
			path.join(sandbox, "repo", "nested"),
		);
	});

	it("reads one directory's markers in list order, whatever order they answer in", async () => {
		// `.git`, `pyproject.toml`, `setup.py`, `setup.cfg`, ..., `Pipfile`:
		// the first two refuse, the first slowly; `setup.cfg` is the hit.
		write("repo", "setup.cfg");
		const file = write("repo", "main.py");
		const repo = path.join(sandbox, "repo");
		const refuse = () => Promise.reject(errno("EACCES"));
		probes.fault = (target) => {
			// A real read settles after every already-rejected probe.
			if (target === path.join(repo, ".git"))
				return fs.promises.readFile(file).then(refuse);
			if (target === path.join(repo, "pyproject.toml")) return refuse();
			if (target === path.join(repo, "Pipfile")) return refuse();
			return undefined;
		};
		const logged = await sessionStartTail();

		expect(
			await NearestRoot([...(server("python").root.rootMarkers ?? [])])(file),
		).toBe(repo);
		// Listed order, and nothing for a marker listed after the hit. The last
		// line is the hit's `.git` boundary climb, a second read of that path.
		expect(await logged()).toEqual([
			`lsp root marker skipped: permission error stat ${path.join(repo, ".git")}`,
			`lsp root marker skipped: permission error stat ${path.join(repo, "pyproject.toml")}`,
			`lsp root marker skipped: permission error stat ${path.join(repo, ".git")}`,
		]);
	});

	it("does not wait on a marker listed after the hit", async () => {
		write("repo", "first.marker");
		const file = write("repo", "main.py");
		const repo = path.join(sandbox, "repo");
		let release!: (reason: Error) => void;
		const held = new Promise<never>((_, reject) => {
			release = reject;
		});
		held.catch(() => {});
		probes.fault = (target) =>
			target === path.join(repo, "second.marker") ? held : undefined;

		expect(await NearestRoot(["first.marker", "second.marker"])(file)).toBe(
			repo,
		);
		release(errno("ENOENT"));
	});

	it.each(["EACCES", "EPERM", "EIO", "ENOTDIR"])(
		"reads a marker whose stat fails with %s as absent and climbs on",
		async (code) => {
			write("repo", "outer.marker");
			write("repo", "nested", "inner.marker");
			const file = write("repo", "nested", "main.py");
			const inner = path.join(sandbox, "repo", "nested", "inner.marker");
			probes.fault = (target) =>
				target === inner ? Promise.reject(errno(code)) : undefined;
			const logged = await sessionStartTail();

			expect(await NearestRoot(["inner.marker", "outer.marker"])(file)).toBe(
				path.join(sandbox, "repo"),
			);
			expect((await logged()).filter((line) => line.includes(inner))).toEqual(
				code === "EACCES" || code === "EPERM"
					? [`lsp root marker skipped: permission error stat ${inner}`]
					: [],
			);
		},
	);

	it("takes a later marker when the `.git` of the temp directory is refused", async () => {
		const temp = path.join(sandbox, "repo");
		write("repo", ".git", "HEAD");
		const file = write("repo", "nested", "main.py");
		vi.stubEnv("TMPDIR", temp);
		vi.stubEnv("TEMP", temp);
		vi.stubEnv("TMP", temp);

		const resolve = NearestRoot([".git", "package.json"], undefined, temp);
		expect(await resolve(file)).toBeUndefined();
		write("repo", "package.json");
		expect(await resolve(file)).toBe(temp);
	});

	it("skips a directory holding any exclude marker", async () => {
		write("repo", "root.marker");
		write("repo", "nested", "root.marker");
		write("repo", "nested", "second.exclude");
		const file = write("repo", "nested", "main.py");

		expect(
			await NearestRoot(
				["root.marker"],
				["first.exclude", "second.exclude"],
			)(file),
		).toBe(path.join(sandbox, "repo"));
	});

	it("logs a refused agent-directory marker once per read", async () => {
		// `tsconfig.json` sits in two of the lists the agent read joins.
		const file = write("repo", ".pi", "agent", "extensions", "x", "a.ts");
		const refused = path.join(sandbox, "repo", ".pi", "agent", "tsconfig.json");
		probes.fault = (target) =>
			target === refused ? Promise.reject(errno("EACCES")) : undefined;
		const logged = await sessionStartTail();

		await server("typescript").root(file);

		expect((await logged()).filter((line) => line.includes(refused))).toEqual([
			`lsp root marker skipped: permission error stat ${refused}`,
		]);
	});

	it("classifies the agent directory by its first listed marker", async () => {
		// tsconfig.json is listed before package.json, so the pair roots the
		// extension at the agent directory; package.json alone would not.
		write("repo", ".pi", "agent", "tsconfig.json");
		write("repo", ".pi", "agent", "package.json");
		const file = write("repo", ".pi", "agent", "extensions", "x", "a.ts");

		expect(await server("typescript").root(file)).toBe(
			path.join(sandbox, "repo", ".pi", "agent"),
		);
	});
});
