import type {
	LSPOperationSupport,
	LSPWorkspaceDiagnosticsSupport,
} from "../client.js";

/**
 * Capability inventory consumed by incumbent wait policy for attached
 * sessions (#822). This contract is process-neutral and must remain free of
 * session-local state.
 */
export interface LSPCapabilitySnapshot {
	serverId: string;
	root: string;
	customServer?: boolean;
	/** True after this server published diagnostics for any document this session. */
	diagnosticsPublished?: boolean;
	operationSupport: LSPOperationSupport;
	workspaceDiagnosticsSupport: LSPWorkspaceDiagnosticsSupport;
	/** Commands the server advertised for workspace/executeCommand (the allowlist) */
	advertisedCommands: string[];
	/** Top-level keys of the raw ServerCapabilities advertised at initialize. */
	rawCapabilityKeys: string[];
	/** See `LSPServerInfo.spawn`'s `launchVariant` (server.ts) — which concrete
	 *  binary/protocol variant this server instance is actually running (e.g.
	 *  classic typescript-language-server vs TS7's native `tsc --lsp --stdio`,
	 *  both under server id "typescript"). Undefined = single-variant server or
	 *  an older client that predates this marker; consumers (the #458 cascade
	 *  tier classifier) must treat that as classic/default behavior. */
	launchVariant?: "classic" | "native-ts7";
}
