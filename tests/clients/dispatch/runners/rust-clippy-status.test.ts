/**
 * #3751 — the rust-clippy runner reported `status: "failed"` both when clippy
 * could not produce a usable result and when it succeeded and found a
 * deny-level lint. `status` must carry the execution outcome only; severity
 * lives in `semantic` and the diagnostics (CONTRIBUTING.md, "Adding a dispatch
 * runner"). These tests drive the real runner and the real `dispatchForFile`
 * so a deny-level clippy lint still blocks.
 *
 * clippy is not installed on the CI host, so the process boundary is a recorded
 * `cargo clippy --message-format=json` stream
 * (`tests/fixtures/clippy/eq-op-deny.jsonl`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../../clients/degradation-ledger.js";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { resetDispatchAvailabilityState } from "../../../../clients/dispatch/runners/utils/runner-helpers.js";
import type { RunnerResult } from "../../../../clients/dispatch/types.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync, tryLazyInstall, findCargoPathAsync } = vi.hoisted(
	() => ({
		safeSpawnAsync: vi.fn(),
		tryLazyInstall: vi.fn(async () => true),
		findCargoPathAsync: vi.fn(async () => "cargo"),
	}),
);

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	safeSpawnAsync,
}));

vi.mock(
	"../../../../clients/dispatch/runners/utils/lazy-installer.js",
	async (importOriginal) => ({
		...(await importOriginal<Record<string, unknown>>()),
		tryLazyInstall,
	}),
);

vi.mock("../../../../clients/rust-client.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	rustClient: { findCargoPathAsync },
}));

const CLIPPY_FIXTURE = path.resolve("tests/fixtures/clippy/eq-op-deny.jsonl");

function writeCrate(tmpDir: string): string {
	fs.writeFileSync(
		path.join(tmpDir, "Cargo.toml"),
		'[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
	);
	const filePath = path.join(tmpDir, "src", "main.rs");
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, "fn main() {\n    let y = x == x;\n}\n");
	return filePath;
}

async function dispatchClippy(tmpDir: string, filePath: string) {
	const { createDispatchContext, dispatchForFile, RunnerRegistry } =
		await import("../../../../clients/dispatch/dispatcher.js");
	const runner = (
		await import("../../../../clients/dispatch/runners/rust-clippy.js")
	).default;
	const registry = new RunnerRegistry();
	registry.register(runner);
	let observed: RunnerResult | undefined;
	const result = await dispatchForFile(
		createDispatchContext(
			filePath,
			tmpDir,
			{ getFlag: () => false },
			new FactStore(),
		),
		[{ mode: "all", runnerIds: ["rust-clippy"] }],
		registry,
		(_id, res) => {
			observed = res;
		},
	);
	return { observed, result };
}

describe("rust-clippy status is the execution outcome (#3751)", () => {
	beforeEach(() => {
		safeSpawnAsync.mockReset();
		tryLazyInstall.mockClear();
		resetDispatchAvailabilityState();
	});

	it("a deny-level lint is a successful run that still blocks", async () => {
		const env = setupTestEnvironment("pi-lens-clippy-status-");
		try {
			const filePath = writeCrate(env.tmpDir);
			const output = fs.readFileSync(CLIPPY_FIXTURE, "utf8");
			safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
				args.includes("--version")
					? { stdout: "clippy 0.1.0", stderr: "", status: 0 }
					: { stdout: output, stderr: "", status: 101 },
			);

			const { observed, result } = await dispatchClippy(env.tmpDir, filePath);

			// The run succeeded: clippy executed and produced parseable output.
			expect(observed?.status).toBe("succeeded");
			// The severity is carried by semantic and the diagnostic itself.
			expect(observed?.semantic).toBe("blocking");
			expect(observed?.diagnostics.map((d) => d.rule)).toEqual([
				"clippy::eq_op",
			]);
			// The lint still blocks through the real dispatch path: the
			// dispatcher derives blockers from `semantic`, never from `status`.
			expect(result.hasBlockers).toBe(true);
			expect(result.blockers.map((d) => d.rule)).toEqual(["clippy::eq_op"]);
		} finally {
			env.cleanup();
		}
	});

	it("unparsable clippy output is the arm that reports failed", async () => {
		const env = setupTestEnvironment("pi-lens-clippy-unparsable-");
		try {
			const filePath = writeCrate(env.tmpDir);
			safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
				args.includes("--version")
					? { stdout: "clippy 0.1.0", stderr: "", status: 0 }
					: {
							stdout: "cargo clippy failed without json",
							stderr: "",
							status: 101,
						},
			);

			const { observed } = await dispatchClippy(env.tmpDir, filePath);

			// A run that produced no usable result is the only failure left.
			expect(observed?.status).toBe("failed");
			expect(observed?.semantic).toBe("warning");
		} finally {
			env.cleanup();
		}
	});

	it("artifact and failed build output remains failed on a nonzero exit", async () => {
		// #3775 recurrence: a failed cargo build with only cargo progress records
		// must not be mistaken for a clean run when the status guard is weakened.
		const env = setupTestEnvironment("pi-lens-clippy-build-failed-");
		try {
			const filePath = writeCrate(env.tmpDir);
			const output = [
				'{"reason":"compiler-artifact"}',
				'{"reason":"build-finished","success":false}',
			].join("\n");
			safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
				args.includes("--version")
					? { stdout: "clippy 0.1.0", stderr: "", status: 0 }
					: {
							stdout: output,
							stderr: "cargo: compiler failed",
							status: 101,
						},
			);

			const { observed } = await dispatchClippy(env.tmpDir, filePath);

			expect(observed?.status).toBe("failed");
		} finally {
			env.cleanup();
		}
	});

	it("non-cargo stdout remains failed on a zero exit", async () => {
		// #3775 recurrence: successful process exit with non-cargo noise must not
		// be admitted as a clean cargo run when recognition is weakened.
		const env = setupTestEnvironment("pi-lens-clippy-non-cargo-");
		try {
			const filePath = writeCrate(env.tmpDir);
			safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
				args.includes("--version")
					? { stdout: "clippy 0.1.0", stderr: "", status: 0 }
					: {
							stdout: "Finished dev profile [unoptimized + debuginfo]",
							stderr: "",
							status: 0,
						},
			);

			const { observed } = await dispatchClippy(env.tmpDir, filePath);

			expect(observed?.status).toBe("failed");
		} finally {
			env.cleanup();
		}
	});

	it("a clean cargo stream with build-finished is a successful clean run", async () => {
		const env = setupTestEnvironment("pi-lens-clippy-clean-");
		try {
			const filePath = writeCrate(env.tmpDir);
			const output = fs
				.readFileSync(CLIPPY_FIXTURE, "utf8")
				.split("\n")
				.filter((line) => !line.includes('"reason":"compiler-message"'))
				.join("\n")
				.replace('"success":false', '"success":true');
			safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
				args.includes("--version")
					? { stdout: "clippy 0.1.0", stderr: "", status: 0 }
					: { stdout: output, stderr: "", status: 0 },
			);

			const { observed } = await dispatchClippy(env.tmpDir, filePath);

			// Cargo emits artifact/build-finished records even when clippy finds no
			// diagnostics; they are evidence of a parseable clean run (#3775).
			expect(observed?.status).toBe("succeeded");
			expect(observed?.semantic).toBe("none");
			expect(observed?.diagnostics).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	// #5411: a timeout is the cut-short rule (`faultIfCutShort`), the same one
	// the seam runners follow; it reported `failureKind: "timeout"` here.
	it("a timeout with partial parseable output stays failed, as did-not-run, findings kept", async () => {
		const env = setupTestEnvironment("pi-lens-clippy-timeout-");
		try {
			const filePath = writeCrate(env.tmpDir);
			const output = fs.readFileSync(CLIPPY_FIXTURE, "utf8");
			safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
				args.includes("--version")
					? { stdout: "clippy 0.1.0", stderr: "", status: 0 }
					: {
							stdout: output,
							stderr: "",
							status: null,
							error: new Error("timed out"),
							failure: "timeout",
						},
			);

			const { observed } = await dispatchClippy(env.tmpDir, filePath);

			expect(observed?.status).toBe("failed");
			expect(observed?.failureKind).toBe("did-not-run");
			expect(observed?.semantic).toBe("blocking");
			expect(observed?.diagnostics.length).toBeGreaterThan(0);
		} finally {
			env.cleanup();
		}
	});

	// #5411: nothing parsed before the timeout is a `did-not-run` skip, the verdict
	// swiftlint and every other seam runner give a timeout.
	it("a timeout with nothing parsed is a did-not-run skip", async () => {
		resetDegradationLedger();
		const env = setupTestEnvironment("pi-lens-clippy-timeout-empty-");
		try {
			const filePath = writeCrate(env.tmpDir);
			safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
				args.includes("--version")
					? { stdout: "clippy 0.1.0", stderr: "", status: 0 }
					: {
							stdout: "",
							stderr: "",
							status: null,
							error: new Error("timed out"),
							failure: "timeout",
						},
			);

			const { observed } = await dispatchClippy(env.tmpDir, filePath);

			expect(observed?.status).toBe("skipped");
			expect(observed?.skipFault).toBe("did-not-run");
			// Recurrence (#5426 review F2): the skip left no record at all, so a 60 s
			// cold-crate timeout was invisible to anything reading the ledger. The
			// seam writes the one bounded `runner-empty-result` row, as helm does.
			expect(
				getDegradationSummary()
					.find((entry) => entry.kind === "runner-empty-result")
					?.latestReasons.map((entry) => entry.subject),
			).toEqual(["rust-clippy"]);
		} finally {
			env.cleanup();
		}
	});

	it("an output-capped truncated stream remains failed", async () => {
		const env = setupTestEnvironment("pi-lens-clippy-cap-");
		try {
			const filePath = writeCrate(env.tmpDir);
			const output = fs.readFileSync(CLIPPY_FIXTURE, "utf8").slice(0, -8);
			safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
				args.includes("--version")
					? { stdout: "clippy 0.1.0", stderr: "", status: 0 }
					: {
							stdout: output,
							stderr: "",
							status: null,
							error: new Error("output cap"),
							failure: "signal",
							killedForOutputCap: true,
						},
			);

			const { observed } = await dispatchClippy(env.tmpDir, filePath);

			expect(observed?.status).toBe("failed");
			expect(observed?.failureKind).toBe("server_error");
		} finally {
			env.cleanup();
		}
	});

	it("keeps warning-only output succeeded and non-blocking", async () => {
		const env = setupTestEnvironment("pi-lens-clippy-warning-");
		try {
			const filePath = writeCrate(env.tmpDir);
			const output = fs
				.readFileSync(CLIPPY_FIXTURE, "utf8")
				.replace('"level":"error"', '"level":"warning"')
				.replace('"success":false', '"success":true');
			safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
				args.includes("--version")
					? { stdout: "clippy 0.1.0", stderr: "", status: 0 }
					: { stdout: output, stderr: "", status: 0 },
			);

			const { observed } = await dispatchClippy(env.tmpDir, filePath);

			expect(observed?.status).toBe("succeeded");
			expect(observed?.semantic).toBe("warning");
		} finally {
			env.cleanup();
		}
	});

	it("keeps mixed warning and blocking output blocking", async () => {
		const env = setupTestEnvironment("pi-lens-clippy-mixed-");
		try {
			const filePath = writeCrate(env.tmpDir);
			const output = fs
				.readFileSync(CLIPPY_FIXTURE, "utf8")
				.replace('"level":"error"', '"level":"warning"');
			const mixed = `${output}${fs.readFileSync(CLIPPY_FIXTURE, "utf8")}`;
			safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
				args.includes("--version")
					? { stdout: "clippy 0.1.0", stderr: "", status: 0 }
					: { stdout: mixed, stderr: "", status: 0 },
			);

			const { observed } = await dispatchClippy(env.tmpDir, filePath);

			expect(observed?.status).toBe("succeeded");
			expect(observed?.semantic).toBe("blocking");
			expect(observed?.diagnostics).toHaveLength(2);
		} finally {
			env.cleanup();
		}
	});
});
