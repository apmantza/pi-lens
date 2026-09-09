// Resolves and checks every pinned compat contract (#476/#2581/#2680 F2).
//
// Combines the CONTRACTS registry (scripts/lib/compat-contracts.mjs — which
// files, which check) with the candidate-path locator
// (scripts/lib/compat-contract-locator.mjs — where those files actually are
// on disk) into one per-contract result, independent of every other
// contract: a relocated or missing file for one contract can never prevent
// the others from resolving and running their own check.
//
// Kept to the fs reads locateContractSources already does — no
// child_process, no npm install, no process.exit — so `resolveAndCheckContracts`
// is directly unit-testable against a small on-disk fixture package tree
// (tests/scripts/compat-contract-resolution.test.ts) without a real npm
// install. scripts/compat-contracts.mjs (the CLI entry point) owns the
// install + argv/exit-code/GITHUB_OUTPUT plumbing around this.

import * as path from "node:path";
import { CONTRACTS } from "./compat-contracts.mjs";
import { locateContractSources } from "./compat-contract-locator.mjs";

/**
 * @typedef {{
 *   id: string,
 *   package: string,
 *   description: string,
 *   outcome: "verified" | "drift" | "infra",
 *   pass: boolean,
 *   detail: string,
 * }} ContractResult
 */

/**
 * Resolve and check every contract in CONTRACTS independently.
 *
 * @param {string} installDir directory containing the installed packages'
 *   `node_modules` (a scratch npm-install dir in production, a small fixture
 *   tree in tests)
 * @param {{ contracts?: typeof CONTRACTS }} [options] `contracts` overrides
 *   the registry — used by tests to exercise a 3-contract fixture (verified/
 *   drift/infra) without touching the real 7-contract list.
 * @returns {ContractResult[]}
 */
export function resolveAndCheckContracts(installDir, options = {}) {
	const contracts = options.contracts ?? CONTRACTS;
	return contracts.map((contract) => {
		const packageDir = path.join(installDir, "node_modules", contract.package);
		const resolved = locateContractSources(packageDir, contract.parts);
		if (!resolved.found) {
			const triedList = resolved.tried
				.map((c) => `${c.path} (observed at ${c.observedAt})`)
				.join(", ");
			return {
				id: contract.id,
				package: contract.package,
				description: contract.description,
				outcome: "infra",
				pass: false,
				detail: `INFRA — expected source not found for "${resolved.part}" (package layout changed?): tried ${triedList}`,
			};
		}
		const checkResult = contract.check(resolved.source);
		return {
			id: contract.id,
			package: contract.package,
			description: contract.description,
			outcome: checkResult.pass ? "verified" : "drift",
			...checkResult,
		};
	});
}
