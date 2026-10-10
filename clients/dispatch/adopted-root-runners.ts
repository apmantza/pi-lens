/**
 * The explicit admission list of dispatch runners admitted for an adopted
 * analysis root (#4242 phase A, the per-file-linters half; the LSP half is
 * #4257).
 *
 * An adopted root is NOT the session project. pi's trust decision describes the
 * session's project only, so an adopted root never runs project-local binaries,
 * project config, project plugins, or test runners, whatever the session trust
 * (#4242 trust rules). Only a runner that reads no project config and cannot
 * execute project code may run there, and only from a global or pi-lens-managed
 * binary.
 *
 * The default is REFUSED. {@link filterGroupsForAdoptedRoot} admits a runner id
 * only when it appears below, so a newly registered runner stays off an adopted
 * root until this population is deliberately extended with the same evidence.
 * The per-runner evidence table lives in the #4242 hand-back/PR body.
 *
 * Admitted today, each because it only parses one file and reads no project
 * config or plugin:
 *   - `php-lint` — `php -l <file>` is syntax-check only; `php.ini` is
 *     machine/global config, never the project's. The runner resolves `php`
 *     through the adopted-root availability checker (`allowProjectLocal:
 *     false`), so a project `.venv/bin/php` is neither probed nor run.
 *   - `fish-indent` — `fish_indent --check <file>` compares one file against
 *     fish's built-in formatter; it reads no config and executes no project
 *     code, and uses the same adopted-root (global/managed-only) checker.
 *
 * Everything else stays refused: config-as-code linters (eslint, oxlint,
 * biome), config-file linters (yamllint, markdownlint, hadolint, shellcheck,
 * shfmt, taplo, sqlfluff, htmlhint, vale, spellcheck, stylelint, ruff, mypy,
 * pyright, rubocop, phpstan, detekt, ktlint, swiftlint, psscriptanalyzer,
 * tflint, terragrunt, trivy/config, actionlint), compilers and build drivers
 * that execute project code (go-vet, golangci-lint, rust-clippy, dotnet-build,
 * javac, cpp-check, zig-check, gleam-check, dart-analyze, elixir-check, credo,
 * cue-vet, prisma-validate, helm, spotbugs), and the LSP/tree-sitter/fact/
 * ast-grep runners plus every whole-project scanner.
 */

import type { RunnerGroup } from "./types.js";

export const ADOPTED_ROOT_RUNNER_ALLOWLIST = [
	"fish-indent",
	"php-lint",
] as const;

const ADMITTED: ReadonlySet<string> = new Set(ADOPTED_ROOT_RUNNER_ALLOWLIST);

/** Whether one runner id is admitted for an adopted root. */
export function isAdoptedRootRunnerAdmitted(runnerId: string): boolean {
	return ADMITTED.has(runnerId);
}

/**
 * The one seam that narrows dispatch groups for an adopted root. Each group
 * keeps its mode and semantics; only non-admitted runner ids are removed, and a
 * group with no admitted member is dropped. An empty result is the caller's
 * signal to skip dispatch entirely, exactly as before this admission list
 * existed.
 */
export function filterGroupsForAdoptedRoot(
	groups: readonly RunnerGroup[],
): RunnerGroup[] {
	const filtered: RunnerGroup[] = [];
	for (const group of groups) {
		const runnerIds: string[] = [];
		for (const runnerId of group.runnerIds) {
			if (isAdoptedRootRunnerAdmitted(runnerId)) runnerIds.push(runnerId);
		}
		if (runnerIds.length === 0) continue;
		filtered.push(
			runnerIds.length === group.runnerIds.length
				? group
				: { ...group, runnerIds },
		);
	}
	return filtered;
}
