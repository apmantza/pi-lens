import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	detectFileKind,
	isHelmYamlTemplatePath,
} from "../../clients/file-kinds.js";

let fixtureRoot: string | undefined;

afterEach(() => {
	if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

describe("detectFileKind — terragrunt", () => {
	it("detects terragrunt.hcl and root.hcl by filename", () => {
		expect(detectFileKind("/repo/infra/terragrunt.hcl")).toBe("terragrunt");
		expect(detectFileKind("/repo/infra/root.hcl")).toBe("terragrunt");
	});

	it("is case-insensitive", () => {
		expect(detectFileKind("/repo/infra/Terragrunt.HCL")).toBe("terragrunt");
		expect(detectFileKind("/repo/infra/ROOT.hcl")).toBe("terragrunt");
	});

	it("leaves a generic .hcl file unmapped", () => {
		expect(detectFileKind("/repo/infra/foo.hcl")).toBeUndefined();
	});

	it("does not match .terraform.lock.hcl", () => {
		expect(detectFileKind("/repo/infra/.terraform.lock.hcl")).toBeUndefined();
	});
});

describe("detectFileKind — Helm templates", () => {
	it("routes YAML files under a real chart templates directory through Helm", () => {
		fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-file-kinds-"));
		const chartRoot = path.join(fixtureRoot, "chart");
		fs.mkdirSync(path.join(chartRoot, "templates", "nested"), {
			recursive: true,
		});
		fs.writeFileSync(path.join(chartRoot, "Chart.yaml"), "apiVersion: v2\n");
		const deployment = path.join(chartRoot, "templates", "deployment.yaml");
		const nested = path.join(chartRoot, "templates", "nested", "route.yml");
		fs.writeFileSync(deployment, "kind: Deployment\n");
		fs.writeFileSync(nested, "kind: Route\n");

		expect(detectFileKind(deployment)).toBe("helm-template");
		expect(detectFileKind(nested)).toBe("helm-template");
	});

	it("does not reclassify ordinary or nested non-chart YAML templates", () => {
		// Regression for F-3034-1: a templates/ directory alone is not Helm chart topology.
		expect(detectFileKind("/repo/chart/values.yaml")).toBe("yaml");
		expect(detectFileKind("/repo/config/templates.yaml")).toBe("yaml");
		fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-file-kinds-"));
		const nested = path.join(fixtureRoot, "project", "templates", "nested");
		fs.mkdirSync(nested, { recursive: true });
		const file = path.join(nested, "route.yaml");
		fs.writeFileSync(file, "kind: Route\n");
		expect(detectFileKind(file)).toBe("yaml");
	});

	it("does not promote Windows-shaped paths without a verified chart root", () => {
		expect(detectFileKind("C:\\repo\\service\\templates\\route.YML")).toBe(
			"yaml",
		);
	});

	it("treats a POSIX literal backslash as part of the filename", () => {
		fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-file-kinds-"));
		const chartRoot = path.join(fixtureRoot, "chart");
		fs.mkdirSync(chartRoot, { recursive: true });
		fs.writeFileSync(path.join(chartRoot, "Chart.yaml"), "apiVersion: v2\n");
		const literalBackslash = path.join(chartRoot, "templates\\deployment.yaml");
		fs.writeFileSync(literalBackslash, "kind: Deployment\n");

		expect(detectFileKind(literalBackslash)).toBe("yaml");
	});

	it("exposes the path predicate for consumers that need the distinction", () => {
		fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-file-kinds-"));
		const chartRoot = path.join(fixtureRoot, "chart");
		fs.mkdirSync(path.join(chartRoot, "templates"), { recursive: true });
		fs.writeFileSync(path.join(chartRoot, "Chart.yaml"), "apiVersion: v2\n");
		expect(
			isHelmYamlTemplatePath(path.join(chartRoot, "templates", "service.yaml")),
		).toBe(true);
		expect(isHelmYamlTemplatePath("/repo/chart/values.yaml")).toBe(false);
	});

	it("routes .tpl helpers through an explicit file kind", () => {
		expect(detectFileKind("/repo/chart/templates/_helpers.tpl")).toBe(
			"helm-template",
		);
		expect(detectFileKind("C:\\repo\\chart\\templates\\notes.TPL")).toBe(
			"helm-template",
		);
	});
});
