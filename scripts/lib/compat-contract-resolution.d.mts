// Type declarations for compat-contract-resolution.mjs (untyped .mjs
// imported from .ts tests).

import type { ContractDefinition } from "./compat-contracts.d.mts";

export interface ContractResult {
	id: string;
	package: string;
	description: string;
	outcome: "verified" | "drift" | "infra";
	pass: boolean;
	detail: string;
}

export function resolveAndCheckContracts(
	installDir: string,
	options?: { contracts?: ContractDefinition[] },
): ContractResult[];
