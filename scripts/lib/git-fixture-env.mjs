import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRUBBED = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_PREFIX",
	"GIT_CONFIG_COUNT",
];

// GIT_CONFIG_COUNT + the indexed GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> pair
// inject arbitrary config (including core.bare) without touching a config
// file. See tests/support/git-fixture-env.ts for the same fix (#2163).
const CONFIG_KV_PATTERN = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

// #4552: `git commit` calls `run_auto_maintenance`, which forks a DETACHED
// `git maintenance run --auto --quiet --detach` child. The child outlives the
// fixture cell and writes inside `.git` (maintenance.lock, packed-refs.lock,
// repack temp files) while the test's teardown removes the directory, so the
// gating Unit shard failed in `afterEach` teardown with ENOTEMPTY on the
// fixture `.git` instead of in an assertion. A fixture never needs background
// maintenance, so the global config every fixture Git process reads (below) is
// the checked-in policy that turns the auto hook and auto-gc off: no child is
// forked, and the writer cannot outlive the cell. A config FILE, not
// GIT_CONFIG_KEY_<n> in the environment: worker sandboxes refuse env- and
// argv-injected config keys, and a path is what the helper already owns.
const FIXTURE_GIT_CONFIG = fileURLToPath(
	new URL("../../tests/fixtures/git-fixture-global.gitconfig", import.meta.url),
);

/**
 * The policy path, or a throw when the file is not there (#4552 review R2).
 *
 * The path is resolved from THIS module, so four fixtures that copy the helper
 * into a clone or throwaway tree (tests/support/fixture-git-copy.ts) must copy
 * the policy beside it. Without this check they silently gave their Git spawns
 * git's DEFAULT config, which restores `maintenance.auto` and forks the
 * detached child again: the failure this PR exists to remove, now invisible
 * because the fixture still passes. Refusing is the honest state.
 */
function fixtureGitConfig() {
	if (!existsSync(FIXTURE_GIT_CONFIG))
		throw new Error(
			`fixture Git policy missing at ${FIXTURE_GIT_CONFIG}: copy it with the helper (tests/support/fixture-git-copy.ts), or fixture Git forks background maintenance that outlives the cell (#4552).`,
		);
	return FIXTURE_GIT_CONFIG;
}

/**
 * Build the only environment a fixture Git process may see.
 *
 * The working directory no longer selects the global config: it is the
 * repo-level fixture policy (`tests/fixtures/git-fixture-global.gitconfig`),
 * identical for every fixture, because a worker sandbox refuses config injected
 * through `GIT_CONFIG_KEY_<n>` and no fixture needs a writable global config.
 * The wrappers keep passing the directory the command runs in.
 */
export function envFor(_cwd, overrides, { keep = [] } = {}) {
	const env = { ...process.env, ...overrides };
	for (const name of SCRUBBED) if (!keep.includes(name)) delete env[name];
	for (const key of Object.keys(env))
		if (CONFIG_KV_PATTERN.test(key)) delete env[key];
	env.GIT_CONFIG_GLOBAL = fixtureGitConfig();
	env.GIT_CONFIG_NOSYSTEM = "1";
	return env;
}

export function gitExecFileSync(args, options = {}) {
	const cwd = options.cwd ?? process.cwd();
	return execFileSync("git", args, {
		...options,
		env: envFor(cwd, options.env, options.gitFixtureEnv),
	});
}

export function gitExecSync(command, options = {}) {
	const cwd = options.cwd ?? process.cwd();
	// A fixture command's non-zero exit is the caller's signal: tests assert it
	// with `.toThrow()`, and swallowing it would turn a broken fixture into a
	// silent pass.
	// pi-lens-ignore: ast-grep:unchecked-throwing-call
	return execSync(command, {
		...options,
		env: envFor(cwd, options.env, options.gitFixtureEnv),
	});
}
