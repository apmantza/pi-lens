/**
 * #5348. Two things the nightly clean-signal probe must not do:
 *   - credit a fixture's row to a launch it did not run (the typescript7 rows
 *     ran the classic server), and
 *   - rewrite the tracked docs/lsp-capability-matrix.md from a bare run.
 * The row attribution is driven through the real `createProbeFixture`; the
 * matrix write gate is pinned on comment-blanked source because
 * scripts/probe-clean-signal.mjs executes on import and spawns servers.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	createProbeFixture,
	type ProbeRow,
} from "../../scripts/lib/probe-fixture.mjs";
import { LSP_FIXTURES } from "../../scripts/smoke-tools.mjs";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { stripSource } from "../support/sweep-kit.js";

describe("a probe row names the launch it measured (#5348)", () => {
	// Recurrence it prevents: scripts/probe-clean-signal.mjs never ran a
	// fixture's `setup` (`npm install typescript@7`), so the typescript7 and
	// typescript7-clean rows launched the CLASSIC typescript-language-server and
	// printed `mode=push-only`. The nightly then filed `silent-not-marked` for
	// "native TS7" from classic's data, and the comments credited native TS7 with
	// it. Native TS7 7.0.2 is a pull server. A row whose launch is not the one
	// the fixture expects is unattributable: it reads `unknown`, never a verdict.
	const typescript7 = LSP_FIXTURES.find((f) => f.lang === "typescript7");
	if (!typescript7) throw new Error("typescript7 fixture missing");
	const typescript = LSP_FIXTURES.find((f) => f.lang === "typescript");
	if (!typescript) throw new Error("typescript fixture missing");

	const measure = async (
		fx: (typeof LSP_FIXTURES)[number],
		snapshots: Array<{ serverId: string; launchVariant?: string }>,
		mode: string,
	) => {
		const dst = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-variant-row-"));
		try {
			const absFile = path.join(dst, fx.file);
			fs.writeFileSync(absFile, "export const x: number = 'a';\n");
			// The dirty touch publishes once (unversioned); the clean transition
			// publishes nothing. A row credited to the launch reads `silent`.
			let phase = 0;
			const drainPublishTrace = Object.assign(
				(sink: Array<Record<string, unknown>>) => {
					if (phase++ === 0)
						sink.push({ server: "typescript", diags: 1, versioned: false });
				},
				{ reset: () => undefined },
			);
			const probeFixture = createProbeFixture({
				lsp: makeLspServiceDouble({
					supportsLSP: () => true,
					touchFile: async () => ({ diags: [], inconclusive: false }),
					getWorkspaceDiagnosticsSupport: async () => ({ mode }),
					getCapabilitySnapshots: async () => snapshots,
				}) as never,
				repoRoot: process.cwd(),
				install: false,
				initLSPConfig: undefined,
				getServersForFileWithConfig: () => [{ id: "typescript" }],
				bootstrapFixtureWorkspace: async () => ({ absFile }),
				drainPublishTrace,
				pubLogSize: () => 0,
				sleep: async () => undefined,
			});
			const row: ProbeRow = {
				lang: fx.lang,
				behavior: "unknown",
				tier: 0,
				tierLabel: "",
				mode: "?",
				detail: "",
				firstPublish: "unknown",
				cleanFixture: Boolean(fx.clean),
			};
			await probeFixture(fx, dst, row);
			return row;
		} finally {
			fs.rmSync(dst, { recursive: true, force: true });
		}
	};

	it("reads a typescript7 row unknown when the classic launch answered it", async () => {
		const row = await measure(
			typescript7,
			[{ serverId: "typescript", launchVariant: "classic" }],
			"push-only",
		);
		expect(row.behavior).toBe("unknown");
		expect(row.mode).toBe("unknown");
		expect(row.tierLabel).toBe("");
		expect(row.detail).toContain("expected launchVariant 'native-ts7'");
		expect(row.detail).toContain("classic");
	});

	it("reads the row unknown when no snapshot names a launch (fail closed)", async () => {
		const row = await measure(typescript7, [], "push-only");
		expect(row.behavior).toBe("unknown");
		expect(row.detail).toContain("(no snapshot)");
	});

	it("reads the row unknown when the snapshot carries no launchVariant", async () => {
		const row = await measure(
			typescript7,
			[{ serverId: "typescript" }],
			"push-only",
		);
		expect(row.behavior).toBe("unknown");
		expect(row.detail).toContain("(unset)");
	});

	it("keeps the pull verdict for a native launch, so typescript7 reads n/a (pull)", async () => {
		const row = await measure(
			typescript7,
			[{ serverId: "typescript", launchVariant: "native-ts7" }],
			"pull",
		);
		expect(row.mode).toBe("pull");
		expect(row.behavior).toBe("n/a (pull)");
	});

	it("classifies a push-only native launch as before (the check refuses only a mismatch)", async () => {
		const row = await measure(
			typescript7,
			[{ serverId: "typescript", launchVariant: "native-ts7" }],
			"push-only",
		);
		expect(row.mode).toBe("push-only");
		expect(row.behavior).toBe("silent");
	});

	it("leaves a fixture with no expected launch variant to the trace (classic typescript)", async () => {
		const row = await measure(typescript, [], "push-only");
		expect(row.mode).toBe("push-only");
		expect(row.behavior).toBe("silent");
	});

	it("every fixture that installs typescript@7 declares the launch it expects", () => {
		// Recurrence: a new TS7 fixture added without `expectLaunchVariant` would
		// be probed as classic and filed as native.
		const installing = LSP_FIXTURES.filter((f) =>
			/typescript@7/.test(String(f.setup ?? "")),
		).map((f) => [f.lang, f.expectLaunchVariant]);
		expect(installing).toEqual([
			["typescript7", "native-ts7"],
			["typescript7-clean", "native-ts7"],
			["effect-tsgo", "effect-tsgo"],
		]);
	});
});

describe("the probe leaves the tracked matrix alone unless asked (#5348)", () => {
	// Recurrence it prevents: the first run of scripts/probe-clean-signal.mjs in
	// a checkout rewrote the tracked docs/lsp-capability-matrix.md (the measurement
	// lane had to `git checkout --` it). The write is now behind `--write-matrix`,
	// and the nightly must pass it, or the refresh PR would carry no matrix.
	// The flag is a string literal, so strings stay; comments are blanked, so a
	// comment quoting the gate cannot satisfy it.
	const source = stripSource(
		fs.readFileSync(
			path.join(process.cwd(), "scripts/probe-clean-signal.mjs"),
			"utf8",
		),
		{ strings: "keep" },
	);

	it("returns from updateMatrix before reading or writing the doc when the flag is absent", () => {
		expect(source).toContain(
			'const writeMatrix = argv.includes("--write-matrix");',
		);
		const body = source.slice(source.indexOf("function updateMatrix("));
		const gate = body.indexOf("if (!writeMatrix) {");
		expect(gate).toBeGreaterThan(-1);
		expect(body.slice(gate, body.indexOf("}", gate))).toMatch(/\breturn;/);
		expect(gate).toBeLessThan(body.indexOf("fs.readFileSync(docPath"));
		expect(gate).toBeLessThan(body.indexOf("fs.writeFileSync(docPath"));
	});

	it("keeps the nightly step on --write-matrix", () => {
		const workflow = yaml.load(
			fs.readFileSync(
				path.join(process.cwd(), ".github/workflows/tool-smoke.yml"),
				"utf8",
			),
		) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
		const probeRuns = workflow.jobs["tool-smoke"].steps
			.map((step) => step.run ?? "")
			.filter((run) => run.includes("probe-clean-signal.mjs"));
		expect(probeRuns).toHaveLength(1);
		expect(probeRuns[0]).toContain("--write-matrix");
	});
});
