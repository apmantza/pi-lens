import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// flake-shape: real-process-spawn — pinned npm must regenerate the real optional binding

const { runLockfileCompleteness } =
	await import("../../scripts/lib/lockfile-completeness.mjs");
const tempDirs: string[] = [];

function fixture() {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-lock-complete-test-"),
	);
	tempDirs.push(root);
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ name: "fixture", packageManager: "npm@11.18.0" }),
	);
	fs.writeFileSync(
		path.join(root, "package-lock.json"),
		JSON.stringify({ packages: { "": {}, "node_modules/kept": {} } }),
	);
	return root;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

describe("lockfile completeness guard", () => {
	it("names the first optional node_modules key npm would restore", () => {
		// Regression: a different npm major omitted optional platform bindings,
		// and the clean-clone production guard caught the drift only after merge.
		const root = fixture();
		const fakeSpawn = (
			_file: string,
			_args: string[],
			options: { cwd: string },
		) => {
			const lockfile = path.join(options.cwd, "package-lock.json");
			const lock = JSON.parse(fs.readFileSync(lockfile, "utf8"));
			lock.packages["node_modules/@rolldown/binding-openharmony-arm64"] = {};
			fs.writeFileSync(lockfile, JSON.stringify(lock));
			return { status: 0, stdout: "", stderr: "" };
		};
		const result = runLockfileCompleteness({
			cwd: root,
			spawn:
				fakeSpawn as unknown as typeof import("node:child_process").spawnSync,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toContain(
			"added node_modules/@rolldown/binding-openharmony-arm64",
		);
	});

	it("reports npm acquisition outages as inconclusive", () => {
		const result = runLockfileCompleteness({
			cwd: fixture(),
			spawn: (() => ({
				status: 1,
				stdout: "",
				stderr:
					"npm ERR! FetchError: request to http://127.0.0.1:9/npm failed ECONNREFUSED",
			})) as unknown as typeof import("node:child_process").spawnSync,
		});
		expect(result).toMatchObject({
			ok: false,
			inconclusive: true,
			reason: "npm pin unavailable",
		});
	});

	it("copies only manifests into the isolated tree", () => {
		// Regression: the old recursive copy placed arbitrary repository content
		// in the npm cwd, despite the gate requiring manifest-only isolation.
		const root = fixture();
		fs.writeFileSync(path.join(root, "unrelated.txt"), "must not copy");
		let entries: string[] = [];
		const result = runLockfileCompleteness({
			cwd: root,
			spawn: ((_file: string, _args: string[], options: { cwd: string }) => {
				entries = fs.readdirSync(options.cwd).sort();
				return { status: 0, stdout: "", stderr: "" };
			}) as unknown as typeof import("node:child_process").spawnSync,
		});
		expect(result.ok).toBe(true);
		expect(entries).toEqual(["package-lock.json", "package.json"]);
	});

	it("reproduces npm's real optional-binding rewrite from the npm-9 lock shape", () => {
		// Regression: npm 9 wrote rolldown's optional declaration without the
		// corresponding packages/node_modules descriptor; npm 11 restored it.
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lock-real-test-"),
		);
		tempDirs.push(root);
		fs.copyFileSync(
			path.join(process.cwd(), "package.json"),
			path.join(root, "package.json"),
		);
		fs.copyFileSync(
			path.join(process.cwd(), "package-lock.json"),
			path.join(root, "package-lock.json"),
		);
		const lockPath = path.join(root, "package-lock.json");
		const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
		delete lock.packages["node_modules/@rolldown/binding-openharmony-arm64"];
		fs.writeFileSync(lockPath, JSON.stringify(lock));
		const result = runLockfileCompleteness({
			cwd: root,
			spawn: spawnSync,
			env: {
				...process.env,
				PI_LENS_HOME: path.join(process.cwd(), ".probe-home"),
				npm_config_cache: path.join(process.cwd(), ".probe-home/npm-cache"),
			},
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toContain(
			"added node_modules/@rolldown/binding-openharmony-arm64",
		);
	}, 30_000);

	it("accepts an unchanged lockfile after npm completes", () => {
		const result = runLockfileCompleteness({
			cwd: fixture(),
			spawn: (() => ({
				status: 0,
				stdout: "",
				stderr: "",
			})) as unknown as typeof import("node:child_process").spawnSync,
		});
		expect(result).toMatchObject({ ok: true, pin: "11.18.0" });
	});
});
