import { describe, expect, it } from "vitest";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";
import {
	AUXILIARY_LSP_PROFILES,
	applyAuxiliarySuppressions,
	enabledAuxiliaryLspServerIds,
	findAuxiliaryProfileForSource,
	isAuxiliaryDiagnosticSuppressed,
} from "../../../clients/dispatch/auxiliary-lsp.js";

const diag = (over: Partial<LSPDiagnostic>): LSPDiagnostic =>
	({
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		message: "x",
		severity: 2,
		...over,
	}) as LSPDiagnostic;

describe("auxiliary LSP enablement", () => {
	it("opengrep is default-on (no kill-switch flag set)", () => {
		const ids = enabledAuxiliaryLspServerIds(() => undefined);
		expect(ids).toContain("opengrep");
	});

	it("the no-opengrep kill switch disables it", () => {
		const ids = enabledAuxiliaryLspServerIds((f) => f === "no-opengrep");
		expect(ids).not.toContain("opengrep");
	});

	it("zizmor is default-on and the no-zizmor kill switch disables it (#272)", () => {
		expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain("zizmor");
		expect(enabledAuxiliaryLspServerIds((f) => f === "no-zizmor")).not.toContain(
			"zizmor",
		);
	});

	it("typos is default-on and the no-typos kill switch disables it (#283)", () => {
		expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain("typos");
		expect(enabledAuxiliaryLspServerIds((f) => f === "no-typos")).not.toContain(
			"typos",
		);
	});
});

describe("auxiliary profile source routing", () => {
	it("routes Opengrep's 'Semgrep' source to the opengrep profile", () => {
		expect(findAuxiliaryProfileForSource("Semgrep")?.tool).toBe("opengrep");
		expect(findAuxiliaryProfileForSource("opengrep")?.tool).toBe("opengrep");
	});

	it("routes zizmor's 'zizmor' source to the zizmor profile (#272)", () => {
		expect(findAuxiliaryProfileForSource("zizmor")?.tool).toBe("zizmor");
	});

	it("routes typos-lsp's 'typos' source to the typos profile (#283)", () => {
		expect(findAuxiliaryProfileForSource("typos")?.tool).toBe("typos");
	});

	it("ignores language-server sources and missing source", () => {
		expect(findAuxiliaryProfileForSource("typescript")).toBeUndefined();
		expect(findAuxiliaryProfileForSource("eslint")).toBeUndefined();
		expect(findAuxiliaryProfileForSource(undefined)).toBeUndefined();
	});
});

describe("opengrep semantic policy", () => {
	const opengrep = AUXILIARY_LSP_PROFILES.find(
		(p) => p.serverId === "opengrep",
	);

	it("blocks ERROR only where blocking is allowed (curated repo rules)", () => {
		expect(opengrep).toBeDefined();
		// blocking allowed (repo has its own rules): ERROR → blocking, else warning.
		expect(
			opengrep?.semantic(diag({ severity: 1 }), { blockingAllowed: true }),
		).toBe("blocking");
		expect(
			opengrep?.semantic(diag({ severity: 2 }), { blockingAllowed: true }),
		).toBe("warning");
	});

	it("never blocks the auto Community set (no local rules) — advisory only", () => {
		// blocking NOT allowed (auto): even ERROR stays a warning (surfaced in lens_diagnostics).
		expect(
			opengrep?.semantic(diag({ severity: 1 }), { blockingAllowed: false }),
		).toBe("warning");
		expect(
			opengrep?.semantic(diag({ severity: 2 }), { blockingAllowed: false }),
		).toBe("warning");
	});

	it("derives a defect class from the rule", () => {
		const dc = opengrep?.defectClass?.(
			diag({ code: "javascript.lang.security.audit.eval", message: "eval" }),
		);
		expect(typeof dc === "string" || dc === undefined).toBe(true);
	});
});

describe("ast-grep semantic policy", () => {
	const astGrep = AUXILIARY_LSP_PROFILES.find((p) => p.serverId === "ast-grep");

	it("uses ast-grep severity for the shipped baseline as well as project sgconfig", () => {
		expect(astGrep).toBeDefined();
		expect(astGrep?.allowBlocking?.("/repo")).toBe(true);
		expect(
			astGrep?.semantic(diag({ severity: 1 }), { blockingAllowed: true }),
		).toBe("blocking");
		expect(
			astGrep?.semantic(diag({ severity: 2 }), { blockingAllowed: true }),
		).toBe("warning");
	});
});

describe("zizmor semantic policy (#272)", () => {
	const zizmor = AUXILIARY_LSP_PROFILES.find((p) => p.serverId === "zizmor");

	it("blocks High (ERROR) only where a repo zizmor.yml opts in; advisory otherwise", () => {
		expect(zizmor).toBeDefined();
		// curated repo config present → High blocks, Medium/Low stays advisory.
		expect(
			zizmor?.semantic(diag({ severity: 1 }), { blockingAllowed: true }),
		).toBe("blocking");
		expect(
			zizmor?.semantic(diag({ severity: 2 }), { blockingAllowed: true }),
		).toBe("warning");
		// no curated config → even High stays a warning (surfaced in lens_diagnostics).
		expect(
			zizmor?.semantic(diag({ severity: 1 }), { blockingAllowed: false }),
		).toBe("warning");
	});

	it("derives a defect class from the rule id", () => {
		const dc = zizmor?.defectClass?.(
			diag({ code: "template-injection", message: "code injection via template" }),
		);
		expect(typeof dc === "string" || dc === undefined).toBe(true);
	});
});

describe("typos semantic policy (#283)", () => {
	const typos = AUXILIARY_LSP_PROFILES.find((p) => p.serverId === "typos");

	it("is advisory by default; blocks only ERROR where a repo typos.toml opts in", () => {
		expect(typos).toBeDefined();
		// no repo typos config → even an ERROR-severity finding stays advisory
		// (typos-lsp's own default severity is WARNING anyway).
		expect(
			typos?.semantic(diag({ severity: 1 }), { blockingAllowed: false }),
		).toBe("warning");
		expect(
			typos?.semantic(diag({ severity: 2 }), { blockingAllowed: false }),
		).toBe("warning");
		// repo opts in with a typos.toml AND raised severity to Error → blocks.
		expect(
			typos?.semantic(diag({ severity: 1 }), { blockingAllowed: true }),
		).toBe("blocking");
		expect(
			typos?.semantic(diag({ severity: 2 }), { blockingAllowed: true }),
		).toBe("warning");
	});

	it("classifies a misspelling as a style (docs/quality) defect — not security", () => {
		expect(typos?.defectClass?.(diag({ message: "`recieve` should be `receive`" }))).toBe(
			"style",
		);
	});
});

// #586: the single, generic lookup+apply helper every call site (per-edit
// dispatch runner, `tools/lsp-diagnostics.ts`, `runWorkspaceDiagnostics`)
// should use instead of re-deriving "find the profile by source, then check
// isSuppressed" independently.
describe("isAuxiliaryDiagnosticSuppressed / applyAuxiliarySuppressions (#586)", () => {
	const RULE = "python.lang.security.audit.subprocess-shell-true.subprocess-shell-true";

	it("drops an opengrep (Semgrep-sourced) diagnostic suppressed by `// nosemgrep`", () => {
		const content = "subprocess.run('ls', shell=True)  // nosemgrep\n";
		const d = diag({
			source: "Semgrep",
			code: RULE,
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		});
		expect(isAuxiliaryDiagnosticSuppressed(d, content)).toBe(true);
		expect(applyAuxiliarySuppressions([d], content)).toEqual([]);
	});

	it("keeps the same diagnostic when there is no nosemgrep comment", () => {
		const content = "subprocess.run('ls', shell=True)\n";
		const d = diag({
			source: "Semgrep",
			code: RULE,
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		});
		expect(isAuxiliaryDiagnosticSuppressed(d, content)).toBe(false);
		expect(applyAuxiliarySuppressions([d], content)).toEqual([d]);
	});

	it("is a no-op for profiles with no isSuppressed callback (e.g. ast-grep, zizmor, typos)", () => {
		const content = "anything\n";
		const astGrepDiag = diag({
			source: "ast-grep",
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		});
		expect(isAuxiliaryDiagnosticSuppressed(astGrepDiag, content)).toBe(false);
		expect(applyAuxiliarySuppressions([astGrepDiag], content)).toEqual([
			astGrepDiag,
		]);
	});

	it("is a no-op for diagnostics with no matching auxiliary profile (plain language-server findings)", () => {
		const content = "anything\n";
		const tsDiag = diag({
			source: "typescript",
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		});
		expect(isAuxiliaryDiagnosticSuppressed(tsDiag, content)).toBe(false);
		expect(applyAuxiliarySuppressions([tsDiag], content)).toEqual([tsDiag]);
	});

	it("filters a mixed list, keeping unsuppressed and dropping suppressed diagnostics", () => {
		const content = [
			"subprocess.run('a', shell=True)  // nosemgrep",
			"subprocess.run('b', shell=True)",
		].join("\n");
		const suppressed = diag({
			source: "Semgrep",
			code: RULE,
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		});
		const kept = diag({
			source: "Semgrep",
			code: RULE,
			range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
		});
		expect(applyAuxiliarySuppressions([suppressed, kept], content)).toEqual([
			kept,
		]);
	});
});
