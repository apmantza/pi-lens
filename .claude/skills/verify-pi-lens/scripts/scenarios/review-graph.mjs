// The review graph behind pilens_module_report / pilens_project_report must see
// an importer edge to a module created after the graph was built (#4346, the
// graph half of #4320). Variants:
//   mcp-create-after-build  over MCP: analyze the importer, create the module,
//                           analyze it, read pilens_module_report (usedBy)
//   builder-incremental     in-process, the #4344 r1 reviewer's shape: a full
//                           build with the module missing, then an incremental
//                           update with only the created file (importers of b.ts)
export const variants = ["mcp-create-after-build", "builder-incremental"];
export const inProcess = ["builder-incremental"];

const IMPORTER = "src/a.ts";
const MODULE = "src/b.ts";
const MODULE_SRC = "export function b(): number {\n  return 1;\n}\n";

export async function setup(ctx) {
	ctx.write("package.json", '{"name":"g","version":"0.0.0"}');
	ctx.write("tsconfig.json", '{"compilerOptions":{"strict":true}}');
	// The call sits inside a function: usedBy is symbol-level.
	ctx.write(
		IMPORTER,
		'import { b } from "./b.js";\nexport function useB(): number {\n  return b();\n}\n',
	);
}

const analyze = (ctx, file, label) =>
	ctx.call(
		"pilens_analyze",
		{ file: `${ctx.ws}/${file}`, flags: { "no-lsp": true } },
		label,
	);

export async function run(ctx, variant) {
	if (variant === "builder-incremental") return builderIncremental(ctx);
	await analyze(ctx, IMPORTER, "build the graph from the importer");
	ctx.write(MODULE, MODULE_SRC);
	ctx.expect("file state: the module exists on disk", ctx.exists(MODULE));
	await analyze(
		ctx,
		MODULE,
		"analyze the created module (incremental graph update)",
	);
	const report = await ctx.call(
		"pilens_module_report",
		{ file: `${ctx.ws}/${MODULE}`, view: "full-json" },
		"module_report of the module",
	);
	const body = JSON.parse(
		report.text.slice(
			report.text.indexOf("{"),
			report.text.lastIndexOf("}") + 1,
		),
	);
	ctx.expect("module_report is available", body.available === true);
	const importers = (body.api ?? []).flatMap((e) =>
		(e.usedBy ?? []).map((u) => u.file.replace(/\\/g, "/")),
	);
	ctx.expect(
		"usedBy of b() names src/a.ts",
		importers.some((f) => f.endsWith("src/a.ts")),
		JSON.stringify(importers),
	);
}

async function builderIncremental(ctx) {
	(await ctx.importTree("clients/project-trust.js")).setProjectTrustState(
		"trusted",
	);
	const {
		buildOrUpdateGraph,
		clearGraphCache,
		clearReviewGraphWorkspaceCache,
	} = await ctx.importTree("clients/review-graph/builder.js");
	const { FactStore } = await ctx.importTree("clients/dispatch/fact-store.js");
	const importersOf = (g) =>
		g.edges
			.filter(
				(e) =>
					e.kind === "imports" && g.nodes.get(e.to)?.filePath?.endsWith(MODULE),
			)
			.map(
				(e) =>
					g.nodes.get(e.from)?.filePath?.replace(`${ctx.ws}/`, "") ?? e.from,
			);
	let g = await buildOrUpdateGraph(ctx.ws, [], new FactStore());
	ctx.record("full build with b.ts missing", { importers: importersOf(g) });
	ctx.write(MODULE, MODULE_SRC);
	g = await buildOrUpdateGraph(
		ctx.ws,
		[`${ctx.ws}/${MODULE}`],
		new FactStore(),
	);
	const incremental = importersOf(g);
	ctx.record("incremental update with only b.ts", { importers: incremental });
	clearGraphCache();
	clearReviewGraphWorkspaceCache(ctx.ws);
	const fresh = importersOf(
		await buildOrUpdateGraph(ctx.ws, [], new FactStore()),
	);
	ctx.record("fresh full build", { importers: fresh });
	ctx.expect(
		"control: a fresh full build has the importer edge",
		fresh.includes(IMPORTER),
		JSON.stringify(fresh),
	);
	ctx.expect(
		"the incremental update has the same importer edge",
		incremental.includes(IMPORTER),
		JSON.stringify(incremental),
	);
}
