// Type declarations for compat-contracts.mjs (untyped .mjs imported from .ts tests).

export interface ContractCheckResult {
  pass: boolean;
  detail: string;
}

export function checkNicobailonChildEnv(source: string): ContractCheckResult;
export function checkSdkExtensionCache(source: string): ContractCheckResult;
export function checkSdkBindExtensionsEmitsSessionStart(
  source: string,
): ContractCheckResult;
export function checkSdkInvalidateCalled(source: string): ContractCheckResult;
export function checkSdkStaleCtxMessage(source: string): ContractCheckResult;
export function checkTintinwebInProcessBind(source: string): ContractCheckResult;

export interface ContractCheckEntry extends ContractCheckResult {
  id: string;
  package: string;
  description: string;
}

export interface ContractCheckInputs {
  nicobailonPiArgsSource: string;
  sdkLoaderSource: string;
  sdkAgentSessionSource: string;
  tintinwebAgentRunnerSource: string;
}

export function runAllContractChecks(inputs: ContractCheckInputs): {
  results: ContractCheckEntry[];
  allPass: boolean;
};
