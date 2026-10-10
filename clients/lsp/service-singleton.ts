import { getProcessSingleton } from "../process-singletons.js";
import { clearWorkspaceSweepHoldForSessionStart } from "./workspace-sweep-hold.js";

export interface LspServiceShutdownOptions {
	fast?: boolean;
	reason?: string;
}

export interface LspServiceLifecycle<T extends object> {
	create(generationHandoff: Promise<void> | undefined): T;
	beforeReset(options: LspServiceShutdownOptions): void;
	destroy(service: T, options: LspServiceShutdownOptions): Promise<void>;
}

interface LspServiceState<T extends object> {
	service: T | null;
	generationHandoff: Promise<void> | undefined;
	lifecycle: LspServiceLifecycle<T> | undefined;
}

const LSP_SERVICE_FAMILY = "lsp.service";
const LSP_SERVICE_VERSION = 2;

function state<T extends object>(): LspServiceState<T> {
	return getProcessSingleton(
		LSP_SERVICE_FAMILY,
		LSP_SERVICE_VERSION,
		() => ({
			service: null,
			generationHandoff: undefined,
			lifecycle: undefined,
		}),
		(value) => {
			const previous = value as Partial<LspServiceState<T>>;
			const service = previous.service;
			if (
				!service ||
				typeof (service as { shutdown?: unknown }).shutdown !== "function"
			)
				return;
			void Promise.resolve(
				(
					service as {
						shutdown(options: LspServiceShutdownOptions): Promise<void>;
					}
				).shutdown({
					fast: true,
					reason: "process_singleton_reset",
				}),
			).catch(() => undefined);
		},
	) as LspServiceState<T>;
}

export function configureLspServiceLifecycle<T extends object>(
	lifecycle: LspServiceLifecycle<T>,
): void {
	state<T>().lifecycle = lifecycle;
}

export function getOwnedLspService<T extends object>(): T {
	const current = state<T>();
	if (!current.lifecycle) {
		throw new Error("LSP service lifecycle is not configured");
	}
	if (!current.service) {
		current.service = current.lifecycle.create(current.generationHandoff);
	}
	return current.service;
}

export function peekOwnedLspService<T extends object>(): T | undefined {
	return state<T>().service ?? undefined;
}

export function resetOwnedLspService<T extends object>(
	options: LspServiceShutdownOptions = {},
): void {
	const current = state<T>();
	if (options.reason === "session_start") {
		clearWorkspaceSweepHoldForSessionStart();
	}
	current.lifecycle?.beforeReset(options);
	const retiringService = current.service;
	current.service = null;
	if (!retiringService || !current.lifecycle) return;

	const teardown = current.lifecycle.destroy(retiringService, options);
	const pending = current.generationHandoff
		? [current.generationHandoff, teardown]
		: [teardown];
	const handoff = Promise.allSettled(pending).then(() => undefined);
	current.generationHandoff = handoff;
	void handoff.then(() => {
		if (current.generationHandoff === handoff)
			current.generationHandoff = undefined;
	});
}
