import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CACHE_VERSION, RuleCache } from "../../clients/cache/rule-cache.js";
import { removeTempDirSync } from "./test-utils.js";
import {
	getGlobalPiLensDir,
	getProjectDataDir,
} from "../../clients/file-utils.js";
import { appendToWorklog, readWorklog } from "../../clients/fix-worklog.js";

const originalDataDir = process.env.PILENS_DATA_DIR;
const originalHome = process.env.PI_LENS_HOME;
const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) removeTempDirSync(tempDirs.pop() as string);
	if (originalDataDir === undefined) {
		delete process.env.PILENS_DATA_DIR;
	} else {
		process.env.PILENS_DATA_DIR = originalDataDir;
	}
	if (originalHome === undefined) {
		delete process.env.PI_LENS_HOME;
	} else {
		process.env.PI_LENS_HOME = originalHome;
	}
});

describe("getProjectDataDir", () => {
	it("defaults to a global pi-lens projects directory instead of the project folder", () => {
		delete process.env.PILENS_DATA_DIR;
		// This test deliberately exercises the real (non-PI_LENS_HOME-overridden)
		// resolver, so it constructs its own explicit override back to the real
		// homedir rather than relying on vitest-setup's PI_LENS_HOME (#525) — see
		// tests/support/vitest-setup.ts.
		delete process.env.PI_LENS_HOME;
		const cwd = path.resolve("/tmp/demo-project");

		const result = getProjectDataDir(cwd);

		expect(
			result.startsWith(path.join(os.homedir(), ".pi-lens", "projects")),
		).toBe(true);
		expect(result.includes(`${path.sep}.pi-lens${path.sep}`)).toBe(true);
		expect(result.startsWith(path.join(cwd, ".pi-lens"))).toBe(false);
	});

	it("reuses an existing legacy project .pi-lens directory when no env override is set", () => {
		delete process.env.PILENS_DATA_DIR;
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-legacy-project-"),
		);
		tempDirs.push(cwd);
		const legacyDir = path.join(cwd, ".pi-lens");
		fs.mkdirSync(legacyDir, { recursive: true });

		const result = getProjectDataDir(cwd);

		expect(result).toBe(legacyDir);
	});

	it("uses PILENS_DATA_DIR when provided", () => {
		process.env.PILENS_DATA_DIR = path.join(os.tmpdir(), "pi-lens-data-root");
		const cwd = path.resolve("/tmp/another-project");

		const result = getProjectDataDir(cwd);

		expect(result.startsWith(process.env.PILENS_DATA_DIR)).toBe(true);
		expect(result.startsWith(path.join(cwd, ".pi-lens"))).toBe(false);
	});

	it("project-data writers do not create a .pi-lens folder inside the project", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-project-data-"));
		tempDirs.push(cwd);
		process.env.PILENS_DATA_DIR = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-global-data-"),
		);
		tempDirs.push(process.env.PILENS_DATA_DIR);
		tempDirs.push(process.env.PILENS_DATA_DIR);

		appendToWorklog(
			cwd,
			[
				{
					id: "demo-id",
					tool: "eslint",
					severity: "warning",
					semantic: "warning",
					filePath: path.join(cwd, "src", "index.ts"),
					message: "demo",
					rule: "demo-rule",
					line: 1,
					column: 1,
					fixable: true,
				},
			],
			false,
		);

		expect(fs.existsSync(path.join(cwd, ".pi-lens"))).toBe(false);
		expect(
			fs.existsSync(path.join(getProjectDataDir(cwd), "worklog.jsonl")),
		).toBe(true);
	});

	it("redacts credential-shaped text from worklog diagnostic messages", () => {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-worklog-redact-"),
		);
		tempDirs.push(cwd);
		process.env.PILENS_DATA_DIR = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-global-data-"),
		);
		tempDirs.push(process.env.PILENS_DATA_DIR);
		const token = `ghp_${"a".repeat(36)}`;

		appendToWorklog(
			cwd,
			[
				{
					id: "secret-scan",
					tool: "gitleaks",
					severity: "warning",
					semantic: "warning",
					filePath: path.join(cwd, "src", "config.ts"),
					message: `hardcoded token ${token} detected`,
					rule: "no-secrets",
					line: 1,
					column: 1,
					fixable: false,
				},
			],
			true,
		);

		const raw = fs.readFileSync(
			path.join(getProjectDataDir(cwd), "worklog.jsonl"),
			"utf8",
		);
		expect(raw).not.toContain(token);

		const entries = readWorklog(cwd);
		expect(entries).toHaveLength(1);
		expect(entries[0].message).toBe(
			"hardcoded token [REDACTED:github-token] detected",
		);
	});

	// #1448: model/provider attribution
	it("carries model and provider when an identity is supplied", () => {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-worklog-model-"),
		);
		tempDirs.push(cwd);
		process.env.PILENS_DATA_DIR = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-global-data-"),
		);
		tempDirs.push(process.env.PILENS_DATA_DIR);

		appendToWorklog(
			cwd,
			[
				{
					id: "demo-id",
					tool: "eslint",
					severity: "warning",
					semantic: "warning",
					filePath: path.join(cwd, "src", "index.ts"),
					message: "demo",
					rule: "demo-rule",
					line: 1,
					column: 1,
					fixable: true,
				},
			],
			false,
			{ model: "claude-sonnet-4-5", provider: "anthropic" },
		);

		const entries = readWorklog(cwd);
		expect(entries).toHaveLength(1);
		expect(entries[0].model).toBe("claude-sonnet-4-5");
		expect(entries[0].provider).toBe("anthropic");
	});

	it("omits model and provider from the persisted line when identity is unknown", () => {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-worklog-blank-"),
		);
		tempDirs.push(cwd);
		process.env.PILENS_DATA_DIR = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-global-data-"),
		);
		tempDirs.push(process.env.PILENS_DATA_DIR);

		appendToWorklog(
			cwd,
			[
				{
					id: "demo-id",
					tool: "eslint",
					severity: "warning",
					semantic: "warning",
					filePath: path.join(cwd, "src", "index.ts"),
					message: "demo",
					rule: "demo-rule",
					line: 1,
					column: 1,
					fixable: true,
				},
			],
			false,
		);

		const raw = fs.readFileSync(
			path.join(getProjectDataDir(cwd), "worklog.jsonl"),
			"utf8",
		);
		expect(raw).not.toContain('"model"');
		expect(raw).not.toContain('"provider"');

		const entries = readWorklog(cwd);
		expect(entries).toHaveLength(1);
		expect(entries[0].model).toBeUndefined();
		expect(entries[0].provider).toBeUndefined();
	});

	it("parses old-shape entries that predate the model/provider fields", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-worklog-old-"));
		tempDirs.push(cwd);
		process.env.PILENS_DATA_DIR = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-global-data-"),
		);
		tempDirs.push(process.env.PILENS_DATA_DIR);
		fs.mkdirSync(getProjectDataDir(cwd), { recursive: true });
		const oldEntry = {
			timestamp: new Date().toISOString(),
			filePath: path.join(cwd, "src", "legacy.ts"),
			rule: "legacy-rule",
			tool: "eslint",
			message: "legacy entry, no model/provider fields at all",
			line: 1,
			fixable: false,
			autoFixed: true,
		};
		fs.writeFileSync(
			path.join(getProjectDataDir(cwd), "worklog.jsonl"),
			`${JSON.stringify(oldEntry)}\n`,
			"utf8",
		);

		const entries = readWorklog(cwd);
		expect(entries).toHaveLength(1);
		expect(entries[0].rule).toBe("legacy-rule");
		expect(entries[0].model).toBeUndefined();
		expect(entries[0].provider).toBeUndefined();
	});

	it("stores rule cache under the configured data directory", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rule-cache-"));
		tempDirs.push(cwd);
		const prev = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-global-data-"),
		);
		tempDirs.push(process.env.PILENS_DATA_DIR);
		try {
			const cache = new RuleCache("typescript", cwd);

			cache.set([], []);

			expect(fs.existsSync(path.join(cwd, ".pi-lens"))).toBe(false);
			expect(
				fs.existsSync(
					path.join(
						getProjectDataDir(cwd),
						"cache",
						`typescript-rules-${CACHE_VERSION}.json`,
					),
				),
			).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = prev;
		}
	});
});

describe("getGlobalPiLensDir (#525 hermeticity)", () => {
	it("defaults to ~/.pi-lens when PI_LENS_HOME is unset", () => {
		delete process.env.PI_LENS_HOME;

		expect(getGlobalPiLensDir()).toBe(path.join(os.homedir(), ".pi-lens"));
	});

	it("respects PI_LENS_HOME as a full override of the machine-global root", () => {
		const override = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-global-home-"),
		);
		tempDirs.push(override);
		process.env.PI_LENS_HOME = override;

		expect(getGlobalPiLensDir()).toBe(path.resolve(override));
	});

	it("PI_LENS_HOME is trimmed of surrounding whitespace", () => {
		const override = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-global-home-ws-"),
		);
		tempDirs.push(override);
		process.env.PI_LENS_HOME = `  ${override}  `;

		expect(getGlobalPiLensDir()).toBe(path.resolve(override));
	});
});
