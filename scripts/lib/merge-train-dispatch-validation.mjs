import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const PR_NUMBER_PATTERN = /^[1-9][0-9]*$/;

function validationError(message) {
	return new Error(`merge-train dispatch validation: ${message}`);
}

async function readJson(response, label) {
	if (!response.ok)
		throw validationError(`${label} API returned HTTP ${response.status}`);
	try {
		return await response.json();
	} catch {
		throw validationError(`${label} API returned invalid JSON`);
	}
}

/**
 * Validate the untrusted repository_dispatch envelope before any downstream
 * checkout or repository action. The fetcher is the network boundary, so this
 * seam can execute the same authenticated API policy in tests and in CI.
 */
export async function validateMergeTrainDispatch({
	fetcher,
	repository,
	payloadRepository,
	payloadSha,
	payloadPrNumber,
	token,
	masterRef = "master",
}) {
	if (payloadRepository !== repository)
		throw validationError("repository does not match this repository");
	if (typeof payloadSha !== "string" || !SHA_PATTERN.test(payloadSha))
		throw validationError("SHA must be a 40-hex commit");
	if (
		(typeof payloadPrNumber !== "number" &&
			typeof payloadPrNumber !== "string") ||
		!PR_NUMBER_PATTERN.test(String(payloadPrNumber))
	)
		throw validationError("PR number must be a positive integer");
	if (typeof token !== "string" || token.length === 0)
		throw validationError("GitHub token is missing");

	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
	};
	const compareResponse = await fetcher(
		`https://api.github.com/repos/${repository}/compare/${payloadSha}...${masterRef}`,
		{ headers },
	);
	const compare = await readJson(compareResponse, "ancestry");
	if (compare.status !== "ahead" && compare.status !== "identical")
		throw validationError("SHA is not an ancestor of master");

	const commitResponse = await fetcher(
		`https://api.github.com/repos/${repository}/commits/${payloadSha}`,
		{ headers },
	);
	const commit = await readJson(commitResponse, "commit resolution");
	if (
		typeof commit.sha !== "string" ||
		commit.sha.toLowerCase() !== payloadSha.toLowerCase()
	)
		throw validationError("GitHub did not resolve the payload SHA exactly");

	return {
		repository,
		sha: commit.sha,
		prNumber: Number(payloadPrNumber),
	};
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
	try {
		const result = await validateMergeTrainDispatch({
			fetcher: globalThis.fetch,
			repository: process.env.GITHUB_REPOSITORY,
			payloadRepository: process.env.PAYLOAD_REPOSITORY,
			payloadSha: process.env.PAYLOAD_SHA,
			payloadPrNumber: process.env.PAYLOAD_PR_NUMBER,
			token: process.env.GITHUB_TOKEN,
		});
		console.log(`Validated ${result.sha} as an ancestor of master`);
	} catch (error) {
		console.error(
			`::error::${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	}
}
