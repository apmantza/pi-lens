import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	findPiLensProjectConfig,
	loadPiLensProjectConfig,
	resetProjectLensConfigCache,
} from "../../clients/project-lens-config.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-project-config-"));
	resetProjectLensConfigCache();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	resetProjectLensConfigCache();
	vi.restoreAllMocks();
});

describe("loadPiLensProjectConfig", () => {
	it("returns empty config when no file exists", () => {
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.ignore).toEqual([]);
		expect(cfg.rules).toEqual({});
		expect(cfg.configPath).toBeUndefined();
		expect(cfg.raw).toBeUndefined();
	});

	it("loads .pi-lens.json from cwd", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				ignore: ["**/__tests__/**", "fixtures/**"],
				rules: { "high-complexity": { threshold: 25 } },
			}),
		);
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.ignore).toEqual(["**/__tests__/**", "fixtures/**"]);
		expect(cfg.rules["high-complexity"]?.threshold).toBe(25);
		expect(cfg.configPath).toBe(path.join(tmpDir, ".pi-lens.json"));
	});

	it("accepts pi-lens.json (no leading dot) as a fallback name", () => {
		fs.writeFileSync(
			path.join(tmpDir, "pi-lens.json"),
			JSON.stringify({ ignore: ["vendor/**"] }),
		);
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.ignore).toEqual(["vendor/**"]);
		expect(cfg.configPath).toBe(path.join(tmpDir, "pi-lens.json"));
	});

	it("prefers .pi-lens.json over pi-lens.json when both exist", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["dotfile-wins/**"] }),
		);
		fs.writeFileSync(
			path.join(tmpDir, "pi-lens.json"),
			JSON.stringify({ ignore: ["nodot/**"] }),
		);
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.ignore).toEqual(["dotfile-wins/**"]);
	});

	it("walks up to find a config in a parent directory", () => {
		const sub = path.join(tmpDir, "src", "lib");
		fs.mkdirSync(sub, { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["upward/**"] }),
		);
		const cfg = loadPiLensProjectConfig(sub);
		expect(cfg.ignore).toEqual(["upward/**"]);
		expect(cfg.configPath).toBe(path.join(tmpDir, ".pi-lens.json"));
	});

	it("invalidates the cache when the file mtime changes", async () => {
		const p = path.join(tmpDir, ".pi-lens.json");
		fs.writeFileSync(p, JSON.stringify({ ignore: ["a"] }));
		const cfg1 = loadPiLensProjectConfig(tmpDir);
		expect(cfg1.ignore).toEqual(["a"]);

		// Sleep is the only portable way to guarantee mtime advances across
		// filesystems; 20ms is well above the 1ms resolution of every modern FS.
		await new Promise((r) => setTimeout(r, 20));
		fs.writeFileSync(p, JSON.stringify({ ignore: ["b", "c"] }));
		const cfg2 = loadPiLensProjectConfig(tmpDir);
		expect(cfg2.ignore).toEqual(["b", "c"]);
	});

	it("returns empty config on malformed JSON without throwing", () => {
		fs.writeFileSync(path.join(tmpDir, ".pi-lens.json"), "{not json");
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.ignore).toEqual([]);
		expect(cfg.configPath).toBeUndefined();
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("ignoring invalid project config"),
		);
	});

	it("returns empty config when root is a non-object JSON value", () => {
		fs.writeFileSync(path.join(tmpDir, ".pi-lens.json"), '"a string"');
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.ignore).toEqual([]);
		expect(cfg.configPath).toBeUndefined();
	});

	it("filters non-string entries out of the ignore array", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				ignore: ["valid/**", 42, null, "also-valid/**", true, { x: 1 }],
			}),
		);
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.ignore).toEqual(["valid/**", "also-valid/**"]);
	});

	it("rejects non-positive and non-finite threshold numbers", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: {
					"high-complexity": { threshold: NaN },
					"high-fan-out": { threshold: Infinity },
					"high-import-coupling": { threshold: -Infinity },
					"cors-wildcard": { threshold: "15" },
					"zero-threshold": { threshold: 0 },
					"negative-threshold": { threshold: -5 },
				},
			}),
		);
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("threshold must be a positive finite number"),
		);
		expect(cfg.rules["high-complexity"]).toBeUndefined();
		expect(cfg.rules["high-fan-out"]).toBeUndefined();
		expect(cfg.rules["high-import-coupling"]).toBeUndefined();
		expect(cfg.rules["cors-wildcard"]).toBeUndefined();
		expect(cfg.rules["zero-threshold"]).toBeUndefined();
		expect(cfg.rules["negative-threshold"]).toBeUndefined();
	});

	it("ignores non-object rule entries and entries with no threshold", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: {
					"high-complexity": "not an object",
					"high-fan-out": null,
					"good-rule": [],
					// Valid object but no threshold key — no actionable override,
					// so we skip it (forward-compat: future rule keys may have
					// sub-keys we don't know about yet, and we don't want to
					// claim support we can't deliver).
					"cors-wildcard": { unrelated: true },
				},
			}),
		);
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.rules["high-complexity"]).toBeUndefined();
		expect(cfg.rules["high-fan-out"]).toBeUndefined();
		expect(cfg.rules["good-rule"]).toBeUndefined();
		expect(cfg.rules["cors-wildcard"]).toBeUndefined();
	});

	it("preserves rule entries that have a finite threshold alongside other keys", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: {
					"high-complexity": { threshold: 20, futureOption: "x" },
				},
			}),
		);
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.rules["high-complexity"]).toEqual({ threshold: 20 });
	});

	it("exposes the raw parsed JSON for forward-compat consumers", () => {
		const raw = {
			ignore: ["x/**"],
			rules: {},
			servers: { foo: { name: "foo" } },
			unknownFutureField: [1, 2, 3],
		};
		fs.writeFileSync(path.join(tmpDir, ".pi-lens.json"), JSON.stringify(raw));
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.raw).toEqual(raw);
	});

	it("findPiLensProjectConfig returns path, dir, and mtime for cache keys", () => {
		const configPath = path.join(tmpDir, ".pi-lens.json");
		fs.writeFileSync(configPath, JSON.stringify({ ignore: ["x/**"] }));
		const info = findPiLensProjectConfig(path.join(tmpDir, "src"));
		expect(info?.path).toBe(configPath);
		expect(info?.dir).toBe(tmpDir);
		expect(typeof info?.mtimeMs).toBe("number");
	});

	it("stops walking at the filesystem root without infinite-looping", () => {
		// /tmp/... is unlikely to have a .pi-lens.json anywhere up the tree
		// (the test runner's tmp dir is sandboxed). If the walker bug-loops,
		// vitest's test timeout will catch it.
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.configPath).toBeUndefined();
	});
});
