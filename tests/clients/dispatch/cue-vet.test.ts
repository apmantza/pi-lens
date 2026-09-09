import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	directoryScopeUnavailable,
	filterToTouchedFile,
	hasPackageClause,
	parseCueVetOutput,
} from "../../../clients/dispatch/runners/cue-vet.js";
import { makeRunnerCtx } from "../../support/runner-ctx.js";

// ── appliesTo ────────────────────────────────────────────────────────────────

describe("cue-vet appliesTo", () => {
	it("applies only to cue", async () => {
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		expect(cueVetRunner.appliesTo).toEqual(["cue"]);
	});
});

// ── parseCueVetOutput — the real cue v0.17.1 output shapes ──────────────────

describe("parseCueVetOutput", () => {
	it("parses a single conflicting-value error with both its locations", () => {
		const raw = [
			'a: conflicting values int and "hello" (mismatched types int and string):',
			"    .\\bad.cue:3:4",
			"    .\\bad.cue:3:10",
		].join("\n");
		const errors = parseCueVetOutput(raw);
		expect(errors).toEqual([
			{
				message:
					'a: conflicting values int and "hello" (mismatched types int and string)',
				locations: [
					{ file: ".\\bad.cue", line: 3, column: 4 },
					{ file: ".\\bad.cue", line: 3, column: 10 },
				],
			},
		]);
	});

	it("parses a syntax error with no field-path prefix", () => {
		const raw = ["expected '}', found 'EOF':", "    .\\syntax.cue:2:6"].join(
			"\n",
		);
		expect(parseCueVetOutput(raw)).toEqual([
			{
				message: "expected '}', found 'EOF'",
				locations: [{ file: ".\\syntax.cue", line: 2, column: 6 }],
			},
		]);
	});

	it("parses multiple independent errors in one run", () => {
		const raw = [
			'a: conflicting values int and "hello" (mismatched types int and string):',
			"    .\\multi.cue:3:4",
			"    .\\multi.cue:3:10",
			"c: conflicting values string and 5 (mismatched types string and int):",
			"    .\\multi.cue:4:4",
			"    .\\multi.cue:4:13",
		].join("\n");
		const errors = parseCueVetOutput(raw);
		expect(errors).toHaveLength(2);
		expect(errors[0].message).toContain("a: conflicting values");
		expect(errors[0].locations[0].line).toBe(3);
		expect(errors[1].message).toContain("c: conflicting values");
		expect(errors[1].locations[0].line).toBe(4);
	});

	// F1 (review round 1): a cross-file conflict names locations in TWO
	// different files — verified against real cue v0.17.1 on a package where
	// bad-values.cue's field conflicts with schema.cue's constraint.
	it("parses a cross-file error's locations across different files", () => {
		const raw = [
			"badField.name: conflicting values 5 and string (mismatched types int and string):",
			"    .\\bad-values.cue:3:11",
			"    .\\bad-values.cue:4:8",
			"    .\\schema.cue:4:8",
		].join("\n");
		const errors = parseCueVetOutput(raw);
		expect(errors).toHaveLength(1);
		expect(errors[0].locations).toEqual([
			{ file: ".\\bad-values.cue", line: 3, column: 11 },
			{ file: ".\\bad-values.cue", line: 4, column: 8 },
			{ file: ".\\schema.cue", line: 4, column: 8 },
		]);
	});

	it("returns a headerless entry (no locations) for a summary-only failure, never zero", () => {
		// The exact message `-c=false` is meant to prevent, kept as a fallback
		// shape guard: a real vet failure must never parse to zero errors.
		const raw =
			"some instances are incomplete; use the -c flag to show errors or -c=false to allow incomplete instances";
		const errors = parseCueVetOutput(raw);
		expect(errors).toHaveLength(1);
		expect(errors[0].locations).toEqual([]);
	});
});

// ── filterToTouchedFile — the F1 fix: package-scoped vet, file-scoped report ─

describe("filterToTouchedFile (#1522 review round 1, F1)", () => {
	it("keeps an error whose location names the touched file", () => {
		const errors = parseCueVetOutput(
			[
				'a: conflicting values int and "hello" (mismatched types int and string):',
				"    .\\bad.cue:3:4",
				"    .\\bad.cue:3:10",
			].join("\n"),
		);
		const diagnostics = filterToTouchedFile(errors, "bad.cue");
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics?.[0].line).toBe(3);
		expect(diagnostics?.[0].column).toBe(4);
	});

	// The regression itself: `values.cue` referencing `schema.cue`'s
	// `#Service` used to be vetted ALONE and reported a false
	// `reference "#Service" not found`. Package-scoped vet no longer produces
	// that error at all (real cue: exit 0, empty output on the valid
	// two-file package — see tests/fixtures/tool-smoke/cue-vet/valid-package),
	// so there is nothing to filter — this asserts the empty-input case is
	// itself the fix, not a masking layer.
	it("produces zero findings when the package-wide vet already found nothing", () => {
		expect(filterToTouchedFile([], "values.cue")).toBeUndefined();
	});

	it("filters out an error whose ONLY location is a sibling file (the missed-finding tradeoff)", () => {
		const errors = parseCueVetOutput(
			[
				"otherField: conflicting values 5 and string (mismatched types int and string):",
				"    .\\sibling.cue:3:11",
				"    .\\sibling.cue:4:8",
			].join("\n"),
		);
		expect(filterToTouchedFile(errors, "values.cue")).toEqual([]);
	});

	it("keeps a cross-file error when the touched file is ANY of its locations, at that location", () => {
		const errors = parseCueVetOutput(
			[
				"badField.name: conflicting values 5 and string (mismatched types int and string):",
				"    .\\bad-values.cue:3:11",
				"    .\\bad-values.cue:4:8",
				"    .\\schema.cue:4:8",
			].join("\n"),
		);
		// Touching the primary offender.
		expect(filterToTouchedFile(errors, "bad-values.cue")).toEqual([
			expect.objectContaining({
				filePath: "bad-values.cue",
				line: 3,
				column: 11,
			}),
		]);
		// Touching the implicated sibling — still a real signal, at ITS location.
		expect(filterToTouchedFile(errors, "schema.cue")).toEqual([
			expect.objectContaining({ filePath: "schema.cue", line: 4, column: 8 }),
		]);
		// An unrelated third file in the same package sees neither.
		expect(filterToTouchedFile(errors, "unrelated.cue")).toEqual([]);
	});

	it("falls back to undefined (never false-clean) when nothing in the output could be file-attributed", () => {
		const errors = parseCueVetOutput(
			"some instances are incomplete; use the -c flag to show errors or -c=false to allow incomplete instances",
		);
		expect(filterToTouchedFile(errors, "values.cue")).toBeUndefined();
	});

	// F7 (review round 2): the mixed case. One error has a location (in a
	// SIBLING, not the touched file); one error has none at all. The original
	// rule fell back to `undefined` only when EVERY error lacked a location,
	// so this combination made `recognized.length` nonzero and the
	// unattributable error's diagnostic silently vanished behind the
	// sibling-filtered `[]` result — a real failure reading as clean.
	it("F7: an unattributable error surfaces even when a SIBLING-located error is also present", () => {
		const errors = parseCueVetOutput(
			[
				"some instances are incomplete; use the -c flag to show errors or -c=false to allow incomplete instances",
				"otherField: conflicting values 5 and string (mismatched types int and string):",
				"    .\\sibling.cue:3:11",
			].join("\n"),
		);
		const diagnostics = filterToTouchedFile(errors, "values.cue");
		// Never undefined (there WAS attributable evidence) and never empty
		// (the unattributable error must not be dropped).
		expect(diagnostics).toBeDefined();
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics?.[0].message).toContain("some instances are incomplete");
		expect(diagnostics?.[0].filePath).toBe("values.cue");
		expect(diagnostics?.[0].line).toBe(1);
	});

	// F7's other half: the unattributable error surfaces ALONGSIDE a real
	// touched-file match too, as two distinct diagnostics — the fix never
	// merges or drops either.
	it("F7: an unattributable error and a touched-file match both surface, distinctly", () => {
		const errors = parseCueVetOutput(
			[
				"some instances are incomplete; use the -c flag to show errors or -c=false to allow incomplete instances",
				'a: conflicting values int and "hello" (mismatched types int and string):',
				"    .\\values.cue:3:4",
				"    .\\values.cue:3:10",
			].join("\n"),
		);
		const diagnostics = filterToTouchedFile(errors, "values.cue");
		expect(diagnostics).toHaveLength(2);
		expect(diagnostics?.some((d) => d.line === 3 && d.column === 4)).toBe(true);
		expect(
			diagnostics?.some((d) =>
				d.message.includes("some instances are incomplete"),
			),
		).toBe(true);
	});
});

// ── directoryScopeUnavailable — the F5/F6 fix's detector ────────────────────

describe("directoryScopeUnavailable (#1522 review round 2, F5/F6)", () => {
	it("recognizes a package-less directory failure (F5)", () => {
		const raw =
			"build constraints exclude all CUE files in .:\n    .\\standalone.cue: no package name\n";
		expect(directoryScopeUnavailable(raw)).toBe(true);
	});

	it("recognizes a package-less failure with MULTIPLE files listed", () => {
		const raw =
			"build constraints exclude all CUE files in .:\n    .\\broken.cue: no package name\n    .\\clean.cue: no package name\n";
		expect(directoryScopeUnavailable(raw)).toBe(true);
	});

	it("recognizes a two-different-packages directory failure (F6), with either trailing location form", () => {
		expect(
			directoryScopeUnavailable(
				'found packages "alpha" (alpha.cue) and "beta" (beta.cue) in "."\n',
			),
		).toBe(true);
		// Verified: cue sometimes reports the directory's own basename instead
		// of "." depending on how it resolves the vet cwd — only the
		// structural "found packages X and Y" part is load-bearing.
		expect(
			directoryScopeUnavailable(
				'found packages "alpha" (alpha.cue) and "beta" (beta.cue) in "two-packages"\n',
			),
		).toBe(true);
	});

	it("does NOT flag a real conflicting-value error as a scope failure", () => {
		const raw =
			'a: conflicting values int and "hello" (mismatched types int and string):\n    .\\bad.cue:3:4\n    .\\bad.cue:3:10\n';
		expect(directoryScopeUnavailable(raw)).toBe(false);
	});

	it("does NOT flag the -c=false-suppressed incomplete-values message", () => {
		expect(
			directoryScopeUnavailable(
				"some instances are incomplete; use the -c flag to show errors or -c=false to allow incomplete instances",
			),
		).toBe(false);
	});
});

// ── run() — mocked spawn, real parser ───────────────────────────────────────

const { safeSpawnAsync, readFileSync } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	// Default: no file exists at the mocked path (ENOENT) — the runner's
	// catch-and-fall-through then behaves exactly as it did before F8
	// (assume package-scoped, use the directory path), which is why every
	// pre-F8 test below needs no fs mocking of its own. F8-specific tests
	// override this per-case with `.mockReturnValueOnce`.
	readFileSync: vi.fn((..._args: unknown[]): string => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	}),
}));

vi.mock("../../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return { ...actual, readFileSync };
});

vi.mock("../../../clients/dispatch/runners/utils/runner-helpers.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/dispatch/runners/utils/runner-helpers.js")>()),
	createAvailabilityChecker: () => ({
		isAvailableAsync: async () => true,
		getCommand: () => "cue",
	}),
	resolveAvailableOrInstall: async () => "cue",
}));

const cueCwd = path.join(os.tmpdir(), "pi-lens-cue-vet-test");
const cueFile = path.join(cueCwd, "bad.cue");
const valuesFile = path.join(cueCwd, "values.cue");

function createCtx(filePath: string, cwd: string) {
	return makeRunnerCtx(filePath, cwd, { kind: "cue" });
}

describe("cue-vet run() — real binary output shapes, mocked spawn", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		readFileSync.mockReset();
		readFileSync.mockImplementation(() => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		});
	});

	it("reports a BLOCKING diagnostic for a real conflicting-value error", async () => {
		safeSpawnAsync.mockResolvedValue({
			status: 1,
			stdout:
				'a: conflicting values int and "hello" (mismatched types int and string):\n    .\\bad.cue:3:4\n    .\\bad.cue:3:10\n',
			stderr: "",
		});
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const result = await cueVetRunner.run(createCtx(cueFile, cueCwd));
		expect(result.status).toBe("failed");
		expect(result.semantic).toBe("blocking");
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].line).toBe(3);
		expect(result.diagnostics[0].column).toBe(4);
		expect(result.diagnostics[0].tool).toBe("cue-vet");

		// F1: spawned with -c=false against the whole PACKAGE (the touched
		// file's directory), not the file alone.
		const [cmd, args, opts] = safeSpawnAsync.mock.calls[0];
		expect(cmd).toBe("cue");
		expect(args).toEqual(["vet", "-c=false", "."]);
		expect(opts.cwd).toBe(cueCwd);
	});

	it("reports clean (no findings) on a real successful vet (exit 0, empty output)", async () => {
		safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const result = await cueVetRunner.run(createCtx(cueFile, cueCwd));
		expect(result.status).toBe("succeeded");
		expect(result.diagnostics).toEqual([]);
	});

	// F1's actual regression: touching `values.cue` in a valid split-schema
	// package used to false-positive because the pre-fix single-file
	// invocation never loaded `schema.cue`. Real cue vets the DIRECTORY
	// clean (exit 0), so this is really just the exit-0 path again — proving
	// it from the values.cue side specifically, since that was the exact
	// file the reviewer's probe caught failing.
	it("F1: a valid split-schema/values package reports zero findings for the touched values.cue", async () => {
		safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const result = await cueVetRunner.run(createCtx(valuesFile, cueCwd));
		expect(result.status).toBe("succeeded");
		expect(result.diagnostics).toEqual([]);
		const [, args] = safeSpawnAsync.mock.calls[0];
		// The directory, never the single file — that was the bug.
		expect(args).toEqual(["vet", "-c=false", "."]);
	});

	// F1: a real error exists in the package, but only in a SIBLING file —
	// touching values.cue must not surface it (filtered), and must not
	// crash or misreport it as blocking values.cue.
	it("F1: an error confined to a sibling file is filtered out for the touched file", async () => {
		safeSpawnAsync.mockResolvedValue({
			status: 1,
			stdout:
				"otherField: conflicting values 5 and string (mismatched types int and string):\n    .\\sibling.cue:3:11\n    .\\sibling.cue:4:8\n",
			stderr: "",
		});
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const result = await cueVetRunner.run(createCtx(valuesFile, cueCwd));
		expect(result.status).toBe("succeeded");
		expect(result.diagnostics).toEqual([]);
	});

	// F1: a real error whose location IS the touched file still reports,
	// even though vet now runs against the whole package.
	it("F1: an error in the touched file still reports when vetting the whole package", async () => {
		safeSpawnAsync.mockResolvedValue({
			status: 1,
			stdout:
				"myField: conflicting values 5 and string (mismatched types int and string):\n    .\\values.cue:3:11\n    .\\schema.cue:4:8\n",
			stderr: "",
		});
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const result = await cueVetRunner.run(createCtx(valuesFile, cueCwd));
		expect(result.status).toBe("failed");
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].line).toBe(3);
		expect(result.diagnostics[0].column).toBe(11);
	});

	it("skips (never reports false-clean) when cue could not run at all", async () => {
		safeSpawnAsync.mockResolvedValue({
			status: 1,
			stdout: "",
			stderr: "",
			error: new Error("ENOENT"),
		});
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const result = await cueVetRunner.run(createCtx(cueFile, cueCwd));
		expect(result.status).toBe("skipped");
		expect(result.diagnostics).toEqual([]);
	});

	// F5 (review round 2, HIGH): a package-less standalone file used to block
	// on every edit — the directory vet fails with "build constraints exclude
	// all CUE files", which has no :line:col, so it read as an unattributable
	// whole-vet failure. This is now the REACTIVE safety net specifically —
	// the touched file's content is unreadable here (readFileSync's default
	// mock throws), so the F8 proactive check below cannot classify it and
	// falls through to the directory-scoped attempt, which then hits this
	// fallback on failure. The realistic readable case is covered by F8's
	// tests further down, which take only ONE spawn call.
	it("F5: falls back to single-file vet reactively when the directory vet fails AND the touched file is unreadable", async () => {
		safeSpawnAsync
			.mockResolvedValueOnce({
				status: 1,
				stdout:
					"build constraints exclude all CUE files in .:\n    .\\standalone.cue: no package name\n",
				stderr: "",
			})
			.mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" });
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const standaloneFile = path.join(cueCwd, "standalone.cue");
		const result = await cueVetRunner.run(createCtx(standaloneFile, cueCwd));
		expect(result.status).toBe("succeeded");
		expect(result.diagnostics).toEqual([]);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(2);
		const [, firstArgs] = safeSpawnAsync.mock.calls[0];
		const [, secondArgs] = safeSpawnAsync.mock.calls[1];
		expect(firstArgs).toEqual(["vet", "-c=false", "."]);
		expect(secondArgs).toEqual(["vet", "-c=false", "./standalone.cue"]);
	});

	// F5's other half: the reactive fallback still reports a REAL defect in a
	// package-less (here: unreadable-content) file — this must not go
	// permanently quiet.
	it("F5: the reactive single-file fallback still reports a real error", async () => {
		safeSpawnAsync
			.mockResolvedValueOnce({
				status: 1,
				stdout:
					"build constraints exclude all CUE files in .:\n    .\\standalone.cue: no package name\n",
				stderr: "",
			})
			.mockResolvedValueOnce({
				status: 1,
				stdout:
					'a: conflicting values int and "hello" (mismatched types int and string):\n    .\\standalone.cue:1:4\n    .\\standalone.cue:1:10\n',
				stderr: "",
			});
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const standaloneFile = path.join(cueCwd, "standalone.cue");
		const result = await cueVetRunner.run(createCtx(standaloneFile, cueCwd));
		expect(result.status).toBe("failed");
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].line).toBe(1);
		expect(result.diagnostics[0].column).toBe(4);
	});

	// F6 (review round 2, medium): a directory holding two DIFFERENT CUE
	// packages — legal CUE — blocked both files on every edit for the same
	// reason as F5. The touched file DOES have its own package clause here
	// (`package alpha`), so F8's proactive check correctly takes the
	// directory-scoped path first; the reactive F5/F6 fallback below is what
	// then handles the two-different-packages failure.
	it("F6: falls back to single-file vet when the directory holds two different packages, and reports clean", async () => {
		readFileSync.mockReturnValue("package alpha\n\na: int\n");
		safeSpawnAsync
			.mockResolvedValueOnce({
				status: 1,
				stdout:
					'found packages "alpha" (alpha.cue) and "beta" (beta.cue) in "."\n',
				stderr: "",
			})
			.mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" });
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const alphaFile = path.join(cueCwd, "alpha.cue");
		const result = await cueVetRunner.run(createCtx(alphaFile, cueCwd));
		expect(result.status).toBe("succeeded");
		expect(result.diagnostics).toEqual([]);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(2);
		const [, firstArgs] = safeSpawnAsync.mock.calls[0];
		const [, secondArgs] = safeSpawnAsync.mock.calls[1];
		expect(firstArgs).toEqual(["vet", "-c=false", "."]);
		expect(secondArgs).toEqual(["vet", "-c=false", "./alpha.cue"]);
	});

	// F8 (review round 3, HIGH): a directory holding BOTH a packaged file and
	// a package-less file. `cue vet .` builds only the package and exits 0 —
	// it never evaluates the loose file at all, so the old F5/F6 fallback
	// (gated on the directory vet FAILING) can never catch this: there is no
	// failure. Reviewer's real-binary probe: a package-less `loose.cue` with
	// `b: int & "x"` (genuine conflict) sitting beside a valid packaged file
	// vetted clean/0-diagnostics before this fix. The fix reads the touched
	// file's OWN content up front and never even attempts directory scope
	// for a package-less file — proven here by asserting exactly ONE spawn
	// call, straight to single-file scope.
	it("F8: a package-less touched file goes straight to single-file scope, bypassing the directory entirely", async () => {
		readFileSync.mockReturnValue("b: int\n");
		safeSpawnAsync.mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" });
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const looseFile = path.join(cueCwd, "loose.cue");
		const result = await cueVetRunner.run(createCtx(looseFile, cueCwd));
		expect(result.status).toBe("succeeded");
		expect(result.diagnostics).toEqual([]);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		const [, args] = safeSpawnAsync.mock.calls[0];
		expect(args).toEqual(["vet", "-c=false", "./loose.cue"]);
	});

	// F8's exact regression scenario: the directory vet WOULD succeed (it
	// only builds the packaged sibling), but the touched loose file has a
	// real conflicting value. Before the fix, this reported succeeded/0
	// diagnostics — shape 10 from the miss side, an empty result that does
	// not distinguish "clean" from "never evaluated". The fix must report it.
	it("F8: reports a real conflicting-value error in a package-less file sharing a directory with a packaged one", async () => {
		readFileSync.mockReturnValue('b: int & "x"\n');
		// A faithful simulation of the REAL binary's two possible responses,
		// keyed on the args actually passed — not a fixed call-order queue —
		// so this genuinely distinguishes "directory scope, which silently
		// succeeds because it only builds the packaged sibling" (verified:
		// `cue vet .` exits 0 on this exact directory shape) from "single-file
		// scope, which evaluates the loose file and catches its real defect".
		// Pre-F8 code only ever issues the first call and trusts its exit 0;
		// the fix must issue (and trust) the second instead.
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args[args.length - 1] === ".") {
				return { status: 0, stdout: "", stderr: "" };
			}
			return {
				status: 1,
				stdout:
					'b: conflicting values int and "x" (mismatched types int and string):\n    .\\loose.cue:1:4\n    .\\loose.cue:1:10\n',
				stderr: "",
			};
		});
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const looseFile = path.join(cueCwd, "loose.cue");
		const result = await cueVetRunner.run(createCtx(looseFile, cueCwd));
		// Exactly one spawn call — the directory pass is never attempted for a
		// package-less touched file, so there's nothing for its misleading
		// exit-0 to hide behind.
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("failed");
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].line).toBe(1);
		expect(result.diagnostics[0].column).toBe(4);
	});

	// F8: a package-less file whose first non-blank line is a comment still
	// classifies correctly — comments above the (absent) package clause are
	// legal CUE and must not be mistaken for the clause itself.
	it("F8: a package-less file with a leading comment is still classified package-less", async () => {
		readFileSync.mockReturnValue("// a loose config file\nb: int\n");
		safeSpawnAsync.mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" });
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const looseFile = path.join(cueCwd, "loose.cue");
		await cueVetRunner.run(createCtx(looseFile, cueCwd));
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		const [, args] = safeSpawnAsync.mock.calls[0];
		expect(args).toEqual(["vet", "-c=false", "./loose.cue"]);
	});

	// F8: a PACKAGED touched file takes the directory-scoped path, same as
	// F1 — the proactive check must not over-fire on every file.
	it("F8: a packaged touched file still takes the directory-scoped path first", async () => {
		readFileSync.mockReturnValue("package smoke\n\na: int\n");
		safeSpawnAsync.mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" });
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const result = await cueVetRunner.run(createCtx(cueFile, cueCwd));
		expect(result.status).toBe("succeeded");
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		const [, args] = safeSpawnAsync.mock.calls[0];
		expect(args).toEqual(["vet", "-c=false", "."]);
	});

	// F10 (review round 4, medium): a touched file opening with a file-level
	// attribute BEFORE its package clause (`@extern(embed)` is the
	// documented real case) must still be classified as packaged and take
	// the directory-scoped path — the reviewer's real-binary probe found the
	// pre-fix heuristic misread this as package-less, routing to single-file
	// scope and false-positiving a clean two-file package as blocking.
	it("F10: a touched file with a leading file-level attribute before its package clause still takes the directory-scoped path", async () => {
		readFileSync.mockReturnValue("@extern(embed)\npackage smoke\n\na: int\n");
		safeSpawnAsync.mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" });
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const result = await cueVetRunner.run(createCtx(cueFile, cueCwd));
		expect(result.status).toBe("succeeded");
		expect(result.diagnostics).toEqual([]);
		// Exactly one spawn call, scoped to the DIRECTORY — a single-file
		// call here is the false-positive shape F10 fixes.
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		const [, args] = safeSpawnAsync.mock.calls[0];
		expect(args).toEqual(["vet", "-c=false", "."]);
	});

	// F9 (review round 3, low): pins the `result.status !== 0` guard on the
	// F5/F6 reactive fallback. A status-0 (successful) directory vet must
	// NEVER trigger a second spawn, even in the pathological case where its
	// (empty, per the real binary) output would otherwise text-match
	// `directoryScopeUnavailable` — success is success, never re-examined by
	// output shape. Deleting the `result.status !== 0 &&` clause leaves this
	// red (a second spawn would fire).
	it("F9: a successful (status 0) directory vet never triggers the reactive fallback, regardless of output text", async () => {
		readFileSync.mockReturnValue("package smoke\n\na: int\n");
		safeSpawnAsync.mockResolvedValueOnce({
			status: 0,
			// Pathological: real cue never prints on success, but this pins the
			// guard against a hypothetical false match rather than trusting exit
			// code alone.
			stdout:
				'found packages "alpha" (alpha.cue) and "beta" (beta.cue) in "."\n',
			stderr: "",
		});
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const result = await cueVetRunner.run(createCtx(cueFile, cueCwd));
		expect(result.status).toBe("succeeded");
		expect(result.diagnostics).toEqual([]);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});
});

// ── hasPackageClause — the F8 fix's detector ────────────────────────────────

describe("hasPackageClause (#1522 review round 3, F8)", () => {
	it("recognizes a package clause on the first line", () => {
		expect(hasPackageClause("package smoke\n\na: int\n")).toBe(true);
	});

	it("recognizes a package clause after leading blank lines and comments", () => {
		expect(
			hasPackageClause("\n// a header comment\n\npackage smoke\n\na: int\n"),
		).toBe(true);
	});

	it("returns false for a package-less file", () => {
		expect(hasPackageClause("a: int\n")).toBe(false);
	});

	it("returns false for a package-less file with only a leading comment", () => {
		expect(hasPackageClause("// just a config\nb: int\n")).toBe(false);
	});

	it("returns false for an empty file", () => {
		expect(hasPackageClause("")).toBe(false);
	});

	it("does not mistake a field literally named 'package' for the clause", () => {
		// `package:` is a plain field label — the real clause has no colon and
		// is followed by a bare identifier, and MUST be the first declaration.
		expect(hasPackageClause('package: "not a clause"\n')).toBe(false);
	});

	// F10 (review round 4, medium): a file-level attribute (`@extern(embed)`
	// is the documented real case) is legal BEFORE the package clause, same
	// as a comment — skipping comments but not attributes misread such a
	// file as package-less, routing it to single-file scope and false-
	// positiving a cross-file reference as "reference not found" on an
	// otherwise clean package (verified against the real binary).
	it("recognizes a package clause after a leading file-level attribute", () => {
		expect(hasPackageClause("@extern(embed)\npackage smoke\n\na: int\n")).toBe(
			true,
		);
	});

	it("recognizes a package clause after a leading attribute AND a comment, in either order", () => {
		expect(
			hasPackageClause("// header\n@mytag(foo)\npackage smoke\n\na: int\n"),
		).toBe(true);
		expect(
			hasPackageClause("@mytag(foo)\n// header\npackage smoke\n\na: int\n"),
		).toBe(true);
	});
});
