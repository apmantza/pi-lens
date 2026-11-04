/**
 * #4689 batch 3: the pipeline's ownership discriminator keys the files pi-lens
 * itself changed by the path identity, not by a spelling.
 *
 * `runPipeline` takes the target in the spelling the agent used (an alias
 * root: `crate-alias` -> `crate`), while a whole-package fixer reports what it
 * changed from a walk that starts at the crate's identity directory
 * (`tryRustClippyFix`, #4689 item 6). The membership test
 * `piChangedFiles.has(path.resolve(filePath))` compared those two spellings,
 * so the target's own change was not the pipeline's: `targetFileModified` was
 * false, the post-write state hash was never drawn, and the published
 * changed-file list named the file only under the identity spelling.
 *
 * The real `runPipeline` and its Rust autofix path run. Only the process
 * boundary is faked: `cargo clippy --fix` is a double that rewrites the file
 * where the real tool would.
 *
 * Recurrence guarded: shape 1 (divergent path keys) on the pipeline-ownership
 * discriminator (#2499), the Set and its probe keyed by two spellings of one
 * file.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BiomeClient } from "../../clients/biome-client.js";
import {
	type PipelineContext,
	type PipelineDeps,
	runPipeline,
} from "../../clients/pipeline.js";
import type { RuffClient } from "../../clients/ruff-client.js";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	_resetForTests as resetBusPublish,
	wireBusEmitter,
} from "../../clients/bus-publish.js";
import { resolveLanguageRootForFile } from "../../clients/language-profile.js";
import { handleAgentEnd } from "../../clients/runtime-agent-end.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { TestRunnerClient } from "../../clients/test-runner-client.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";
import { setupTestEnvironment } from "./test-utils.js";

const fake = vi.hoisted(() => ({
	/** The body of the fake `cargo clippy --fix`; it runs where clippy would. */
	clippy: undefined as undefined | ((cwd: string) => Promise<number>),
	/** The body of the fake `dart fix --apply`. */
	dartFix: undefined as undefined | ((cwd: string) => Promise<number>),
	/** How many `dart fix --apply` runs the fixer started. */
	dartFixRuns: 0,
}));

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/safe-spawn.js")>();
	return {
		...actual,
		safeSpawnAsync: vi.fn(
			async (
				command: string,
				args: readonly string[],
				options?: Parameters<typeof actual.safeSpawnAsync>[2],
			) => {
				if (command === "cargo" && args[0] === "--version") {
					return { stdout: "cargo 1.82.0", stderr: "", status: 0 };
				}
				if (
					command === "cargo" &&
					args[0] === "clippy" &&
					args.includes("--fix")
				) {
					const status = (await fake.clippy?.(options?.cwd ?? "")) ?? 0;
					return { stdout: "", stderr: "", status };
				}
				if (command === "cargo" && args[0] === "clippy") {
					return { stdout: "", stderr: "", status: 0 };
				}
				if (command === "dart" && args[0] === "--version") {
					return { stdout: "Dart SDK version: 3.5.0", stderr: "", status: 0 };
				}
				if (command === "dart" && args[0] === "fix") {
					fake.dartFixRuns++;
					const status = (await fake.dartFix?.(options?.cwd ?? "")) ?? 0;
					return { stdout: "", stderr: "", status };
				}
				return actual.safeSpawnAsync(command, [...args], options);
			},
		),
	};
});

const ORIGINAL = "fn main() { let x = 1; }\n";
const TOOL_FIXED = "fn main() { let _x = 1; }\n";

describe("pipeline changed-file discriminator keys by path identity (#4689)", () => {
	let tmpDir: string;
	let cleanup: () => void;
	let realMain: string;
	let aliasMain: string;
	let skipReason: string | undefined;

	beforeEach(async () => {
		// `{ rootMarker: false }`: the Rust root comes from the `Cargo.toml`
		// below, not from a `.git` the shared fixture would plant.
		const env = setupTestEnvironment("pi-lens-pipeline-identity-4689-", {
			rootMarker: false,
		});
		tmpDir = env.tmpDir;
		cleanup = env.cleanup;
		const crate = path.join(tmpDir, "crate");
		fs.mkdirSync(path.join(crate, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(crate, "Cargo.toml"),
			'[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n',
		);
		fs.writeFileSync(
			path.join(tmpDir, "Cargo.toml"),
			'[workspace]\nmembers = ["crate"]\n',
		);
		realMain = path.join(crate, "src", "main.rs");
		fs.writeFileSync(realMain, ORIGINAL);
		skipReason = undefined;
		try {
			fs.symlinkSync("crate", path.join(tmpDir, "crate-alias"), "dir");
		} catch (err) {
			skipReason = `cannot create symlinks here: ${
				err instanceof Error ? err.message : String(err)
			}`;
		}
		aliasMain = path.join(tmpDir, "crate-alias", "src", "main.rs");
		await installLspServiceDouble(null);
	});

	afterEach(() => {
		fake.clippy = undefined;
		cleanup();
	});

	/** A formatter double that reports a change and leaves the bytes alone. */
	const formattingService = () =>
		({
			recordRead: () => {},
			formatFile: async () => ({
				formatters: [
					{
						name: "rustfmt",
						outcome: "formatted",
						changed: true,
						success: true,
					},
				],
				anyChanged: true,
				allSucceeded: true,
			}),
		}) as never;

	function deps(getFormatService: () => never = () => ({}) as never) {
		return {
			biomeClient: {
				isSupportedFile: () => true,
				ensureAvailable: async () => false,
				fixFileAsync: async () => ({ success: true, changed: false, fixed: 0 }),
			} as unknown as BiomeClient,
			ruffClient: {
				isPythonFile: () => false,
				ensureAvailable: async () => false,
			} as unknown as RuffClient,
			testRunnerClient: new TestRunnerClient(),
			getFormatService,
			fixedThisTurn: new Set(),
		} as PipelineDeps;
	}

	function context(filePath: string, immediateFormat = false): PipelineContext {
		return {
			filePath,
			cwd: tmpDir,
			toolName: "write",
			getFlag: (name: string) => immediateFormat && name === "immediate-format",
			dbg: () => {},
		};
	}

	it("counts the target's own autofix as the pipeline's through an alias root", async (ctx) => {
		if (skipReason) ctx.skip(skipReason);
		fake.clippy = async () => {
			fs.writeFileSync(realMain, TOOL_FIXED);
			return 0;
		};

		// Immediate format on: the format phase adds the alias spelling and the
		// fixer adds the real one, so the published list can name the file twice.
		const result = await runPipeline(
			context(aliasMain, true),
			deps(formattingService),
		);

		expect(fs.readFileSync(realMain, "utf-8")).toBe(TOOL_FIXED);
		// The discriminator: the target changed, so the post-write state hash is
		// drawn from the bytes pi-lens left (#2499).
		expect(result.fileModified).toBe(true);
		expect(result.postWriteStateHash).toBeTypeOf("string");
		// Recurrence: the notice named one file twice, once per spelling.
		expect(result.postAutofixNotice?.changedFiles).toHaveLength(1);
		// The fixer's own spelling of the file it changed, listed once.
		expect(result.changedFiles).toEqual([fs.realpathSync(realMain)]);
		// The postMutation gate reads the same fixer report: the model gets the
		// authoritative content of a file pi-lens rewrote, whatever its spelling.
		expect(result.postMutation?.content).toBe(TOOL_FIXED);
	}, 10000);

	it("answers the same through the real path", async () => {
		fake.clippy = async () => {
			fs.writeFileSync(realMain, TOOL_FIXED);
			return 0;
		};

		const result = await runPipeline(context(realMain), deps());

		expect(result.postWriteStateHash).toBeTypeOf("string");
		expect(result.changedFiles).toEqual([fs.realpathSync(realMain)]);
		expect(result.postMutation?.content).toBe(TOOL_FIXED);
	}, 10000);
});

// #4689 batch 3 (AE1, AE2): the deferred autofix drain's scope key and its
// changed-file set were censused as spelling-keyed. The producer of a record's
// cwd, `resolveLanguageRootForFile`, answers the marker directory by its
// identity for every spelling of a file, so two records of one Dart package
// share a scope key and `dart fix` runs once; its walk reports each file once.
// These cells pin that refutation: a producer that kept the spelling would run
// the package fixer twice and name a file under two spellings in the published
// list.
describe("deferred autofix drain keys the package scope by identity (#4689)", () => {
	let tmpDir: string;
	let cleanup: () => void;
	let skipReason: string | undefined;
	const DART_ORIGINAL = "void main() { var x = 1; }\n";
	const DART_FIXED = "void main() { final x = 1; }\n";

	beforeEach(() => {
		const env = setupTestEnvironment("pi-lens-agent-end-identity-4689-", {
			rootMarker: false,
		});
		tmpDir = env.tmpDir;
		cleanup = env.cleanup;
		const pkg = path.join(tmpDir, "pkg");
		fs.mkdirSync(path.join(pkg, "lib"), { recursive: true });
		fs.writeFileSync(
			path.join(pkg, "pubspec.yaml"),
			"name: fixture\nenvironment:\n  sdk: ^3.0.0\n",
		);
		fs.writeFileSync(path.join(pkg, "lib", "a.dart"), DART_ORIGINAL);
		fs.writeFileSync(path.join(pkg, "lib", "b.dart"), DART_ORIGINAL);
		skipReason = undefined;
		try {
			fs.symlinkSync("pkg", path.join(tmpDir, "pkg-alias"), "dir");
		} catch (err) {
			skipReason = `cannot create symlinks here: ${
				err instanceof Error ? err.message : String(err)
			}`;
		}
	});

	afterEach(() => {
		fake.dartFix = undefined;
		fake.dartFixRuns = 0;
		resetBusPublish();
		cleanup();
	});

	it("runs the package fixer once for records spelled through an alias and the real path", async (ctx) => {
		if (skipReason) ctx.skip(skipReason);
		const realA = path.join(tmpDir, "pkg", "lib", "a.dart");
		const realB = path.join(tmpDir, "pkg", "lib", "b.dart");
		const aliasA = path.join(tmpDir, "pkg-alias", "lib", "a.dart");
		fake.dartFix = async () => {
			fs.writeFileSync(realA, DART_FIXED);
			fs.writeFileSync(realB, DART_FIXED);
			return 0;
		};
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = tmpDir;
		// The cwd of each record is what the production producers hand
		// `deferMutation`: `resolveLanguageRootForFile` of the file as spelled.
		for (const file of [aliasA, realB]) {
			runtime.deferMutation(
				file,
				resolveLanguageRootForFile(file, tmpDir),
				"edit",
				tmpDir,
				"autofix",
			);
		}
		const emit = vi.fn();
		wireBusEmitter(emit);

		await handleAgentEnd({
			ctxCwd: tmpDir,
			getFlag: (name) => name === "no-lsp",
			notify: vi.fn(),
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			biomeClient: {} as never,
			ruffClient: {} as never,
			getFormatService: () =>
				({ recordRead: () => {}, formatFile: vi.fn() }) as never,
		});

		expect(fake.dartFixRuns).toBe(1);
		const touched = emit.mock.calls
			.filter((call) => call[0] === "pilens:files:touched")
			.flatMap((call) => call[1].paths as string[]);
		expect(touched.map((p) => fs.realpathSync(p)).sort()).toEqual(
			[fs.realpathSync(realA), fs.realpathSync(realB)].sort(),
		);
		expect(new Set(touched).size).toBe(touched.length);
	}, 10000);
});
