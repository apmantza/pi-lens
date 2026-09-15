import { describe, expect, it } from "vitest";
import {
	detectFileKind,
	isHelmYamlTemplatePath,
} from "../../clients/file-kinds.js";

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
	it("routes YAML files under a templates directory through Helm", () => {
		expect(detectFileKind("/repo/chart/templates/deployment.yaml")).toBe(
			"helm-template",
		);
		expect(
			detectFileKind("C:\\repo\\chart\\templates\\nested\\route.YML"),
		).toBe("helm-template");
	});

	it("does not reclassify ordinary YAML outside templates", () => {
		expect(detectFileKind("/repo/chart/values.yaml")).toBe("yaml");
		expect(detectFileKind("/repo/config/templates.yaml")).toBe("yaml");
	});

	it("exposes the path predicate for consumers that need the distinction", () => {
		expect(isHelmYamlTemplatePath("/repo/chart/templates/service.yaml")).toBe(
			true,
		);
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
