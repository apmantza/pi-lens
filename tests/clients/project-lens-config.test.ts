import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGlobalConfigLocationCache } from "../../clients/lens-config.js";
import {
	findPiLensProjectConfig,
	loadPiLensConfigInDir,
	loadPiLensProjectConfig,
	PROJECT_CONFIG_BASENAMES,
	resetProjectLensConfigCache,
} from "../../clients/project-lens-config.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { resolveLensToolEnabled } from "../../clients/tool-config.js";
import { removeTempDirSync } from "./test-utils.js";
import { useConfigPath } from "../support/global-config.js";

// #1333: these config/telemetry warnings no longer reach the terminal — pi owns
// it — they go to the ndjson sink in `clients/extension-log.ts`. The sink mock
// below forwards each entry's message to `console.error` so the assertions in
// this file keep covering what they were written to cover (message content and
// the warn-once dedup contract) without re-deriving every expectation. The
// "no raw terminal write" half of the invariant is enforced repo-wide by
// tests/clients/extension-terminal-silence.test.ts.
vi.mock("../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/extension-log.js")>();
	return {
		...actual,
		logExtension: (entry: { message: string }) => console.error(entry.message),
	};
});

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-project-config-"));
	resetProjectLensConfigCache();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	removeTempDirSync(tmpDir);
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

	it("parses project-level mutation controls", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				format: { enabled: false },
				autofix: { enabled: false },
				actionableWarnings: { autoFix: { enabled: false } },
			}),
		);

		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.format).toEqual({ enabled: false });
		expect(cfg.autofix).toEqual({ enabled: false });
		expect(cfg.actionableWarnings).toEqual({
			autoFix: { enabled: false },
		});
	});

	it("ignores invalid project-level mutation controls", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				format: { enabled: "no" },
				autofix: false,
				actionableWarnings: { autoFix: { enabled: 1 } },
			}),
		);

		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.format?.enabled).toBeUndefined();
		expect(cfg.autofix).toBeUndefined();
		expect(cfg.actionableWarnings?.autoFix?.enabled).toBeUndefined();
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("format.enabled must be a boolean"),
		);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("autofix must be an object"),
		);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining(
				"actionableWarnings.autoFix.enabled must be a boolean",
			),
		);
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

	/**
	 * #2426 review round 2, F4: the only canonical-wins coverage at this loader
	 * used to be the `ignore` case above plus a shape assertion on the location
	 * TABLE. Both halves below are BEHAVIORAL and both go red under a
	 * `PROJECT_CONFIG_LOCATIONS.reverse()` mutation — the ordering is what
	 * decides, not `lspSectionOf`'s namespace-over-root rule.
	 */
	it("reads a colliding maxProjectFiles from the canonical file (#2426)", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ maxProjectFiles: 2222 }),
		);
		fs.writeFileSync(
			path.join(tmpDir, "pi-lens.json"),
			JSON.stringify({ maxProjectFiles: 1111 }),
		);
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.maxProjectFiles).toBe(2222);
		expect(cfg.configPath).toBe(path.join(tmpDir, ".pi-lens.json"));
		// The per-directory (no-walk) counterpart used for nested layering (#783)
		// resolves the same collision the same way.
		expect(loadPiLensConfigInDir(tmpDir).maxProjectFiles).toBe(2222);
	});

	it("orders PROJECT_CONFIG_BASENAMES canonical-first (#2426)", () => {
		// DESCENDING precedence, first match wins — so the canonical basename is
		// index 0. Pinned as an ordered list rather than as a set: the set is what
		// is read, the ORDER is what decides a collision.
		expect(PROJECT_CONFIG_BASENAMES).toEqual([".pi-lens.json", "pi-lens.json"]);
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

	it("does not leak a token from a malformed config into the warning (#2431)", () => {
		// The literal shape from #2431's evidence: Node's own JSON.parse
		// SyntaxError embeds a slice of the source text, so an unquoted value
		// next to a real-shaped credential leaked straight through as `reason`
		// before this fix.
		const TOKEN = `ghp_${"A".repeat(36)}`;
		const configPath = path.join(tmpDir, ".pi-lens.json");
		fs.writeFileSync(configPath, `{"piToken": ${TOKEN}}`);

		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.ignore).toEqual([]);

		expect(console.error).toHaveBeenCalledTimes(1);
		const [message] = vi.mocked(console.error).mock.calls[0];
		expect(message).not.toContain(TOKEN);
		expect(message).not.toContain("ghp_");
		// #2451: the position-free `Unexpected token` shape (exactly what this
		// fixture hits) used to lose ALL locality after #2431's redaction —
		// strictly less signal than before that fix. It is recovered here, end
		// to end, through the real `readConfigDocument` -> `reportConfigReadFailure`
		// production wiring, not just at the `normalizeParseErrorReason` unit level.
		expect(message).toContain("SyntaxError at line 1 col 13");
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

	describe("reviewGraph.maxFiles (#775 R2)", () => {
		it("is undefined when the field is absent", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ ignore: [] }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.reviewGraph).toBeUndefined();
		});

		it("parses a valid in-range value", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ reviewGraph: { maxFiles: 8000 } }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.reviewGraph).toEqual({ maxFiles: 8000 });
		});

		it("tolerantly parses a numeric string, like maxProjectFiles", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ reviewGraph: { maxFiles: "8000" } }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.reviewGraph).toEqual({ maxFiles: 8000 });
		});

		it("floors a fractional value", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ reviewGraph: { maxFiles: 8000.7 } }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.reviewGraph).toEqual({ maxFiles: 8000 });
		});

		it("clamps a value below the minimum (100) without warning", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ reviewGraph: { maxFiles: 5 } }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.reviewGraph).toEqual({ maxFiles: 100 });
			expect(console.error).not.toHaveBeenCalled();
		});

		it("clamps a value above the maximum (20,000) without warning", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ reviewGraph: { maxFiles: 1_000_000 } }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.reviewGraph).toEqual({ maxFiles: 20_000 });
			expect(console.error).not.toHaveBeenCalled();
		});

		it("warns once and drops a non-numeric maxFiles", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ reviewGraph: { maxFiles: "not-a-number" } }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.reviewGraph?.maxFiles).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining(
					"reviewGraph.maxFiles must be a positive finite number",
				),
			);
		});

		it("warns once and drops a non-positive maxFiles", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ reviewGraph: { maxFiles: -5 } }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.reviewGraph?.maxFiles).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining(
					"reviewGraph.maxFiles must be a positive finite number",
				),
			);
		});

		it("warns once when reviewGraph itself is not an object", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ reviewGraph: "not-an-object" }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.reviewGraph).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining("reviewGraph must be an object"),
			);
		});

		it("only warns once for repeated loads of the same invalid config", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ reviewGraph: { maxFiles: "bogus" } }),
			);
			// Two loads without resetting the cache in between — the warn-once
			// dedupe (keyed by configPath:reason) must suppress the second call.
			loadPiLensProjectConfig(tmpDir);
			loadPiLensProjectConfig(tmpDir);
			const calls = (
				console.error as unknown as { mock: { calls: unknown[][] } }
			).mock.calls.filter((args) =>
				String(args[0]).includes("reviewGraph.maxFiles"),
			);
			expect(calls.length).toBe(1);
		});
	});

	// #533/#883: a shared `.pi-lens.json` typo must produce a signal, but the
	// file is ALSO the LSP loader's home, so foreign namespaces must stay
	// silent, and a user-level-only lens key gets a distinct scope signal.
	describe("unknown-key warnings (#533)", () => {
		function warnedFor(substring: string): boolean {
			return (console.error as ReturnType<typeof vi.fn>).mock.calls
				.flat()
				.some((arg) => typeof arg === "string" && arg.includes(substring));
		}

		function noticeFor(substring: string): string | undefined {
			return (console.error as ReturnType<typeof vi.fn>).mock.calls
				.flat()
				.find(
					(arg): arg is string =>
						typeof arg === "string" && arg.includes(substring),
				);
		}

		it("warns on a typo'd top-level key", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ maxProjectFile: 5000, lps: { enabled: false } }),
			);
			loadPiLensProjectConfig(tmpDir);
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining('unknown key "maxProjectFile"'),
			);
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining('unknown key "lps"'),
			);
		});

		it("does NOT warn on the `lsp` namespace or $schema", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					$schema: "https://example.com/pi-lens.json",
					// The CANONICAL spelling since #2426: `lsp` is a namespace inside
					// `.pi-lens.json`, read by the LSP loader out of the same file.
					lsp: {
						servers: { foo: { name: "foo" } },
						serverOverrides: { rust: {} },
						disabledServers: ["go"],
						warmFiles: ["src/main.ts"],
					},
					// Legitimate project keys alongside them.
					ignore: ["dist/**"],
					format: { enabled: false },
				}),
			);
			loadPiLensProjectConfig(tmpDir);
			expect(console.error).not.toHaveBeenCalled();
		});

		it("correctly LABELS a legacy root LSP key's migration notice, even reported alone (#2426)", () => {
			// The four legacy root keys are still honored for their deprecation
			// window (`DEPRECATED_CONFIG_SURFACES`), so this is not an "unknown key"
			// and not an "ignoring invalid" — the setting APPLIES.
			//
			// WHO announces it changed AGAIN in review round 3 (F1): the subsystem a
			// record reports under is now derived from the record itself
			// (`configRecordOwner` + tier), not from which loader is calling. This
			// loader reports EVERY record its own resolution of this file produced —
			// no filtering — so it DOES emit these four notices when called alone
			// (this test never calls `loadLSPConfig`). They are still correctly
			// LABELLED "deprecated LSP config key", because the subsystem comes from
			// the record's own `lsp.*` ownership, not from the fact that the project
			// loader happens to be the one reporting it. Calling the LSP loader too
			// (`config-notice-ownership.test.ts`) reports the SAME records, and the
			// warn-once latch (keyed on subsystem, not caller) collapses the two
			// calls into the one notice per key that a user should see.
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					servers: { foo: { name: "foo" } },
					serverOverrides: { rust: {} },
					disabledServers: ["go"],
					warmFiles: ["src/main.ts"],
					ignore: ["dist/**"],
				}),
			);
			loadPiLensProjectConfig(tmpDir);
			for (const key of [
				"servers",
				"serverOverrides",
				"disabledServers",
				"warmFiles",
			]) {
				// Not a typo report.
				expect(warnedFor(`unknown key "${key}"`), key).toBe(false);
				// Reported, and labelled as the LSP loader's own notice — never as a
				// project-config notice.
				expect(warnedFor(`move "${key}" to "lsp.${key}"`), key).toBe(true);
				expect(warnedFor(`deprecated LSP config key`), key).toBe(true);
			}
			// The whole-file "ignoring invalid" prose must NOT appear: nothing was
			// ignored.
			expect(warnedFor("ignoring invalid")).toBe(false);
			// No PROJECT-labelled notice for any of the four LSP keys — `ignore` is
			// canonical here and produces no record at all.
			expect(warnedFor("deprecated project config")).toBe(false);
		});

		it("does NOT warn on the pi-lens-native `trivy` key (read via .raw)", () => {
			// `trivy.enabled`/`trivy.minSeverity` are read off PiLensProjectConfig.raw
			// by trivy-client.ts — a legitimate opt-in, must not look like a typo.
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ trivy: { enabled: true, minSeverity: "HIGH" } }),
			);
			loadPiLensProjectConfig(tmpDir);
			expect(console.error).not.toHaveBeenCalled();
		});

		it("signals that a global-only lens key is not honored at project scope", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					delta: { enabled: false },
					tests: { enabled: false },
					dispatch: { runnerTimeoutFloorMs: 180_000 },
					widget: { visible: false },
				}),
			);
			loadPiLensProjectConfig(tmpDir);
			expect(warnedFor("not honored in a project")).toBe(true);
			expect(warnedFor('"delta"')).toBe(true);
			expect(warnedFor('"tests"')).toBe(true);
			// `dispatch` is mixed-scope now (`dispatch.disabledRunners` is honored
			// at project scope), so the notice names the dotted global-only key.
			expect(warnedFor('"dispatch.runnerTimeoutFloorMs"')).toBe(true);
			expect(warnedFor('"widget"')).toBe(true);
			const deltaNotice = noticeFor('"delta" is a global-only');
			const testsNotice = noticeFor('"tests" is a global-only');
			const dispatchNotice = noticeFor(
				'"dispatch.runnerTimeoutFloorMs" is a global-only',
			);
			const widgetNotice = noticeFor('"widget" is a global-only');
			expect(deltaNotice).toBeDefined();
			expect(testsNotice).toBeDefined();
			expect(dispatchNotice).toBeDefined();
			expect(widgetNotice).toBeDefined();
			expect(deltaNotice).toContain("pass the matching CLI flag");
			expect(testsNotice).toContain("pass the matching CLI flag");
			expect(dispatchNotice).not.toContain("pass the matching CLI flag");
			expect(widgetNotice).not.toContain("pass the matching CLI flag");
			// It is NOT reported as a typo — it is a real key, wrong scope.
			expect(warnedFor('unknown key "delta"')).toBe(false);
		});

		it("does NOT call `lsp` a global-only key any more (#2426)", () => {
			// `lsp` used to be global-only at project scope, because the LSP loader
			// read its settings from the ROOT of `.pi-lens.json`. Since #2426 `lsp`
			// IS the project-scoped namespace those settings live in, so telling a
			// user their `lsp` section does nothing here would be false.
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ lsp: { disabledServers: ["go"] } }),
			);
			loadPiLensProjectConfig(tmpDir);
			expect(warnedFor('"lsp" is a global-only')).toBe(false);
			expect(warnedFor('unknown key "lsp"')).toBe(false);
		});

		it("still says a GLOBAL-scope flag under `lsp` does nothing here (#2426 R2/F3)", () => {
			// Tolerating the whole `lsp` namespace swallowed `lsp.enabled`, which is
			// a `scope: "global"` flag (`--no-lsp`): a user who wrote it in a project
			// file used to get the honest global-only notice and, after #2426's first
			// round, got silence — while `docs/configuration.md` promises nothing is
			// ignored silently. The namespace is tolerated KEY BY KEY: the four LSP
			// settings a project file may carry pass, anything else is scanned by the
			// same rules as a top-level key.
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					lsp: {
						enabled: false,
						disabledServers: ["go"],
						servers: {},
						serverOverrides: {},
						warmFiles: [],
					},
				}),
			);
			loadPiLensProjectConfig(tmpDir);
			expect(warnedFor("not honored in a project")).toBe(true);
			expect(warnedFor('"lsp.enabled"')).toBe(true);
			expect(warnedFor('"lsp.enabled" is a global-only')).toBe(true);
			expect(warnedFor("pass the matching CLI flag")).toBe(true);
			// The four honored LSP settings stay silent — they are read from this
			// very file by the LSP loader.
			for (const key of [
				"disabledServers",
				"servers",
				"serverOverrides",
				"warmFiles",
			]) {
				expect(warnedFor(`"lsp.${key}"`), key).toBe(false);
			}
			// And it is a scope signal, not a typo report.
			expect(warnedFor('unknown key "lsp.enabled"')).toBe(false);
		});

		it("reports an unrecognized sub-key of `lsp` as a typo (#2426 R2/F3)", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ lsp: { disabledServer: ["go"] } }),
			);
			loadPiLensProjectConfig(tmpDir);
			expect(warnedFor('unknown key "lsp.disabledServer"')).toBe(true);
		});

		it("warns once for the same typo across re-parses (warn-once dedup)", async () => {
			const p = path.join(tmpDir, ".pi-lens.json");
			fs.writeFileSync(p, JSON.stringify({ maxProjectFile: 5000 }));
			loadPiLensProjectConfig(tmpDir);
			// Force a re-parse (new mtime) WITHOUT clearing the warn-once cache.
			await new Promise((r) => setTimeout(r, 20));
			fs.writeFileSync(p, JSON.stringify({ maxProjectFile: 5000, ignore: [] }));
			loadPiLensProjectConfig(tmpDir);
			const typoWarns = (console.error as ReturnType<typeof vi.fn>).mock.calls
				.flat()
				.filter(
					(arg) =>
						typeof arg === "string" &&
						arg.includes('unknown key "maxProjectFile"'),
				);
			expect(typoWarns.length).toBe(1);
		});
	});

	// `rules.<id>.disable` / `rules.<id>.select` are the project-level rule
	// policy — output-only filtering applied by the dispatcher and the
	// `lens_diagnostics` tool. Disable wins over select (explicit exclusion
	// trumps explicit inclusion). The matcher normalizes rule ids so an entry
	// listed as `no-eval` covers `ast-grep:no-eval` and `no-eval-js` (the same
	// normalization the inline suppression parser already uses).
	describe("rules.<id>.disable / rules.<id>.select", () => {
		it("parses a disable list alongside a threshold", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: {
						"high-complexity": {
							threshold: 25,
							disable: ["no-eval", "no-debugger"],
						},
					},
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]).toEqual({
				threshold: 25,
				disable: ["no-eval", "no-debugger"],
			});
		});

		it("parses a select list without any threshold", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: {
						"high-complexity": { select: ["no-eval", "no-debugger"] },
					},
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]).toEqual({
				select: ["no-eval", "no-debugger"],
			});
		});

		it("accepts a policy-only entry (no threshold, only disable/select)", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: {
						"unused-var": { disable: ["no-unused-vars"] },
					},
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["unused-var"]).toEqual({
				disable: ["no-unused-vars"],
			});
		});

		it("filters non-string entries out of disable/select lists", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: {
						"high-complexity": {
							disable: ["no-eval", 42, null, "no-debugger", { x: 1 }],
						},
					},
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]?.disable).toEqual([
				"no-eval",
				"no-debugger",
			]);
		});

		it("trims whitespace around list entries", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: {
						"high-complexity": { disable: ["  no-eval  ", " no-debugger"] },
					},
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]?.disable).toEqual([
				"no-eval",
				"no-debugger",
			]);
		});

		it("warns when the lists are written directly under rules (#444's own example)", () => {
			// `{"rules": {"disable": [...]}}` is the shape the issue proposed and
			// the most likely thing a user tries. It parses as valid JSON and has
			// zero effect, so it has to say so rather than fail silent.
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ rules: { disable: ["no-eval"] } }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules.disable).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining(
					"rules.disable must be an object with threshold, disable, or select",
				),
			);
		});

		it("warns on a rule entry whose only key is unrecognized (e.g. #444's `only`)", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ rules: { "no-eval": { only: ["no-eval"] } } }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["no-eval"]).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining(
					"rules.no-eval has no recognized setting (threshold, disable, select)",
				),
			);
		});

		it("does not warn twice when a recognized field was merely malformed", () => {
			// `disable` already warned about its own shape — adding a second
			// "no recognized setting" line for the same entry would be noise.
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ rules: { "no-eval": { disable: "no-eval" } } }),
			);
			loadPiLensProjectConfig(tmpDir);
			expect(console.error).not.toHaveBeenCalledWith(
				expect.stringContaining("has no recognized setting"),
			);
		});

		it("warns once and drops a non-array disable", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: { "high-complexity": { disable: "no-eval" } },
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]?.disable).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining(
					"rules.high-complexity.disable must be an array of strings",
				),
			);
		});

		it("warns once and drops a non-array select", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: { "high-complexity": { select: { id: "no-eval" } } },
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]?.select).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining(
					"rules.high-complexity.select must be an array of strings",
				),
			);
		});

		it("treats an explicitly empty disable list as a silent no-op (#1087)", () => {
			// #1087 P3-7: `"disable": []` is well-formed — an intentional empty
			// list — not an error. It must NOT warn (the old code did), and the
			// pointless entry is dropped rather than stored.
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: { "high-complexity": { disable: [] } },
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]).toBeUndefined();
			expect(console.error).not.toHaveBeenCalled();
		});

		it("warns once and drops a non-empty select list with no usable strings", () => {
			// A NON-empty array whose entries are all blank/non-string is a real
			// authoring mistake and must still warn (distinct from `[]` above).
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: { "high-complexity": { select: [42, null, true] } },
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]?.select).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining(
					"rules.high-complexity.select must contain at least one non-empty string",
				),
			);
		});

		it("preserves threshold when an invalid disable value is dropped", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: { "high-complexity": { threshold: 25, disable: "bad" } },
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]?.threshold).toBe(25);
			expect(cfg.rules["high-complexity"]?.disable).toBeUndefined();
		});

		it("preserves both disable and select when both are valid", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: {
						"high-complexity": {
							disable: ["no-eval"],
							select: ["no-debugger"],
						},
					},
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]?.disable).toEqual(["no-eval"]);
			expect(cfg.rules["high-complexity"]?.select).toEqual(["no-debugger"]);
		});

		it("does not warn on a forward-compat entry with no recognized fields", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: {
						"future-rule": { unrelated: true },
					},
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			// No recognized fields → entry not stored (forward-compat). No
			// warning emitted either, since unrecognized keys are silently
			// ignored for forward-compat rules per the existing describe block.
			expect(cfg.rules["future-rule"]).toBeUndefined();
		});
	});
});

describe("config cache freshness (#1105 mtime+size)", () => {
	// The config cache gates reuse on mtime alone before #1105; an in-place edit
	// that PRESERVES mtime (git checkout timestamp restoration, a same-second
	// rewrite) but changes the file's byte length replayed a stale parsed config.
	// The fix adds `size` as the free second axis (the stat that yields mtime
	// already read it). Both writes below are pinned to the SAME fixed mtime, so
	// mtime is identical across the two loads and ONLY size differs — isolating
	// exactly the residual the second axis closes. FS-agnostic (no case/separator
	// assumptions), so it exercises the gate identically on Linux CI (#1024).
	it("re-parses an mtime-preserving, length-changing config edit", () => {
		const configPath = path.join(tmpDir, ".pi-lens.json");
		const pinned = new Date("2020-01-01T00:00:00.000Z");

		// First config — a longer ignore list (larger byte length).
		fs.writeFileSync(
			configPath,
			JSON.stringify({ ignore: ["alpha/**", "beta/**", "gamma/**"] }),
		);
		fs.utimesSync(configPath, pinned, pinned);
		const mtimeBefore = fs.statSync(configPath).mtimeMs;
		const first = loadPiLensProjectConfig(tmpDir);
		expect(first.ignore).toEqual(["alpha/**", "beta/**", "gamma/**"]);

		// Rewrite in place with a SHORTER config, then restore the SAME mtime so
		// the mtime-only gate would (wrongly) treat the cached entry as fresh.
		fs.writeFileSync(configPath, JSON.stringify({ ignore: ["alpha/**"] }));
		fs.utimesSync(configPath, pinned, pinned);
		// The gate is now isolated to the size axis: mtime is provably identical.
		expect(fs.statSync(configPath).mtimeMs).toBe(mtimeBefore);

		// Cache is intentionally NOT reset — this asserts the in-process gate, not
		// a cold read. Pre-#1105 (mtime-only) this returned the stale 3-entry list.
		const second = loadPiLensProjectConfig(tmpDir);
		expect(second.ignore).toEqual(["alpha/**"]);
	});
});

describe("the config-deprecated ledger row survives a warm cache across sessions (#2426 review round 3, F2)", () => {
	beforeEach(() => {
		resetDegradationLedger();
	});

	afterEach(() => {
		resetDegradationLedger();
	});

	function deprecatedCount(): number {
		return (
			getDegradationSummary().find(
				(entry) => entry.kind === "config-deprecated",
			)?.count ?? 0
		);
	}

	it("re-populates on a cache HIT, not just the session that first parsed the file", () => {
		fs.writeFileSync(
			path.join(tmpDir, "pi-lens.json"),
			JSON.stringify({ ignore: ["dist/**"] }),
		);

		// Session 1: cold cache — `parseConfigFile` runs, records the row.
		loadPiLensProjectConfig(tmpDir);
		expect(deprecatedCount(), "session 1").toBeGreaterThan(0);

		// A session boundary resets the ledger (mirrors `handleSessionStart`'s
		// `resetDegradationLedger()`) but NOT the project config cache — there is
		// no production caller of `resetProjectLensConfigCache`, so the cache
		// stays warm across sessions for the life of the process.
		resetDegradationLedger();
		expect(deprecatedCount(), "reset").toBe(0);

		// Session 2: same directory, same unchanged file on disk — a cache HIT.
		// Before the fix, `loadPiLensProjectConfig` returned the cached config
		// without re-running `parseConfigFile`, so nothing re-reported the
		// migration record and this session's row was silently absent.
		loadPiLensProjectConfig(tmpDir);
		expect(deprecatedCount(), "session 2, cache warm").toBeGreaterThan(0);
	});
});

describe("a global-only setting's notice names the file the resolver actually reads (#2426 review round 3, S1)", () => {
	const setConfigPath = useConfigPath();

	function warnedFor(substring: string): boolean {
		return (console.error as ReturnType<typeof vi.fn>).mock.calls
			.flat()
			.some((arg) => typeof arg === "string" && arg.includes(substring));
	}

	it.skipIf(fs.existsSync(path.join(os.homedir(), ".pi-lens", "config.json")))(
		"names the ~/.pi-lens/config.json default when PI_LENS_CONFIG_PATH is unset",
		() => {
			// Premise (the skip condition above): the maintainer's real home carries
			// no legacy config — a real one would win the grandfathering tier and
			// change the named file. The production resolution is
			// homedir-anchored: PI_LENS_HOME does not participate (the #2457
			// split-brain stays a separate issue), and vitest-setup neutralizes the
			// agent-dir env the resolution does read.
			setConfigPath(undefined);
			resetGlobalConfigLocationCache();
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ delta: { enabled: false } }),
			);
			loadPiLensProjectConfig(tmpDir);
			expect(warnedFor("set it in ~/.pi-lens/config.json")).toBe(true);
			resetGlobalConfigLocationCache();
		},
	);

	it("names the PI_LENS_CONFIG_PATH override, not the hardcoded ~/.pi-lens/config.json", () => {
		// Under the override the resolver reads THIS file for the global tier,
		// never `~/.pi-lens/config.json` — a hardcoded string in the notice would
		// tell the user to write a file the resolver does not read (#2426 review
		// round 3, S1; the sibling defect the F1 test in
		// `config-notice-ownership.test.ts` pins for the migration-notice path).
		const relocated = path.join(tmpDir, "elsewhere", "pi-lens-config.json");
		setConfigPath(relocated);

		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ delta: { enabled: false } }),
		);
		loadPiLensProjectConfig(tmpDir);

		// Never the stale hardcoded default...
		expect(warnedFor("~/.pi-lens/config.json")).toBe(false);
		// ...and it DOES name the override (the tail survives both the raw-path
		// and the home-relative "~" rendering, so this holds regardless of
		// whether `tmpDir` happens to sit under the real home directory).
		expect(warnedFor("pi-lens-config.json")).toBe(true);
		expect(warnedFor("elsewhere")).toBe(true);
	});
});

/**
 * #3112 — `tools.<name>.enabled` is documented as a PROJECT-scope setting
 * (`docs/settings.md`, `docs/globalconfig.md`) and is read out of the project
 * document by `resolveLensToolEnabled`, but the loader's scope scan derived its
 * accepted set from the flag registry alone. The only registry flag under
 * `tools` is the global `tools.lazy` (`--no-lazy-tools`), so the whole `tools`
 * section landed in `globalScopeOnlyKeys` and every project-scope per-tool
 * override was announced as `ignoring invalid project config … "tools" is a
 * global-only pi-lens setting … ignored` (`PILENS_CFG_0001`) — a warning that
 * told the user their honoured setting was being dropped.
 *
 * `tools` is a MIXED-SCOPE section: the per-tool leaves are project-owned and
 * validated by `readToolConfig` against `TOOL_REGISTRY`; `tools.lazy` is not.
 */
describe("project-scope tools.<name>.enabled (#3112)", () => {
	function warnedFor(substring: string): boolean {
		return (console.error as ReturnType<typeof vi.fn>).mock.calls
			.flat()
			.some((arg) => typeof arg === "string" && arg.includes(substring));
	}

	function warnCountFor(substring: string): number {
		return (console.error as ReturnType<typeof vi.fn>).mock.calls
			.flat()
			.filter((arg) => typeof arg === "string" && arg.includes(substring))
			.length;
	}

	it("accepts a per-tool override with no ignored-config warning, and it takes effect", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ tools: { ast_grep_replace: { enabled: false } } }),
		);
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(warnedFor('"tools" is a global-only')).toBe(false);
		expect(warnedFor("ignoring invalid project config")).toBe(false);
		expect(console.error).not.toHaveBeenCalled();
		// Effective through the production resolver the pi and MCP hosts call.
		expect(resolveLensToolEnabled("ast_grep_replace", undefined, cfg.raw)).toBe(
			false,
		);
		expect(resolveLensToolEnabled("symbol_search", undefined, cfg.raw)).toBe(
			true,
		);
	});

	it("still says tools.lazy is global-only at project scope", () => {
		// The other half of a mixed-scope section: `tools.lazy` IS `scope:
		// "global"` (`--no-lazy-tools`), and `readToolConfig` skips it, so without
		// the sub-key scan a project file setting it would be ignored in silence —
		// the #2426 review-round-2 F3 defect (`lsp.enabled`) arriving through a
		// second namespace.
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ tools: { lazy: false } }),
		);
		loadPiLensProjectConfig(tmpDir);
		expect(warnedFor('"tools.lazy" is a global-only')).toBe(true);
		expect(warnedFor('unknown key "tools.lazy"')).toBe(false);
	});

	it("reports a MALFORMED global-only sub-key too — presence, not validity", () => {
		// `{"tools":{"lazy":"yes"}}` is a global-only setting written in a project
		// file exactly as `false` would be, and the user deserves the same notice.
		// Resolving the key by its VALUE (`readFlagConfigValue`, which returns
		// `undefined` for a non-boolean leaf) would drop this one in silence, so
		// the scan asks `hasFlagConfigPath` whether the key is PRESENT.
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ tools: { lazy: "yes" } }),
		);
		loadPiLensProjectConfig(tmpDir);
		expect(warnedFor('"tools.lazy" is a global-only')).toBe(true);
	});

	it("reports a global-only sub-key ONCE, however many scans see it", () => {
		// `lsp.enabled` is reported by the enumerated-honored-keys scan AND by the
		// mixed-scope scan, with the same key and the same reason; the warn-once
		// latch is what collapses them. This pins that: it is why the mixed-scope
		// loop needs no per-namespace skip, and it is the assertion that reds if a
		// future scan grows a second spelling for one setting.
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ lsp: { enabled: false, disabledServers: ["go"] } }),
		);
		loadPiLensProjectConfig(tmpDir);
		expect(warnCountFor('"lsp.enabled" is a global-only')).toBe(1);
	});

	// #3968 AC 4 — verify, don't fix: `tools.shellcheck.enabled` is spelled
	// against a RUNNER id, not a TOOL_REGISTRY tool, so `readToolConfig` must
	// keep emitting PILENS_CFG_0009 instead of silently no-op'ing. This pin
	// exists so a future change cannot widen `tools.*` to accept runner ids
	// without review — the knob would start reading like it works while
	// governing nothing.
	it("keeps refusing a runner id under tools.* — shellcheck is a runner, not a tool", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ tools: { shellcheck: { enabled: false } } }),
		);
		loadPiLensProjectConfig(tmpDir);
		expect(warnedFor("[PILENS_CFG_0009]")).toBe(true);
		expect(
			warnedFor('"tools.shellcheck.enabled" is not a recognized pi-lens tool'),
		).toBe(true);
		// The setting must not be accepted into tool state either way: no
		// `tools.shellcheck` entry exists to resolve.
	});
	it("leaves an unknown tool name to readToolConfig — one notice, not two", () => {
		// `readToolConfig` already reports an unrecognized tool name with its own
		// code (`PILENS_CFG_0009`). A second, generic "check for a typo" notice
		// from the scope scan for the same key is the duplicate-notice noise
		// #2426 review round 6 called out.
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ tools: { no_such_tool: { enabled: false } } }),
		);
		loadPiLensProjectConfig(tmpDir);
		expect(warnedFor("is not a recognized pi-lens tool")).toBe(true);
		expect(warnCountFor("no_such_tool")).toBe(1);
	});

	it("keeps warning about a genuinely global-only section", () => {
		// The scope table did not get looser: a section with no project-scoped
		// surface at all still reports itself.
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				tools: { ast_grep_replace: { enabled: false } },
				delta: { enabled: false },
			}),
		);
		loadPiLensProjectConfig(tmpDir);
		expect(warnedFor('"delta" is a global-only')).toBe(true);
		expect(warnedFor('"tools" is a global-only')).toBe(false);
		// Once, as the SECTION — the mixed-scope scan must not report
		// `delta.enabled` as a second notice for the same setting.
		expect(warnCountFor("delta")).toBe(1);
	});
});

describe("non-flag global-only key inside a mixed-scope section (#3131)", () => {
	function warnedFor(substring: string): boolean {
		return (console.error as ReturnType<typeof vi.fn>).mock.calls
			.flat()
			.some((arg) => typeof arg === "string" && arg.includes(substring));
	}

	function warnCountFor(substring: string): number {
		return (console.error as ReturnType<typeof vi.fn>).mock.calls
			.flat()
			.filter((arg) => typeof arg === "string" && arg.includes(substring))
			.length;
	}

	it("warns that actionableWarnings.autoFix.maxFixes is global-only, and drops the value", () => {
		// `actionableWarnings` is recognized at project scope only because its
		// SIBLING `autoFix.enabled` is a project-scoped flag — `maxFixes` is not a
		// `LENS_FLAGS` entry at all (no CLI flag, not boolean), documented global
		// (docs/settings.md), read only through
		// `getGlobalActionableWarningMaxFixes()`. Before #3131 it was parsed away
		// with no signal.
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				actionableWarnings: { autoFix: { enabled: true, maxFixes: 99 } },
			}),
		);
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(
			warnedFor('"actionableWarnings.autoFix.maxFixes" is a global-only'),
		).toBe(true);
		expect(
			warnedFor(
				'"actionableWarnings.autoFix.maxFixes" is a global-only pi-lens setting and is not honored in a project',
			),
		).toBe(true);
		expect(warnedFor("pass the matching CLI flag")).toBe(false);
		expect(warnCountFor("actionableWarnings.autoFix.maxFixes")).toBe(1);
		// The value never reaches the parsed project config — same non-goal #3126
		// left this key with: the notice is new, the scope is not.
		expect(
			(cfg.actionableWarnings?.autoFix as { maxFixes?: number } | undefined)
				?.maxFixes,
		).toBeUndefined();
		expect(cfg.actionableWarnings?.autoFix?.enabled).toBe(true);
	});

	it("control: the project-scoped sibling autoFix.enabled stays silent", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ actionableWarnings: { autoFix: { enabled: false } } }),
		);
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(warnedFor("global-only")).toBe(false);
		expect(console.error).not.toHaveBeenCalled();
		expect(cfg.actionableWarnings?.autoFix?.enabled).toBe(false);
	});

	it("does not duplicate the notice alongside a genuinely global-only sibling section", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				actionableWarnings: { autoFix: { enabled: true, maxFixes: 1 } },
				delta: { enabled: false },
			}),
		);
		loadPiLensProjectConfig(tmpDir);
		expect(warnCountFor("actionableWarnings.autoFix.maxFixes")).toBe(1);
		expect(warnCountFor('"delta" is a global-only')).toBe(1);
	});
});

describe("dispatch.disabledRunners at project scope", () => {
	function warnedFor(substring: string): boolean {
		return (console.error as ReturnType<typeof vi.fn>).mock.calls
			.flat()
			.some((arg) => typeof arg === "string" && arg.includes(substring));
	}

	it("is honored silently: no typo notice and no global-only notice", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ dispatch: { disabledRunners: ["dotnet-build"] } }),
		);
		loadPiLensProjectConfig(tmpDir);
		expect(warnedFor("global-only")).toBe(false);
		expect(warnedFor("unknown key")).toBe(false);
		expect(console.error).not.toHaveBeenCalled();
	});

	it("still tells the project that dispatch.runnerTimeoutFloorMs does nothing there", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				dispatch: {
					disabledRunners: ["dotnet-build"],
					runnerTimeoutFloorMs: 180_000,
				},
			}),
		);
		loadPiLensProjectConfig(tmpDir);
		expect(warnedFor('"dispatch.runnerTimeoutFloorMs" is a global-only')).toBe(
			true,
		);
		expect(warnedFor('"dispatch.disabledRunners"')).toBe(false);
	});

	it("reports a mistyped dispatch sub-key as a typo, not as global-only", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ dispatch: { disabledRunner: ["dotnet-build"] } }),
		);
		loadPiLensProjectConfig(tmpDir);
		expect(warnedFor('unknown key "dispatch.disabledRunner"')).toBe(true);
		expect(warnedFor("global-only")).toBe(false);
	});
});

// #5306: the explicit single-file diagnostics query's line limit is a USER
// resource policy. Recurrence it prevents: a repository's tracked
// `.pi-lens.json` raising how large a document the user's language server is
// fed (clangd +0.95 GB at 20k lines). The `lsp` namespace is project-recognized
// for the LSP loader's four keys, so without a registry row this key would be
// dropped as an unknown-key typo notice instead of the honest scope notice.
describe("lsp.queryMaxFileLines at project scope (#5306)", () => {
	function warnCount(substring: string): number {
		return (console.error as ReturnType<typeof vi.fn>).mock.calls
			.flat()
			.filter((arg) => typeof arg === "string" && arg.includes(substring))
			.length;
	}

	it("is ignored with one global-only warning per session, beside the honored lsp keys", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				lsp: { disabledServers: ["go"], queryMaxFileLines: 20000 },
			}),
		);

		const cfg = loadPiLensProjectConfig(tmpDir);
		// A changed file is re-parsed (the cache is keyed on its content), and the
		// same notice must not be raised a second time in the session.
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				ignore: ["dist/**"],
				lsp: { disabledServers: ["go"], queryMaxFileLines: 20000 },
			}),
		);
		loadPiLensProjectConfig(tmpDir);

		expect(warnCount('"lsp.queryMaxFileLines" is a global-only')).toBe(1);
		expect(warnCount('unknown key "lsp.queryMaxFileLines"')).toBe(0);
		expect(warnCount("lsp.disabledServers")).toBe(0);
		const { raw: _raw, configPath: _configPath, ...parsed } = cfg;
		expect(JSON.stringify(parsed)).not.toContain("queryMaxFileLines");
	});
});
