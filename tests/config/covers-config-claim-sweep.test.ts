/**
 * #3968 class sweep — "a config field whose values name another module's
 * identity is not validated fail-closed against that registry".
 *
 * Population census over the custom-server config surface
 * (`CustomServerConfig`, `clients/lsp/config.ts`) — the fields a user writes
 * under `lsp.servers.<id>` that gate runtime behavior. Two detector
 * families:
 *
 *   A. **identity-valued fields are validated fail-closed at load.** A field
 *      whose members name identities another registry owns (a dispatch
 *      runner id, today `covers`) must be validated against the owning
 *      registry's identity source — projected, never a parallel list — with
 *      a visible record when it drops something. The pre-#3968 shape was the
 *      defect: `covers`-class values (free-form strings with no validation)
 *      would silently never match, reading downstream as a clean lane the
 *      user believed they had configured away.
 *
 *   B. **the identity source itself is projected, not hand-copied.** The
 *      registration entrance (`RunnerRegistry.register`) feeds the identity
 *      leaf; a SECOND hand-written runner-id list anywhere in the config
 *      path is the same single-source-of-truth defect AGENTS.md names.
 *
 * Sources are comment-and-string-striped (`stripSource`), so prose or a
 * string literal cannot satisfy a requirement; the census floor names the
 * real population (defect shape 10).
 *
 * Free-form fields (no owning enum) are ADMISSIONS with a reason, not
 * failures: their values never select between registries, so silent
 * misspelling cannot suppress a lane — the absent/unavailable verdicts
 * carry them (`runtime-tool-result`, installer probe).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNonEmptyScan, stripSource } from "../support/sweep-kit.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

const LSP_CONFIG = path.join(ROOT, "clients/lsp/config.ts");
const LEAF = path.join(ROOT, "clients/dispatch/known-runner-ids.ts");
const DISPATCHER = path.join(ROOT, "clients/dispatch/dispatcher.ts");

/** The fields of the custom-server config surface, parsed from source. */
function customServerConfigFields(): string[] {
	// Comment-and-string blanked; the interface body is the population.
	const blanked = stripSource(fs.readFileSync(LSP_CONFIG, "utf8"));
	const match = /export interface CustomServerConfig \{([\s\S]*?)\n\}/.exec(
		blanked,
	);
	expect(match, "CustomServerConfig declaration found").toBeTruthy();
	return [...match![1].matchAll(/(?:^|\n)\t(\??\w+)\??:/g)].map(
		(m) => m[1] ?? "",
	);
}

describe("covers-class sweep — identity-valued config fields (#3968)", () => {
	it("has the custom-server config surface to census (declared floor)", () => {
		// Floor: today's seven fields. An emptied census fails loud, never
		// reads as clean; a new field joins through the admission table below.
		const fields = customServerConfigFields();
		// Registered-or-fail floor (sweep-floor-coverage meta-sweep): a census
		// of zero files or zero fields must fail loud, never read as clean.
		assertNonEmptyScan("custom-server config surface", fields.length, 7);
	});

	it("every field of the surface is either admitted free-form or validated fail-closed", () => {
		const fields = customServerConfigFields();
		// Admission table: per-member verdicts. A field added to
		// CustomServerConfig that is NOT here reds this sweep and forces an
		// honest row (registered-or-fail).
		const freeForm = new Set([
			// Free-form display/selection values; no owning enum. A typo in
			// these cannot silently suppress a lane — the server simply does
			// not match/attach, and selection reports `extension-mismatch`.
			"name",
			"extensions",
			"command",
			"role",
			"args",
			"rootMarkers",
			"env",
			"initializationOptions",
		]);
		const identityValued = new Set([
			// Members are dispatch runner ids (another registry's identity) —
			// MUST be validated fail-closed by the family-A detectors below.
			"covers",
		]);
		const unclassified = fields.filter(
			(f) => !freeForm.has(f) && !identityValued.has(f),
		);
		expect(unclassified).toEqual([]);
	});

	it("family A: identity-valued fields are projected from the owning registry with a visible refusal record", () => {
		// Blank everything: the requirement is CODE structure (a call to the
		// identity predicate and a coded refuse-record path), not prose.
		const blanked = stripSource(fs.readFileSync(LSP_CONFIG, "utf8"));
		// 1. The identity question is asked through the registry-projected
		//    predicate, and the unpopulated-registry arm is named.
		expect(blanked).toContain("isKnownRunnerId");
		expect(blanked).toContain("runnerIdentityPopulated");
		// 2. The refusal is a fail-closed record with a stable code: the
		//    `PILENS_CFG_0005` record builder lives here (string blanked, so
		//    the needle is structural in the source, not a doc quote).
		expect(blanked).toContain("coversClaimRecords");
		const schema = stripSource(
			fs.readFileSync(path.join(ROOT, "clients/config-schema.ts"), "utf8"),
		);
		// 3. The claim's SHAPE validation is the published schema's job
		//    (config-core drops a non-array value / non-string member with
		//    `PILENS_CFG_0005` at the leaf pointer) — the typed node exists.
		expect(schema).toContain("properties: {\n\t\t\tcovers: {\n");
	});

	it("family B: the identity leaf is populated from the registry's registration entrance, never by hand", () => {
		const leaf = stripSource(fs.readFileSync(LEAF, "utf8"));
		// The leaf contains NO runner ids of its own — no parallel list. A
		// hand-written id literal in the leaf fails this sweep.
		expect(leaf).not.toMatch(/"(?:shellcheck|shfmt|taplo|lsp|fact-rules)"/);
		const dispatcher = stripSource(fs.readFileSync(DISPATCHER, "utf8"));
		// The ONE entrance populates it: `RunnerRegistry.register` calls
		// registerRunnerId — the population is the registration.
		expect(dispatcher).toContain("registerRunnerId(");
		// ...and the population is called from `register`, the set's only
		// writer (the call sits inside the register method's body; both
		// needles are structural in blanked source).
		const registerBody =
			/register\(runner: RunnerDefinition\): void \{([\s\S]*?)\n\t\}/.exec(
				dispatcher,
			);
		expect(registerBody, "RunnerRegistry.register body").toBeTruthy();
		expect(registerBody![1]).toContain("registerRunnerId");
	});
});
