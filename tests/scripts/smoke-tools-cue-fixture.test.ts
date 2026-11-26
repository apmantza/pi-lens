/**
 * The CUE tool-smoke fixture has to PROVE a diagnostic fires (#1520 review F2).
 *
 * Two defects let it ship broken twice. First, the LSP lane's default verdict
 * is "handshook — server replied", which passes on ZERO diagnostics, so a
 * fixture whose entire purpose is to surface a defect passed while surfacing
 * nothing. Second, cuelsp only publishes the parse diagnostic when the package
 * clause is the very first line of the file; the fixture carried a comment
 * header above `package`, which suppressed the diagnostic outright.
 *
 * These guards bind both. They do not need a `cue` binary: the fixture shape is
 * a file fact, and the pass/fail decision is a pure function.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	LSP_FIXTURES,
	matchDiagnosticMessages,
} from "../../scripts/smoke-tools.mjs";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

interface LspFixture {
	lang: string;
	dir: string;
	file: string;
	expectMessageMatch?: string;
}

const cueFixture = (LSP_FIXTURES as LspFixture[]).find(
	(fx) => fx.lang === "cue",
);

describe("CUE tool-smoke fixture (#1520 F2)", () => {
	it("keeps the package clause on line 1 so cuelsp publishes at all", () => {
		const source = readFileSync(
			path.join(repoRoot, cueFixture?.dir ?? "", cueFixture?.file ?? ""),
			"utf8",
		);
		expect(source.split(/\r?\n/)[0]).toMatch(/^package\s+\w+/);
	});

	it("still contains the unclosed struct the diagnostic comes from", () => {
		const source = readFileSync(
			path.join(repoRoot, cueFixture?.dir ?? "", cueFixture?.file ?? ""),
			"utf8",
		);
		// Count braces in CODE only. The comment header quotes the expected
		// diagnostic — `expected '}', found 'EOF'` — so counting the whole file
		// balances the unclosed struct against a brace that lives in prose.
		const code = source
			.split(/\r?\n/)
			.filter((line) => !line.trimStart().startsWith("//"))
			.join("\n");
		const opens = (code.match(/\{/g) ?? []).length;
		const closes = (code.match(/\}/g) ?? []).length;
		expect(opens).toBeGreaterThan(closes);
	});
});

describe("expectMessageMatch decides on message text, not handshake", () => {
	const pattern = "expected '\\}'|found 'EOF'";
	const realCuelspDiagnostic = {
		source: "cue",
		severity: 1,
		message: "expected '}', found 'EOF'",
	};

	// The regression itself: the old lane passed here. A fixture that must
	// surface a defect and surfaces nothing has to go red.
	it("matches nothing when the server published no diagnostics", () => {
		expect(matchDiagnosticMessages(pattern, [])).toHaveLength(0);
		expect(matchDiagnosticMessages(pattern, undefined)).toHaveLength(0);
	});

	it("matches the diagnostic real cuelsp publishes for this fixture", () => {
		expect(
			matchDiagnosticMessages(pattern, [realCuelspDiagnostic]),
		).toHaveLength(1);
	});

	it("does not match an unrelated diagnostic", () => {
		expect(
			matchDiagnosticMessages(pattern, [
				{
					source: "cue",
					severity: 1,
					message: "conflicting values int and string",
				},
			]),
		).toHaveLength(0);
	});

	// Without a pattern on the fixture the lane falls through to the bare
	// "handshook" pass, which treats zero diagnostics as success — backwards for
	// this fixture. Matching the real message also reds a dropped or wrong
	// pattern (#1520 F2). An empty pattern skips the smoke lane's message check
	// (#1520 F2).
	it("uses the fixture's own pattern against the real message", () => {
		expect(cueFixture?.expectMessageMatch).toBeTruthy();
		expect(
			matchDiagnosticMessages(cueFixture?.expectMessageMatch ?? "$^", [
				realCuelspDiagnostic,
			]),
		).toHaveLength(1);
	});
});
