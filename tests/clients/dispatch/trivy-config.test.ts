import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { suppressTrivyConfigDockerOverlap } from "../../../clients/dispatch/dispatcher.js";
import {
	looksLikeCloudFormationTemplate,
	looksLikeKubernetesManifest,
	parseTrivyConfigOutput,
} from "../../../clients/dispatch/runners/trivy-config.js";
import type { Diagnostic } from "../../../clients/dispatch/types.js";
import { makeRunnerCtx } from "../../support/runner-ctx.js";

// ── appliesTo — Terraform is in scope, Terragrunt is deliberately excluded ────

describe("trivy-config appliesTo", () => {
	it("applies to docker, yaml, terraform, and json, but not terragrunt", async () => {
		const trivyConfigRunner = (
			await import("../../../clients/dispatch/runners/trivy-config.js")
		).default;
		expect(trivyConfigRunner.appliesTo).toEqual([
			"docker",
			"yaml",
			"terraform",
			"json",
		]);
		expect(trivyConfigRunner.appliesTo).not.toContain("terragrunt");
	});
});

// ── Terraform files skip the yaml/k8s content gate ─────────────────────────────

const {
	safeSpawnAsync,
	isTrivyEnabled,
	resolveSeverityFloor,
	incrementDegradationCount,
} = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	isTrivyEnabled: vi.fn(),
	resolveSeverityFloor: vi.fn(),
	incrementDegradationCount: vi.fn(),
}));

vi.mock("../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
}));

vi.mock("../../../clients/trivy-client.js", () => ({
	isTrivyEnabled,
	resolveSeverityFloor,
}));

vi.mock("../../../clients/degradation-ledger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/degradation-ledger.js")>()),
	incrementDegradationCount,
}));

vi.mock("../../../clients/dispatch/runners/utils/runner-helpers.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/dispatch/runners/utils/runner-helpers.js")>()),
	createAvailabilityChecker: () => ({
		isAvailableAsync: async () => true,
		getCommand: () => "trivy",
	}),
}));

function createCtx(
	kind: "terraform" | "yaml" | "json",
	filePath: string,
	cwd: string,
) {
	return makeRunnerCtx(filePath, cwd, { kind });
}

// Derived (not hardcoded) so the assertions hold on both POSIX and Windows:
// `path.join(os.tmpdir(), ...)` yields a real, OS-native absolute path, and
// the runner's `path.resolve(cwd, ctx.filePath)` is a no-op when filePath is
// already absolute — so the resolved spawn arg equals `tfFile` on either OS.
const tfCwd = path.join(os.tmpdir(), "pi-lens-trivy-config-test");
const tfFile = path.join(tfCwd, "main.tf");

describe("trivy-config run() — terraform pass-through", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		isTrivyEnabled.mockReset();
		resolveSeverityFloor.mockReset();
		incrementDegradationCount.mockReset();
		isTrivyEnabled.mockReturnValue(true);
		resolveSeverityFloor.mockReturnValue(["HIGH", "CRITICAL"]);
	});

	it("scans a .tf file directly, without the yaml k8s-manifest gate", async () => {
		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout: JSON.stringify({ Results: [] }),
			stderr: "",
		});

		const runner = (
			await import("../../../clients/dispatch/runners/trivy-config.js")
		).default;

		const result = await runner.run(
			createCtx("terraform", tfFile, tfCwd) as never,
		);

		expect(safeSpawnAsync).toHaveBeenCalledWith(
			"trivy",
			expect.arrayContaining(["config", tfFile]),
			expect.objectContaining({ cwd: tfCwd }),
		);
		expect(result.status).toBe("succeeded");
	});

	// `trivy config` gets no `--exit-code`, so it exits 0 whenever it
	// completed (findings included). A nonzero exit is therefore always a
	// real error, regardless of stdout content — an empty-output-ONLY guard
	// would miss this (a bad policy bundle, an unreadable file, a rejected
	// flag with empty stdout, all real errors).
	it("skips when trivy exits nonzero without producing output", async () => {
		safeSpawnAsync.mockResolvedValue({
			status: 1,
			stdout: "",
			stderr: "FATAL failed to load policies",
		});

		const runner = (
			await import("../../../clients/dispatch/runners/trivy-config.js")
		).default;

		const result = await runner.run(
			createCtx("terraform", tfFile, tfCwd) as never,
		);

		expect(result.status).toBe("skipped");
		expect(result.diagnostics).toEqual([]);
	});

	// #1757 F3: a rejected flag (e.g. the `--no-progress` bug that shipped in
	// the first version of this fix) makes trivy exit nonzero but print
	// non-empty, unparseable usage text to STDOUT — an empty-output-only
	// guard does NOT catch this. Pre-fix, this fell through to
	// `parseTrivyConfigOutput` (which returns `[]` on unparseable JSON) and
	// reported `{ status: "succeeded", diagnostics: [] }`: a clean scan for a
	// file trivy never read. Any nonzero exit must be treated as an error,
	// full stop, regardless of what's on stdout.
	//
	// #1757 review round 3 (V1): the ledger call is the ENTIRE remedy for this
	// silent-death lane — a future edit deleting it would leave the failure
	// invisible again with every other assertion here still green (status
	// "skipped" alone doesn't prove the record exists). This test asserts the
	// exact kind, subject (the scanned file's absolute path), and that the
	// reason names both the binary and the exit status, mirroring the
	// reviewer's probe: nonzero exit + usage text on stdout through the
	// production run() path → verdict skipped + exactly this ledger entry.
	it("treats a nonzero exit with non-empty (unparseable) stdout as errored, never clean, and records it", async () => {
		safeSpawnAsync.mockResolvedValue({
			status: 1,
			stdout:
				"Scan config files for misconfigurations\n\nUsage:\n  trivy config [flags] DIR\n".repeat(
					40,
				),
			stderr: "FATAL	Fatal error	unknown flag: --no-progress",
		});

		const runner = (
			await import("../../../clients/dispatch/runners/trivy-config.js")
		).default;

		const result = await runner.run(
			createCtx("terraform", tfFile, tfCwd) as never,
		);

		expect(result.status).not.toBe("succeeded");
		expect(result.diagnostics).toEqual([]);

		expect(incrementDegradationCount).toHaveBeenCalledTimes(1);
		const record = incrementDegradationCount.mock.calls[0][0];
		expect(record.kind).toBe("runner-empty-result");
		expect(record.subject).toBe(tfFile);
		expect(record.reason).toContain("trivy config");
		expect(record.reason).toContain("1");
	});
});

// ── CloudFormation content gate — yaml AND json (#1757) ─────────────────────────

describe("trivy-config run() — CloudFormation content gate", () => {
	let cfnCwd: string;

	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		isTrivyEnabled.mockReset();
		resolveSeverityFloor.mockReset();
		isTrivyEnabled.mockReturnValue(true);
		resolveSeverityFloor.mockReturnValue(["HIGH", "CRITICAL"]);
		cfnCwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-trivy-config-cfn-test-"),
		);
	});

	it("scans a CloudFormation yaml template", async () => {
		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout: JSON.stringify({ Results: [] }),
			stderr: "",
		});
		const file = path.join(cfnCwd, "template.yaml");
		fs.writeFileSync(
			file,
			"AWSTemplateFormatVersion: '2010-09-09'\nResources:\n  Bucket:\n    Type: AWS::S3::Bucket\n",
		);

		const runner = (
			await import("../../../clients/dispatch/runners/trivy-config.js")
		).default;
		const result = await runner.run(createCtx("yaml", file, cfnCwd) as never);

		expect(safeSpawnAsync).toHaveBeenCalled();
		expect(result.status).toBe("succeeded");
	});

	it("scans a CloudFormation json template", async () => {
		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout: JSON.stringify({ Results: [] }),
			stderr: "",
		});
		const file = path.join(cfnCwd, "template.json");
		fs.writeFileSync(
			file,
			JSON.stringify({
				AWSTemplateFormatVersion: "2010-09-09",
				Resources: { Bucket: { Type: "AWS::S3::Bucket" } },
			}),
		);

		const runner = (
			await import("../../../clients/dispatch/runners/trivy-config.js")
		).default;
		const result = await runner.run(createCtx("json", file, cfnCwd) as never);

		expect(safeSpawnAsync).toHaveBeenCalled();
		expect(result.status).toBe("succeeded");
	});

	// Mutation-proof: adding "json" to appliesTo without a content gate would
	// make trivy-config spawn on every package.json/tsconfig.json in a repo.
	it("skips a generic (non-CloudFormation) json file without spawning trivy", async () => {
		const file = path.join(cfnCwd, "package.json");
		fs.writeFileSync(
			file,
			JSON.stringify({ name: "not-cfn", version: "1.0.0" }),
		);

		const runner = (
			await import("../../../clients/dispatch/runners/trivy-config.js")
		).default;
		const result = await runner.run(createCtx("json", file, cfnCwd) as never);

		expect(safeSpawnAsync).not.toHaveBeenCalled();
		expect(result.status).toBe("skipped");
	});
});

// ── Kubernetes manifest heuristic ─────────────────────────────────────────────

describe("looksLikeKubernetesManifest", () => {
	it("matches a manifest with apiVersion + kind", () => {
		expect(
			looksLikeKubernetesManifest(
				"apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n",
			),
		).toBe(true);
	});

	it("matches when one document in a multi-doc file is a manifest", () => {
		const content = [
			"# config\nfoo: bar",
			"apiVersion: v1\nkind: Service\nmetadata:\n  name: svc",
		].join("\n---\n");
		expect(looksLikeKubernetesManifest(content)).toBe(true);
	});

	it("does NOT match a CI workflow / plain yaml (no apiVersion+kind)", () => {
		expect(
			looksLikeKubernetesManifest("name: CI\non: [push]\njobs:\n  build:\n"),
		).toBe(false);
		expect(looksLikeKubernetesManifest("kind: only-kind-no-apiversion")).toBe(
			false,
		);
	});
});

// ── CloudFormation template heuristic (#1757) ──────────────────────────────────

describe("looksLikeCloudFormationTemplate", () => {
	it("matches on AWSTemplateFormatVersion (yaml)", () => {
		expect(
			looksLikeCloudFormationTemplate(
				"AWSTemplateFormatVersion: '2010-09-09'\nResources:\n  Bucket:\n    Type: AWS::S3::Bucket\n",
			),
		).toBe(true);
	});

	it("matches on AWSTemplateFormatVersion (json)", () => {
		expect(
			looksLikeCloudFormationTemplate(
				JSON.stringify({
					AWSTemplateFormatVersion: "2010-09-09",
					Resources: { Bucket: { Type: "AWS::S3::Bucket" } },
				}),
			),
		).toBe(true);
	});

	it("matches a SAM template's Transform even without AWSTemplateFormatVersion", () => {
		expect(
			looksLikeCloudFormationTemplate(
				"Transform: AWS::Serverless-2016-10-31\nResources:\n  Fn:\n    Type: AWS::Serverless::Function\n",
			),
		).toBe(true);
	});

	it("matches on a bare Resources[].Type in the AWS:: namespace (no version key)", () => {
		expect(
			looksLikeCloudFormationTemplate(
				"Resources:\n  Bucket:\n    Type: AWS::S3::Bucket\n    Properties: {}\n",
			),
		).toBe(true);
	});

	it("does NOT match plain yaml/json with no CFN signal", () => {
		expect(
			looksLikeCloudFormationTemplate(
				"name: CI\non: [push]\njobs:\n  build:\n",
			),
		).toBe(false);
		expect(
			looksLikeCloudFormationTemplate(JSON.stringify({ name: "not-cfn" })),
		).toBe(false);
	});

	it("does NOT match a Kubernetes manifest", () => {
		expect(
			looksLikeCloudFormationTemplate(
				"apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n",
			),
		).toBe(false);
	});
});

// ── Parser ────────────────────────────────────────────────────────────────────

describe("parseTrivyConfigOutput", () => {
	it("maps Misconfigurations[] with severity → semantic", () => {
		const report = JSON.stringify({
			Results: [
				{
					Target: "Dockerfile",
					Class: "config",
					Type: "dockerfile",
					Misconfigurations: [
						{
							ID: "DS026",
							Title: "No HEALTHCHECK defined",
							Severity: "CRITICAL",
							Resolution: "Add a HEALTHCHECK instruction.",
							CauseMetadata: { StartLine: 3 },
						},
						{
							ID: "DS002",
							Title: "Image runs as root",
							Severity: "HIGH",
							CauseMetadata: { StartLine: 1 },
						},
					],
				},
			],
		});
		const diags = parseTrivyConfigOutput(report, "Dockerfile");
		expect(diags).toHaveLength(2);
		expect(diags[0]).toMatchObject({
			rule: "DS026",
			line: 3,
			severity: "error",
			semantic: "blocking",
			defectClass: "safety",
			tool: "trivy-config",
		});
		expect(diags[0].message).toContain("Add a HEALTHCHECK");
		expect(diags[1]).toMatchObject({
			rule: "DS002",
			line: 1,
			severity: "warning",
			semantic: "warning",
		});
	});

	it("defaults line to 1 when CauseMetadata is missing, skips rows without ID", () => {
		const report = JSON.stringify({
			Results: [
				{
					Target: "deploy.yaml",
					Misconfigurations: [
						{ Title: "no id", Severity: "HIGH" },
						{ ID: "KSV001", Title: "Privileged", Severity: "HIGH" },
					],
				},
			],
		});
		const diags = parseTrivyConfigOutput(report, "deploy.yaml");
		expect(diags).toHaveLength(1);
		expect(diags[0]).toMatchObject({ rule: "KSV001", line: 1 });
	});

	it("is defensive against malformed / empty input", () => {
		expect(parseTrivyConfigOutput("", "f")).toEqual([]);
		expect(parseTrivyConfigOutput("not json", "f")).toEqual([]);
		expect(parseTrivyConfigOutput("{}", "f")).toEqual([]);
		expect(
			parseTrivyConfigOutput(JSON.stringify({ Results: null }), "f"),
		).toEqual([]);
	});
});

// ── Dockerfile overlap dedup vs hadolint (#131 Mode 2 acceptance gate) ─────────

describe("suppressTrivyConfigDockerOverlap", () => {
	function diag(tool: string, line: number, rule: string): Diagnostic {
		return {
			id: `${tool}-${rule}-${line}`,
			message: `${rule} at ${line}`,
			filePath: "Dockerfile",
			line,
			column: 1,
			severity: "warning",
			semantic: "warning",
			tool,
			rule,
			fixable: false,
		};
	}

	it("drops the trivy-config finding where hadolint already flags the same line", () => {
		const out = suppressTrivyConfigDockerOverlap([
			diag("hadolint", 7, "DL3007"), // :latest
			diag("trivy-config", 7, "DS001"), // :latest — overlap, dropped
			diag("trivy-config", 12, "DS026"), // net-new security check, kept
		]);
		expect(out.map((d) => `${d.tool}:${d.line}`)).toEqual([
			"hadolint:7",
			"trivy-config:12",
		]);
	});

	it("keeps Kubernetes findings (no hadolint diagnostics for YAML)", () => {
		const k8s = [
			{ ...diag("trivy-config", 5, "KSV017"), filePath: "deploy.yaml" },
			{ ...diag("trivy-config", 9, "KSV001"), filePath: "deploy.yaml" },
		];
		expect(suppressTrivyConfigDockerOverlap(k8s)).toHaveLength(2);
	});

	it("is a no-op when no hadolint diagnostics are present", () => {
		const only = [diag("trivy-config", 1, "DS002")];
		expect(suppressTrivyConfigDockerOverlap(only)).toEqual(only);
	});
});
