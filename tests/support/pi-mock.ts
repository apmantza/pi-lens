/**
 * A dependency-free mock of the host `ExtensionAPI` for testing pi-lens's
 * extension wiring (#171).
 *
 * pi-lens's entry (`index.ts` default export) registers flags, commands, tools,
 * and lifecycle hooks through `pi.registerFlag/registerCommand/registerTool/on`.
 * `createPiMock()` records every registration and lets a test drive a hook
 * (`emit`) or command (`runCommand`) through the *real* handler, so the glue is
 * verified end-to-end instead of each helper in isolation.
 *
 * Typed against the pinned `@earendil-works/pi-coding-agent` types only
 * (type-only import — no runtime dependency, per AGENTS.md install constraints).
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

export interface RecordedFlag {
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
}

export interface RecordedCommand {
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
	getArgumentCompletions?: unknown;
}

/** A handler registered via `pi.on(event, handler)`. */
type Hook = (event: unknown, ctx: unknown) => unknown;

/** A `ui.notify(...)` call captured for assertions. */
export interface CapturedNotification {
	message: string;
	type: "info" | "warning" | "error";
}

/** A `ui.setStatus(...)` call captured for assertions. */
export interface CapturedStatus {
	key: string;
	text: string | undefined;
}

/** A `ui.setWidget(...)` call captured for assertions. */
export interface CapturedWidget {
	key: string;
	content: unknown;
	options: unknown;
}

export interface MockCtx extends ExtensionCommandContext {
	/** Every `ctx.ui.notify(...)` made through this context, in order. */
	notifications: CapturedNotification[];
	/** Every `ctx.ui.setStatus(...)` call, in order. */
	statusCalls: CapturedStatus[];
	/** Every `ctx.ui.setWidget(...)` call, in order. */
	widgetCalls: CapturedWidget[];
}

/** A `pi.sendMessage(...)` call captured for assertions (#484). */
export interface CapturedMessage {
	customType: string;
	content: unknown;
	display: boolean;
	details: unknown;
}

export interface PiMock {
	// ── recordings ───────────────────────────────────────────────────────────
	readonly flags: Map<string, RecordedFlag>;
	readonly commands: Map<string, RecordedCommand>;
	readonly tools: Map<string, unknown>;
	readonly handlers: Map<string, Hook[]>;
	readonly flagValues: Map<string, boolean | string>;
	readonly messageRenderers: Map<string, unknown>;
	readonly sentMessages: CapturedMessage[];

	// ── ExtensionAPI surface that index.ts uses ──────────────────────────────
	registerFlag(name: string, options: RecordedFlag): void;
	registerCommand(name: string, options: RecordedCommand): void;
	registerTool(tool: { name: string } & Record<string, unknown>): void;
	on(event: string, handler: Hook): void;
	getFlag(name: string): boolean | string | undefined;
	/** #484: registered message renderers, keyed by customType. */
	registerMessageRenderer(customType: string, renderer: unknown): void;
	/** #484: captures every `pi.sendMessage(...)` call into `sentMessages`. */
	sendMessage(message: {
		customType: string;
		content: unknown;
		display: boolean;
		details?: unknown;
	}): void;

	// ── test helpers ─────────────────────────────────────────────────────────
	/** Pre-set a flag value (read back via getFlag); call before `extension(pi)`. */
	setFlag(name: string, value: boolean | string): void;
	getHandlers(event: string): Hook[];
	/** First handler for an event, or throw if none registered. */
	getHandlerOrThrow(event: string): Hook;
	getTool(name: string): unknown | undefined;
	getCommand(name: string): RecordedCommand | undefined;
	/** Run every handler registered for `event`; return the last defined result. */
	emit(event: string, payload?: unknown, ctx?: unknown): Promise<unknown>;
	/** Invoke a registered command's handler. */
	runCommand(name: string, args?: string, ctx?: ExtensionCommandContext): Promise<void>;
	/** Cast to the host type for `extension(pi.asExtensionAPI())`. */
	asExtensionAPI(): ExtensionAPI;
}

export function createPiMock(
	initialFlags: Record<string, boolean | string> = {},
): PiMock {
	const flags = new Map<string, RecordedFlag>();
	const commands = new Map<string, RecordedCommand>();
	const tools = new Map<string, unknown>();
	const handlers = new Map<string, Hook[]>();
	const flagValues = new Map<string, boolean | string>(
		Object.entries(initialFlags),
	);
	const messageRenderers = new Map<string, unknown>();
	const sentMessages: CapturedMessage[] = [];

	const mock: PiMock = {
		flags,
		commands,
		tools,
		handlers,
		flagValues,
		messageRenderers,
		sentMessages,

		registerFlag(name, options) {
			flags.set(name, options);
			// Seed a default so getFlag is meaningful even if not pre-set.
			if (!flagValues.has(name) && options.default !== undefined) {
				flagValues.set(name, options.default);
			}
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerTool(tool) {
			if (!tool?.name) throw new Error("registerTool: tool has no name");
			if (tools.has(tool.name)) {
				// Mirror the host: a duplicate name throws so callers can catch it.
				throw new Error(`tool already registered: ${tool.name}`);
			}
			tools.set(tool.name, tool);
		},
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getFlag(name) {
			return flagValues.get(name);
		},
		registerMessageRenderer(customType, renderer) {
			messageRenderers.set(customType, renderer);
		},
		sendMessage(message) {
			sentMessages.push({
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
			});
		},

		setFlag(name, value) {
			flagValues.set(name, value);
		},
		getHandlers(event) {
			return handlers.get(event) ?? [];
		},
		getHandlerOrThrow(event) {
			const list = handlers.get(event);
			if (!list || list.length === 0) {
				throw new Error(`no handler registered for event: ${event}`);
			}
			return list[0];
		},
		getTool(name) {
			return tools.get(name);
		},
		getCommand(name) {
			return commands.get(name);
		},
		async emit(event, payload, ctx) {
			let result: unknown;
			for (const handler of mock.getHandlers(event)) {
				const r = await handler(payload, ctx);
				if (r !== undefined) result = r;
			}
			return result;
		},
		async runCommand(name, args = "", ctx = makeCtx()) {
			const cmd = commands.get(name);
			if (!cmd) throw new Error(`no command registered: ${name}`);
			await cmd.handler(args, ctx);
		},
		asExtensionAPI() {
			return mock as unknown as ExtensionAPI;
		},
	};

	return mock;
}

/**
 * A minimal command/handler context. Only the fields pi-lens handlers actually
 * touch are real (`cwd`, `ui.notify`, `ui.setStatus`, `ui.setWidget`,
 * `ui.theme`); the rest are inert stubs. `notifications` captures every
 * `ui.notify(...)` for assertions.
 */
export function makeCtx(
	overrides: Partial<{ cwd: string; sessionId: string }> = {},
): MockCtx {
	const notifications: CapturedNotification[] = [];
	const statusCalls: CapturedStatus[] = [];
	const widgetCalls: CapturedWidget[] = [];
	const ui = {
		notify: (message: string, type: "info" | "warning" | "error" = "info") => {
			notifications.push({ message, type });
		},
		setStatus: (key: string, text: string | undefined) => {
			statusCalls.push({ key, text });
		},
		setWidget: (key: string, content?: unknown, options?: unknown) => {
			widgetCalls.push({ key, content, options });
		},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setTitle: () => {},
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		theme: {},
	};

	const ctx = {
		ui,
		notifications,
		statusCalls,
		widgetCalls,
		mode: "tui",
		hasUI: true,
		cwd: overrides.cwd ?? process.cwd(),
		// Read-only session manager (#190). Tests pass `sessionId` to drive
		// resume rehydration via `ctx.sessionManager.getSessionId()`.
		sessionManager: {
			getSessionId: () => overrides.sessionId,
		},
		model: undefined,
		signal: undefined,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		waitForIdle: async () => {},
	};

	return ctx as unknown as MockCtx;
}
