#!/usr/bin/env node
// Records which package-lock.json this node_modules was installed from, so the
// Vitest global setup can warn when a shared install is stale (#3694).
//
// Runs from `prepare`, after npm has populated node_modules. It must NEVER fail
// `prepare`: when node_modules is absent (a git-dependency install, a pruned
// tree) there is nothing to stamp, and a stamp is a hint, not a build product.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/is-main-module.mjs";

export const STAMP_NAME = ".pi-lens-package-lock-sha256";

/**
 * @param {string} root Repository root (the directory holding package-lock.json).
 * @returns {"stamped"|"no-node-modules"|"failed"}
 */
export function stampPackageLock(root) {
	const nodeModules = path.join(root, "node_modules");
	if (!existsSync(nodeModules)) return "no-node-modules";
	try {
		const hash = createHash("sha256")
			.update(readFileSync(path.join(root, "package-lock.json")))
			.digest("hex");
		writeFileSync(path.join(nodeModules, STAMP_NAME), `${hash}\n`);
		return "stamped";
	} catch {
		return "failed";
	}
}

if (isMainModule(import.meta.url)) {
	stampPackageLock(fileURLToPath(new URL("../", import.meta.url)));
}
