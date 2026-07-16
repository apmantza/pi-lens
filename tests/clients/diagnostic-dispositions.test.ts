import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The NDJSON disposition logger is isTestMode-gated (like every pi-lens
// logger), so asserting the fields markDisposition passes requires mocking
// the module rather than reading the log file.
const logDispositionEvent = vi.hoisted(() => vi.fn());
vi.mock("../../clients/disposition-logger.js", () => ({
	logDispositionEvent: (...args: unknown[]) => logDispositionEvent(...args),
}));

import { _resetForTests as _resetBusPublishForTests } from "../../clients/bus-publish.js";
import {
	_resetDispositionPublishForTests,
	BUS_DISPOSITION_EVENT,
	BUS_DISPOSITION_VERSION,
	wireDispositionBusEmitter,
	type PilensDispositionPayload,
} from "../../clients/disposition-publish.js";
import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
	anchorsForDiagnostic,
	applyDispositions,
	computeStrictAnchor,
	getDisposition,
	markDisposition,
} from "../../clients/diagnostic-dispositions.js";
import { getProjectDataDir } from "../../clients/file-utils.js";

let tmpDir: string;
let previousDataDir: string | undefined;

const originalBusEnv = process.env.PI_LENS_BUS_PUBLISH;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-dd-"));
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(tmpDir, "data");
	_resetDeferredForTests();
	_resetStateCacheForTests();
	_resetDispositionPublishForTests();
	_resetBusPublishForTests();
	logDispositionEvent.mockClear();
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	if (originalBusEnv === undefined) delete process.env.PI_LENS_BUS_PUBLISH;
	else process.env.PI_LENS_BUS_PUBLISH = originalBusEnv;
	_resetDispositionPublishForTests();
	_resetBusPublishForTests();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function cwd(): string {
	return path.join(tmpDir, "project");
}

function filePath(): string {
	return path.join(cwd(), "a.ts");
}

function statePath(): string {
	return path.join(
		getProjectDataDir(cwd()),
		"cache",
		"diagnostic-dispositions.json",
	);
}

describe("computeStrictAnchor (false-positive's site-specific binding)", () => {
	it("is stable when unrelated lines are inserted ABOVE the diagnostic", () => {
		const before = "const a = 1;\nconst target = bad();\n";
		const after = "const inserted = 0;\nconst a = 1;\nconst target = bad();\n";
		const anchorBefore = computeStrictAnchor({
			cwd: cwd(),
			filePath: filePath(),
			tool: "eslint",
			rule: "no-bad",
			message: "bad call",
			line: 2,
			content: before,
		});
		const anchorAfter = computeStrictAnchor({
			cwd: cwd(),
			filePath: filePath(),
			tool: "eslint",
			rule: "no-bad",
			message: "bad call",
			line: 3,
			content: after,
		});
		expect(anchorAfter).toBe(anchorBefore);
	});

	it("changes when the flagged line's content changes semantically", () => {
		const a = computeStrictAnchor({
			cwd: cwd(),
			filePath: filePath(),
			rule: "r",
			message: "m",
			line: 1,
			content: "const target = bad();\n",
		});
		const b = computeStrictAnchor({
			cwd: cwd(),
			filePath: filePath(),
			rule: "r",
			message: "m",
			line: 1,
			content: "const target = good();\n",
		});
		expect(b).not.toBe(a);
	});

	it("ignores pure whitespace changes on the flagged line", () => {
		const a = computeStrictAnchor({
			cwd: cwd(),
			filePath: filePath(),
			rule: "r",
			message: "m",
			line: 1,
			content: "const target=bad();\n",
		});
		const b = computeStrictAnchor({
			cwd: cwd(),
			filePath: filePath(),
			rule: "r",
			message: "m",
			line: 1,
			content: "  const   target = bad();  \n",
		});
		expect(b).toBe(a);
	});
});

describe("markDisposition + applyDispositions (#690)", () => {
	const content = "const target = bad();\n";
	const diag = { tool: "eslint", rule: "no-bad", message: "bad call", line: 1 };

	it("persists false-positive/suppress/flagged to the disposition store file under getProjectDataDir", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"false-positive",
		);
		expect(fs.existsSync(statePath())).toBe(true);
		const raw = JSON.parse(fs.readFileSync(statePath(), "utf-8")) as {
			dispositions: Record<string, unknown>;
		};
		expect(Object.keys(raw.dispositions)).toHaveLength(1);
	});

	it("applyDispositions drops false-positive and suppress, but keeps flagged", () => {
		markDisposition(
			cwd(),
			{
				cwd: cwd(),
				filePath: filePath(),
				tool: "eslint",
				rule: "fp-rule",
				message: "m1",
				line: 1,
				content,
			},
			"false-positive",
		);
		markDisposition(
			cwd(),
			{
				cwd: cwd(),
				filePath: filePath(),
				tool: "eslint",
				rule: "sup-rule",
				message: "m2",
				line: 1,
				content,
			},
			"suppress",
		);
		markDisposition(
			cwd(),
			{
				cwd: cwd(),
				filePath: filePath(),
				tool: "eslint",
				rule: "flag-rule",
				message: "m3",
				line: 1,
				content,
			},
			"flagged",
		);

		const diags = [
			{ tool: "eslint", rule: "fp-rule", message: "m1", line: 1 },
			{ tool: "eslint", rule: "sup-rule", message: "m2", line: 1 },
			{ tool: "eslint", rule: "flag-rule", message: "m3", line: 1 },
		];
		const kept = applyDispositions(diags, cwd(), filePath(), content);
		expect(kept.map((d) => d.rule)).toEqual(["flag-rule"]);
	});

	it("defer drops the diagnostic for the session; _resetDeferredForTests restores it", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"defer",
		);
		expect(applyDispositions([diag], cwd(), filePath(), content)).toEqual([]);
		_resetDeferredForTests();
		expect(applyDispositions([diag], cwd(), filePath(), content)).toEqual([
			diag,
		]);
	});

	it("defer survives an edit to the flagged line itself (weak anchor)", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"defer",
		);
		const editedContent = "const target = bad(1, 2, 3);\n";
		expect(applyDispositions([diag], cwd(), filePath(), editedContent)).toEqual(
			[],
		);
	});

	it("false-positive RESURFACES after the flagged line's content changes semantically", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"false-positive",
		);
		expect(applyDispositions([diag], cwd(), filePath(), content)).toEqual([]);
		const editedContent = "const target = good();\n";
		expect(
			applyDispositions([diag], cwd(), filePath(), editedContent),
		).toEqual([diag]);
	});

	it("false-positive survives whitespace-only changes and unrelated-lines-above insertions", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"false-positive",
		);
		const whitespaceOnly = "  const   target = bad();  \n";
		expect(
			applyDispositions([diag], cwd(), filePath(), whitespaceOnly),
		).toEqual([]);

		const shiftedDiag = { ...diag, line: 2 };
		const withInsertedLineAbove = "// unrelated\nconst target = bad();\n";
		expect(
			applyDispositions([shiftedDiag], cwd(), filePath(), withInsertedLineAbove),
		).toEqual([]);
	});

	it("flagged tag survives a line edit (weak-anchor lookup)", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"flagged",
		);
		const editedContent = "const target = bad(1, 2, 3);\n";
		const { weak } = anchorsForDiagnostic(cwd(), filePath(), diag, editedContent);
		expect(getDisposition(cwd(), weak)?.disposition).toBe("flagged");
	});

	it("getDisposition returns the entry, including flagged's line/lineText fix context", () => {
		const anchor = markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"flagged",
			"come back to this",
		);
		const entry = getDisposition(cwd(), anchor);
		expect(entry?.disposition).toBe("flagged");
		expect(entry?.reason).toBe("come back to this");
		expect(entry?.line).toBe(1);
		expect(entry?.lineText).toBe("const target = bad();");
	});

	it("mtime memoization: a write is immediately visible to the next read (write -> read -> mark again -> read sees both)", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"flagged",
		);
		// Populates the read cache from disk.
		expect(applyDispositions([diag], cwd(), filePath(), content)).toEqual([
			diag,
		]);

		const diag2 = { tool: "eslint", rule: "second", message: "m2", line: 1 };
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag2, content },
			"false-positive",
		);
		// Both marks must be visible: diag (flagged) kept, diag2 (false-positive)
		// dropped — proves the cache was refreshed by the second write rather than
		// serving the stale single-entry snapshot from the first read.
		const kept = applyDispositions([diag, diag2], cwd(), filePath(), content);
		expect(kept.map((d) => d.rule)).toEqual(["no-bad"]);
	});
});

describe("mark telemetry (#690 — NDJSON log + pilens:diagnostic:disposition)", () => {
	const content = "const target = bad();\n";
	const diag = { tool: "eslint", rule: "no-bad", message: "bad call", line: 1 };

	function mark(disposition: "false-positive" | "suppress" | "defer" | "flagged", reason?: string) {
		return markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			disposition,
			reason,
		);
	}

	it("markDisposition logs a mark entry with the full field set (project-relative path)", () => {
		const anchor = mark("false-positive", "rule misfires on generics");
		expect(logDispositionEvent).toHaveBeenCalledTimes(1);
		expect(logDispositionEvent).toHaveBeenCalledWith({
			event: "mark",
			disposition: "false-positive",
			tool: "eslint",
			rule: "no-bad",
			filePath: "a.ts",
			line: 1,
			reason: "rule misfires on generics",
			anchor,
			previousDisposition: undefined,
		});
	});

	it("logs previousDisposition when a re-mark overwrites an existing store entry", () => {
		mark("flagged");
		logDispositionEvent.mockClear();
		mark("suppress");
		expect(logDispositionEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				disposition: "suppress",
				previousDisposition: "flagged",
			}),
		);
	});

	it("logs defer marks too — the log is their only durable trace", () => {
		mark("defer");
		expect(logDispositionEvent).toHaveBeenCalledWith(
			expect.objectContaining({ event: "mark", disposition: "defer" }),
		);
	});

	it("publishes the v1 bus payload when an emitter is wired", () => {
		const emit = vi.fn();
		wireDispositionBusEmitter(emit);

		const anchor = mark("flagged", "fix later");

		expect(emit).toHaveBeenCalledTimes(1);
		const [channel, payload] = emit.mock.calls[0] as [
			string,
			PilensDispositionPayload,
		];
		expect(channel).toBe(BUS_DISPOSITION_EVENT);
		expect(payload.v).toBe(BUS_DISPOSITION_VERSION);
		expect(payload.source).toBe("pi-lens");
		expect(payload.disposition).toBe("flagged");
		expect(payload.tool).toBe("eslint");
		expect(payload.rule).toBe("no-bad");
		expect(payload.line).toBe(1);
		expect(payload.anchor).toBe(anchor);
		expect(payload.reason).toBe("fix later");
		// filePath is absolute + normalized (forward slashes), unlike the log's
		// project-relative one.
		expect(payload.filePath).not.toContain("\\");
		expect(payload.filePath.endsWith("/a.ts")).toBe(true);
	});

	it("is a silent no-op (mark still succeeds) when no emitter is wired", () => {
		expect(() => mark("flagged")).not.toThrow();
		expect(getDisposition(cwd(), mark("flagged"))?.disposition).toBe("flagged");
	});

	it("respects the PI_LENS_BUS_PUBLISH=0 kill switch", () => {
		process.env.PI_LENS_BUS_PUBLISH = "0";
		_resetBusPublishForTests();
		const emit = vi.fn();
		wireDispositionBusEmitter(emit);

		mark("false-positive");

		expect(emit).not.toHaveBeenCalled();
		// The NDJSON log is independent of the bus kill switch — still records.
		expect(logDispositionEvent).toHaveBeenCalledTimes(1);
	});

	it("swallows an emit throw — the mark itself must never fail on telemetry", () => {
		wireDispositionBusEmitter(() => {
			throw new Error("bus explosion");
		});
		expect(() => mark("flagged")).not.toThrow();
		expect(getDisposition(cwd(), mark("flagged"))?.disposition).toBe("flagged");
	});
});
