type Provider = Record<string, unknown>;

export default function scriptedProvider(pi: {
	registerProvider(name: string, provider: Provider): void;
}): void;
