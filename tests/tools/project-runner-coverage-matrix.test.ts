import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
const covered = (runnerId: string, files?: string[]) => [
	{ runnerId, root: "/proj", files: new Set(files ?? []) },
];

describe("project runner coverage state space (#2887)", () => {
	it("coverage state: scanned-set ok stale retires when contained", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("opengrep"),
				"/proj/retained.py",
				new Set(["opengrep"]),
				covered("opengrep", ["/proj/retained.py"]),
			),
		).toBe("retire");
	});
	it("coverage state: scanned-set ok fresh keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("opengrep"),
				"/proj/clean.ts",
				new Set(["opengrep"]),
				covered("opengrep", ["/proj/other.ts"]),
			),
		).toBe("keep");
	});
	it("coverage state: scanned-set ok empty falls back to id gate", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("opengrep"),
				"/proj/retained.py",
				new Set(["opengrep"]),
				covered("opengrep"),
			),
		).toBe("retire");
	});
	it("coverage state: scanned-set error stale keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("opengrep"),
				"/proj/retained.py",
				undefined,
				undefined,
			),
		).toBe("keep");
	});
	it("coverage state: scanned-set error fresh keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("opengrep"),
				"/proj/clean.ts",
				undefined,
				undefined,
			),
		).toBe("keep");
	});
	it("coverage state: no evidence ok stale uses id gate", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("knip"),
				"/proj/retained.ts",
				new Set(["knip"]),
				undefined,
			),
		).toBe("retire");
	});
	it("coverage state: no evidence ok fresh uses id gate", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("gitleaks"),
				"/proj/clean.txt",
				new Set(["gitleaks"]),
				undefined,
			),
		).toBe("retire");
	});
	it("coverage state: no evidence error stale keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("trivy"),
				"/proj/retained.json",
				undefined,
				undefined,
			),
		).toBe("keep");
	});
	it("coverage state: no evidence error fresh keeps", () => {
		expect(
			runnerRetirementDecision(
				diagnostic("govulncheck"),
				"/proj/clean.go",
				new Set(),
				undefined,
			),
		).toBe("keep");
	});
	it("coverage state: symlink path matches scanned-set realpath", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-coverage-"));
		const real = path.join(root, "real");
		const link = path.join(root, "link");
		fs.mkdirSync(real);
		fs.writeFileSync(path.join(real, "a.py"), "x");
		fs.symlinkSync(real, link, "dir");
		try {
			expect(
				runnerRetirementDecision(
					diagnostic("opengrep"),
					path.join(link, "a.py"),
					new Set(["opengrep"]),
					[
						{
							runnerId: "opengrep",
							root: real,
							files: new Set([fs.realpathSync(path.join(real, "a.py"))]),
						},
					],
				),
			).toBe("retire");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	it("coverage state: scanned path resolves outside recorded root keeps", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-coverage-"));
		const outside = path.join(root, "outside.ts");
		const link = path.join(root, "inside.ts");
		fs.writeFileSync(outside, "x");
		fs.symlinkSync(outside, link, "file");
		try {
			expect(
				runnerRetirementDecision(
					diagnostic("opengrep"),
					link,
					new Set(["opengrep"]),
					[
						{
							runnerId: "opengrep",
							root: path.join(root, "project"),
							files: new Set([outside]),
						},
					],
				),
			).toBe("keep");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
