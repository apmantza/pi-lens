/**
 * Centralized accessor for `vscode-jsonrpc`. See ./typescript.ts for the
 * rationale. The runtime values live on the `./node` subpath (v9 `exports` map);
 * the connection type comes from the package root.
 */
export type { MessageConnection } from "vscode-jsonrpc";
export {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
