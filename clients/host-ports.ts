/** Host-neutral capabilities available to the pi-lens engine (#1358 S2). */

import type { ExtensionLogEntry } from "./extension-log.js";
import type { ExtensionRunMode } from "./extension-mode.js";
import type { ProjectTrustState } from "./project-trust.js";
import type { UserNotifyLevel } from "./user-notify.js";

type HostLogSink = (entry: Record<string, unknown>) => void;

export interface HostPorts {
	readonly notify: {
		user(message: string, level?: UserNotifyLevel): void;
	};
	readonly trust: {
		isProjectTrusted(): ProjectTrustState;
	};
	readonly mode: {
		current(): ExtensionRunMode;
		supportsTuiWidget(): boolean;
		suppressesUserNotify(): boolean;
	};
	readonly log: {
		extension(entry: ExtensionLogEntry): void;
		debug(message: string, metadata?: Record<string, unknown>): void;
		sink(subsystem: string): HostLogSink;
	};
	readonly emit: {
		/**
		 * Every `pi.events` publish, including the `pi-lens/*` producer family
		 * (clients/lens-events.ts). A separate `.lens` port existed briefly but
		 * was never wired to anything but this same `emit` function — removed
		 * as vestigial (#1415 review) rather than kept as a distinction with no
		 * behavioral difference.
		 */
		bus(channel: string, payload: unknown): void;
	};
	readonly status: {
		set(name: string, value: string): void;
	};
	readonly spawn: {
		abortSignal(): AbortSignal | undefined;
		isAllowed(context: string): boolean;
	};
	readonly render: {
		invalidate(): void;
	};
	readonly session: {
		id(): string | undefined;
	};
	readonly workspace: {
		cwd(): string | undefined;
		projectRoot(): string | undefined;
	};
	readonly flags: {
		get(name: string, filePath?: string): string | boolean | undefined;
	};
	readonly tools: {
		has(name: string): Promise<boolean>;
		getActive(): string[];
		setActive(names: string[]): void;
	};
}

export type HostPortsOverrides = {
	[K in keyof HostPorts]?: Partial<HostPorts[K]>;
};

/**
 * Headless/test implementation. Its feature-detection defaults deliberately
 * match the pre-ports absent-host paths: unknown trust/mode, fail-open spawn,
 * and no-op delivery surfaces.
 */
export function createDefaultHostPorts(
	overrides: HostPortsOverrides = {},
): HostPorts {
	const unknownMode = (): ExtensionRunMode => "unknown";
	const defaults: HostPorts = {
		notify: { user: () => {} },
		trust: { isProjectTrusted: () => "unknown" },
		mode: {
			current: unknownMode,
			supportsTuiWidget: () => true,
			suppressesUserNotify: () => false,
		},
		log: { extension: () => {}, debug: () => {}, sink: () => () => {} },
		emit: { bus: () => {} },
		status: { set: () => {} },
		spawn: { abortSignal: () => undefined, isAllowed: () => true },
		render: { invalidate: () => {} },
		session: { id: () => undefined },
		workspace: { cwd: () => undefined, projectRoot: () => undefined },
		flags: { get: () => undefined },
		tools: { has: async () => false, getActive: () => [], setActive: () => {} },
	};
	// SAFETY: `Object.fromEntries` is typed `Record<string, T>` — it cannot
	// carry the key literals or the per-group value types through. The keys
	// come from `Object.entries(defaults)`, and `defaults` is declared as a
	// complete `HostPorts`, so every group is present; each value is that
	// group's default spread-merged with the same group's override, so no
	// group's member set shrinks. Add a group to `HostPorts` without adding it
	// to `defaults` and this cast becomes a lie, which is why `defaults` is
	// annotated rather than inferred.
	return Object.fromEntries(
		Object.entries(defaults).map(([group, value]) => [
			group,
			{ ...value, ...overrides[group as keyof HostPorts] },
		]),
	) as unknown as HostPorts;
}
