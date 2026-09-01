/**
 * #1603 — warm formatter selection must not poll configuration files.
 *
 * Config changes are invalidated by the write-result seam. The cold signature
 * walk still uses real filesystem state to discover the initial config set.
 */

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		access: vi.fn(actual.access),
		readdir: vi.fn(actual.readdir),
	};
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

import * as fsp from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_findUpForTests,
	clearFormatterRuntimeState,
	getFormattersForFile,
	invalidateFormatterCacheForPath,
} from "../../clients/formatters.js";
import { gatedPromise } from "../support/fault-injection.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";
import { setupTestEnvironment } from "./test-utils.js";

const accessMock = vi.mocked(fsp.access);
const readdirMock = vi.mocked(fsp.readdir);
const existsSyncMock = vi.mocked(nodeFs.existsSync);

let tmpDir: string;
let cleanup: () => void;

beforeEach(() => {
	({ tmpDir, cleanup } = setupTestEnvironment("pi-lens-fmt-sig-"));
	accessMock.mockClear();
	readdirMock.mockClear();
	existsSyncMock.mockClear();
});

afterEach(() => {
	clearFormatterRuntimeState();
	cleanup();
});

describe("formatterConfigSignature warm-cache cost (#1603)", () => {
	it("does no filesystem work on a warm selection hit", async () => {
		const filePath = path.join(tmpDir, "index.zzznotarealext");

		await getFormattersForFile(filePath, tmpDir);
		const coldReaddirCount = readdirMock.mock.calls.length;
		expect(coldReaddirCount).toBeGreaterThan(0);
		accessMock.mockClear();
		readdirMock.mockClear();

		await getFormattersForFile(filePath, tmpDir);

		expect(accessMock).not.toHaveBeenCalled();
		expect(readdirMock).not.toHaveBeenCalled();
	});

	it("shares the cold signature walk across concurrent cwd lookups", async () => {
		const firstFile = path.join(tmpDir, "README.md");
		const secondFile = path.join(tmpDir, "index.ts");
		const thirdFile = path.join(tmpDir, "guide.mdx");
		await fsp.writeFile(path.join(tmpDir, ".prettierrc"), "{}\n");
		readdirMock.mockClear();
		await Promise.all([
			getFormattersForFile(firstFile, tmpDir),
			getFormattersForFile(secondFile, tmpDir),
			getFormattersForFile(thirdFile, tmpDir),
		]);

		expect(readdirMock.mock.calls.length).toBeGreaterThan(0);
		readdirMock.mockClear();
		accessMock.mockClear();
		existsSyncMock.mockClear();
		await Promise.all([
			getFormattersForFile(firstFile, tmpDir),
			getFormattersForFile(secondFile, tmpDir),
			getFormattersForFile(thirdFile, tmpDir),
		]);
		// If either cold caller overwrote the other's cache object, its second
		// lookup misses and re-runs an explicit-config filesystem check.
		expect(readdirMock).not.toHaveBeenCalled();
		expect(accessMock).not.toHaveBeenCalled();
		expect(existsSyncMock).not.toHaveBeenCalled();
	});

	it("keeps signature flights independent for different cwd and config state", async () => {
		const otherCwd = path.join(tmpDir, "nested");
		await fsp.mkdir(otherCwd);
		await fsp.writeFile(path.join(otherCwd, ".prettierrc"), "{}\n");
		readdirMock.mockClear();

		await Promise.all([
			getFormattersForFile(path.join(tmpDir, "first.zzznotarealext"), tmpDir),
			getFormattersForFile(
				path.join(otherCwd, "second.zzznotarealext"),
				otherCwd,
			),
		]);

		const readDirectories = new Set(
			readdirMock.mock.calls.map(([directory]) => directory),
		);
		expect(readDirectories.has(tmpDir)).toBe(true);
		expect(readDirectories.has(otherCwd)).toBe(true);
	});

	it("treats a rejected directory read as a negative signature", async () => {
		const originalReaddir = readdirMock.getMockImplementation()!;
		readdirMock.mockRejectedValue(new Error("directory unavailable"));
		await expect(
			getFormattersForFile(
				path.join(tmpDir, "unavailable.zzznotarealext"),
				tmpDir,
			),
		).resolves.toEqual([]);

		// Reset clears the negative detection entry and the completed flight, so
		// a later call can observe the directory after the filesystem recovers.
		clearFormatterRuntimeState();
		readdirMock.mockImplementation(originalReaddir);
		await expect(
			getFormattersForFile(
				path.join(tmpDir, "recovered.zzznotarealext"),
				tmpDir,
			),
		).resolves.toEqual([]);
		expect(readdirMock).toHaveBeenCalled();
	});

	it("drops a cold result invalidated while its signature is in flight", async () => {
		const filePath = path.join(tmpDir, "init.lua");
		const configPath = path.join(tmpDir, "stylua.toml");
		await fsp.writeFile(configPath, "column_width = 100\n");
		const gate = gatedPromise<string[]>();
		const original = readdirMock.getMockImplementation()!;
		let held = false;
		readdirMock.mockImplementation(async (...args) => {
			const entries = await original(...args);
			if (!held) {
				held = true;
				await gate.promise;
			}
			return entries;
		});
		try {
			const pending = getFormattersForFile(filePath, tmpDir);
			while (!held) await new Promise<void>((resolve) => setImmediate(resolve));
			await fsp.rm(configPath);
			invalidateFormatterCacheForPath(configPath);
			gate.resolve([]);
			expect(await pending).toEqual([]);
			// The stale caller must retry in the new generation. One walk belongs
			// to the invalidated flight, and one belongs to its retry.
			expect(
				readdirMock.mock.calls.filter(([directory]) => directory === tmpDir),
			).toHaveLength(2);
		} finally {
			gate.resolve([]);
			readdirMock.mockImplementation(original);
		}
	});

	it("scales with matched candidates, not the candidate-list size", async () => {
		const ancestor = path.join(tmpDir, "project");
		const sourceDir = path.join(ancestor, "src");
		const nested = path.join(sourceDir, "deep");
		await fsp.mkdir(nested, { recursive: true });
		await fsp.writeFile(path.join(sourceDir, "real.config"), "ok\n");

		const small = await _findUpForTests(["real.config"], nested, ancestor);
		const smallAccesses = accessMock.mock.calls.length;
		const smallReads = readdirMock.mock.calls.length;
		expect(small).toEqual([path.join(sourceDir, "real.config")]);
		assertNonEmptyScan("formatter candidate scaling: small list", small.length);

		accessMock.mockClear();
		readdirMock.mockClear();
		const large = await _findUpForTests(
			[
				"real.config",
				"missing-a.config",
				"missing-b.config",
				"missing-c.config",
			],
			nested,
			ancestor,
		);

		// The independent setup work is complete before counters are read. A
		// restored per-candidate probe would increase access calls fourfold;
		// removing entrySet.has would also admit the three missing names.
		expect(large).toEqual(small);
		assertNonEmptyScan("formatter candidate scaling: large list", large.length);
		expect(accessMock.mock.calls.length).toBe(smallAccesses);
		expect(readdirMock.mock.calls.length).toBe(smallReads);
	});

	it.skipIf(process.platform === "win32")(
		"rejects dangling symlinks but keeps accessible matched files",
		async () => {
			// Windows ACL denial is not deterministic on the developer and CI
			// accounts, so the inaccessible-entry axis remains a stated non-goal;
			// the production access check still preserves the old failure semantics.
			const ancestor = path.join(tmpDir, "project");
			const sourceDir = path.join(ancestor, "src");
			const nested = path.join(sourceDir, "deep");
			await fsp.mkdir(nested, { recursive: true });
			await fsp.writeFile(path.join(sourceDir, "real.config"), "ok\n");
			await fsp.symlink(
				path.join(sourceDir, "missing-target"),
				path.join(sourceDir, "dangling.config"),
			);

			await expect(
				_findUpForTests(["dangling.config", "real.config"], nested, ancestor),
			).resolves.toEqual([path.join(sourceDir, "real.config")]);
		},
	);

	it("invalidates cold and warm results for config create and remove", async () => {
		const filePath = path.join(tmpDir, "init.lua");
		const configPath = path.join(tmpDir, "stylua.toml");

		expect(await getFormattersForFile(filePath, tmpDir)).toEqual([]);
		await fsp.writeFile(configPath, "column_width = 100\n");
		// No polling: an external mutation remains invisible until its owner
		// reports the path through invalidateFormatterCacheForPath.
		expect(await getFormattersForFile(filePath, tmpDir)).toEqual([]);

		invalidateFormatterCacheForPath(configPath);
		expect(
			(await getFormattersForFile(filePath, tmpDir)).map((f) => f.name),
		).toEqual(["stylua"]);

		await fsp.writeFile(configPath, "column_width = 120\n");
		invalidateFormatterCacheForPath(configPath);
		readdirMock.mockClear();
		expect(
			(await getFormattersForFile(filePath, tmpDir)).map((f) => f.name),
		).toEqual(["stylua"]);
		expect(readdirMock.mock.calls.length).toBeGreaterThan(0);

		await fsp.rm(configPath);
		invalidateFormatterCacheForPath(configPath);
		expect(await getFormattersForFile(filePath, tmpDir)).toEqual([]);
	});
});
