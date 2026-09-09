import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
