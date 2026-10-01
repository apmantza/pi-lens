import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	computeVerdict,
	EXIT_DIRTY,
	EXIT_FAILURE,
	EXIT_PENDING,
	EXIT_SUCCESS,
	EXIT_TRANSPORT,
	extractRequiredCheckNames,
	formatVersionTooOldMessage,
	isGhMissingError,
	mapRestMergeableState,
	MIN_GH_TIMEOUT_MS,
	nodeSupportsUseEnvProxy,
	parseOwnerRepoFromGitRemote,
	REEXEC_REEXEC,
	REEXEC_RUN,
	REEXEC_VERSION_TOO_OLD,
	resolveGithubApiBase,
	resolveGithubToken,
	resolveReexecPlan,
	resolveRepositoryViaGit,
	resolveRequiredCheckNames,
	resolveTransport,
	restFetchCheckRunsPayload,
	restResolveHeadSha,
	restResolveRequiredCheckNames,
	run,
	TRANSPORT_GH,
	TRANSPORT_REST,
} from "../../scripts/ci-verdict.mjs";

/**
 * #3497: the REST transport this script uses when `gh` is not on PATH but a
 * `GH_TOKEN`/`GITHUB_TOKEN` is available -- the Claude Code cloud
 * container's own shape (see the module's `TRANSPORT_GH`/`TRANSPORT_REST`
 * doc comment). Lives in its own file rather than `ci-verdict.test.ts`
 * (owned by G19's mutation-lane round, per this batch's brief) -- purely a
 * file-ownership boundary, not a design choice; every case here would sit
 * naturally beside that file's existing `resolveRequiredCheckNames` /
 * `fetchCheckRunsPayload` / `resolveHeadSha` describe blocks.
 *
 * Red-first proof (this repo's own sandbox has no `gh` on PATH, and its
 * session carries a real `GH_TOKEN` via the outbound proxy -- exactly the
 * #3497 incident shape): before any of this file's production code existed,
 *
 *   $ which gh; echo "gh on PATH: $?"
 *   gh on PATH: 1
 *   $ GH_TOKEN=faketoken123 node scripts/ci-verdict.mjs 3497
 *   spawnSync gh ENOENT
 *   EXIT_CODE=70
 *
 * -- today's script exits 70 even with a token set, which is the exact
 * acceptance criterion. `resolveTransport`'s own tests below reproduce this
 * decision as a pure function; the `run()` case further down reproduces it
 * end-to-end with `PATH` genuinely emptied for the duration of the test.
 */

function checkRun({
	name,
	status = "completed",
	conclusion = "success",
	id = 1,
}: {
	name: string;
	status?: string;
	conclusion?: string | null;
	id?: number;
}) {
	return {
		name,
		status,
		conclusion,
		started_at: "2026-09-03T00:00:00Z",
		id,
		html_url: `https://github.com/apmantza/pi-lens/actions/runs/${id}`,
		details_url: `https://github.com/apmantza/pi-lens/actions/runs/${id}/job/${id}`,
	};
}

const REAL_CHECK_RUNS = JSON.parse(
	readFileSync(
		join(process.cwd(), "tests/fixtures/ci-verdict/real-check-runs.json"),
		"utf8",
	),
);

describe("resolveGithubToken (#3497)", () => {
	it("prefers GH_TOKEN over GITHUB_TOKEN, matching gh's own documented precedence", () => {
		expect(
			resolveGithubToken({ GH_TOKEN: "gh-token", GITHUB_TOKEN: "gha-token" }),
		).toBe("gh-token");
	});

	it("falls back to GITHUB_TOKEN when GH_TOKEN is unset", () => {
		expect(resolveGithubToken({ GITHUB_TOKEN: "gha-token" })).toBe("gha-token");
	});

	it("returns null when neither is set, or is set empty", () => {
		expect(resolveGithubToken({})).toBeNull();
		expect(resolveGithubToken({ GH_TOKEN: "", GITHUB_TOKEN: "" })).toBeNull();
	});
});

describe("resolveGithubApiBase (#3497)", () => {
	it("defaults to the public API", () => {
		expect(resolveGithubApiBase({})).toBe("https://api.github.com");
	});

	it("honors GITHUB_API_URL for GitHub Enterprise Server", () => {
		expect(
			resolveGithubApiBase({
				GITHUB_API_URL: "https://ghe.example.com/api/v3",
			}),
		).toBe("https://ghe.example.com/api/v3");
	});
});

describe("isGhMissingError (#3497)", () => {
	it("is true only for an ENOENT-coded Error", () => {
		expect(
			isGhMissingError(Object.assign(new Error("x"), { code: "ENOENT" })),
		).toBe(true);
	});

	it("is false for any other error shape, including a non-Error", () => {
		expect(
			isGhMissingError(Object.assign(new Error("x"), { code: "EACCES" })),
		).toBe(false);
		expect(isGhMissingError(new Error("gh auth login"))).toBe(false);
		expect(isGhMissingError("boom")).toBe(false);
		expect(isGhMissingError(undefined)).toBe(false);
	});
});

describe("parseOwnerRepoFromGitRemote (#3497)", () => {
	it.each([
		["https://github.com/apmantza/pi-lens.git", "apmantza/pi-lens"],
		["https://github.com/apmantza/pi-lens", "apmantza/pi-lens"],
		["git@github.com:apmantza/pi-lens.git", "apmantza/pi-lens"],
		["https://github.com/apmantza/pi-lens.git/", "apmantza/pi-lens"],
	])("parses %s as %s", (remote, expected) => {
		expect(parseOwnerRepoFromGitRemote(remote)).toBe(expected);
	});

	it("returns null for a non-GitHub remote", () => {
		expect(
			parseOwnerRepoFromGitRemote("https://gitlab.com/acme/repo.git"),
		).toBeNull();
	});

	it("returns null for garbage input", () => {
		expect(parseOwnerRepoFromGitRemote("")).toBeNull();
		expect(parseOwnerRepoFromGitRemote(undefined)).toBeNull();
	});
});

describe("resolveRepositoryViaGit (#3497)", () => {
	it("reads owner/repo from `git remote get-url origin`", () => {
		const gitExec = (bin: string, args: string[]) => {
			expect(bin).toBe("git");
			expect(args).toEqual(["remote", "get-url", "origin"]);
			return "https://github.com/apmantza/pi-lens.git\n";
		};
		expect(resolveRepositoryViaGit(gitExec)).toBe("apmantza/pi-lens");
	});

	it("throws when the remote cannot be parsed as owner/repo", () => {
		const gitExec = () => "https://example.com/not-github\n";
		expect(() => resolveRepositoryViaGit(gitExec)).toThrow(/could not parse/);
	});
});

describe("mapRestMergeableState (#3497)", () => {
	it("maps mergeable_state=dirty to CONFLICTING", () => {
		// N2 (verify round): mergeable is null here, not false -- with
		// mergeable: false the F6 clause (mergeable === false) alone already
		// yields CONFLICTING, so neutering THIS clause (mergeable_state ===
		// "dirty") stayed green under the old fixture. A null mergeable
		// isolates the dirty-state clause as the only thing that can pass
		// this assertion.
		expect(
			mapRestMergeableState({ mergeable: null, mergeable_state: "dirty" }),
		).toBe("CONFLICTING");
	});

	it("maps mergeable=true to MERGEABLE", () => {
		expect(
			mapRestMergeableState({ mergeable: true, mergeable_state: "clean" }),
		).toBe("MERGEABLE");
	});

	it.each(["unstable", "blocked", "unknown", "draft", undefined])(
		"maps mergeable_state=%s (mergeable not true) to UNKNOWN",
		(state) => {
			expect(
				mapRestMergeableState({ mergeable: null, mergeable_state: state }),
			).toBe("UNKNOWN");
		},
	);

	// F6 (review round 2): mergeable=false is a genuine merge conflict no
	// matter which mergeable_state string is attached to it -- a conflicted
	// PR reported through a state other than "dirty" (e.g. "draft" for an
	// undrafted-but-unmergeable PR, "blocked" for one branch-protection
	// holds) must not fall through to UNKNOWN and read as fine.
	it.each(["draft", "blocked", "unstable", "unknown", undefined])(
		"maps mergeable=false to CONFLICTING even when mergeable_state=%s (not dirty)",
		(state) => {
			expect(
				mapRestMergeableState({ mergeable: false, mergeable_state: state }),
			).toBe("CONFLICTING");
		},
	);

	it("maps a missing pull request payload to UNKNOWN, not a throw", () => {
		expect(mapRestMergeableState(undefined)).toBe("UNKNOWN");
	});
});

describe("extractRequiredCheckNames (#3497 -- shared by gh and REST)", () => {
	it("prefers checks[].context over the legacy contexts array", () => {
		expect(
			extractRequiredCheckNames({
				checks: [{ context: "Unit tests" }, { context: "Lint & type-check" }],
				contexts: ["stale"],
			}),
		).toEqual(["Unit tests", "Lint & type-check"]);
	});

	it("falls back to contexts when checks is absent or empty", () => {
		expect(extractRequiredCheckNames({ contexts: ["Unit tests"] })).toEqual([
			"Unit tests",
		]);
		expect(
			extractRequiredCheckNames({ checks: [], contexts: ["Unit tests"] }),
		).toEqual(["Unit tests"]);
	});

	it("returns null when nothing usable is present", () => {
		expect(extractRequiredCheckNames({})).toBeNull();
		expect(extractRequiredCheckNames(undefined)).toBeNull();
	});

	// Behavior-preservation proof for the extraction out of
	// `resolveRequiredCheckNames` (#3497): same gh-path inputs must still
	// produce the same output through the call-through, matching the 43
	// pre-existing `resolveRequiredCheckNames` tests in the owned
	// ci-verdict.test.ts (all 132 of that file's tests stayed green after
	// this extraction -- quoted in the PR body).
	it("resolveRequiredCheckNames still returns the identical value through the shared extraction", () => {
		const ghExec = () =>
			JSON.stringify({
				required_status_checks: {
					checks: [{ context: "Unit tests" }, { context: "Lint & type-check" }],
				},
			});
		expect(resolveRequiredCheckNames("acme/repo", ghExec)).toEqual([
			"Unit tests",
			"Lint & type-check",
		]);
	});
});

describe("restResolveHeadSha (#3497)", () => {
	it("resolves a PR number via GET .../pulls/<n>, reading head.sha and mergeable_state", async () => {
		const calls: string[] = [];
		const fetchImpl = async (url: string) => {
			calls.push(url);
			return new Response(
				JSON.stringify({
					head: { sha: "c0ffee" },
					mergeable: true,
					mergeable_state: "clean",
				}),
			);
		};
		const result = await restResolveHeadSha("acme/repo", "2539", {
			token: "tok",
			fetchImpl,
		});
		expect(result).toEqual({ sha: "c0ffee", mergeable: "MERGEABLE" });
		expect(calls).toEqual([
			"https://api.github.com/repos/acme/repo/pulls/2539",
		]);
	});

	it("resolves a bare SHA target with no fetch at all", async () => {
		const fetchImpl = async () => {
			throw new Error("must not fetch for a bare-SHA target");
		};
		const result = await restResolveHeadSha("acme/repo", "abc1234", {
			token: "tok",
			fetchImpl,
		});
		expect(result).toEqual({ sha: "abc1234", mergeable: null });
	});
});

describe("restFetchCheckRunsPayload (#3497)", () => {
	it("reads every page until total_count is covered (parity with fetchCheckRunsPayload's own #3373 fixture)", async () => {
		const calls: string[] = [];
		const fetchImpl = async (url: string) => {
			calls.push(url);
			const page = Number(new URL(url).searchParams.get("page"));
			return new Response(
				JSON.stringify({
					total_count: REAL_CHECK_RUNS.source.total_count,
					check_runs: REAL_CHECK_RUNS.pages[page - 1] ?? [],
				}),
			);
		};
		const payload = await restFetchCheckRunsPayload(
			"apmantza/pi-lens",
			"head",
			{
				token: "tok",
				fetchImpl,
			},
		);
		expect(calls).toEqual([
			"https://api.github.com/repos/apmantza/pi-lens/commits/head/check-runs?per_page=100&page=1",
			"https://api.github.com/repos/apmantza/pi-lens/commits/head/check-runs?per_page=100&page=2",
		]);
		expect(payload.check_runs).toHaveLength(REAL_CHECK_RUNS.source.total_count);
	});

	// The four acceptance-criterion fixtures: computeVerdict must reach the
	// SAME exit code from a REST-shaped payload as it does from the
	// equivalent gh-shaped one (already proven correct by the 132
	// pre-existing ci-verdict.test.ts cases) -- proving the REST fetch
	// function hands computeVerdict an equivalent payload, not a second
	// verdict policy.
	function fetchImplFor(checkRuns: unknown[]) {
		return async () =>
			new Response(
				JSON.stringify({
					total_count: checkRuns.length,
					check_runs: checkRuns,
				}),
			);
	}

	it("green head: both required checks succeed -> EXIT_SUCCESS", async () => {
		const payload = await restFetchCheckRunsPayload("acme/repo", "sha1", {
			token: "tok",
			fetchImpl: fetchImplFor([
				checkRun({ name: "Unit tests", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
			]),
		});
		expect(computeVerdict(payload, undefined, "MERGEABLE").exitCode).toBe(
			EXIT_SUCCESS,
		);
	});

	it("a failed required check -> EXIT_FAILURE", async () => {
		const payload = await restFetchCheckRunsPayload("acme/repo", "sha2", {
			token: "tok",
			fetchImpl: fetchImplFor([
				checkRun({ name: "Unit tests", conclusion: "failure", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
			]),
		});
		expect(computeVerdict(payload, undefined, "MERGEABLE").exitCode).toBe(
			EXIT_FAILURE,
		);
	});

	it("an absent required check (not CONFLICTING) -> EXIT_PENDING", async () => {
		const payload = await restFetchCheckRunsPayload("acme/repo", "sha3", {
			token: "tok",
			fetchImpl: fetchImplFor([checkRun({ name: "Unit tests", id: 1 })]),
		});
		expect(computeVerdict(payload, undefined, "MERGEABLE").exitCode).toBe(
			EXIT_PENDING,
		);
	});

	it("a latest cancelled required run -> EXIT_PENDING, not EXIT_SUCCESS (#3373's own required cancellation shape)", async () => {
		const payload = await restFetchCheckRunsPayload("acme/repo", "sha4", {
			token: "tok",
			fetchImpl: fetchImplFor([
				checkRun({ name: "Unit tests", conclusion: "cancelled", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
			]),
		});
		expect(computeVerdict(payload, undefined, "MERGEABLE").exitCode).toBe(
			EXIT_PENDING,
		);
	});

	it("mutation table row: same shape but CONFLICTING -> EXIT_DIRTY beats the green rows above", async () => {
		const payload = await restFetchCheckRunsPayload("acme/repo", "sha5", {
			token: "tok",
			fetchImpl: fetchImplFor([
				checkRun({ name: "Unit tests", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
			]),
		});
		expect(computeVerdict(payload, undefined, "CONFLICTING").exitCode).toBe(
			EXIT_DIRTY,
		);
	});
});

describe("restResolveRequiredCheckNames (#3497)", () => {
	it("returns the live contexts on a readable branch-protection response", async () => {
		const fetchImpl = async () =>
			new Response(
				JSON.stringify({
					required_status_checks: {
						contexts: ["Unit tests", "Lint & type-check"],
					},
				}),
			);
		expect(
			await restResolveRequiredCheckNames("acme/repo", {
				token: "tok",
				fetchImpl,
			}),
		).toEqual(["Unit tests", "Lint & type-check"]);
	});

	it("returns null on a 403/404, matching the gh path's fail-open contract", async () => {
		const fetchImpl = async () => new Response("", { status: 403 });
		expect(
			await restResolveRequiredCheckNames("acme/repo", {
				token: "tok",
				fetchImpl,
			}),
		).toBeNull();
	});
});

describe("resolveTransport (#3497)", () => {
	it("stays on gh when ghExec is not the module default, regardless of token or probe", () => {
		expect(resolveTransport(false, "tok", () => false)).toBe(TRANSPORT_GH);
	});

	it("stays on gh when the default ghExec is used but no token is set", () => {
		expect(resolveTransport(true, null, () => false)).toBe(TRANSPORT_GH);
	});

	it("stays on gh when the default ghExec is used, a token is set, and gh IS available", () => {
		expect(resolveTransport(true, "tok", () => true)).toBe(TRANSPORT_GH);
	});

	it("switches to REST only when the default ghExec is used, a token is set, and gh is confirmed missing", () => {
		expect(resolveTransport(true, "tok", () => false)).toBe(TRANSPORT_REST);
	});

	// Mutation table (each direction of the AND, per this batch's brief):
	// M1 ghExec-is-default flipped false -> must stay gh (proven above).
	// M2 token flipped absent -> must stay gh (proven above).
	// M3 probe flipped true (gh available) -> must stay gh (proven above).
	// M4 all three conditions hold -> must switch to REST (proven above).
	// A neutered guard (`return TRANSPORT_REST` unconditionally) is proven
	// by the PR body's mutation transcript, not restated here.
});

// F1 (review round 2): Node's global fetch ignores HTTPS_PROXY, and the
// agent proxy in THIS container swaps a placeholder GH_TOKEN for the real
// credential only when the proxy is actually used -- a direct fetch sends
// the placeholder and GitHub returns a real, well-formed 401. Verified
// live, in this session, against the real GitHub API through the real
// proxy (transcripts in the PR body):
//   GH_TOKEN=<placeholder> node -e 'fetch(".../user", {Bearer GH_TOKEN})' -> 401
//   NODE_USE_ENV_PROXY=1 node -e '...same...'                             -> 200
// and the version boundary, via a throwaway `nvm install 22.19.0` (this
// repo's own `engines` floor) in this same session:
//   node --use-env-proxy                        -> "bad option" (flag does not exist)
//   NODE_USE_ENV_PROXY=1 node -e '...same...'    -> still 401 (flag silently ignored)
// matching the agent proxy's own README ("NODE_USE_ENV_PROXY=1 on Node >= 22.21").
//
// N1 (verify round): NOT a simple "any later major" boundary. A second
// throwaway `nvm install 23.11.0` in this same session, same Bearer `fetch`
// probe, with NODE_USE_ENV_PROXY=1 set: still 401 -- Node 23 (never an LTS
// line) silently drops the flag, independent of the verify reviewer's own
// probe across several 23.x/24.x builds (22.21.0 and every 24.x -> 200,
// 23.11.0 -> 401). `major >= 24` is therefore its own explicit clause.
describe("nodeSupportsUseEnvProxy (#3497 F1)", () => {
	it.each(["v22.21.0", "v22.21.5", "v22.22.2", "v24.0.0", "v24.4.1"])(
		"%s is supported",
		(version) => {
			expect(nodeSupportsUseEnvProxy(version)).toBe(true);
		},
	);

	it.each([
		"v22.19.0",
		"v22.20.9",
		"v21.99.0",
		"v20.0.0",
		"v0.1.2",
		"v23.0.0",
		"v23.11.0",
	])(
		"%s (below the probed boundary, or Node 23) is not supported",
		(version) => {
			expect(nodeSupportsUseEnvProxy(version)).toBe(false);
		},
	);

	it("an unparseable version string is not supported", () => {
		expect(nodeSupportsUseEnvProxy("not-a-version")).toBe(false);
		expect(nodeSupportsUseEnvProxy(null)).toBe(false);
		expect(nodeSupportsUseEnvProxy("")).toBe(false);
	});

	it("defaults to process.version (this session's own runtime) when called with no argument", () => {
		expect(nodeSupportsUseEnvProxy()).toBe(
			nodeSupportsUseEnvProxy(process.version),
		);
	});
});

describe("resolveReexecPlan (#3497 F1)", () => {
	const base = {
		usesRestTransport: true,
		proxyUrl: "http://127.0.0.1:46561",
		envProxyFlagAlreadySet: false,
		nodeVersion: "v22.22.2",
	};

	it("re-execs only when REST is used, a proxy is set, the flag isn't set yet, and this Node supports it", () => {
		expect(resolveReexecPlan(base)).toBe(REEXEC_REEXEC);
	});

	it("runs directly when the transport is gh, even with a proxy configured", () => {
		expect(resolveReexecPlan({ ...base, usesRestTransport: false })).toBe(
			REEXEC_RUN,
		);
	});

	it("runs directly when no proxy is configured", () => {
		expect(resolveReexecPlan({ ...base, proxyUrl: null })).toBe(REEXEC_RUN);
	});

	it("runs directly (no re-exec loop) once the flag is already set", () => {
		expect(resolveReexecPlan({ ...base, envProxyFlagAlreadySet: true })).toBe(
			REEXEC_RUN,
		);
	});

	it("reports version-too-old instead of re-execing into a no-op below the boundary", () => {
		expect(resolveReexecPlan({ ...base, nodeVersion: "v22.19.0" })).toBe(
			REEXEC_VERSION_TOO_OLD,
		);
	});

	// Mutation table, one row per condition in the guard:
	// - usesRestTransport flipped false -> RUN (proven above).
	// - proxyUrl flipped null -> RUN (proven above).
	// - envProxyFlagAlreadySet flipped true -> RUN (proven above, and takes
	//   priority over the version check so an already-set flag never routes
	//   to version-too-old by mistake).
	// - nodeVersion below the boundary -> VERSION_TOO_OLD, not REEXEC
	//   (proven above) -- the one direction a naive "just re-exec" fix
	//   would get wrong, silently reproducing F1 on an older Node.
});

// N3 (verify round, security-relevant): the version-too-old message used to
// print HTTPS_PROXY verbatim -- probed live on Node 22.20.0 with
// HTTPS_PROXY=http://alice:s3cretpw@127.0.0.1:9, stderr printed
// "HTTPS_PROXY is set (http://alice:s3cretpw@127.0.0.1:9)". Fixed by
// removing the proxy-URL PARAMETER from the message function entirely
// (`formatVersionTooOldMessage` takes only a Node version), not by trying to
// redact it.
describe("formatVersionTooOldMessage (#3497 N3)", () => {
	const CREDENTIAL_PROXY_URLS = [
		"http://alice:s3cretpw@127.0.0.1:9",
		"http://alice:s3cretpw@127.0.0.1:9999",
		"https://deploy-token-abc123@proxy.internal:8443",
	];

	it("never contains an '@' (no userinfo can appear -- the function takes no URL at all)", () => {
		for (const version of ["v22.20.0", "v22.19.0", "v23.11.0"]) {
			expect(formatVersionTooOldMessage(version)).not.toContain("@");
		}
	});

	it.each(CREDENTIAL_PROXY_URLS)(
		"never echoes a credential-bearing HTTPS_PROXY (%s) even when one is set in the environment around the call",
		(proxyUrl) => {
			const original = process.env.HTTPS_PROXY;
			process.env.HTTPS_PROXY = proxyUrl;
			try {
				const message = formatVersionTooOldMessage("v22.20.0");
				expect(message).not.toContain(proxyUrl);
				expect(message).not.toMatch(/:\/\/[^/\s]+:[^/\s@]+@/); // scheme://user:pass@
				expect(message).not.toContain("s3cretpw");
				expect(message).not.toContain("deploy-token-abc123");
			} finally {
				if (original === undefined) delete process.env.HTTPS_PROXY;
				else process.env.HTTPS_PROXY = original;
			}
		},
	);

	it("still names that HTTPS_PROXY is the reason, and the Node-version requirement, without the value", () => {
		const message = formatVersionTooOldMessage("v22.20.0");
		expect(message).toContain("HTTPS_PROXY is set");
		expect(message).toContain("v22.20.0");
		expect(message).toContain("22.21.0");
	});
});

// N3's broader ask: sweep EVERY other message in these two files for a
// printed env value or URL that could carry a credential. Static, not a
// live probe of every transitive network-error path (that path is safe too
// -- probed separately: a proxy CONNECT failure's `fetch` error carries only
// `ECONNREFUSED <host>:<port>`, never the proxy URL's userinfo, quoted in
// the PR body) -- this guards the SOURCE against a future message
// reintroducing the leak, which a one-time probe cannot.
describe("no message in ci-verdict.mjs or detect-untriaged-issues.mjs prints a raw env value or credential-bearing URL (#3497 N3)", () => {
	const CI_VERDICT_SOURCE = readFileSync(
		join(process.cwd(), "scripts/ci-verdict.mjs"),
		"utf8",
	);
	const DETECT_UNTRIAGED_SOURCE = readFileSync(
		join(process.cwd(), "scripts/detect-untriaged-issues.mjs"),
		"utf8",
	);
	const LABEL_TRIAGE_SOURCE = readFileSync(
		join(process.cwd(), "scripts/lib/label-triage.mjs"),
		"utf8",
	);

	// Every console.error/console.log/stderr(/stdout( call and every `throw
	// new Error(` site, with its full argument list (balanced parens), so a
	// multi-line template literal is captured whole, not truncated at the
	// first newline.
	function messageCallSites(source: string): string[] {
		const sites: string[] = [];
		const callStart =
			/\b(?:console\.(?:error|log|warn)|stderr|stdout|new Error)\s*\(/g;
		for (const match of source.matchAll(callStart)) {
			const start = match.index + match[0].length;
			let depth = 1;
			let end = start;
			while (end < source.length && depth > 0) {
				if (source[end] === "(") depth += 1;
				else if (source[end] === ")") depth -= 1;
				end += 1;
			}
			sites.push(source.slice(start, end));
		}
		return sites;
	}

	// A message is suspect if it directly interpolates the proxy URL
	// variable, a raw `process.env.HTTPS_PROXY`/`https_proxy` read, or a
	// token/credential-shaped env var -- restGet's own Authorization HEADER
	// construction (never a printed message) is deliberately not in this
	// list; that seam is covered by the R4 test instead.
	const SUSPECT =
		/\$\{\s*proxyUrl\s*\}|process\.env\.(?:HTTPS_PROXY|https_proxy|GH_TOKEN|GITHUB_TOKEN)\b/;

	it("scripts/ci-verdict.mjs: no message call site interpolates a proxy URL or a raw token env var", () => {
		const suspects = messageCallSites(CI_VERDICT_SOURCE).filter((site) =>
			SUSPECT.test(site),
		);
		expect(suspects).toEqual([]);
	});

	it("scripts/detect-untriaged-issues.mjs: no message call site interpolates a raw token env var", () => {
		const suspects = messageCallSites(DETECT_UNTRIAGED_SOURCE).filter((site) =>
			SUSPECT.test(site),
		);
		expect(suspects).toEqual([]);
	});

	it("scripts/lib/label-triage.mjs: no message call site interpolates a raw token env var", () => {
		const suspects = messageCallSites(LABEL_TRIAGE_SOURCE).filter((site) =>
			SUSPECT.test(site),
		);
		expect(suspects).toEqual([]);
	});

	it("the sweep's own regex actually catches a planted leak (sanity: the sweep is not vacuous)", () => {
		const planted =
			"console.error(`leaked: ${proxyUrl} and ${process.env.HTTPS_PROXY}`);";
		expect(messageCallSites(planted).some((site) => SUSPECT.test(site))).toBe(
			true,
		);
	});
});

describe("run() — REST transport end to end (#3497)", () => {
	// PATH is genuinely emptied for the probe's real `gh(["--version"])`
	// call, so this reproduces "gh not on PATH" deterministically regardless
	// of whether the CI runner (which DOES carry `gh`, unlike this repo's own
	// sandbox) has it installed. `ghExec` is left at its real default -- not
	// overridden -- which is what makes `resolveTransport`'s
	// `usesDefaultGhExec` check true here, exactly as it is for a real
	// `node scripts/ci-verdict.mjs <target>` invocation.
	async function withEmptyPathAndToken(run_: () => Promise<void>) {
		const originalPath = process.env.PATH;
		const originalGhToken = process.env.GH_TOKEN;
		const originalGithubToken = process.env.GITHUB_TOKEN;
		process.env.PATH = "";
		process.env.GH_TOKEN = "test-token";
		delete process.env.GITHUB_TOKEN;
		try {
			await run_();
		} finally {
			process.env.PATH = originalPath;
			if (originalGhToken === undefined) delete process.env.GH_TOKEN;
			else process.env.GH_TOKEN = originalGhToken;
			if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = originalGithubToken;
		}
	}

	it("uses the REST transport, reaches the same verdict a green gh read would, and names the transport", async () => {
		const gitExec = (bin: string, args: string[]) => {
			expect(bin).toBe("git");
			expect(args).toEqual(["remote", "get-url", "origin"]);
			return "https://github.com/acme/repo.git\n";
		};
		const fetchImpl = async (url: string) => {
			if (url.includes("/pulls/2539")) {
				return new Response(
					JSON.stringify({
						head: { sha: "c0ffee" },
						mergeable: true,
						mergeable_state: "clean",
					}),
				);
			}
			if (url.includes("/branches/master/protection")) {
				return new Response("", { status: 403 });
			}
			return new Response(
				JSON.stringify({
					total_count: 2,
					check_runs: [
						checkRun({ name: "Unit tests", id: 1 }),
						checkRun({ name: "Lint & type-check", id: 2 }),
					],
				}),
			);
		};
		const stdoutLines: string[] = [];
		let result: { code: number; kind: string } | undefined;
		await withEmptyPathAndToken(async () => {
			result = await run({
				argv: ["2539"],
				gitExec,
				fetchImpl,
				stdout: (line: string) => stdoutLines.push(line),
				stderr: () => {},
			});
		});
		expect(result?.code).toBe(EXIT_SUCCESS);
		expect(stdoutLines).toContain("Transport: rest");
		expect(stdoutLines.join("\n")).toContain("acme/repo@c0ffee");
	});

	// #3700: the failed-job log read is `gh api --allow-escape-sequences`, which
	// this transport has no REST twin for. A red head must still exit 1 with the
	// plain table -- not spawn a `gh` that is not there and print its ENOENT as
	// a note under every failed row.
	it("a red head on the REST transport exits 1 without trying to read job logs through gh", async () => {
		const gitExec = () => "https://github.com/acme/repo.git\n";
		const fetchImpl = async (url: string) => {
			if (url.includes("/pulls/2539")) {
				return new Response(
					JSON.stringify({
						head: { sha: "c0ffee" },
						mergeable: true,
						mergeable_state: "clean",
					}),
				);
			}
			if (url.includes("/branches/master/protection")) {
				return new Response("", { status: 403 });
			}
			return new Response(
				JSON.stringify({
					total_count: 2,
					check_runs: [
						checkRun({ name: "Unit tests", id: 1, conclusion: "failure" }),
						checkRun({ name: "Lint & type-check", id: 2 }),
					],
				}),
			);
		};
		const stdoutLines: string[] = [];
		let result: { code: number; kind: string } | undefined;
		await withEmptyPathAndToken(async () => {
			result = await run({
				argv: ["2539"],
				gitExec,
				fetchImpl,
				stdout: (line: string) => stdoutLines.push(line),
				stderr: () => {},
			});
		});
		expect(result?.code).toBe(EXIT_FAILURE);
		expect(result?.kind).toBe("red");
		expect(stdoutLines).toContain("Transport: rest");
		expect(stdoutLines.join("\n")).not.toContain("failed step");
		expect(stdoutLines.join("\n")).not.toContain("could not read the job");
		// #3779: the MUTATION line reads a PR comment through `gh` only; the REST
		// transport adds no network path for it.
		expect(stdoutLines.join("\n")).not.toContain("MUTATION");
	});

	it("still exits 70 when gh is missing and NO token is set (unchanged acceptance case)", async () => {
		const originalPath = process.env.PATH;
		const originalGhToken = process.env.GH_TOKEN;
		const originalGithubToken = process.env.GITHUB_TOKEN;
		process.env.PATH = "";
		delete process.env.GH_TOKEN;
		delete process.env.GITHUB_TOKEN;
		let result: { code: number; kind: string } | undefined;
		try {
			result = await run({
				argv: ["2539"],
				stdout: () => {},
				stderr: () => {},
			});
		} finally {
			process.env.PATH = originalPath;
			if (originalGhToken === undefined) delete process.env.GH_TOKEN;
			else process.env.GH_TOKEN = originalGhToken;
			if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = originalGithubToken;
		}
		expect(result?.code).toBe(EXIT_TRANSPORT);
	});

	function fakeClock(start = 0) {
		let now = start;
		const sleeps: number[] = [];
		return {
			now: () => now,
			sleepImpl: async (ms: number) => {
				sleeps.push(ms);
				now += ms;
			},
			sleeps,
		};
	}

	// F3 (review round 2): restGet's failure contract had NO test coverage --
	// five mutations (the !response.ok check, the ETIMEDOUT mapping, the
	// Authorization header, the connect-error stderr text, and the
	// `HTTP ${status}` text --wait's retry depends on) all stayed green. The
	// R1 direction matters most: with `!response.ok` neutered, a 401 or 403
	// falls through to a normal (if malformed) payload parse instead of
	// throwing, and `run()` would misread it the same way #3491's
	// `check_suite.completed` wake was misread -- silent PENDING, not a
	// loud transport failure.
	it("R1: a 401 on the PR lookup exits 70 with the status in stderr, never a silent pending read", async () => {
		const gitExec = () => "https://github.com/acme/repo.git\n";
		const fetchImpl = async () =>
			new Response(JSON.stringify({ message: "Bad credentials" }), {
				status: 401,
			});
		const stderrLines: string[] = [];
		let result: { code: number; kind: string } | undefined;
		await withEmptyPathAndToken(async () => {
			result = await run({
				argv: ["2539"],
				gitExec,
				fetchImpl,
				stdout: () => {},
				stderr: (line: string) => stderrLines.push(line),
			});
		});
		expect(result?.code).toBe(EXIT_TRANSPORT);
		expect(result?.code).not.toBe(EXIT_PENDING);
		expect(stderrLines.join("\n")).toContain("401");
	});

	it("R6: a 502 on the check-runs read retries under --wait (the transient-retry line prints), then exits 70 once the budget is exhausted", async () => {
		const clock = fakeClock();
		const stderrLines: string[] = [];
		const gitExec = () => "https://github.com/acme/repo.git\n";
		const fetchImpl = async (url: string) => {
			if (url.includes("/pulls/2539")) {
				return new Response(
					JSON.stringify({
						head: { sha: "c0ffee" },
						mergeable: true,
						mergeable_state: "clean",
					}),
				);
			}
			if (url.includes("/branches/master/protection")) {
				return new Response("", { status: 403 });
			}
			return new Response("Bad Gateway", { status: 502 });
		};
		let result: { code: number; kind: string } | undefined;
		await withEmptyPathAndToken(async () => {
			result = await run({
				argv: ["2539", "--wait", "65"],
				gitExec,
				fetchImpl,
				stdout: () => {},
				stderr: (line: string) => stderrLines.push(line),
				now: clock.now,
				sleepImpl: clock.sleepImpl,
			});
		});
		expect(result?.code).toBe(EXIT_TRANSPORT);
		expect(stderrLines.some((line) => /transient/i.test(line))).toBe(true);
		expect(stderrLines.some((line) => /HTTP 502/.test(line))).toBe(true);
		expect(clock.sleeps.length).toBeGreaterThan(0);
	});

	it("R3: an AbortError from fetchImpl maps to ETIMEDOUT, matching gh's own hung-process code", async () => {
		const fetchImpl = async () => {
			const error = new Error("The operation was aborted");
			error.name = "AbortError";
			throw error;
		};
		await expect(
			restFetchCheckRunsPayload("acme/repo", "sha", {
				token: "tok",
				fetchImpl,
			}),
		).rejects.toMatchObject({ code: "ETIMEDOUT" });
	});

	it("R3: a TimeoutError (AbortSignal.timeout's own name) also maps to ETIMEDOUT", async () => {
		const fetchImpl = async () => {
			const error = new Error("The operation timed out");
			error.name = "TimeoutError";
			throw error;
		};
		await expect(
			restFetchCheckRunsPayload("acme/repo", "sha", {
				token: "tok",
				fetchImpl,
			}),
		).rejects.toMatchObject({ code: "ETIMEDOUT" });
	});

	it("R4: every restGet call carries the Bearer token, never a bare or missing Authorization header", async () => {
		const seenAuthHeaders: Array<string | undefined> = [];
		const fetchImpl = async (_url: string, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string>;
			seenAuthHeaders.push(headers.Authorization);
			return new Response(JSON.stringify({ total_count: 0, check_runs: [] }));
		};
		await restFetchCheckRunsPayload("acme/repo", "sha", {
			token: "sekrit-token",
			fetchImpl,
		});
		expect(seenAuthHeaders).toEqual(["Bearer sekrit-token"]);
	});
});

// Sanity: MIN_GH_TIMEOUT_MS is re-imported here (used nowhere else in this
// file) purely so a future accidental removal of the export from
// ci-verdict.mjs breaks this file's import too, not just the owned suite.
describe("shared exports stay importable", () => {
	it("MIN_GH_TIMEOUT_MS is a small positive number", () => {
		expect(MIN_GH_TIMEOUT_MS).toBeGreaterThan(0);
		expect(MIN_GH_TIMEOUT_MS).toBeLessThan(60_000);
	});
});
