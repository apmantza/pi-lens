/**
 * Centralized accessor for `typebox`. See ./typescript.ts for the rationale.
 * (typebox is a pi-bundled core package, so it resolves from the host at
 * runtime — but it's still routed through here for a uniform dep surface.)
 */
export * from "typebox";
