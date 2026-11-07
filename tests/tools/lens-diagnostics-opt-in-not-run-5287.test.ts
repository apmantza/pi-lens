/**
 * #5287 fold (alignment routine, family 4): the `lens_diagnostics` mode=full
 * sweep names an enabled opt-in server as not run, as `lsp_diagnostics` does.
 *
 * Recurrence prevented: `lsp_diagnostics` printed `Opt-in, not run by this
 * check: fallow.` (#4956 F2), but the sweep took its exclude set from
 * `configDisabledAuxiliaryLspServerIds` alone. With `--lens-fallow` on, that set
 * was empty, the sweep never asked fallow, and its "Switched off, not run" note
 * was absent, so a sweep with no fallow rows read as fallow's answer.
 *
 * Driven through the real tool and the real flag reader; only the language
 * server process is doubled, and the double records what the sweep excluded.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	clearWidgetState,
	recordDiagnostics,
} from "../../clients/widget-state.js";
import {
	removeTempDirSync,
	setupTestEnvironment,
} from "../clients/test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";

describe("lens_diagnostics mode=full names an enabled opt-in as not run (#5287)", () => {
	let tmp: string;
	let file: string;

	beforeEach(() => {
		clearWidgetState();
		tmp = fs.realpathSync(setupTestEnvironment("pi-lens-5287-optin-").tmpDir);
		file = path.join(tmp, "a.ts");
		fs.writeFileSync(file, "export const value = 1;\n");
	});

	afterEach(() => {
		clearWidgetState();
		removeTempDirSync(tmp);
	});

	async function sweep(flags: ReadonlySet<string>) {
		const runWorkspaceDiagnostics = vi.fn(async () => [
			{ filePath: file, diagnostics: [], count: 0 },
		]);
		const service = makeLspServiceDouble({ runWorkspaceDiagnostics });
		const tool = createLensDiagnosticsTool(
			{ readCache: vi.fn(() => undefined) } as never,
			() => tmp,
			() => service as never,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			(name) => (flags.has(name) ? true : undefined),
		);
		const result = (await tool.execute(
			"1",
			{ mode: "full", paths: [file] },
			new AbortController().signal,
			null as never,
			{ cwd: tmp } as never,
		)) as { content: Array<{ text: string }> };
		const calls = runWorkspaceDiagnostics.mock.calls as unknown as Array<
			[string, { excludeServerIds?: ReadonlySet<string> }]
		>;
		return {
			text: result.content.map((c) => c.text).join("\n"),
			excluded: [...(calls[0]?.[1].excludeServerIds ?? [])].sort(),
		};
	}

	it("says an enabled opt-in was not run, and leaves it unasked", async () => {
		const { text, excluded } = await sweep(new Set(["lens-fallow"]));
		expect(text).toContain("Opt-in, not run by this check: fallow.");
		expect(text).not.toContain("Switched off, not run (auxiliary LSP): fallow");
		expect(excluded).toEqual(["fallow"]);
	});

	it("keeps the switched-off sentence first and the opt-in one beside it", async () => {
		const { text } = await sweep(new Set(["lens-fallow", "no-opengrep"]));
		expect(text).toContain(
			"Switched off, not run (auxiliary LSP): opengrep. Opt-in, not run by this check: fallow.",
		);
	});

	it("adds nothing for an operator who never asked for the opt-in", async () => {
		const { text, excluded } = await sweep(new Set(["no-opengrep"]));
		expect(text).toContain("Switched off, not run (auxiliary LSP): opengrep.");
		expect(text).not.toContain("Opt-in");
		expect(excluded).toEqual(["opengrep"]);
	});

	// Recurrence prevented: #5287. mode=full has no cache verdict, so its
	// one-line summary said `clean (1 files)` for a sweep over a file no check
	// completed on, beside a report that named it as not checked.
	it("renders a sweep over files no check completed on as unchecked, not clean", async () => {
		const notes = path.join(tmp, "notes.zzz");
		fs.writeFileSync(notes, "plain notes\n");
		recordDiagnostics(notes, [], undefined, undefined, {
			reason: "no analyzer handles this file type",
			inapplicable: true,
		});
		const service = makeLspServiceDouble({
			runWorkspaceDiagnostics: vi.fn(async () => []),
		});
		const tool = createLensDiagnosticsTool(
			{ readCache: vi.fn(() => undefined) } as never,
			() => tmp,
			() => service as never,
		);
		const result = await tool.execute(
			"1",
			{ mode: "full", paths: [notes] },
			new AbortController().signal,
			null as never,
			{ cwd: tmp } as never,
		);
		const text = (result as { content: Array<{ text: string }> }).content
			.map((c) => c.text)
			.join("\n");
		const summary = tool
			.renderResult(result as never, { expanded: false }, {} as Theme, {
				args: { mode: "full" },
			})
			.render(240)
			.join("\n");

		expect(text).toContain("⚠ 1 file not checked");
		expect(text).not.toContain("✓");
		expect(summary).toContain("lens_diagnostics full — unchecked (1 files)");
		expect(summary).not.toContain("clean");
	});
});
