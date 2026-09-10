import { describe, expect, it } from "vitest";
import { runnerRetirementDecision } from "../../tools/lens-diagnostics.js";
import type { WidgetDiagnostic } from "../../clients/widget-state.js";

const diagnostic = (tool: string): WidgetDiagnostic => ({
	tool,
	severity: "warning",
	message: "retained",
	uri: "",
	rule: `${tool}:finding`,
});

describe("project runner coverage state space (#2887)", () => {
	it("coverage matrix: knip root under-root retires", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("knip"),
				"/proj/retained.ts",
				new Set(["knip"]),
				[
					{
						runnerId: "knip",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("retire");
	});
	it("coverage matrix: knip root another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("knip"),
				"/other/retained.ts",
				new Set(["knip"]),
				[
					{
						runnerId: "knip",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: knip root another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("knip-other-language"),
				"/proj/retained.rs",
				new Set(["knip"]),
				[
					{
						runnerId: "knip",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: knip file-set under-root keeps-with-record", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("knip"),
				"/proj/retained.ts",
				new Set(["knip"]),
				[
					{
						runnerId: "knip",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep-with-record");
	});
	it("coverage matrix: knip file-set another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("knip"),
				"/other/retained.ts",
				new Set(["knip"]),
				[
					{
						runnerId: "knip",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: knip file-set another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("knip-other-language"),
				"/proj/retained.rs",
				new Set(["knip"]),
				[
					{
						runnerId: "knip",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: knip partial under-root keeps-with-record", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("knip"),
				"/proj/retained.ts",
				new Set(["knip"]),
				[{ runnerId: "knip", root: "/proj", complete: false }],
			),
		).toBe("keep-with-record");
	});
	it("coverage matrix: knip partial another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("knip"),
				"/other/retained.ts",
				new Set(["knip"]),
				[{ runnerId: "knip", root: "/proj", complete: false }],
			),
		).toBe("keep");
	});
	it("coverage matrix: knip partial another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("knip-other-language"),
				"/proj/retained.rs",
				new Set(["knip"]),
				[{ runnerId: "knip", root: "/proj", complete: false }],
			),
		).toBe("keep");
	});
	it("coverage matrix: jscpd root under-root retires", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("jscpd"),
				"/proj/retained.ts",
				new Set(["jscpd"]),
				[
					{
						runnerId: "jscpd",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("retire");
	});
	it("coverage matrix: jscpd root another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("jscpd"),
				"/other/retained.ts",
				new Set(["jscpd"]),
				[
					{
						runnerId: "jscpd",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: jscpd root another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("jscpd-other-language"),
				"/proj/retained.rs",
				new Set(["jscpd"]),
				[
					{
						runnerId: "jscpd",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: jscpd file-set under-root keeps-with-record", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("jscpd"),
				"/proj/retained.ts",
				new Set(["jscpd"]),
				[
					{
						runnerId: "jscpd",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep-with-record");
	});
	it("coverage matrix: jscpd file-set another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("jscpd"),
				"/other/retained.ts",
				new Set(["jscpd"]),
				[
					{
						runnerId: "jscpd",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: jscpd file-set another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("jscpd-other-language"),
				"/proj/retained.rs",
				new Set(["jscpd"]),
				[
					{
						runnerId: "jscpd",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: jscpd partial under-root keeps-with-record", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("jscpd"),
				"/proj/retained.ts",
				new Set(["jscpd"]),
				[{ runnerId: "jscpd", root: "/proj", complete: false }],
			),
		).toBe("keep-with-record");
	});
	it("coverage matrix: jscpd partial another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("jscpd"),
				"/other/retained.ts",
				new Set(["jscpd"]),
				[{ runnerId: "jscpd", root: "/proj", complete: false }],
			),
		).toBe("keep");
	});
	it("coverage matrix: jscpd partial another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("jscpd-other-language"),
				"/proj/retained.rs",
				new Set(["jscpd"]),
				[{ runnerId: "jscpd", root: "/proj", complete: false }],
			),
		).toBe("keep");
	});
	it("coverage matrix: madge root under-root retires", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("madge"),
				"/proj/retained.ts",
				new Set(["madge"]),
				[
					{
						runnerId: "madge",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("retire");
	});
	it("coverage matrix: madge root another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("madge"),
				"/other/retained.ts",
				new Set(["madge"]),
				[
					{
						runnerId: "madge",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: madge root another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("madge-other-language"),
				"/proj/retained.rs",
				new Set(["madge"]),
				[
					{
						runnerId: "madge",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: madge file-set under-root keeps-with-record", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("madge"),
				"/proj/retained.ts",
				new Set(["madge"]),
				[
					{
						runnerId: "madge",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep-with-record");
	});
	it("coverage matrix: madge file-set another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("madge"),
				"/other/retained.ts",
				new Set(["madge"]),
				[
					{
						runnerId: "madge",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: madge file-set another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("madge-other-language"),
				"/proj/retained.rs",
				new Set(["madge"]),
				[
					{
						runnerId: "madge",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: madge partial under-root keeps-with-record", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("madge"),
				"/proj/retained.ts",
				new Set(["madge"]),
				[{ runnerId: "madge", root: "/proj", complete: false }],
			),
		).toBe("keep-with-record");
	});
	it("coverage matrix: madge partial another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("madge"),
				"/other/retained.ts",
				new Set(["madge"]),
				[{ runnerId: "madge", root: "/proj", complete: false }],
			),
		).toBe("keep");
	});
	it("coverage matrix: madge partial another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("madge-other-language"),
				"/proj/retained.rs",
				new Set(["madge"]),
				[{ runnerId: "madge", root: "/proj", complete: false }],
			),
		).toBe("keep");
	});
	it("coverage matrix: gitleaks root under-root retires", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("gitleaks"),
				"/proj/retained.ts",
				new Set(["gitleaks"]),
				[
					{
						runnerId: "gitleaks",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("retire");
	});
	it("coverage matrix: gitleaks root another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("gitleaks"),
				"/other/retained.ts",
				new Set(["gitleaks"]),
				[
					{
						runnerId: "gitleaks",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: gitleaks root another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("gitleaks-other-language"),
				"/proj/retained.rs",
				new Set(["gitleaks"]),
				[
					{
						runnerId: "gitleaks",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: gitleaks file-set under-root keeps-with-record", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("gitleaks"),
				"/proj/retained.ts",
				new Set(["gitleaks"]),
				[
					{
						runnerId: "gitleaks",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep-with-record");
	});
	it("coverage matrix: gitleaks file-set another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("gitleaks"),
				"/other/retained.ts",
				new Set(["gitleaks"]),
				[
					{
						runnerId: "gitleaks",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: gitleaks file-set another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("gitleaks-other-language"),
				"/proj/retained.rs",
				new Set(["gitleaks"]),
				[
					{
						runnerId: "gitleaks",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: gitleaks partial under-root keeps-with-record", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("gitleaks"),
				"/proj/retained.ts",
				new Set(["gitleaks"]),
				[{ runnerId: "gitleaks", root: "/proj", complete: false }],
			),
		).toBe("keep-with-record");
	});
	it("coverage matrix: gitleaks partial another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("gitleaks"),
				"/other/retained.ts",
				new Set(["gitleaks"]),
				[{ runnerId: "gitleaks", root: "/proj", complete: false }],
			),
		).toBe("keep");
	});
	it("coverage matrix: gitleaks partial another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("gitleaks-other-language"),
				"/proj/retained.rs",
				new Set(["gitleaks"]),
				[{ runnerId: "gitleaks", root: "/proj", complete: false }],
			),
		).toBe("keep");
	});
	it("coverage matrix: govulncheck root under-root retires", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("govulncheck"),
				"/proj/retained.ts",
				new Set(["govulncheck"]),
				[
					{
						runnerId: "govulncheck",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("retire");
	});
	it("coverage matrix: govulncheck root another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("govulncheck"),
				"/other/retained.ts",
				new Set(["govulncheck"]),
				[
					{
						runnerId: "govulncheck",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: govulncheck root another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("govulncheck-other-language"),
				"/proj/retained.rs",
				new Set(["govulncheck"]),
				[
					{
						runnerId: "govulncheck",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: govulncheck file-set under-root keeps-with-record", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("govulncheck"),
				"/proj/retained.ts",
				new Set(["govulncheck"]),
				[
					{
						runnerId: "govulncheck",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep-with-record");
	});
	it("coverage matrix: govulncheck file-set another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("govulncheck"),
				"/other/retained.ts",
				new Set(["govulncheck"]),
				[
					{
						runnerId: "govulncheck",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: govulncheck file-set another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("govulncheck-other-language"),
				"/proj/retained.rs",
				new Set(["govulncheck"]),
				[
					{
						runnerId: "govulncheck",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: govulncheck partial under-root keeps-with-record", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("govulncheck"),
				"/proj/retained.ts",
				new Set(["govulncheck"]),
				[{ runnerId: "govulncheck", root: "/proj", complete: false }],
			),
		).toBe("keep-with-record");
	});
	it("coverage matrix: govulncheck partial another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("govulncheck"),
				"/other/retained.ts",
				new Set(["govulncheck"]),
				[{ runnerId: "govulncheck", root: "/proj", complete: false }],
			),
		).toBe("keep");
	});
	it("coverage matrix: govulncheck partial another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("govulncheck-other-language"),
				"/proj/retained.rs",
				new Set(["govulncheck"]),
				[{ runnerId: "govulncheck", root: "/proj", complete: false }],
			),
		).toBe("keep");
	});
	it("coverage matrix: opengrep root under-root retires", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("opengrep"),
				"/proj/retained.ts",
				new Set(["opengrep"]),
				[
					{
						runnerId: "opengrep",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("retire");
	});
	it("coverage matrix: opengrep root another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("opengrep"),
				"/other/retained.ts",
				new Set(["opengrep"]),
				[
					{
						runnerId: "opengrep",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: opengrep root another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("opengrep-other-language"),
				"/proj/retained.rs",
				new Set(["opengrep"]),
				[
					{
						runnerId: "opengrep",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: opengrep file-set under-root keeps-with-record", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("opengrep"),
				"/proj/retained.ts",
				new Set(["opengrep"]),
				[
					{
						runnerId: "opengrep",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep-with-record");
	});
	it("coverage matrix: opengrep file-set another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("opengrep"),
				"/other/retained.ts",
				new Set(["opengrep"]),
				[
					{
						runnerId: "opengrep",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: opengrep file-set another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("opengrep-other-language"),
				"/proj/retained.rs",
				new Set(["opengrep"]),
				[
					{
						runnerId: "opengrep",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: opengrep partial under-root keeps-with-record", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("opengrep"),
				"/proj/retained.ts",
				new Set(["opengrep"]),
				[{ runnerId: "opengrep", root: "/proj", complete: false }],
			),
		).toBe("keep-with-record");
	});
	it("coverage matrix: opengrep partial another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("opengrep"),
				"/other/retained.ts",
				new Set(["opengrep"]),
				[{ runnerId: "opengrep", root: "/proj", complete: false }],
			),
		).toBe("keep");
	});
	it("coverage matrix: opengrep partial another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("opengrep-other-language"),
				"/proj/retained.rs",
				new Set(["opengrep"]),
				[{ runnerId: "opengrep", root: "/proj", complete: false }],
			),
		).toBe("keep");
	});
	it("coverage matrix: trivy root under-root retires", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("trivy"),
				"/proj/retained.ts",
				new Set(["trivy"]),
				[
					{
						runnerId: "trivy",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("retire");
	});
	it("coverage matrix: trivy root another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("trivy"),
				"/other/retained.ts",
				new Set(["trivy"]),
				[
					{
						runnerId: "trivy",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: trivy root another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("trivy-other-language"),
				"/proj/retained.rs",
				new Set(["trivy"]),
				[
					{
						runnerId: "trivy",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: trivy file-set under-root keeps-with-record", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("trivy"),
				"/proj/retained.ts",
				new Set(["trivy"]),
				[
					{
						runnerId: "trivy",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep-with-record");
	});
	it("coverage matrix: trivy file-set another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("trivy"),
				"/other/retained.ts",
				new Set(["trivy"]),
				[
					{
						runnerId: "trivy",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: trivy file-set another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("trivy-other-language"),
				"/proj/retained.rs",
				new Set(["trivy"]),
				[
					{
						runnerId: "trivy",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: trivy partial under-root keeps-with-record", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("trivy"),
				"/proj/retained.ts",
				new Set(["trivy"]),
				[{ runnerId: "trivy", root: "/proj", complete: false }],
			),
		).toBe("keep-with-record");
	});
	it("coverage matrix: trivy partial another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("trivy"),
				"/other/retained.ts",
				new Set(["trivy"]),
				[{ runnerId: "trivy", root: "/proj", complete: false }],
			),
		).toBe("keep");
	});
	it("coverage matrix: trivy partial another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("trivy-other-language"),
				"/proj/retained.rs",
				new Set(["trivy"]),
				[{ runnerId: "trivy", root: "/proj", complete: false }],
			),
		).toBe("keep");
	});
	it("coverage matrix: dead-code root under-root retires", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("dead-code-python"),
				"/proj/retained.ts",
				new Set(["dead-code-python"]),
				[
					{
						runnerId: "dead-code-python",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("retire");
	});
	it("coverage matrix: dead-code root another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("dead-code-python"),
				"/other/retained.ts",
				new Set(["dead-code-python"]),
				[
					{
						runnerId: "dead-code-python",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: dead-code root another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("dead-code-python-other-language"),
				"/proj/retained.rs",
				new Set(["dead-code-python"]),
				[
					{
						runnerId: "dead-code-python",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: dead-code file-set under-root keeps-with-record", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("dead-code-python"),
				"/proj/retained.ts",
				new Set(["dead-code-python"]),
				[
					{
						runnerId: "dead-code-python",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep-with-record");
	});
	it("coverage matrix: dead-code file-set another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("dead-code-python"),
				"/other/retained.ts",
				new Set(["dead-code-python"]),
				[
					{
						runnerId: "dead-code-python",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: dead-code file-set another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("dead-code-python-other-language"),
				"/proj/retained.rs",
				new Set(["dead-code-python"]),
				[
					{
						runnerId: "dead-code-python",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: dead-code partial under-root keeps-with-record", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("dead-code-python"),
				"/proj/retained.ts",
				new Set(["dead-code-python"]),
				[{ runnerId: "dead-code-python", root: "/proj", complete: false }],
			),
		).toBe("keep-with-record");
	});
	it("coverage matrix: dead-code partial another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("dead-code-python"),
				"/other/retained.ts",
				new Set(["dead-code-python"]),
				[{ runnerId: "dead-code-python", root: "/proj", complete: false }],
			),
		).toBe("keep");
	});
	it("coverage matrix: dead-code partial another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("dead-code-python-other-language"),
				"/proj/retained.rs",
				new Set(["dead-code-python"]),
				[{ runnerId: "dead-code-python", root: "/proj", complete: false }],
			),
		).toBe("keep");
	});
	it("coverage matrix: test-runner root under-root retires", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("test-runner"),
				"/proj/retained.ts",
				new Set(["test-runner"]),
				[
					{
						runnerId: "test-runner",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("retire");
	});
	it("coverage matrix: test-runner root another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("test-runner"),
				"/other/retained.ts",
				new Set(["test-runner"]),
				[
					{
						runnerId: "test-runner",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: test-runner root another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("test-runner-other-language"),
				"/proj/retained.rs",
				new Set(["test-runner"]),
				[
					{
						runnerId: "test-runner",
						root: "/proj",
						files: ["/proj/retained.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: test-runner file-set under-root keeps-with-record", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("test-runner"),
				"/proj/retained.ts",
				new Set(["test-runner"]),
				[
					{
						runnerId: "test-runner",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep-with-record");
	});
	it("coverage matrix: test-runner file-set another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("test-runner"),
				"/other/retained.ts",
				new Set(["test-runner"]),
				[
					{
						runnerId: "test-runner",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: test-runner file-set another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("test-runner-other-language"),
				"/proj/retained.rs",
				new Set(["test-runner"]),
				[
					{
						runnerId: "test-runner",
						root: "/proj",
						files: ["/proj/included.ts"],
						complete: true,
					},
				],
			),
		).toBe("keep");
	});
	it("coverage matrix: test-runner partial under-root keeps-with-record", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("test-runner"),
				"/proj/retained.ts",
				new Set(["test-runner"]),
				[{ runnerId: "test-runner", root: "/proj", complete: false }],
			),
		).toBe("keep-with-record");
	});
	it("coverage matrix: test-runner partial another-root keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("test-runner"),
				"/other/retained.ts",
				new Set(["test-runner"]),
				[{ runnerId: "test-runner", root: "/proj", complete: false }],
			),
		).toBe("keep");
	});
	it("coverage matrix: test-runner partial another-language keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("test-runner-other-language"),
				"/proj/retained.rs",
				new Set(["test-runner"]),
				[{ runnerId: "test-runner", root: "/proj", complete: false }],
			),
		).toBe("keep");
	});
});
