/**
 * #4789: the exemptions from the real-home scan: tests that name the real home
 * on purpose, either to read it (`REAL_HOME`) or to double the spelling the
 * scan looks for (a mocked `node:os` `userInfo`).
 *
 * `tests/support/vitest-setup.ts` pins HOME, USERPROFILE and the XDG
 * directories for every worker, so `os.homedir()` answers the worker's own
 * scratch home. A test that needs the real one goes through `REAL_HOME` (or
 * `os.userInfo()`, which does not read HOME). Each such file is a row here,
 * with the reason it is exempt, and carries the same
 * `// real-home: <reason>` header (the reason text must match the row). The scan in
 * `tests/config/real-home-reader-registry.test.ts` fails a file that spells
 * either and has no row, and a row whose file no longer does.
 *
 * Reading is the only admission: a row never lets a test WRITE through the
 * real home. Keep this list short; a test that can use `pinFixtureHome` does.
 */
export const REAL_HOME_READERS: Readonly<Record<string, string>> = {
	"tests/clients/formatter-template-preserve.test.ts":
		"read-only path probe for the maintainer's managed prettier (`~/.pi-lens/tools/node_modules/prettier`); prettier is not a devDependency, so without the real home this suite skips on the one host that has it",
	"tests/clients/knip-cache-consumer-staleness.test.ts":
		"read-only PATH probe for the maintainer's managed knip (`~/.pi-lens/tools/node_modules/.bin`); the pinned home has no managed tools tree, and the suite skips where neither that nor a PATH knip exists",
	"tests/clients/turn-scenarios.test.ts":
		"read-only PATH probe for the maintainer's managed knip (`~/.pi-lens/tools/node_modules/.bin`); the pinned home has no managed tools tree, and the scenario skips where neither that nor a PATH knip exists",
	"tests/clients/lsp/pyright-settings-effect-4758.integration.test.ts":
		"read-only path probe for the maintainer's managed pyright (`~/.pi-lens/tools/node_modules/.bin/pyright-langserver`); the pinned home has no managed tools tree, so without the real home the effect case skips on the one host that has pyright",
	"tests/clients/lsp/opengrep-offline-findings-4765.integration.test.ts":
		"read-only path probe for the maintainer's managed opengrep (`~/.pi-lens/bin/opengrep`); the pinned home has no managed tools tree, so without the real home the file skips on the one host that has opengrep",
	"tests/clients/installer/markdownlint-verify-2045.test.ts":
		"read-only path probe for the maintainer's managed markdownlint-cli2 (`~/.pi-lens/tools/node_modules/.bin`); the pinned home has no managed tools tree, so the real-CLI case skips on the one host that has it",
	"tests/clients/installer/tool-discovery.test.ts":
		"mocks node:os with its own `userInfo` that answers a fixture home; reads nothing of the real one",
	"tests/clients/installer/version-drift.test.ts":
		"mocks node:os with its own `userInfo` that answers a fixture home; reads nothing of the real one",
	"tests/clients/worker-home-pin-hermeticity.test.ts":
		"the pin's own proof: compares paths against the passwd home to show a child never sees it; never reads or writes through it",
};
