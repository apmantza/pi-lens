// real-home: read-only RUSTUP_HOME probe (`~/.rustup`); the harness pins HOME per worker, and without the real toolchain home the rustup shim on PATH finds no toolchain, so the case skips on the one host that has rust-analyzer.
// flake-shape: real-process-spawn — a real rust-analyzer child is the observation; only its own `textDocument/references` answer shows whether the graph's symbol position finds a pub fn's consumers.
/**
 * #5559: the neighbour cascade's references leg must return the consumers of a
 * Rust `pub fn`.
 *
 * Recurrence this prevents: the review graph recorded a Rust symbol's column at
 * the declaration start (the `pub` keyword), the cascade asked the language
 * server there, and rust-analyzer 1.100.0 answered 0 references (6 at the
 * identifier), so public Rust symbols never produced neighbours. A double of
 * the server cannot show it: only a real rust-analyzer decides which positions
 * answer.
 *
 * Production chain: `buildOrUpdateGraph` over a Cargo workspace (the real
 * tree-sitter extractor and graph builder), the symbol node's recorded
 * position, and the real `LSPService.references` the cascade calls. The
 * position rule (`nameLine ?? line`, `nameColumn ?? column`) is restated here
 * from `clients/dispatch/integration.ts`; the cascade's own use of it is pinned
 * by `tests/clients/cascade-compute.test.ts`. This file does not drive
 * `computeCascadeForFile`.
 *
 * The control: the identifier position, computed from the source text (not from
 * the graph), is polled until rust-analyzer has loaded the workspace and
 * answers with the consumers. A graph position that then answers empty is the
 * defect, not a server that is still starting.
 *
 * Skipped, with a named reason, when `rust-analyzer` is not runnable (the unit
 * lanes install no Rust toolchain): it must answer `--version` on PATH.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { initLSPConfig } from "../../../clients/lsp/config.js";
import { getLSPService, resetLSPService } from "../../../clients/lsp/index.js";
import {
	adoptProjectTrustFromContext,
	resetProjectTrust,
} from "../../../clients/project-trust.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { buildOrUpdateGraph } from "../../../clients/review-graph/service.js";
import { REAL_HOME } from "../../support/vitest-setup.js";
import { withEnv } from "../../support/with-env.js";
import { pinFixtureHome, setupTestEnvironment } from "../test-utils.js";

const RUSTUP_HOME = process.env.RUSTUP_HOME ?? path.join(REAL_HOME, ".rustup");

function runnableRustAnalyzer(): string | undefined {
	const probe = spawnSync("rust-analyzer", ["--version"], {
		encoding: "utf8",
		env: { ...process.env, RUSTUP_HOME },
		timeout: 20_000,
	});
	return probe.status === 0 ? probe.stdout.trim() : undefined;
}

const VERSION = runnableRustAnalyzer();
const SKIP_REASON =
	VERSION === undefined ? "no runnable rust-analyzer on PATH" : "";

const API = [
	"pub fn alpha(x: i32) -> i32 {",
	"    x + 1",
	"}",
	"",
	"fn private_one() -> i32 {",
	"    2",
	"}",
	"",
	"pub fn use_private() -> i32 {",
	"    private_one()",
	"}",
	"",
].join("\n");

describe.skipIf(SKIP_REASON !== "")(
	`rust-analyzer finds a pub fn's consumers at the graph position (#5559)${SKIP_REASON ? ` [skipped: ${SKIP_REASON}]` : ""}`,
	() => {
		let env: ReturnType<typeof setupTestEnvironment>;
		let restoreHome: () => void = () => {};
		let restoreEnv: () => void = () => {};

		beforeAll(() => {
			env = setupTestEnvironment("pi-lens-ra-5559-");
			restoreHome = pinFixtureHome("ra-5559").restore;
			restoreEnv = withEnv({
				RUSTUP_HOME,
				CARGO_HOME: path.join(env.tmpDir, "cargo-home"),
				CARGO_TARGET_DIR: path.join(env.tmpDir, "target"),
				PI_LENS_TEST_MODE: "0",
				PI_LENS_DISABLE_TOOL_INSTALL: "1",
				PI_LENS_DISABLE_LSP_INSTALL: "1",
			});
			adoptProjectTrustFromContext({ isProjectTrusted: () => true });
		});

		afterAll(async () => {
			try {
				await getLSPService().shutdown({ fast: true, reason: "test" });
			} finally {
				resetLSPService();
				resetProjectTrust();
				restoreEnv();
				restoreHome();
				env.cleanup();
			}
		});

		it("returns both consumers at the position the review graph records for `pub fn alpha`", async () => {
			const root = env.tmpDir;
			const w = (rel: string, text: string) => {
				fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
				fs.writeFileSync(path.join(root, rel), text);
			};
			w(
				"Cargo.toml",
				'[package]\nname = "shapes"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n',
			);
			w("src/lib.rs", "pub mod api;\npub mod a;\npub mod b;\n");
			w("src/api.rs", API);
			w(
				"src/a.rs",
				"use crate::api::alpha;\n\npub fn run_a() -> i32 {\n    alpha(1)\n}\n",
			);
			w(
				"src/b.rs",
				"use crate::api::alpha;\n\npub fn run_b() -> i32 {\n    alpha(2) + alpha(3)\n}\n",
			);
			const api = path.join(root, "src", "api.rs");
			const aUri = pathToFileURL(path.join(root, "src", "a.rs")).href;
			const bUri = pathToFileURL(path.join(root, "src", "b.rs")).href;

			// The production graph builder, then the symbol node the cascade reads.
			const graph = await buildOrUpdateGraph(root, [api], new FactStore());
			const ids = graph.symbolNodesByFile.get(normalizeMapKey(api)) ?? [];
			const node = ids
				.map((id) => graph.nodes.get(id))
				.find((n) => n?.symbolName === "alpha");
			expect(node, "alpha is a graph symbol").toBeDefined();
			const line = Number(node?.metadata?.nameLine ?? node?.metadata?.line);
			const column = Number(
				node?.metadata?.nameColumn ?? node?.metadata?.column,
			);

			await initLSPConfig(root);
			const lsp = getLSPService();
			await lsp.touchFile(api, API, {
				diagnostics: "document",
				collectDiagnostics: true,
				clientScope: "primary",
				maxClientWaitMs: 60_000,
				maxDiagnosticsWaitMs: 3_000,
				source: "cascade-rust-references-5559",
			});

			// Control: the identifier, found in the source text. Waits for the
			// workspace to load; the answer must carry both consumers.
			const identifierCol = API.split("\n")[0].indexOf("alpha");
			const uris = async (l: number, c: number) =>
				(await lsp.references(api, l, c, false)).map((r) => r.uri);
			const deadline = Date.now() + 90_000;
			let control: string[] = [];
			while (Date.now() < deadline) {
				control = await uris(0, identifierCol).catch(() => [] as string[]);
				if (control.includes(aUri) && control.includes(bUri)) break;
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
			expect(control, "control: identifier position answers").toEqual(
				expect.arrayContaining([aUri, bUri]),
			);

			// The cascade's call, at the graph's position (`line - 1, column - 1`).
			const atGraphPosition = await uris(line - 1, column - 1);
			expect(
				atGraphPosition.map((u) => path.basename(fileURLToPath(u))).sort(),
				`graph position ${line}:${column}`,
			).toEqual(expect.arrayContaining(["a.rs", "b.rs"]));
		}, 180_000);
	},
);
