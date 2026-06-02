import { describe, expect, it } from "vitest";
import { parseGovulncheckJson } from "../../clients/govulncheck-client.js";

describe("parseGovulncheckJson (#132)", () => {
	it("returns an empty list for empty / whitespace input", () => {
		expect(parseGovulncheckJson("")).toEqual([]);
		expect(parseGovulncheckJson("   \n\n\t ")).toEqual([]);
	});

	it("returns an empty list when the stream contains only progress / config records", () => {
		const stream = [
			JSON.stringify({ config: { protocol_version: "v1.0.0" } }),
			JSON.stringify({ progress: { message: "Scanning..." } }),
		].join("\n");
		expect(parseGovulncheckJson(stream)).toEqual([]);
	});

	it("extracts a single reachable finding with module + fix + trace + summary from a normal stream", () => {
		const stream = [
			JSON.stringify({ config: { protocol_version: "v1.0.0" } }),
			JSON.stringify({
				osv: {
					id: "GO-2024-1234",
					summary: "Path traversal in archive/tar",
					details: "Details here",
					database_specific: {
						url: "https://pkg.go.dev/vuln/GO-2024-1234",
					},
					affected: [
						{
							package: { name: "archive/tar" },
							ranges: [
								{ events: [{ introduced: "0" }, { fixed: "1.21.5" }] },
							],
						},
					],
				},
			}),
			JSON.stringify({
				finding: {
					osv: "GO-2024-1234",
					fixed_version: "1.21.5",
					trace: [
						{
							module: "archive/tar",
							package: "archive/tar",
							function: "extract",
							position: {
								filename: "/proj/cmd/main.go",
								line: 42,
							},
						},
					],
				},
			}),
		].join("\n");

		const findings = parseGovulncheckJson(stream);
		expect(findings).toHaveLength(1);
		const f = findings[0];
		expect(f.osv).toBe("GO-2024-1234");
		expect(f.module).toBe("archive/tar");
		expect(f.fixedVersion).toBe("1.21.5");
		expect(f.summary).toBe("Path traversal in archive/tar");
		expect(f.url).toBe("https://pkg.go.dev/vuln/GO-2024-1234");
		expect(f.trace).toHaveLength(1);
		expect(f.trace[0]).toMatchObject({
			module: "archive/tar",
			packageName: "archive/tar",
			functionName: "extract",
			filename: "/proj/cmd/main.go",
			line: 42,
		});
	});

	it("deduplicates findings by OSV id when govulncheck reports the same CVE from multiple call sites", () => {
		const stream = [
			JSON.stringify({
				osv: {
					id: "GO-2024-9999",
					summary: "Affects net/http",
					affected: [
						{
							package: { name: "net/http" },
							ranges: [{ events: [{ fixed: "1.22.0" }] }],
						},
					],
				},
			}),
			JSON.stringify({
				finding: {
					osv: "GO-2024-9999",
					trace: [
						{
							module: "net/http",
							package: "net/http",
							function: "ServeMux.Handler",
							position: { filename: "/proj/a.go", line: 10 },
						},
					],
				},
			}),
			JSON.stringify({
				finding: {
					osv: "GO-2024-9999",
					trace: [
						{
							module: "net/http",
							package: "net/http",
							function: "ServeMux.Handle",
							position: { filename: "/proj/b.go", line: 20 },
						},
					],
				},
			}),
		].join("\n");

		const findings = parseGovulncheckJson(stream);
		// One finding, even though two call sites reached the CVE. The first
		// trace wins (call-site attribution preserved).
		expect(findings).toHaveLength(1);
		expect(findings[0].trace[0].filename).toBe("/proj/a.go");
	});

	it("tolerates records concatenated without newlines (govulncheck doesn't strictly NDJSON)", () => {
		const stream =
			JSON.stringify({ config: {} }) +
			JSON.stringify({
				osv: {
					id: "GO-2024-5555",
					affected: [
						{
							package: { name: "encoding/json" },
							ranges: [{ events: [{ fixed: "1.20.0" }] }],
						},
					],
				},
			}) +
			JSON.stringify({
				finding: {
					osv: "GO-2024-5555",
					trace: [
						{
							position: { filename: "/proj/x.go", line: 5 },
						},
					],
				},
			});

		const findings = parseGovulncheckJson(stream);
		expect(findings).toHaveLength(1);
		expect(findings[0].osv).toBe("GO-2024-5555");
	});

	it("tolerates findings without matching OSV metadata (still surfaces the OSV id + trace)", () => {
		// govulncheck always emits the OSV record before its finding, but if
		// the stream is truncated mid-scan we should still surface what we have.
		const stream = JSON.stringify({
			finding: {
				osv: "GO-2024-7777",
				trace: [
					{
						position: { filename: "/proj/y.go", line: 99 },
					},
				],
			},
		});

		const findings = parseGovulncheckJson(stream);
		expect(findings).toHaveLength(1);
		expect(findings[0].osv).toBe("GO-2024-7777");
		expect(findings[0].fixedVersion).toBeUndefined();
		expect(findings[0].summary).toBeUndefined();
	});

	it("ignores malformed JSON objects in the stream rather than failing the whole scan", () => {
		const stream = [
			"{not valid json",
			JSON.stringify({
				osv: {
					id: "GO-2024-1111",
					affected: [
						{
							package: { name: "io" },
							ranges: [{ events: [{ fixed: "1.21.0" }] }],
						},
					],
				},
			}),
			JSON.stringify({
				finding: {
					osv: "GO-2024-1111",
					trace: [{ position: { filename: "/proj/z.go", line: 1 } }],
				},
			}),
		].join("\n");

		const findings = parseGovulncheckJson(stream);
		expect(findings).toHaveLength(1);
		expect(findings[0].osv).toBe("GO-2024-1111");
	});
});
