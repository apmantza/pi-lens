/**
 * Witnesses for #4268: project-local executables honour pi's project trust.
 *
 * The shared local-bin lookups (`clients/package-manager.ts`) consult
 * `getProjectTrustState()` and refuse a project-local candidate under
 * unknown/untrusted trust. This file drives the REAL seams:
 *
 *   - `eslintRunner.run` — the witness the issue names — through the real
 *     `resolveToolCommand` and the real availability probe;
 *   - `resolveToolCommand`/`resolveLocalFirstAsync` for oxlint and prisma;
 *   - `prettierFormatter.resolveCommand` for the formatter family;
 *   - `detectPythonEnvironment` for the project `.venv` interpreter.
 *
 * The cache-only npx fallback's CHILD environment (the hostile-`.npmrc`
 * vector) is witnessed at the process boundary in
 * `npx-child-env-isolation.test.ts`; an assertion on
 * `getIsolatedNpxSpawnOptions()`'s own return cannot see the spawn merge.
 *
 * Global and managed binaries stay eligible, so under refusal the runner falls
 * back to a global/PATH command rather than executing the project's shim.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../support/runner-ctx.js";
import { setupTestEnvironment } from "./test-utils.js";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	safeSpawnAsync,
}));

// Config discovery is not what these cases witness; open the eslint gate.
vi.mock("../../clients/tool-policy.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	hasEslintConfig: () => true,
}));

import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import { resolveToolCommand } from "../../clients/dispatch/runners/utils/runner-helpers.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";

/** Plant an executable-looking shim at `<dir>/node_modules/.bin/<name>`. */
function plantNodeBin(dir: string, name: string): string {
	const bin = path.join(dir, "node_modules", ".bin");
	fs.mkdirSync(bin, { recursive: true });
	const target = path.join(bin, name);
	fs.writeFileSync(target, "");
	fs.writeFileSync(`${target}.cmd`, "");
	return target;
}

const ok = () => ({ error: null, status: 0, stdout: "[]", stderr: "" });

describe("#4268 project-local binary trust gate", () => {
	beforeEach(() => {
		resetDegradationLedger();
		safeSpawnAsync.mockReset();
		safeSpawnAsync.mockResolvedValue(ok());
	});

	afterEach(() => {
		resetProjectTrust();
		vi.unstubAllEnvs();
	});

	it("eslintRunner.run never executes the project's eslint under unknown or untrusted trust", async () => {
		const env = setupTestEnvironment("pi-lens-trust-eslint-");
		try {
			const local = plantNodeBin(env.tmpDir, "eslint");
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const a = 1;\n");
			const { default: eslintRunner } =
				await import("../../clients/dispatch/runners/eslint.js");
			const ctx = makeRunnerCtx(filePath, env.tmpDir);
			const commands = (): string[] =>
				safeSpawnAsync.mock.calls.map((c) => c[0] as string);

			for (const trust of ["unknown", "untrusted"] as const) {
				setProjectTrustState(trust);
				safeSpawnAsync.mockClear();
				await eslintRunner.run(ctx as never);
				expect(commands(), `trust=${trust}`).not.toContain(local);
			}

			setProjectTrustState("trusted");
			safeSpawnAsync.mockClear();
			await eslintRunner.run(ctx as never);
			expect(commands()).toContain(local);
		} finally {
			env.cleanup();
		}
	});

	it("resolveToolCommand admits the local oxlint only when trusted", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-trust-oxlint-"));
		try {
			const local = plantNodeBin(dir, "oxlint");
			setProjectTrustState("unknown");
			expect(resolveToolCommand(dir, "oxlint")).toBe("oxlint");
			setProjectTrustState("untrusted");
			expect(resolveToolCommand(dir, "oxlint")).toBe("oxlint");
			setProjectTrustState("trusted");
			expect(resolveToolCommand(dir, "oxlint")).toBe(local);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a formatter resolver refuses the project's prettier until trusted", async () => {
		const env = setupTestEnvironment("pi-lens-trust-prettier-");
		try {
			const local = plantNodeBin(env.tmpDir, "prettier");
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "function f() {\n  return 1;\n}\n");
			// No global/managed prettier can answer: every probe fails.
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: "",
			});
			const { prettierFormatter } = await import("../../clients/formatters.js");

			setProjectTrustState("unknown");
			const refused = await prettierFormatter.resolveCommand?.(
				filePath,
				env.tmpDir,
			);
			expect(Array.isArray(refused) ? refused[0] : refused).not.toBe(local);

			setProjectTrustState("trusted");
			const admitted = await prettierFormatter.resolveCommand?.(
				filePath,
				env.tmpDir,
			);
			expect(Array.isArray(admitted) ? admitted[0] : admitted).toBe(local);
		} finally {
			env.cleanup();
		}
	});

	it("detectPythonEnvironment refuses the project's own .venv interpreter until trusted", async () => {
		const env = setupTestEnvironment("pi-lens-trust-venv-");
		try {
			const binDir = path.join(env.tmpDir, ".venv", "bin");
			fs.mkdirSync(binDir, { recursive: true });
			const pythonPath = path.join(binDir, "python");
			fs.writeFileSync(pythonPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
			vi.stubEnv("VIRTUAL_ENV", "");
			vi.stubEnv("CONDA_PREFIX", "");
			vi.stubEnv("UV_PROJECT_ENVIRONMENT", "");
			const { detectPythonEnvironment } =
				await import("../../clients/python-environment.js");

			setProjectTrustState("unknown");
			expect(
				await detectPythonEnvironment(env.tmpDir, os.homedir()),
			).toBeUndefined();
			setProjectTrustState("untrusted");
			expect(
				await detectPythonEnvironment(env.tmpDir, os.homedir()),
			).toBeUndefined();
			setProjectTrustState("trusted");
			expect(
				(await detectPythonEnvironment(env.tmpDir, os.homedir()))?.pythonPath,
			).toBe(pythonPath);
		} finally {
			env.cleanup();
		}
	});
});
