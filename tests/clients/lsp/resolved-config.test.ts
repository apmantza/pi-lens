import { afterEach, describe, expect, it } from "vitest";
import {
	registerRunnerId,
	resetRunnerIdentityForTests,
} from "../../../clients/dispatch/known-runner-ids.js";
import {
	resolveLspConfig,
	type ResolvedLspConfig,
} from "../../../clients/lsp/resolved-config.js";

const project = (value: unknown) => ({
	tier: "project" as const,
	file: "/workspace/.pi-lens.json",
	value,
});

afterEach(() => resetRunnerIdentityForTests());

describe("ResolvedLspConfig compatibility normalizer (#2416)", () => {
	it("defaults an omitted canonical name from the server id", () => {
		const result = resolveLspConfig({
			sources: [
				project({
					lsp: { servers: { rust: { command: ["rust-analyzer"] } } },
				}),
			],
		});
		expect(result.value.servers.rust.name).toBe("rust");
		expect(result.value.servers.rust.command).toEqual(["rust-analyzer"]);
	});

	it("keeps reserved server fields inert in the normalized model", () => {
		const result = resolveLspConfig({
			sources: [
				project({
					lsp: {
						servers: {
							rust: {
								command: ["rust-analyzer"],
								reservedFutureField: "must-not-become-runtime-state",
							},
						},
					},
				}),
			],
		});
		expect(result.value.servers.rust).not.toHaveProperty("reservedFutureField");
	});

	it("normalizes legacy string command plus args to identical argv", () => {
		const result = resolveLspConfig({
			sources: [
				project({
					servers: { rust: { command: "rust-analyzer", args: ["--stdio"] } },
				}),
			],
		});
		expect(result.value.servers.rust.command).toEqual([
			"rust-analyzer",
			"--stdio",
		]);
	});

	it("keeps a commandless disabled built-in entry as an override", () => {
		const result = resolveLspConfig({
			sources: [project({ lsp: { servers: { rust: { enabled: false } } } })],
		});
		expect(result.value.servers.rust.kind).toBe("override");
		expect(result.value.servers.rust.enabled).toBe(false);
	});

	it("canonical layout wins a root collision and records one migration row", () => {
		const result = resolveLspConfig({
			sources: [
				project({
					servers: { rust: { command: "legacy" } },
					lsp: { servers: { rust: { command: ["canonical"] } } },
				}),
			],
		});
		expect(result.value.servers.rust.command).toEqual(["canonical"]);
		expect(
			result.records.filter((record) => record.code === "PILENS_CFG_0002"),
		).toHaveLength(1);
	});

	it("rejects malformed process fields before a runtime registration seam", () => {
		const result = resolveLspConfig({
			sources: [
				project({
					lsp: {
						servers: {
							bad: {
								command: [],
								extensions: [42],
								rootMarkers: [false],
								env: { TOKEN: 42 },
								initializationOptions: [],
							},
						},
					},
				}),
			],
		});
		expect(result.value.servers.bad).toBeUndefined();
		expect(
			result.records.filter((record) => record.code === "PILENS_CFG_0005")
				.length,
		).toBeGreaterThanOrEqual(1);
	});

	it("does not let project input clear global disabled servers", () => {
		const result = resolveLspConfig({
			sources: [
				{
					...project({ lsp: { disabledServers: ["rust"] } }),
					tier: "global" as const,
					file: "/home/.pi-lens/config.json",
				},
				project({ lsp: { disabledServers: [] } }),
			],
		});
		expect(result.value.disabledServers).toEqual(["rust"]);
	});

	it("drops only unknown covers claims and retains the server", () => {
		registerRunnerId("shellcheck");
		const result = resolveLspConfig({
			sources: [
				project({
					lsp: {
						servers: {
							rust: {
								command: ["rust-analyzer"],
								covers: ["shellcheck", "unknown-runner"],
							},
						},
					},
				}),
			],
		});
		expect(result.value.servers.rust).toMatchObject({
			command: ["rust-analyzer"],
		});
		expect(result.value.servers.rust.covers).toEqual(["shellcheck"]);
	});

	it("uses the legacy-file migration code and canonical destination", () => {
		const result = resolveLspConfig({
			sources: [
				{
					tier: "project",
					file: "/workspace/.pi-lens/lsp.json",
					value: { servers: { rust: { command: ["rust-analyzer"] } } },
				},
			],
		});
		expect(result.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "PILENS_CFG_0003",
					key: "servers",
					canonicalKey: "lsp.servers",
				}),
			]),
		);
		expect(result.records).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "PILENS_CFG_0002", key: "servers" }),
			]),
		);
	});

	it("bounds normalizer records with the requested cap", () => {
		const servers = Object.fromEntries(
			Array.from({ length: 30 }, (_, index) => [
				`bad${index}`,
				{ command: [] },
			]),
		);
		const result = resolveLspConfig({
			sources: [project({ lsp: { servers } })],
			maxRecords: 1,
		});
		expect(result.records).toHaveLength(1);
	});

	it("sanitizes a control-bearing server id in diagnostic records", () => {
		const id = "bad\nghp_abcdefghijklmnopqrst";
		const result = resolveLspConfig({
			sources: [project({ lsp: { servers: { [id]: { command: [] } } } })],
		});
		const record = result.records.find(
			(entry) => entry.code === "PILENS_CFG_0005",
		);
		expect(record?.key).toBe(
			"/lsp/servers/bad [REDACTED:github-token]/command",
		);
		expect(record?.subject).not.toContain("\n");
		expect(record?.subject).not.toContain("ghp_abcdefghijklmnopqrst");
	});

	it("publishes a tiered schema artifact matching the runtime schema", async () => {
		const [{ PI_LENS_CONFIG_SCHEMA }, fs, path] = await Promise.all([
			import("../../../clients/config-schema.js"),
			import("node:fs/promises"),
			import("node:path"),
		]);
		const artifact = JSON.parse(
			await fs.readFile(
				path.resolve(
					import.meta.dirname,
					"../../../docs/schema/pi-lens-config-v1.json",
				),
				"utf8",
			),
		);
		expect(artifact).toEqual(PI_LENS_CONFIG_SCHEMA);
	});
});

void (undefined as unknown as ResolvedLspConfig);
