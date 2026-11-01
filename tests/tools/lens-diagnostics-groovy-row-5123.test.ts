/**
 * #5123: the built-in Groovy row (groovy-language-server) through the real
 * `lens_diagnostics source=lsp` route.
 *
 * The server publishes only for files with errors, and it recompiles an open
 * document from disk on pi-lens's own first-open watched-files notice and
 * publishes an empty set that erases the error it just sent (#5131). #5133 and
 * #5134 made a CUSTOM `lsp.servers` entry honest about both; the built-in row
 * takes other branches in each place (`entry.info.custom`, the echo hold's
 * `customServer` gate, the strategy table), so a Groovy row that only reused
 * the custom config would have read a broken file clean and a silent one
 * unsupported or clean.
 *
 * Recurrence this file prevents: the live #5123 reports. A `.groovy` file with
 * `unable to resolve class Foo` read `clean=1, findings=0` (the echo), and a
 * clean file read `unsupported`.
 *
 * Nothing is doubled below the language-server binary: a `groovy-language-server`
 * shim on PATH (the host boundary) launches `tests/fixtures/fake-lsp-server.mjs`
 * through the built-in row's production `spawn`; the real `LSPService`, client,
 * registry, tool and outcome tally run.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const env = setupTestEnvironment("pi-lens-5123-diag-");
const root = env.tmpDir;
const shimDir = path.join(root, "shim-bin");
const originalPath = process.env.PATH;

const BROKEN = "class A { Foo f }\n";
const CLEAN = "class B { }\n";
const ERROR_CODE = "P5131";

function writeShim(name: string): void {
	fs.mkdirSync(shimDir, { recursive: true });
	const shim = path.join(shimDir, name);
	fs.writeFileSync(
		shim,
		[
			"#!/usr/bin/env node",
			`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
			"",
		].join("\n"),
	);
	fs.chmodSync(shim, 0o755);
}

let counter = 0;
function workspace(): string {
	const dir = path.join(root, `ws-${counter++}`);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "build.gradle"), "// gradle\n");
	return dir;
}

function source(dir: string, name: string, body: string): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, body);
	return file;
}

type Outcome = { file: string; outcome: string };
type ToolResult = {
	content: { text?: string }[];
	details: { outcomes?: Outcome[]; outcomeCounts?: Record<string, number> };
};

async function probe(dir: string, files: string[]): Promise<ToolResult> {
	const config = await import("../../clients/lsp/config.js");
	await config.initLSPConfig(dir);
	const { createLensDiagnosticsTool } =
		await import("../../tools/lens-diagnostics.js");
	const lens = createLensDiagnosticsTool({} as never, () => dir);
	return (await lens.execute(
		"probe-5123",
		{
			source: "lsp",
			scope: "paths",
			paths: files,
			serverScope: "primary",
			waitMs: 3000,
		},
		undefined,
		null,
		{ cwd: dir },
	)) as unknown as ToolResult;
}

const outcomeOf = (result: ToolResult, file: string): string | undefined =>
	result.details.outcomes?.find(
		(entry) => path.resolve(entry.file) === path.resolve(file),
	)?.outcome;

afterEach(() => {
	vi.unstubAllEnvs();
});

/**
 * The fake server's behaviour for the next spawn, unstubbed after each case:
 * push-only, and publishing nothing unless it recompiles (`compileMs`).
 */
function serve(compileMs?: string): void {
	vi.stubEnv("FAKE_LSP_NO_DIAGNOSTIC_PROVIDER", "1");
	if (compileMs !== undefined)
		vi.stubEnv("FAKE_LSP_RECOMPILE_CLEARS_MS", compileMs);
}

describe("#5123 the built-in Groovy row through lens_diagnostics source=lsp", () => {
	let service: { shutdown: () => Promise<void> } | undefined;

	beforeAll(async () => {
		// Host-boundary stub: the row executes project code (Gradle import), so
		// it is admitted as a trusted project.
		setProjectTrustState("trusted");
		writeShim("groovy-language-server");
		process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ""}`;
		const lsp = await import("../../clients/lsp/index.js");
		service = lsp.getLSPService();
	});
	beforeEach(() => {
		resetDegradationLedger();
	});
	afterAll(async () => {
		resetProjectTrust();
		process.env.PATH = originalPath;
		await cleanupTestEnvironmentsDrained("pi-lens-5123-diag-", {
			beforeDrain: async () => {
				await service?.shutdown();
			},
		});
	});

	it("reports the error the server published before its own recompile clear", async () => {
		serve("200");
		const dir = workspace();
		const file = source(dir, "Broken.groovy", BROKEN);

		const result = await probe(dir, [file]);

		expect(outcomeOf(result, file)).toBe("findings");
		expect(result.content.map((part) => part.text).join("\n")).toContain(
			ERROR_CODE,
		);
		// Bounded observability: the held empty publish is one counted row.
		expect(
			getDegradationSummary().find(
				(group) => group.kind === "lsp-watched-echo-held",
			)?.count,
		).toBe(1);
	}, 30_000);

	it("reads a file the server never published for as inconclusive, never clean or unsupported", async () => {
		serve();
		const dir = workspace();
		const file = source(dir, "Quiet.groovy", CLEAN);

		const result = await probe(dir, [file]);

		expect(result.details.outcomeCounts).toMatchObject({
			clean: 0,
			findings: 0,
			unsupported: 0,
			inconclusive: 1,
		});
	}, 30_000);

	it.each([".gradle", ".dsl"])(
		"does not route a %s file to the row",
		async (ext) => {
			serve("0");
			const dir = workspace();
			const file = source(dir, `build${ext}`, BROKEN);

			const result = await probe(dir, [file]);

			expect(outcomeOf(result, file)).toBe("unsupported");
			expect(result.details.outcomeCounts?.findings ?? 0).toBe(0);
		},
		30_000,
	);
});
