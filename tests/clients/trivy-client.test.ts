import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";
import {
	hasAnyDependencyManifest,
	isTrivyEnabled,
	parseTrivyReport,
	parseTrivySecrets,
	resolveSeverityFloor,
	shouldScanTrivy,
} from "../../clients/trivy-client.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-trivy-"));
	resetProjectLensConfigCache();
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
	resetProjectLensConfigCache();
});

// ── Detection gate ──────────────────────────────────────────────────────────

describe("hasAnyDependencyManifest", () => {
	it("trips on a dependency manifest at the root", () => {
		fs.writeFileSync(path.join(tmp, "package.json"), "{}");
		expect(hasAnyDependencyManifest(tmp)).toBe(true);
	});

	it("trips for non-JS ecosystems too (e.g. Cargo, Go, Gemfile)", () => {
		for (const manifest of ["Cargo.lock", "go.mod", "Gemfile.lock"]) {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-trivy-eco-"));
			fs.writeFileSync(path.join(dir, manifest), "");
			expect(hasAnyDependencyManifest(dir)).toBe(true);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not trip on a docs-only project", () => {
		fs.writeFileSync(path.join(tmp, "README.md"), "# hi");
		expect(hasAnyDependencyManifest(tmp)).toBe(false);
	});
});

// ── Explicit opt-in gate ─────────────────────────────────────────────────────

describe("isTrivyEnabled / shouldScanTrivy (#131 opt-in)", () => {
	function writeConfig(trivy: unknown) {
		fs.writeFileSync(
			path.join(tmp, ".pi-lens.json"),
			JSON.stringify({ trivy }),
		);
		resetProjectLensConfigCache();
	}

	it("is OFF by default (no config) even with a manifest", () => {
		fs.writeFileSync(path.join(tmp, "package.json"), "{}");
		expect(isTrivyEnabled(tmp)).toBe(false);
		expect(shouldScanTrivy(tmp)).toBe(false);
	});

	it("opts in only when trivy.enabled === true", () => {
		writeConfig({ enabled: true });
		expect(isTrivyEnabled(tmp)).toBe(true);
		// enabled but no manifest → still nothing to scan
		expect(shouldScanTrivy(tmp)).toBe(false);
		fs.writeFileSync(path.join(tmp, "requirements.txt"), "django==2.0.0\n");
		expect(shouldScanTrivy(tmp)).toBe(true);
	});

	it("treats truthy-but-not-true values as not opted in", () => {
		fs.writeFileSync(path.join(tmp, "package.json"), "{}");
		for (const v of [{ enabled: "true" }, { enabled: 1 }, {}]) {
			writeConfig(v);
			expect(isTrivyEnabled(tmp)).toBe(false);
			expect(shouldScanTrivy(tmp)).toBe(false);
		}
	});
});

// ── Severity floor ──────────────────────────────────────────────────────────

describe("resolveSeverityFloor", () => {
	function writeConfig(minSeverity: string) {
		fs.writeFileSync(
			path.join(tmp, ".pi-lens.json"),
			JSON.stringify({ trivy: { minSeverity } }),
		);
		resetProjectLensConfigCache();
	}

	it("defaults to HIGH + CRITICAL with no config", () => {
		expect(resolveSeverityFloor(tmp)).toEqual(["HIGH", "CRITICAL"]);
	});

	it("lowers the floor to MEDIUM when configured", () => {
		writeConfig("MEDIUM");
		expect(resolveSeverityFloor(tmp)).toEqual(["MEDIUM", "HIGH", "CRITICAL"]);
	});

	it("lowers the floor to LOW (everything) when configured", () => {
		writeConfig("low");
		expect(resolveSeverityFloor(tmp)).toEqual([
			"LOW",
			"MEDIUM",
			"HIGH",
			"CRITICAL",
		]);
	});

	it("clamps to HIGH — a CRITICAL-only config can never hide HIGH (#131)", () => {
		writeConfig("CRITICAL");
		expect(resolveSeverityFloor(tmp)).toEqual(["HIGH", "CRITICAL"]);
	});
});

// ── Parser ──────────────────────────────────────────────────────────────────

describe("parseTrivyReport", () => {
	it("maps Results[].Vulnerabilities[] to findings across ecosystems", () => {
		const report = JSON.stringify({
			Results: [
				{
					Target: "package-lock.json",
					Class: "lang-pkgs",
					Type: "npm",
					Vulnerabilities: [
						{
							VulnerabilityID: "CVE-2026-11111",
							PkgName: "left-pad",
							InstalledVersion: "1.0.0",
							FixedVersion: "1.0.1",
							Severity: "CRITICAL",
							Title: "RCE in left-pad",
							PrimaryURL: "https://example.test/CVE-2026-11111",
						},
					],
				},
				{
					Target: "Cargo.lock",
					Class: "lang-pkgs",
					Type: "cargo",
					Vulnerabilities: [
						{
							VulnerabilityID: "RUSTSEC-2026-0001",
							PkgName: "tokio",
							InstalledVersion: "1.0.0",
							// no FixedVersion → "no fix yet"
							Severity: "high",
						},
					],
				},
			],
		});
		const findings = parseTrivyReport(report);
		expect(findings).toHaveLength(2);
		expect(findings[0]).toMatchObject({
			vulnerabilityId: "CVE-2026-11111",
			pkgName: "left-pad",
			installedVersion: "1.0.0",
			fixedVersion: "1.0.1",
			severity: "CRITICAL",
			target: "package-lock.json",
		});
		// lowercase severity normalized; empty/missing FixedVersion → undefined
		expect(findings[1]).toMatchObject({
			vulnerabilityId: "RUSTSEC-2026-0001",
			severity: "HIGH",
			target: "Cargo.lock",
		});
		expect(findings[1].fixedVersion).toBeUndefined();
	});

	it("returns [] for a clean scan (Results null / no vulnerabilities)", () => {
		expect(parseTrivyReport(JSON.stringify({ Results: null }))).toEqual([]);
		expect(
			parseTrivyReport(
				JSON.stringify({ Results: [{ Target: "go.mod", Vulnerabilities: null }] }),
			),
		).toEqual([]);
	});

	it("is defensive against malformed / empty input (never throws)", () => {
		expect(parseTrivyReport("")).toEqual([]);
		expect(parseTrivyReport("not json")).toEqual([]);
		expect(parseTrivyReport("{}")).toEqual([]);
	});

	it("ignores Secrets[] rows (CVE parser only)", () => {
		const report = JSON.stringify({
			Results: [
				{ Target: "src/config.ts", Secrets: [{ RuleID: "aws", StartLine: 1 }] },
			],
		});
		expect(parseTrivyReport(report)).toEqual([]);
	});
});

// ── Secret parser (#131 Mode 3) ──────────────────────────────────────────────

describe("parseTrivySecrets", () => {
	it("maps Results[].Secrets[] to normalized secret findings", () => {
		const report = JSON.stringify({
			Results: [
				{
					Target: "src/config.ts",
					Class: "secret",
					Secrets: [
						{
							RuleID: "aws-access-key-id",
							Category: "AWS",
							Severity: "CRITICAL",
							Title: "AWS Access Key ID",
							StartLine: 42,
							EndLine: 42,
							Match: "AKIA…",
						},
					],
				},
				// CVE result with no Secrets[] — skipped.
				{
					Target: "package-lock.json",
					Vulnerabilities: [{ VulnerabilityID: "CVE-1", PkgName: "x" }],
				},
			],
		});
		const secrets = parseTrivySecrets(report);
		expect(secrets).toHaveLength(1);
		expect(secrets[0]).toEqual({
			ruleId: "aws-access-key-id",
			file: "src/config.ts",
			line: 42,
			title: "AWS Access Key ID",
		});
	});

	it("skips rows missing RuleID or StartLine, and is defensive on junk", () => {
		const report = JSON.stringify({
			Results: [
				{
					Target: "a.ts",
					Secrets: [
						{ Category: "no-rule", StartLine: 1 },
						{ RuleID: "no-line" },
						{ RuleID: "ok", StartLine: 7 },
					],
				},
			],
		});
		expect(parseTrivySecrets(report)).toEqual([
			{ ruleId: "ok", file: "a.ts", line: 7, title: undefined },
		]);
		expect(parseTrivySecrets("")).toEqual([]);
		expect(parseTrivySecrets("not json")).toEqual([]);
		expect(parseTrivySecrets("{}")).toEqual([]);
	});

	it("skips entries missing the required id/pkg fields", () => {
		const report = JSON.stringify({
			Results: [
				{
					Target: "pom.xml",
					Vulnerabilities: [
						{ PkgName: "no-id", Severity: "HIGH" },
						{ VulnerabilityID: "CVE-2026-22222", Severity: "HIGH" },
						{
							VulnerabilityID: "CVE-2026-33333",
							PkgName: "log4j",
							Severity: "unknown-text",
						},
					],
				},
			],
		});
		const findings = parseTrivyReport(report);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			vulnerabilityId: "CVE-2026-33333",
			pkgName: "log4j",
			severity: "UNKNOWN",
		});
	});
});
