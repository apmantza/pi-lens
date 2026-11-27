/**
 * #5814: the LSP root walks awaited one `stat` per marker per directory, so a
 * markerless python file cost a chain of about 200 sequential round trips
 * (2855 ms for 130 of them on a stalled Windows runner, #5802). A directory's
 * markers are now probed together. These cells guard both halves: the number
 * of sequential rounds, and the precedence the one-at-a-time loops defined.
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
import { removeTempDirSync } from "../test-utils.js";

/**
 * A pass-through recorder over the real filesystem calls. A "round" is the
 * calls started in one synchronous stretch: a caller that awaits each call
 * before starting the next makes one round per call. `fault` lets a cell fail
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
const sessionStartLines = vi.hoisted(() => [] as string[]);

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
vi.mock("../../../clients/sessionstart-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../clients/sessionstart-logger.js")
		>();
	return {
		...actual,
		logSessionStart: (line: string) => {
			sessionStartLines.push(line);
		},
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
	sessionStartLines.length = 0;
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

	it("probes one directory's boundary and project markers in one round", async () => {
		const dir = path.dirname(write("repo", "empty", "keep.txt"));

		probes.recording = true;
		expect(await hasProjectBoundaryMarker(dir, server("python"))).toBe(false);
		probes.recording = false;
		expect(probes.rounds).toBe(1);
		expect(probes.calls).toBeGreaterThan(10);

		probes.calls = 0;
		probes.rounds = 0;
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
		const refuse = (ms: number) =>
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(errno("EACCES")), ms),
			);
		probes.fault = (target) => {
			if (target === path.join(repo, ".git")) return refuse(30);
			if (target === path.join(repo, "pyproject.toml")) return refuse(0);
			if (target === path.join(repo, "Pipfile")) return refuse(0);
			return undefined;
		};

		expect(
			await NearestRoot([...(server("python").root.rootMarkers ?? [])])(file),
		).toBe(repo);
		// Listed order, and nothing for a marker listed after the hit. The last
		// line is the hit's `.git` boundary climb, a second read of that path.
		expect(
			sessionStartLines.filter((line) => line.includes("permission error")),
		).toEqual([
			`lsp root marker skipped: permission error stat ${path.join(repo, ".git")}`,
			`lsp root marker skipped: permission error stat ${path.join(repo, "pyproject.toml")}`,
			`lsp root marker skipped: permission error stat ${path.join(repo, ".git")}`,
		]);
	});

	it("does not wait on a marker listed after the hit", async () => {
		write("repo", "first.marker");
		const file = write("repo", "main.py");
		const repo = path.join(sandbox, "repo");
		probes.fault = (target) =>
			target === path.join(repo, "second.marker")
				? new Promise<never>(() => {})
				: undefined;

		expect(await NearestRoot(["first.marker", "second.marker"])(file)).toBe(
			repo,
		);
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

			expect(await NearestRoot(["inner.marker", "outer.marker"])(file)).toBe(
				path.join(sandbox, "repo"),
			);
			expect(
				sessionStartLines.filter((line) => line.includes(inner)),
			).toHaveLength(code === "EACCES" || code === "EPERM" ? 1 : 0);
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
