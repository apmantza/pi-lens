/**
 * Centralized accessor for `@earendil-works/pi-tui`. See ./typescript.ts for the
 * rationale. (pi-tui is a pi-bundled core package, host-provided at runtime.)
 *
 * Re-export named bindings, not `export *`: with the package kept external, a
 * wildcard re-export leaves the namespace undefined at runtime under the bundle.
 */
export { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
export type { Component } from "@earendil-works/pi-tui";
