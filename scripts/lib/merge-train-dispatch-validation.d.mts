export interface DispatchValidationOptions {
	fetcher: (
		url: string,
		init?: { headers?: Record<string, string> },
	) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
	repository: string;
	payloadRepository: unknown;
	payloadSha: unknown;
	payloadPrNumber: unknown;
	token: unknown;
	masterRef?: string;
}

export function validateMergeTrainDispatch(
	options: DispatchValidationOptions,
): Promise<{ repository: string; sha: string; prNumber: number }>;
