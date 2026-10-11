const { parse: parseJson5 } = require("json5");
const { readFileSync } = require("node:fs");
const eagerClients = parseJson5(
	readFileSync("./config/dependency-cruiser-eager-allowlist.json", "utf8"),
);

const eagerClientPattern = `^(?:\\./)?(?:${eagerClients
	.map((modulePath) =>
		modulePath.replace(/^\.\//, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
	)
	.join("|")})$`;

module.exports = {
	forbidden: [
		{
			name: "no-client-cycles",
			severity: "error",
			comment: "clients/ modules must remain acyclic.",
			from: { path: "^(?:\\./)?clients/" },
			to: {
				path: "^(?:\\./)?clients/",
				circular: true,
				dependencyTypesNot: ["dynamic-import"],
				// A dynamic import anywhere in the cycle breaks the static
				// initialization loop; `dependencyTypesNot` above sees only the
				// cycle's first edge (#4314: lsp-lazy's literal import).
				viaOnly: { dependencyTypesNot: ["dynamic-import"] },
			},
		},
		{
			name: "declared-client-leaf",
			severity: "error",
			comment: "Declared leaf modules must not import another clients/ module.",
			from: {
				// #2504 adds the two leaves it introduced. Both exist precisely so
				// a heavyweight importer (runtime-turn, lsp/index) can reach a
				// small shared primitive without dragging that primitive's owner's
				// import graph along — a claim each module's own doc comment makes
				// and which only this rule can actually hold.
				path: "^(?:\\./)?clients/(ledger-bounds|spawn-output-cap|map-with-concurrency|deferred-lsp-work|lsp/workspace-diagnostics-session)\\.js$",
			},
			to: { path: "^(?:\\./)?clients/" },
		},
		{
			name: "session-start-eager-allowlist-config-dependency-cruiser-eager-allowlist-json",
			severity: "error",
			comment:
				"A session-start eager import must be added to config/dependency-cruiser-eager-allowlist.json deliberately.",
			from: { path: "^index\\.ts$" },
			to: {
				path: "^(?:\\./)?clients/",
				pathNot: eagerClientPattern,
				dependencyTypesNot: ["dynamic-import"],
			},
		},
	],
	options: {
		// dependency-cruiser 18 cannot parse TypeScript 7, but CI builds first and
		// cruises the compiled clients/*.js graph. index.ts is still parsed as TS
		// without a transpiler, so type-only client imports remain ordinary edges
		// there and are marked in the eager allowlist.
		tsConfig: { fileName: "tsconfig.json" },
		doNotFollow: { path: "(^|/)node_modules/" },
		preserveSymlinks: false,
	},
};
