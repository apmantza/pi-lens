// Type declarations for compat-contracts.mjs (untyped .mjs imported from .ts tests).

export interface ContractCheckResult {
	pass: boolean;
	detail: string;
}

export function checkNicobailonChildEnv(source: string): ContractCheckResult;
export function checkAvtcChildEnv(source: string): ContractCheckResult;
export function checkSdkExtensionCache(source: string): ContractCheckResult;
export function checkSdkBindExtensionsEmitsSessionStart(
	source: string,
): ContractCheckResult;
export function checkSdkInvalidateCalled(source: string): ContractCheckResult;
export function checkSdkStaleCtxMessage(source: string): ContractCheckResult;
export function checkTintinwebInProcessBind(
	source: string,
): ContractCheckResult;

export interface ContractSourceCandidate {
	path: string;
	observedAt: string;
}

export interface ContractSourcePart {
	name: string;
	candidates: ContractSourceCandidate[];
}

export interface ContractDefinition {
	id: string;
	package: string;
	description: string;
	check: (source: string) => ContractCheckResult;
	parts: ContractSourcePart[];
}

export const CONTRACTS: ContractDefinition[];
