import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";

// These suites intentionally inspect the compiled package/build. The mutation
// lane must not change that contract while redirecting ordinary client imports.
export const STRYKER_ALIAS_EXCLUSIONS = {
	"tests/build-freshness-guard.test.ts":
		"tests the compiled-source freshness guard",
	"tests/packaging.test.ts":
		"tests dist/ consumers and the published package shape",
} as const;

const sourceImport = /^(.*\/(?:clients|tools|mcp)\/.*)\.js$/;

export function strykerSourceAlias() {
	return {
		name: "stryker-compiled-imports-to-sources",
		resolveId(source: string, importer?: string) {
			if (
				!importer ||
				Object.keys(STRYKER_ALIAS_EXCLUSIONS).some((test) =>
					path.normalize(importer).endsWith(path.normalize(test)),
				)
			)
				return;
			const match = source.match(sourceImport);
			if (!match) return;
			const candidate = path.resolve(path.dirname(importer), `${match[1]}.ts`);
			return existsSync(candidate) ? candidate : undefined;
		},
	};
}

export default defineConfig({
	...baseConfig,
	plugins: [...(baseConfig.plugins ?? []), strykerSourceAlias()],
	resolve: {
		alias: [{ find: sourceImport, replacement: "$1.ts" }],
	},
	test: {
		...baseConfig.test,
		projects: baseConfig.test?.projects?.map((project) => {
			if (typeof project === "string") return project;
			const projectConfig = project as Record<string, unknown> & {
				resolve?: Record<string, unknown>;
			};
			return {
				...projectConfig,
				resolve: {
					...projectConfig.resolve,
					alias: [{ find: sourceImport, replacement: "$1.ts" }],
				},
			};
		}),
	},
});
