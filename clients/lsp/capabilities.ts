/**
 * The experimental LSP capability facade (#2372, #277).
 *
 * The groups are the extraction boundary for the next slices.  This first
 * slice deliberately adapts the existing service without moving ownership or
 * changing any operation.  The flat service members remain available as a
 * compatibility surface while callers migrate to the facade module.
 */

import "./index.js";
import type {
	LSPService,
	LSPWorkspaceScopeAttribution,
	LSPWorkspaceUnconfirmedReason,
} from "./index.js";
import {
	getOwnedLspService,
	peekOwnedLspService,
	resetOwnedLspService,
} from "./service-singleton.js";
import { groupFilesByPrimaryServer, runPerServerGroups } from "./grouping.js";
import type { LSPShutdownOptions } from "./client.js";
import type { DriftDisposition } from "./document-drift.js";

type CapabilityMethods<K extends keyof LSPService> = Pick<LSPService, K>;

export type LspClientLifecycleCapabilities = CapabilityMethods<
	| "checkDestroyed"
	| "getAliveClientCount"
	| "getAliveServerIds"
	| "getBrokenStatus"
	| "getStatus"
	| "isSpawnInFlight"
	| "shutdown"
>;

export type LspDocumentCapabilities = CapabilityMethods<
	"getOpenDocumentPaths" | "openFile" | "touchFile"
>;

export type LspDiagnosticCapabilities = CapabilityMethods<
	| "getAllDiagnostics"
	| "getDiagnostics"
	| "getDiagnosticsHealth"
	| "getLastKnownDiagnostics"
	| "readCachedDiagnosticsForServers"
	| "runWorkspaceDiagnostics"
>;

export type LspNavigationCapabilities = CapabilityMethods<
	| "codeAction"
	| "documentSymbol"
	| "definition"
	| "hover"
	| "implementation"
	| "incomingCalls"
	| "outgoingCalls"
	| "prepareCallHierarchy"
	| "references"
	| "rename"
	| "typeDefinition"
>;

export type LspWorkspaceCapabilities = CapabilityMethods<
	| "getAdvertisedCommands"
	| "getCapabilitySnapshots"
	| "getClientForFile"
	| "getOperationSupport"
	| "getWarmClientForFile"
	| "hasServerPublishedForFileRoot"
	| "supportsLSP"
>;

export interface LspCapabilities extends LSPService {
	/** Optional for legacy test doubles; present on adapted live services. */
	readonly clients?: LspClientLifecycleCapabilities;
	readonly documents?: LspDocumentCapabilities;
	readonly diagnostics?: LspDiagnosticCapabilities;
	readonly navigation?: LspNavigationCapabilities;
	readonly workspace?: LspWorkspaceCapabilities;
}

const adaptedServices = new WeakMap<LSPService, LspCapabilities>();

function bindGroup<T extends object>(
	service: LSPService,
	keys: readonly (keyof T)[],
): T {
	return new Proxy({} as T, {
		get(_target, key: string | symbol) {
			if (!keys.includes(key as keyof T)) return undefined;
			const value = service[key as keyof LSPService];
			return typeof value === "function" ? value.bind(service) : value;
		},
	});
}

/** Adapt one live service while preserving method identity and `this`. */
export function adaptLspService(service: LSPService): LspCapabilities {
	const existing = adaptedServices.get(service);
	if (existing) return existing;

	const groups = {
		clients: bindGroup<LspClientLifecycleCapabilities>(service, [
			"checkDestroyed",
			"getAliveClientCount",
			"getAliveServerIds",
			"getBrokenStatus",
			"getStatus",
			"isSpawnInFlight",
			"shutdown",
		]),
		documents: bindGroup<LspDocumentCapabilities>(service, [
			"getOpenDocumentPaths",
			"openFile",
			"touchFile",
		]),
		diagnostics: bindGroup<LspDiagnosticCapabilities>(service, [
			"getAllDiagnostics",
			"getDiagnostics",
			"getDiagnosticsHealth",
			"getLastKnownDiagnostics",
			"readCachedDiagnosticsForServers",
			"runWorkspaceDiagnostics",
		]),
		navigation: bindGroup<LspNavigationCapabilities>(service, [
			"codeAction",
			"documentSymbol",
			"definition",
			"hover",
			"implementation",
			"incomingCalls",
			"outgoingCalls",
			"prepareCallHierarchy",
			"references",
			"rename",
			"typeDefinition",
		]),
		workspace: bindGroup<LspWorkspaceCapabilities>(service, [
			"getAdvertisedCommands",
			"getCapabilitySnapshots",
			"getClientForFile",
			"getOperationSupport",
			"getWarmClientForFile",
			"hasServerPublishedForFileRoot",
			"supportsLSP",
		]),
	};

	const adapted = new Proxy(service as LspCapabilities, {
		get(target, key, receiver) {
			if (key in groups) return groups[key as keyof typeof groups];
			const value = Reflect.get(target, key, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	adaptedServices.set(service, adapted);
	return adapted;
}

/** The grouped facade over the process singleton. */
export function getLSPService(): LspCapabilities {
	return adaptLspService(getOwnedLspService<LSPService>());
}

/** @public — reached by clients/pipeline.ts through the clients/lsp-lazy.ts dynamic import, which knip cannot see. Read-only lifecycle access; this never creates a service. */
export function peekLSPService(): LspCapabilities | undefined {
	const service = peekOwnedLspService<LSPService>();
	return service ? adaptLspService(service) : undefined;
}

/** Compatibility lifecycle exports remain named so host hooks keep their ABI. */
export const resetLSPService = (options: LSPShutdownOptions = {}): void =>
	resetOwnedLspService<LSPService>(options);

export async function notifyExternalFileChange(
	filePath: string,
	type: number,
): Promise<void> {
	return getLSPService().notifyExternalFileChange(filePath, type);
}

export async function resyncGitChangedFiles(
	changedPaths: readonly string[],
): Promise<ReadonlyMap<string, DriftDisposition>> {
	return getLSPService().resyncGitChangedFiles(changedPaths);
}

export async function hasAuxiliaryLspPublishedForRoot(
	serverId: string,
	filePath: string,
): Promise<boolean> {
	return getLSPService().hasServerPublishedForFileRoot(serverId, filePath);
}

export type {
	LSPService,
	LSPWorkspaceScopeAttribution,
	LSPWorkspaceUnconfirmedReason,
};
export { groupFilesByPrimaryServer, runPerServerGroups };
