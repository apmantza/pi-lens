import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";
import {
	hasAnyDependencyManifest,
	isTrivyEnabled,
	parseTrivyLicenses,
	parseTrivyReport,
	parseTrivySecrets,
	resolveSeverityFloor,
	shouldScanTrivy,
	TrivyClient,
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

// ── License parser (#131 Mode 4) ─────────────────────────────────────────────

describe("parseTrivyLicenses", () => {
	it("maps Results[].Licenses[] to normalized license findings", () => {
		const report = JSON.stringify({
			Results: [
				{
					Target: "node_modules/leftpad/package.json",
					Class: "license",
					Licenses: [
						{
							Severity: "HIGH",
							Category: "restricted",
							PkgName: "leftpad",
							Name: "GPL-3.0",
							FilePath: "",
						},
					],
				},
				// CVE result with no Licenses[] — skipped.
				{ Target: "go.sum", Vulnerabilities: [{ VulnerabilityID: "CVE-1" }] },
			],
		});
		const licenses = parseTrivyLicenses(report);
		expect(licenses).toHaveLength(1);
		expect(licenses[0]).toEqual({
			license: "GPL-3.0",
			pkgName: "leftpad",
			severity: "HIGH",
			category: "restricted",
			filePath: "node_modules/leftpad/package.json",
		});
	});

	it("falls back to FilePath as pkgName for license-file findings", () => {
		const report = JSON.stringify({
			Results: [
				{
					Target: "LICENSE",
					Class: "license-file",
					Licenses: [
						{ Severity: "MEDIUM", Name: "AGPL-3.0", FilePath: "vendor/LICENSE" },
					],
				},
			],
		});
		const [lic] = parseTrivyLicenses(report);
		expect(lic).toMatchObject({
			license: "AGPL-3.0",
			pkgName: "vendor/LICENSE",
			filePath: "vendor/LICENSE",
			severity: "MEDIUM",
		});
	});

	it("skips rows without a license Name and is defensive on junk", () => {
		const report = JSON.stringify({
			Results: [
				{ Target: "a", Licenses: [{ Severity: "HIGH" }, { Name: "MIT" }] },
			],
		});
		const licenses = parseTrivyLicenses(report);
		expect(licenses).toHaveLength(1);
		expect(licenses[0].license).toBe("MIT");
		expect(parseTrivyLicenses("")).toEqual([]);
		expect(parseTrivyLicenses("not json")).toEqual([]);
		expect(parseTrivyLicenses("{}")).toEqual([]);
	});
});

describe("TrivyClient de-dupe guard (#585 prerequisite)", () => {
	it("de-dupes concurrent scan() calls for the same project root (SecurityScanClient.dedupeScan)", async () => {
		// #585: mode=full can now trigger a fresh trivy scan while a
		// session_start scan of the same root may still be in flight. Without
		// this guard (added via the shared SecurityScanClient base, #313) that
		// would double-spawn trivy — the slowest of these analyzers (own ~180s
		// timeout ceiling), making a double-spawn especially costly.
		fs.writeFileSync(
			path.join(tmp, ".pi-lens.json"),
			JSON.stringify({ trivy: { enabled: true } }),
		);
		fs.writeFileSync(path.join(tmp, "package.json"), "{}");
		resetProjectLensConfigCache();

		const client = new TrivyClient(false) as unknown as {
			ensureAvailable: () => Promise<boolean>;
			runScan: (cwd: string) => Promise<{
				success: boolean;
				findings: unknown[];
				scannedAt: string;
			}>;
			scan: (cwd: string) => Promise<unknown>;
		};
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);

		type Resolver = (v: {
			success: boolean;
			findings: unknown[];
			scannedAt: string;
		}) => void;
		let resolveRun: Resolver | null = null;
		let runCalls = 0;
		const runSpy = vi.spyOn(client, "runScan").mockImplementation(
			() =>
				new Promise((res) => {
					runCalls++;
					resolveRun = res as unknown as Resolver;
				}),
		);

		const first = client.scan(tmp);
		const second = client.scan(tmp);

		await Promise.resolve();
		await Promise.resolve();

		expect(runCalls).toBe(1);
		expect(runSpy).toHaveBeenCalledTimes(1);

		const payload = { success: true, findings: [], scannedAt: "now" };
		(resolveRun as Resolver | null)?.(payload);

		const [a, b] = await Promise.all([first, second]);
		expect(a).toBe(b);
	});
});
