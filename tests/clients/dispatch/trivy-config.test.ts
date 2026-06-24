import { describe, expect, it } from "vitest";
import { suppressTrivyConfigDockerOverlap } from "../../../clients/dispatch/dispatcher.js";
import {
	looksLikeKubernetesManifest,
	parseTrivyConfigOutput,
} from "../../../clients/dispatch/runners/trivy-config.js";
import type { Diagnostic } from "../../../clients/dispatch/types.js";

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
