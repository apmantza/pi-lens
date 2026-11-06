// The per-fixture measurement step of scripts/probe-clean-signal.mjs, lifted out
// of that script (which executes on import) so its row attribution can be
// driven with injected collaborators. #3665 recurrence: the call site that
// resolved `row.serverId` was only exercised by the nightly, so a revert to the
// primary-by-role expression stayed green in every unit test.
import * as fs from "node:fs";
import * as path from "node:path";
import {
	classifyCleanBehavior,
	classifyFirstPublish,
	COMPARABLE_FIRST_PUBLISH,
	resolveProbeServerId,
} from "./clean-signal.mjs";
import { isAuxiliary } from "../../dist/clients/lsp/server-traits.js";
import { touchAnsweredDiagnostics } from "./touch-result.mjs";

// Budgets (reuse the original probe's generosity — this is off the hot path).
const CLIENT_WAIT_MS = 30000; // cold spawn + initialize
const PROVE_LIVE_WAIT_MS = 8000; // first touch: cold analysis may be slow (match smoke-tools)
const STEP_WAIT_MS = 2500; // per-touch publish budget (matches the old probe)
const SETTLE_MS = 400; // let a late publish land + past the touch debounce

// A byte-changing, diagnostic-neutral edit: append a trailing comment line in the
// file's comment syntax (falls back to a blank line). Keeps the diagnostic SET
// unchanged so a re-publish is purely the server's clean-scan behavior. Shared
// with scripts/probe-save-verdict.mjs's `savedWrite` arm, which needs the same
// property for the same reason — one comment-syntax table, not a sibling.
export function commentFor(file) {
	const ext = path.extname(file).toLowerCase();
	if (
		[
			".py",
			".rb",
			".sh",
			".yaml",
			".yml",
			".toml",
			".tf",
			".ex",
			".exs",
			".nix",
			".ps1",
		].includes(ext)
	)
		return "#";
	if ([".lua", ".sql", ".hs"].includes(ext)) return "--";
	if ([".clj", ".ml", ".mli"].includes(ext)) return ";;"; // best-effort; ocaml uses (* *) but a trailing line is harmless bytes
	return "//"; // js/ts/go/rust/c/cpp/java/kotlin/php/dart/zig/vue/svelte/prisma…
}

/**
 * @param {object} deps the script's live collaborators: `lsp`, `repoRoot`,
 *   `install`, `ensureTool`, `initLSPConfig`, `getServersForFileWithConfig`,
 *   `bootstrapFixtureWorkspace`, `trustRefusal`, `drainPublishTrace`,
 *   `pubLogSize`, `sleep`.
 */
export function createProbeFixture(deps) {
	const {
		lsp,
		repoRoot,
		install,
		ensureTool,
		initLSPConfig,
		getServersForFileWithConfig,
		bootstrapFixtureWorkspace,
		trustRefusal,
		drainPublishTrace,
		pubLogSize,
		sleep,
	} = deps;
	return async function probeFixture(fx, dst, row) {
		// `dst` is pre-created by the caller (mkdtemp'd BEFORE `withTimeout` starts
		// the race, so its `finally` can always clean it up, even if bootstrapping
		// itself times out) — pass it straight through as `workspace`.
		const { absFile } = await bootstrapFixtureWorkspace(fx, {
			initLSPConfig,
			repoRoot,
			workspace: dst,
		});
		const servers = getServersForFileWithConfig(absFile);
		row.serverId = resolveProbeServerId(fx, servers);
		// #5348: the registry's own role decides, not the fixture's declaration; a
		// server it does not list as an auxiliary stays comparable (fail closed).
		row.auxiliary = servers.some(
			(server) => server.id === row.serverId && isAuxiliary(server),
		);
		if (install && ensureTool) {
			for (const t of fx.tools ?? [])
				await ensureTool(t).catch(() => undefined);
		}
		if (!lsp.supportsLSP(absFile)) {
			row.mode = "no-lsp";
			row.detail = "no LSP server registered for this file";
			return;
		}

		const auxIds = fx.auxiliaryServerIds ?? [];
		const useAux = auxIds.length > 0;
		const touchOptions = {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: useAux ? "with-auxiliary" : "primary",
			...(useAux ? { auxiliaryServerIds: auxIds } : {}),
			maxClientWaitMs: CLIENT_WAIT_MS,
			source: "clean-probe",
		};
		const touch = (content, diagWaitMs) =>
			lsp.touchFile(absFile, content, {
				...touchOptions,
				maxDiagnosticsWaitMs: diagWaitMs,
			});

		const dirtyContent = fs.readFileSync(absFile, "utf8");

		// PHASE-AWARE capture: one sink per phase, switched between touches (a
		// publish can land during touchFile, the settle window, or the capability
		// read, so the sink stays live across each phase's whole span):
		//   dirty phase — the first touch: cold spawn + initialize + first analysis
		//     (generous budget + settle, so a slow cold publish is both captured AND
		//     attributed to the dirty phase, not leaked into the next one);
		//   clean-transition phase — a byte-changing, diagnostic-neutral edit (the
		//     clean→clean analog): bytes differ so the file re-opens (the touch-notify
		//     debounce doesn't dedupe it) and the server re-scans, while the
		//     diagnostic SET is unchanged. Publish here (and whether it carries a
		//     version) is the discriminator.
		const dirtyPubs = [];
		const cleanPubs = [];
		let dirtyResult;
		let support;
		try {
			drainPublishTrace.reset(pubLogSize());
			dirtyResult = await touch(dirtyContent, PROVE_LIVE_WAIT_MS);
			await sleep(SETTLE_MS);
			support = await lsp.getWorkspaceDiagnosticsSupport(absFile);
			await sleep(SETTLE_MS);
			// Phase boundary: every publish written so far is the dirty touch's.
			// The trace is scoped to (server, THIS fixture's document) — several
			// live clients share a server id, and the sink's byte offset marks the
			// flush position, not the arrival position, so a foreign client's late
			// line can land inside this phase (#4615).
			drainPublishTrace(dirtyPubs, row.serverId, absFile);

			fs.writeFileSync(
				absFile,
				`${dirtyContent}\n${commentFor(fx.file)} clean-probe edit\n`,
			);
			await sleep(SETTLE_MS);
			await touch(fs.readFileSync(absFile, "utf8"), STEP_WAIT_MS);
			await sleep(SETTLE_MS);
		} finally {
			drainPublishTrace(cleanPubs, row.serverId, absFile);
		}

		row.mode = support?.mode ?? "unknown";
		if (row.mode === "pull") {
			row.behavior = "n/a (pull)";
			row.tier = 1;
			row.tierLabel = "1";
			row.detail = "pull-mode: authoritative clean via textDocument/diagnostic";
			return;
		}

		const obs = {
			dirtyPublishes: dirtyPubs.length,
			dirtyVersioned: dirtyPubs.filter((p) => p.versioned).length,
			cleanTransitionPublishes: cleanPubs.length,
			cleanTransitionVersioned: cleanPubs.filter((p) => p.versioned).length,
		};
		const dirtyDiagCount =
			touchAnsweredDiagnostics(dirtyResult, touchOptions, lsp)?.length ?? 0;
		const verdict = classifyCleanBehavior(obs);
		// #4514: a server trust kept from launching published nothing, which reads
		// exactly like a slow one. Name the refusal instead of "no publish
		// observed"; the row stays `unknown`, so the matrix merge never writes it.
		const refused =
			obs.dirtyPublishes === 0 && obs.cleanTransitionPublishes === 0
				? await trustRefusal?.()
				: undefined;
		if (refused) {
			if (row.mode === "unknown") row.mode = refused;
			row.detail = refused;
			return;
		}
		// #3310: the first-publish class comes from the dirty phase's publish ORDER,
		// which this trace already holds — no extra touch, no extra server time.
		const firstPublishVerdict = classifyFirstPublish(dirtyPubs);
		row.firstPublish = firstPublishVerdict.firstPublish;
		// #4615: a `clean: true` fixture's file carries no diagnostic, so ANY
		// comparable class from it is not a measurement of this axis — not only
		// `direct` (a finding-bearing publish) but equally `empty-first` (its own
		// empty publish, then a finding-bearing one): a clean file has no finding
		// to publish, so such a trace is another document's line, or the fixture's
		// `clean` flag is stale. Its own honest class is `empty-only`. Refuse the
		// class at the producer (the conservative reading) so nothing clean-authored
		// can be stored or handed to the matrix; `resolveTargetLangRows` refuses it
		// again at the seam, because the guard keys on who may AUTHOR the axis, not
		// on which class arrived.
		let firstPublishReason = firstPublishVerdict.reason;
		if (
			fx.clean &&
			COMPARABLE_FIRST_PUBLISH.has(firstPublishVerdict.firstPublish)
		) {
			row.firstPublish = "unknown";
			firstPublishReason = `refused (#4615): a clean fixture's file has no finding to publish, so this is not its measurement — ${firstPublishVerdict.reason}`;
		}
		row.behavior = verdict.behavior;
		row.tier = verdict.tier;
		row.tierLabel = verdict.tierLabel;
		row.detail = `dirtyPubs=${obs.dirtyPublishes}(v:${obs.dirtyVersioned}) cleanPubs=${obs.cleanTransitionPublishes}(v:${obs.cleanTransitionVersioned}) dirtyDiags=${dirtyDiagCount} first-publish=${row.firstPublish} — ${verdict.reason}; ${firstPublishReason}`;
	};
}
