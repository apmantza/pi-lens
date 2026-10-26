// flake-shape: real-process-spawn — the fixture's build server is a real child
// process, and the BSP framing over its stdio is what sourcekit-lsp's client
// speaks; an in-process call cannot produce that protocol.
/**
 * #4880: the contract of `LSP_FIXTURES`' `swift-xcode` row and of the fixture
 * it drives (`tests/fixtures/tool-smoke/swift-xcode`).
 *
 * The row exists because every Swift fixture before it shipped a
 * `Package.swift`, so no layer drove a root chosen by another marker
 * sourcekit-lsp reads — and #4854 (an Xcode project rooted at each file's own
 * directory, so every cross-file symbol read as `Cannot find 'X' in scope`)
 * reached an external user. Three things have to stay true for the row to
 * keep measuring that:
 *
 * 1. The table entry asserts the ABSENCE of the cross-file diagnostic, not
 *    just the presence of the seeded gate error (which fires either way).
 * 2. The fixture is an Xcode layout: `buildServer.json` at its root, no
 *    `Package.swift` anywhere inside, and the gate marker in the file that
 *    USES the sibling's symbol, because that is the file the row touches.
 * 3. The project root resolves through that marker. Pre-#4857
 *    `SwiftServer.root` knew `Package.swift` only, so it answered `undefined`
 *    here and pi-lens fell back to the file's own directory; the case below
 *    reproduces both answers through the production root seam.
 *
 * The fixture ships its own build server (a stand-in for xcode-build-server,
 * which needs a real Xcode build): without one, a rooted client has no
 * compiler arguments for the module and the cross-file symbol cannot resolve
 * on any host. Its BSP answers are pinned below against the fixture's own two
 * files.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LSP_FIXTURES, type LspFixture } from "../../scripts/smoke-tools.mjs";
import { setupTestEnvironment } from "../clients/test-utils.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const FIXTURE_DIR = path.join("tests", "fixtures", "tool-smoke", "swift-xcode");
const FIXTURE = path.join(repoRoot, FIXTURE_DIR);
const USING_FILE = path.join("Sources", "App", "ContentView.swift");
const DECLARING_FILE = path.join("Sources", "App", "Greeting.swift");
const BSP_SERVER = "bsp-server.mjs";

const row = (LSP_FIXTURES as LspFixture[]).find(
	(fixture) => fixture.lang === "swift-xcode",
);

function readFixture(relative: string): string {
	return fs.readFileSync(path.join(FIXTURE, relative), "utf8");
}

function swiftFiles(dir: string): string[] {
	const found: string[] = [];
	const walk = (current: string) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".swift")) {
				found.push(path.relative(FIXTURE, full));
			}
		}
	};
	walk(path.join(dir === FIXTURE ? dir : path.join(FIXTURE, dir)));
	return found.sort();
}

/** A JSON-RPC frame in the `Content-Length` framing BSP uses over stdio. */
function frame(message: unknown): string {
	const json = JSON.stringify(message);
	return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

function parseFrames(stdout: Buffer): Array<Record<string, unknown>> {
	const messages: Array<Record<string, unknown>> = [];
	let buffer = stdout;
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd < 0) return messages;
		const header = buffer.subarray(0, headerEnd).toString("ascii");
		const length = /content-length:\s*(\d+)/i.exec(header);
		const start = headerEnd + 4;
		if (!length) {
			buffer = buffer.subarray(start);
			continue;
		}
		const size = Number(length[1]);
		if (buffer.length < start + size) return messages;
		messages.push(
			JSON.parse(buffer.subarray(start, start + size).toString("utf8")),
		);
		buffer = buffer.subarray(start + size);
	}
}

const optionsFor = (messages: Array<Record<string, unknown>>) =>
	messages.find((message) => message.id === 4)?.result as
		| { compilerArguments?: string[]; workingDirectory?: string }
		| undefined;

describe("swift-xcode smoke row (#4880)", () => {
	it("asserts the absence of the cross-file diagnostic, not only the gate error", () => {
		expect(row, "LSP_FIXTURES has no swift-xcode row").toBeDefined();
		expect(row?.dir).toBe(FIXTURE_DIR);
		expect(row?.file).toBe(USING_FILE);
		// Gate-eligible with a seeded error: the lsp_diagnostics layer proves the
		// primary answered, and the marker must be in the file the row touches.
		expect(row?.lspGate).toBe(true);
		expect(row?.lspGateExempt).toBeUndefined();
		expect(readFixture(USING_FILE)).toContain(row?.lspGateMarker);
		// The absence assertion: the exact diagnostic a wrong root produces.
		expect(row?.expectNoMessageMatch).toBeTruthy();
		const forbidden = new RegExp(row?.expectNoMessageMatch ?? "", "i");
		expect(forbidden.test("Cannot find 'Greeting' in scope")).toBe(true);
		// ...and it must NOT be satisfied by the seeded gate error alone.
		expect(
			forbidden.test(
				"cannot convert value of type 'String' to specified type 'Int'",
			),
		).toBe(false);
	});

	it("is an Xcode layout: buildServer.json, no Package.swift, one declaration and one use", () => {
		expect(fs.existsSync(path.join(FIXTURE, "buildServer.json"))).toBe(true);
		expect(
			fs.readdirSync(FIXTURE).includes("Package.swift"),
			"an Xcode project has no Package.swift: it would root the client through the SPM marker this row exists to avoid",
		).toBe(false);
		expect(
			swiftFiles("Sources"),
			"exactly one file declares the symbol and one uses it",
		).toEqual(
			[USING_FILE, DECLARING_FILE].map((file) => path.join(file)).sort(),
		);
		expect(readFixture(DECLARING_FILE)).toMatch(/struct\s+Greeting\b/);
		expect(readFixture(USING_FILE)).toMatch(/\bGreeting\.text\(\)/);
		// sourcekit-lsp launches `argv[0]` relative to the project root, and only
		// a `.py` entry gets an interpreter, so this script must be executable.
		const config = JSON.parse(readFixture("buildServer.json")) as {
			argv?: string[];
			languages?: string[];
			bspVersion?: string;
		};
		expect(config.languages).toContain("swift");
		expect(config.bspVersion).toBeTruthy();
		expect(config.argv?.[0]).toBe(BSP_SERVER);
		const server = path.join(FIXTURE, BSP_SERVER);
		expect(fs.existsSync(server)).toBe(true);
		if (process.platform !== "win32") {
			// git preserves the mode; a checkout that lost it breaks the launch.
			expect(
				fs.statSync(server).mode & 0o111,
				`${BSP_SERVER} must be executable`,
			).not.toBe(0);
		}
	});

	it("resolves the project root through buildServer.json, and the file's directory without it", async () => {
		const { SwiftServer } = await import("../../clients/lsp/server.js");
		// No planted root marker: the fixture's own buildServer.json must answer,
		// not an ancestor `.git` that would resolve the same directory for the
		// wrong reason (AGENTS.md shape 73).
		const { tmpDir } = setupTestEnvironment("pi-lens-swift-xcode-root-", {
			rootMarker: false,
		});
		fs.cpSync(FIXTURE, tmpDir, { recursive: true });
		const usingFile = path.join(tmpDir, USING_FILE);
		// The smoke harness registers the copied fixture as its session root, so
		// pi's cwd is that project while the file resolves.
		const cwd = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
		try {
			await expect(SwiftServer.root(usingFile)).resolves.toBe(tmpDir);
			// The pre-#4857 marker set: no marker under the project, so the root
			// seam answers undefined and pi-lens falls back to the file's own
			// directory — where sourcekit-lsp compiles the file alone.
			fs.rmSync(path.join(tmpDir, "buildServer.json"));
			await expect(SwiftServer.root(usingFile)).resolves.toBeUndefined();
		} finally {
			cwd.mockRestore();
		}
	});

	it("serves the module's compile arguments: both files, no build server otherwise", () => {
		const exchanged = [
			{
				jsonrpc: "2.0",
				id: 1,
				method: "build/initialize",
				params: { rootUri: `file://${FIXTURE}`, bspVersion: "2.0" },
			},
			{ jsonrpc: "2.0", id: 2, method: "workspace/buildTargets", params: {} },
			{
				jsonrpc: "2.0",
				id: 3,
				method: "buildTarget/sources",
				params: { targets: [{ uri: "bsp://swift-xcode" }] },
			},
			{
				jsonrpc: "2.0",
				id: 4,
				method: "textDocument/sourceKitOptions",
				params: {
					textDocument: { uri: `file://${path.join(FIXTURE, USING_FILE)}` },
				},
			},
			{ jsonrpc: "2.0", id: 5, method: "build/shutdown" },
			{ jsonrpc: "2.0", method: "build/exit" },
		];
		const child = spawnSync(
			process.execPath,
			[path.join(FIXTURE, BSP_SERVER)],
			{
				input: exchanged.map(frame).join(""),
				timeout: 30_000,
			},
		);
		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr?.toString()).toBe(0);
		const messages = parseFrames(child.stdout as Buffer);
		const initialize = messages.find((message) => message.id === 1)?.result as
			| {
					capabilities?: { languageIds?: string[] };
					data?: Record<string, unknown>;
			  }
			| undefined;
		expect(initialize?.capabilities?.languageIds).toContain("swift");
		// Pull-based settings: without this sourcekit-lsp never asks for arguments.
		expect(initialize?.data?.sourceKitOptionsProvider).toBe(true);
		const targets = messages.find((message) => message.id === 2)?.result as
			| { targets?: Array<{ languageIds?: string[] }> }
			| undefined;
		expect(targets?.targets?.[0]?.languageIds).toContain("swift");
		const sources = messages.find((message) => message.id === 3)?.result as
			| { items?: Array<{ sources?: Array<{ kind?: number }> }> }
			| undefined;
		// A directory source (kind 2) covers every module file, the way
		// xcode-build-server answers.
		expect(sources?.items?.[0]?.sources?.[0]?.kind).toBe(2);
		const options = optionsFor(messages);
		expect(options?.workingDirectory).toBe(FIXTURE);
		expect(options?.compilerArguments).toContain(
			path.join(FIXTURE, USING_FILE),
		);
		expect(
			options?.compilerArguments,
			"the sibling must be an input, or the cross-file symbol cannot resolve",
		).toContain(path.join(FIXTURE, DECLARING_FILE));
	});
});
