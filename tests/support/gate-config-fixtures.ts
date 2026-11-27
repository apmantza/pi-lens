/**
 * The one config file that makes a project "configured" for the tool a runner
 * suite drives (#5408 slice 2). The runner gates ask
 * `clients/tool-config-presence.ts`, and a suite that is about a parser, not a
 * gate, plants the real file in its per-case directory instead of forcing the
 * seam open: a forced `hasToolConfig` reaches the policy layer too and turns
 * the sibling runners (biome, oxlint) off.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const GATE_CONFIG_FILES: Readonly<Record<string, readonly [string, string]>> = {
	eslint: ["eslint.config.js", "export default [];\n"],
	mypy: ["mypy.ini", "[mypy]\n"],
	phpstan: ["phpstan.neon", "parameters:\n"],
	stylelint: [".stylelintrc.json", "{}\n"],
	yamllint: [".yamllint", "extends: default\n"],
	sqlfluff: [".sqlfluff", "[sqlfluff]\ndialect = ansi\n"],
	"golangci-lint": [".golangci.yml", "run: {}\n"],
};

/** Writes the tool's config into `dir`; a tool with no config gate is left alone. */
export function plantGateConfig(tool: string, dir: string): void {
	const entry = GATE_CONFIG_FILES[tool];
	if (entry) fs.writeFileSync(path.join(dir, entry[0]), entry[1]);
}
