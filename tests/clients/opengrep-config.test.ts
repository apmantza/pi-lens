import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findLocalOpengrepConfig,
	normalizeOpengrepConfigArg,
	resolveOpengrepConfig,
} from "../../clients/opengrep-config.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opengrep-cfg-"));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("opengrep config resolution", () => {
	it("is disabled with a reason when no config exists and the flag is unset", () => {
		const r = resolveOpengrepConfig(tmp);
		expect(r.enabled).toBe(false);
		expect(r.source).toBe("disabled");
		expect(r.reason).toMatch(/--lens-opengrep not set/);
	});

	it("auto-enables from a local .opengrep.yml", () => {
		const cfg = path.join(tmp, ".opengrep.yml");
		fs.writeFileSync(cfg, "rules: []\n");
		const r = resolveOpengrepConfig(tmp);
		expect(r.enabled).toBe(true);
		expect(r.source).toBe("local");
		expect(r.configArg).toBe(cfg);
	});

	it("also detects a legacy .semgrep.yml (shared rule format)", () => {
		const cfg = path.join(tmp, ".semgrep.yml");
		fs.writeFileSync(cfg, "rules: []\n");
		expect(findLocalOpengrepConfig(tmp)).toBe(cfg);
		expect(resolveOpengrepConfig(tmp).enabled).toBe(true);
	});

	it("--lens-opengrep alone defaults to the 'auto' ruleset (seamless)", () => {
		const r = resolveOpengrepConfig(tmp, { enabled: true });
		expect(r.enabled).toBe(true);
		expect(r.source).toBe("flag");
		expect(r.configArg).toBe("auto");
	});

	it("--lens-opengrep prefers a discovered local rule file over 'auto'", () => {
		const cfg = path.join(tmp, ".opengrep.yml");
		fs.writeFileSync(cfg, "rules: []\n");
		const r = resolveOpengrepConfig(tmp, { enabled: true });
		expect(r.enabled).toBe(true);
		expect(r.source).toBe("local");
		expect(r.configArg).toBe(cfg);
	});

	it("an explicit --lens-opengrep-config implies enable and overrides", () => {
		const r = resolveOpengrepConfig(tmp, { config: "p/ci" });
		expect(r.enabled).toBe(true);
		expect(r.source).toBe("flag");
		expect(r.configArg).toBe("p/ci");
	});
});

describe("normalizeOpengrepConfigArg", () => {
	it("passes registry/auto configs through verbatim", () => {
		expect(normalizeOpengrepConfigArg("auto", tmp)).toBe("auto");
		expect(normalizeOpengrepConfigArg("p/security", tmp)).toBe("p/security");
		expect(normalizeOpengrepConfigArg("r/some.rule", tmp)).toBe("r/some.rule");
	});

	it("resolves relative paths against cwd and keeps absolute paths", () => {
		expect(normalizeOpengrepConfigArg("rules/x.yml", tmp)).toBe(
			path.resolve(tmp, "rules/x.yml"),
		);
		const abs = path.join(tmp, "abs.yml");
		expect(normalizeOpengrepConfigArg(abs, tmp)).toBe(abs);
	});

	it("returns undefined for empty/missing input", () => {
		expect(normalizeOpengrepConfigArg(undefined, tmp)).toBeUndefined();
		expect(normalizeOpengrepConfigArg("   ", tmp)).toBeUndefined();
	});
});
