import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

// Set test mode to isolate logging from production logs
process.env.PI_LENS_TEST_MODE = "1";

const ensureTool = vi.fn();
const getToolEnvironment = vi.fn(async () => ({}));
const launchLSP = vi.fn();

vi.mock("../../../clients/installer/index.js", () => ({
	ensureTool,
	getToolEnvironment,
	findManagedToolBinary: vi.fn(async () => undefined),
}));

vi.mock("../../../clients/lsp/launch.js", () => ({
	launchLSP,
	admitProjectSuppliedTsserver: (tsserverPath: string) => tsserverPath,
}));

vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency: vi.fn(),
	resetLatencyLog: vi.fn(),
}));

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		removeTempDirSync(dir);
	}
	ensureTool.mockReset();
	launchLSP.mockReset();
	vi.resetModules();
});

function makeRoot(): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-typos-root-"));
	dirs.push(tmp);
	return tmp;
}

describe("TyposServer.spawn initialization (#967)", () => {
	it("steps aside (injects no config) when the project has its own typos config", async () => {
		const root = makeRoot();
		fs.writeFileSync(path.join(root, "_typos.toml"), "[default]\n");
		launchLSP.mockResolvedValue({ pid: 123 } as never);

		const { TyposServer } = await import("../../../clients/lsp/server.js");
		const result = await TyposServer.spawn(root, { allowInstall: false });

		expect(result).toBeDefined();
		expect(result?.initialization).toBeUndefined();
	});

	it("injects the bundled config when the project has no typos config", async () => {
		const root = makeRoot();
		launchLSP.mockResolvedValue({ pid: 123 } as never);

		const { TyposServer } = await import("../../../clients/lsp/server.js");
		const result = await TyposServer.spawn(root, { allowInstall: false });

		expect(result).toBeDefined();
		const config = result?.initialization?.config;
		expect(typeof config).toBe("string");
		expect(path.isAbsolute(config as string)).toBe(true);
		expect(fs.existsSync(config as string)).toBe(true);
		expect(path.basename(config as string)).toBe("_typos.toml");
	});
});

describe("bundled default typos config (#967)", () => {
	const bundledPath = path.resolve(
		__dirname,
		"../../../rules/typos/_typos.toml",
	);

	/**
	 * pi-lens has no bundled TOML parser dependency, so this walks the file
	 * with a minimal line parser (stripping comments/blank lines, tracking the
	 * current `[section]`) — enough to assert structure without pulling in a
	 * new dependency just for a test.
	 */
	function parseSimpleToml(raw: string): {
		sections: string[];
		entries: Record<string, Record<string, string>>;
	} {
		const sections: string[] = [];
		const entries: Record<string, Record<string, string>> = {};
		let currentSection: string | undefined;
		for (const rawLine of raw.split(/\r?\n/)) {
			const line = rawLine.replace(/#.*$/, "").trim();
			if (!line) continue;
			const sectionMatch = line.match(/^\[([^\]]+)\]$/);
			if (sectionMatch) {
				currentSection = sectionMatch[1];
				sections.push(currentSection);
				entries[currentSection] = {};
				continue;
			}
			const kvMatch = line.match(/^(\S+)\s*=\s*"([^"]*)"$/);
			if (kvMatch && currentSection) {
				entries[currentSection][kvMatch[1]] = kvMatch[2];
			}
		}
		return { sections, entries };
	}

	it("exists", () => {
		expect(fs.existsSync(bundledPath)).toBe(true);
	});

	it("contains only [default.extend-identifiers] — no bulk word-list suppression", () => {
		const raw = fs.readFileSync(bundledPath, "utf8");
		const { sections, entries } = parseSimpleToml(raw);
		expect(sections).toEqual(["default.extend-identifiers"]);
		expect(entries["default.extend-identifiers"]).toEqual({
			dito: "dito",
			unparseable: "unparseable",
		});
	});
});
