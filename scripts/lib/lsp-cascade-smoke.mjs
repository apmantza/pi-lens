/**
 * Live cascade cover for the four priority servers (#1712).
 *
 * The cascade (`computeCascadeForFile`) is the path an agent's write takes to
 * learn that it broke an importer. Every unit test drives a double of the
 * server; #4495/#4812 added a classic-tsserver live twin that CI skips. This
 * module owns the pure half of the nightly `--lsp-cascade` lane in
 * scripts/smoke-tools.mjs: the fixtures, the verdict on one cascade run, and
 * the telemetry row. The runner that spawns the servers is `runLspCascade`
 * there.
 *
 * A fixture is a 3-file project with a real import edge: an exporter, and two
 * importers that call it. The lane breaks the exporter's signature and asks
 * the production cascade about the importers. A neighbour is CONCLUSIVE when
 * the run observed it (`observedNeighborPaths`: clean or with findings) and
 * did not list it under `unconfirmed`. `expectFindings` pins that the verdict
 * is the right one: a server that concludes "clean" on a neighbour whose
 * import is now broken is the stale-importer defect (#4485) in its quiet form.
 */
import * as path from "node:path";

/** Default time, from the exporter's write, for every neighbour to conclude. */
export const CASCADE_CONCLUSIVE_DEADLINE_MS = 60_000;
/** Default time for a cold server to answer its first warm-up touch. */
export const CASCADE_WARM_DEADLINE_MS = 90_000;
/** Pause between cascade attempts that ended with a neighbour unconfirmed. */
export const CASCADE_RETRY_INTERVAL_MS = 2_000;
/**
 * Conclusive deadlines a fixture's rename phase spends beyond its edit cascade:
 * the restored exporter's importers returning to clean, then the importers
 * after the move (`runCascadeRename`). The lane's worst-case bound reads it.
 */
export const CASCADE_RENAME_EXTRA_DEADLINES = 2;

/**
 * The fixtures. `lang` names the LSP_FIXTURES row whose `tools`, `setup`,
 * `serverHint`, `expectLaunchVariant` and handshake-census entry this lane
 * reuses; `dir`, `file` (the exporter) and the rest are the cascade project.
 *
 * `symbol` is the exported function the edit breaks; each neighbour calls it.
 *
 * `provisionedBy: "<ENV>"` marks a server pi-lens cannot install itself
 * (jdtls has no managed installer, #3400): the workflow step provisions it and
 * hands the lane its path in that variable. The handshake census, which ran
 * without it, is not consulted: the variable set means the server MUST answer
 * (a miss is red), unset means it was not provisioned here (a warning).
 *
 * `rename: { to, staleSpecifier, expectFindings }` adds the rename phase
 * (#1677): see `classifyRenameImporter`.
 *
 * `expectDefect: { skipReason, reason }` declares a known defect of the cascade
 * for this fixture, with its cause. The row is then a `known-defect` (its own
 * state, never `skip`, which means "unavailable"), and only while the cascade
 * skips with exactly `skipReason` (a skip reason is set only on an
 * inconclusive run). Every other outcome is red, so the declaration covers the
 * one known shape and nothing else: an unconfirmed importer, another skip
 * reason, a wrong verdict, and a run that concluded (the defect is gone:
 * remove the declaration). Declared today: none; java's was removed once
 * a push-only server's pre-edit cached answer read unconfirmed and java joined
 * the cascade (#5040).
 */
export const CASCADE_FIXTURES = [
	{
		// typescript-go (native `tsc --lsp --stdio`, pull diagnostics).
		lang: "typescript7",
		dir: "tests/fixtures/lsp-cascade/typescript7",
		file: "src/a.ts",
		symbol: "foo",
		neighbours: ["src/b.ts", "src/c.ts"],
		edit: { from: "(x: number): number", to: "(x: string): string" },
		expectFindings: "is not assignable",
		// #1677 path, live: after the edit cascade the lane restores the exporter,
		// moves it through `LSPService.renameFile` (the rename tool's service call)
		// and asks the importers again. `staleSpecifier` is what an importer spells
		// while the server offered no `willRenameFiles` edit for it; such an
		// importer must then report `expectFindings`, and a rewritten one must be
		// clean.
		rename: {
			to: "src/renamed.ts",
			staleSpecifier: '"./a"',
			expectFindings: "Cannot find module",
		},
	},
	{
		lang: "rust",
		dir: "tests/fixtures/lsp-cascade/rust",
		file: "src/a.rs",
		symbol: "foo",
		neighbours: ["src/b.rs", "src/c.rs"],
		edit: { from: "(x: i32) -> i32", to: "(x: &str) -> String" },
		expectFindings: "E0308|expected .* found",
	},
	{
		lang: "go",
		dir: "tests/fixtures/lsp-cascade/go",
		file: "lib/lib.go",
		symbol: "Foo",
		neighbours: ["app/app.go", "tool/tool.go"],
		edit: { from: "(x int) int", to: "(x string) string" },
		expectFindings: "cannot use",
	},
	{
		lang: "java",
		dir: "tests/fixtures/lsp-cascade/java",
		file: "src/lib/Lib.java",
		symbol: "foo",
		neighbours: ["src/app/B.java", "src/app/C.java"],
		edit: { from: "int foo(int x)", to: "String foo(String x)" },
		expectFindings: "not applicable|mismatch|cannot convert",
		warmDeadlineMs: 180_000,
		provisionedBy: "JDTLS_PATH",
	},
];

const posix = (p) => p.split(path.sep).join("/");

/**
 * The verdict for one neighbour of one cascade run: `unconfirmed` (the server
 * asked gave no answer within the run's bound, or the run never reached it),
 * `findings` (observed, and the cascade output carries a diagnostics block for
 * it) or `clean` (observed, no block).
 *
 * `workspace` and `rel` are matched through `path.resolve`, because the run
 * names paths in the host's normalised form.
 */
export function neighbourVerdict(run, workspace, rel) {
	const abs = path.resolve(workspace, rel);
	const same = (p) => path.resolve(p) === abs;
	if ((run?.unconfirmed?.servers ?? []).some((s) => s.paths.some(same)))
		return "unconfirmed";
	if (!(run?.observedNeighborPaths ?? []).some(same)) return "unconfirmed";
	const formatted = run?.result?.formatted ?? "";
	return formatted.includes(`<diagnostics file="${posix(rel)}"`)
		? "findings"
		: "clean";
}

/**
 * Does the cascade output carry the expected finding text inside the
 * neighbour's own diagnostics block (the block header ends at `>`, then the
 * first lines are the server's message).
 */
export function neighbourShowsFinding(run, rel, pattern) {
	const block = new RegExp(
		`<diagnostics file="${posix(rel).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>\\n[^<]*(?:${pattern})`,
		"i",
	);
	return block.test(run?.result?.formatted ?? "");
}

/**
 * Classify one cascade run against a fixture.
 *
 * - `conclusive`: every neighbour observed, none unconfirmed, and (when the
 *   fixture declares `expectFindings`) each shows the expected finding.
 * - `wrong-verdict`: every neighbour concluded but one does not show the
 *   expected finding: the server answered, and answered stale.
 * - `inconclusive`: a neighbour is unconfirmed, or the run carries a skip
 *   reason that means the cascade never asked.
 */
export function classifyCascadeRun(run, fx, workspace) {
	const neighbours = Object.fromEntries(
		fx.neighbours.map((rel) => [rel, neighbourVerdict(run, workspace, rel)]),
	);
	const unasked = [
		"blockers",
		"non_code",
		"no_neighbors",
		"indeterminate",
		"error",
	];
	if (unasked.includes(run?.skipReason)) {
		return {
			state: "inconclusive",
			neighbours,
			skipReason: run.skipReason,
			detail: `cascade skipped: ${run.skipReason}`,
		};
	}
	const open = fx.neighbours.filter((rel) => neighbours[rel] === "unconfirmed");
	if (open.length > 0) {
		return {
			state: "inconclusive",
			neighbours,
			detail: `${open.join(", ")} unconfirmed`,
		};
	}
	if (fx.expectFindings) {
		const stale = fx.neighbours.filter(
			(rel) => !neighbourShowsFinding(run, rel, fx.expectFindings),
		);
		if (stale.length > 0) {
			return {
				state: "wrong-verdict",
				neighbours,
				detail: `${stale.join(", ")} concluded without a /${fx.expectFindings}/ finding (importer of a broken export read ${stale.map((rel) => neighbours[rel]).join(", ")})`,
			};
		}
	}
	return {
		state: "conclusive",
		neighbours,
		detail: "all neighbours concluded",
	};
}

/**
 * Why the last warm-up touch of `file` got no answer, read from the latency
 * log's own phases (`lsp_client_selected`, `lsp_touch_file`): a red that says
 * only "never answered" sends the next reader to a runner log it no longer has.
 * `extensionLogText` adds the launcher's own spawn-failure classification.
 * Returns an empty string when the logs hold nothing for the file.
 */
export function describeLastTouch(latencyLogText, file, extensionLogText = "") {
	const rows = [];
	for (const line of String(latencyLogText).split("\n").slice(-6000)) {
		try {
			const row = JSON.parse(line);
			if (row?.filePath === file) rows.push(row);
		} catch {
			// A partial or non-JSON line says nothing about this file.
		}
	}
	const last = (phase) => rows.filter((r) => r.phase === phase).at(-1);
	const parts = [];
	const selected = last("lsp_client_selected")?.metadata;
	if (selected) parts.push(`client ${selected.serverId}: ${selected.outcome}`);
	const touch = last("lsp_touch_file")?.metadata;
	if (touch?.failureKind) parts.push(`touch ${touch.failureKind}`);
	// The launcher's own classification (extension.log), for a server whose
	// process never started: `kind` says why (tool-not-found, exit, timeout).
	let spawn;
	for (const line of String(extensionLogText).split("\n").slice(-6000)) {
		try {
			const row = JSON.parse(line);
			const meta = row?.metadata;
			if (
				row?.message === "spawn failure classified" &&
				typeof meta?.cwd === "string" &&
				file.startsWith(meta.cwd)
			)
				spawn = meta;
		} catch {
			// A partial or non-JSON line says nothing about this file.
		}
	}
	if (spawn)
		parts.push(`spawn ${spawn.kind} (${path.basename(String(spawn.command))})`);
	return parts.join("; ");
}

/**
 * The verdict on one importer after the exporter was renamed (#1677).
 *
 * `content` is the importer as it is on disk now; `messages` are the server's
 * diagnostic messages for it, or `undefined` when the server gave no answer.
 *
 * - `unconfirmed`: no answer.
 * - `concluded`: the server's picture matches the file. An importer that still
 *   spells `staleSpecifier` (no `willRenameFiles` edit rewrote it) must report
 *   `expectFindings`; one the server's edit rewrote must report nothing.
 * - `stale-clean`: the importer still names the moved module and the server
 *   says it is clean: the server never learned the file moved (the stale
 *   importer defect, #4485's quiet form).
 * - `wrong-finding`: any other disagreement, such as a rewritten importer that
 *   still reports an error or a stale one with an unrelated message.
 */
export function classifyRenameImporter(rename, { content, messages }) {
	if (messages === undefined) return "unconfirmed";
	if (content.includes(rename.staleSpecifier)) {
		if (messages.length === 0) return "stale-clean";
		return messages.some((m) => new RegExp(rename.expectFindings, "i").test(m))
			? "concluded"
			: "wrong-finding";
	}
	return messages.length === 0 ? "concluded" : "wrong-finding";
}

/**
 * The lane row from the measurements of one fixture.
 *
 * `answered` is false when the warm-up never got an answer from the server;
 * `handshook` is the handshake-census verdict for the same server (`true`
 * pass, `false` anything else, `undefined` no census). A server that handshook
 * and then never answered is a regression (fail); one that never handshook,
 * or with no census to say, is unavailable on this runner (skip).
 */
export function cascadeRow(fx, m) {
	const base = {
		lang: fx.lang,
		runner: fx.serverHint ?? fx.lang,
		diags: Object.values(m.neighbours ?? {}).filter((v) => v === "findings")
			.length,
	};
	if (!m.answered) {
		return m.handshook === true
			? {
					...base,
					state: "fail",
					detail: `expected to answer (handshake passed or provisioned here) but never answered a touch in ${m.warmMs} ms${m.why ? ` (${m.why})` : ""}`,
				}
			: {
					...base,
					state: "skip",
					detail: `${base.runner} unavailable (no answer in ${m.warmMs} ms${m.handshook === false ? "; not provisioned, or the handshake did not complete" : ""})`,
				};
	}
	const defect = fx.expectDefect;
	if (defect && m.concluded?.state === "conclusive")
		// A declaration cannot outlive the defect it records: the cascade that
		// concludes is the cue to remove it.
		return {
			...base,
			state: "fail",
			detail: `declared known defect (${defect.reason}) but concluded in ${m.timeToConclusiveMs} ms: remove the declaration`,
		};
	if (m.concluded?.state === "conclusive") {
		const cascade = `neighbours concluded in ${m.timeToConclusiveMs} ms (attempt ${m.attempts}; first cascade ${m.firstCascadeMs} ms)`;
		if (!fx.rename) return { ...base, state: "pass", detail: cascade };
		// A rename that did not run, or whose importers never reached the right
		// verdict, is the stale-importer defect after a file move: red, with the
		// edit cascade's own time kept in the detail.
		if (m.rename?.state !== "concluded")
			return {
				...base,
				state: "fail",
				detail: `${cascade}; rename: ${m.rename?.detail ?? "not run"}`,
			};
		return {
			...base,
			state: "pass",
			detail: `${cascade}; rename: ${m.rename.detail}`,
		};
	}
	const why = `${m.concluded?.detail ?? "no cascade ran"} after ${m.attempts} attempt(s), ${m.elapsedMs} ms`;
	if (defect && m.concluded?.skipReason === defect.skipReason)
		// The declared shape and nothing else. It is a row of its own, not a
		// `skip` (unavailable): the durable record names the cause.
		return {
			...base,
			state: "known-defect",
			detail: `known defect (${defect.reason}): ${why}`,
		};
	return { ...base, state: "fail", detail: why };
}

/** The telemetry record the lane writes with `--times-out`. */
export function cascadeTimesRecord(rows, measurements, env = process.env) {
	return {
		schema: 1,
		command:
			"node scripts/smoke-tools.mjs --lsp-cascade --install --times-out=<file>",
		date: new Date().toISOString().slice(0, 10),
		runner: {
			os: process.platform,
			arch: process.arch,
			node: process.version,
			ci: env.GITHUB_ACTIONS === "true",
			runId: env.GITHUB_RUN_ID ?? null,
			image: env.ImageVersion ?? null,
		},
		rows: rows.map((row) => {
			const m = measurements[row.lang] ?? {};
			return {
				lang: row.lang,
				server: row.runner,
				state: row.state,
				// A known-defect row keeps its cause: `state` alone cannot say why.
				...(row.state === "known-defect" && { detail: row.detail }),
				warmMs: m.warmMs ?? null,
				firstCascadeMs: m.firstCascadeMs ?? null,
				timeToConclusiveMs:
					m.concluded?.state === "conclusive" ? m.timeToConclusiveMs : null,
				attempts: m.attempts ?? null,
				neighbours: m.neighbours ?? null,
				// Only a fixture with a rename phase carries these keys.
				...(m.rename && {
					rename: {
						state: m.rename.state,
						renameMs: m.rename.renameMs ?? null,
						importersRewritten: m.rename.importersRewritten ?? null,
						timeToConclusiveMs:
							m.rename.state === "concluded"
								? m.rename.timeToConclusiveMs
								: null,
						importers: m.rename.importers ?? null,
					},
				}),
			};
		}),
	};
}
