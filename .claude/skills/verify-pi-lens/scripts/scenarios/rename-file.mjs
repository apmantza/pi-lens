// #4344 r1 F2: pilens_lsp_navigation rename_file moves a module into the path
// an importer was missing. Pyrefly advertises willRename but no didRename, so
// pi-lens must send the file events itself: old path Deleted (3), new path
// Created (1).
import { setup as lspSetup } from "./lsp-created-module.mjs";

export const variants = ["into-missing-path"];

const OLD = "src/fixturepkg/old.py";
const NEW = "src/fixturepkg/new_module.py";
const IMPORTER = "tools/probe.py";
const BAD = "tools/bad.py";
const MISSING = /Cannot find module `fixturepkg\.new_module`/;

export async function setup(ctx) {
	await lspSetup(ctx);
	ctx.write(OLD, "def describe_source() -> str:\n    return 'synthetic'\n");
}

const check = (ctx, paths, label) =>
	ctx.call(
		"pilens_diagnostics",
		{
			source: "lsp",
			scope: "paths",
			paths,
			serverScope: "primary",
			waitMs: 3000,
			severity: "all",
		},
		label,
	);

export async function run(ctx) {
	const before = await check(ctx, [IMPORTER, BAD], "before: importer + bad");
	ctx.expect(
		"before: the importer reports the missing module",
		MISSING.test(before.text),
	);

	const renamed = await ctx.call(
		"pilens_lsp_navigation",
		{ operation: "rename_file", path: OLD, newFilePath: NEW, apply: true },
		"rename old.py to new_module.py",
	);
	ctx.expect(
		"file state: the module moved",
		ctx.exists(NEW) && !ctx.exists(OLD),
		renamed.text.slice(0, 120),
	);

	const after = await check(
		ctx,
		[NEW, IMPORTER, BAD],
		"after: moved module, importer, bad",
	);
	ctx.expect(
		"the importer no longer reports the missing module",
		!MISSING.test(after.text),
		after.text.split("\n").find((l) => MISSING.test(l)) ?? "",
	);
	ctx.expect(
		"bad.py still reports its genuinely missing module",
		/never_exists/.test(after.text),
	);

	const where = await ctx.call(
		"pilens_lsp_navigation",
		{
			operation: "definition",
			path: IMPORTER,
			line: 1,
			symbol: "describe_source",
			// The default view is text (#5222); this step parses the envelope.
			view: "json",
		},
		"definition of describe_source from the importer",
	);
	const uris = (where.json?.result ?? []).map((r) => r.uri);
	ctx.expect(
		"definition lands in new_module.py, not the import site",
		uris.length === 1 && uris[0].endsWith("/src/fixturepkg/new_module.py"),
		uris.join(" "),
	);

	const events = ctx.lspWire(/didChangeWatchedFiles/);
	ctx.expect(
		"wire: old.py Deleted (type 3)",
		events.some((l) => l.includes("old.py") && /"type":3\b/.test(l)),
	);
	ctx.expect(
		"wire: new_module.py Created (type 1)",
		events.some((l) => l.includes("new_module.py") && /"type":1\b/.test(l)),
	);
}
