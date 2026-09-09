// Type declarations for compat-contract-locator.mjs (untyped .mjs imported
// from .ts tests).

export interface ContractSourceCandidate {
	path: string;
	observedAt: string;
}

export type LocateContractSourceResult =
	| {
			found: true;
			relativePath: string;
			observedAt: string;
			source: string;
	  }
	| {
			found: false;
			tried: ContractSourceCandidate[];
	  };

export function locateContractSource(
	packageDir: string,
	candidates: ContractSourceCandidate[],
): LocateContractSourceResult;

export interface ContractSourcePart {
	name: string;
	candidates: ContractSourceCandidate[];
}

export type LocateContractSourcesResult =
	| {
			found: true;
			source: string;
			parts: Array<{
				name: string;
				relativePath: string;
				observedAt: string;
			}>;
	  }
	| {
			found: false;
			part: string;
			tried: ContractSourceCandidate[];
	  };

export function locateContractSources(
	packageDir: string,
	parts: ContractSourcePart[],
): LocateContractSourcesResult;
