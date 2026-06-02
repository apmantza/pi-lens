import type { AgentBehaviorClient } from "./agent-behavior-client.js";
import type { BiomeClient } from "./biome-client.js";
import type { ComplexityClient } from "./complexity-client.js";
import type { DependencyChecker } from "./dependency-checker.js";
import type { GitleaksClient } from "./gitleaks-client.js";
import type { GoClient } from "./go-client.js";
import type { GovulncheckClient } from "./govulncheck-client.js";
import type { JscpdClient } from "./jscpd-client.js";
import type { KnipClient } from "./knip-client.js";
import type { MetricsClient } from "./metrics-client.js";
import type { RuffClient } from "./ruff-client.js";
import type { RustClient } from "./rust-client.js";
import type { TestRunnerClient } from "./test-runner-client.js";
import type { TodoScanner } from "./todo-scanner.js";
import type { TypeCoverageClient } from "./type-coverage-client.js";

export interface BootstrapClients {
	ruffClient: RuffClient;
	biomeClient: BiomeClient;
	knipClient: KnipClient;
	todoScanner: TodoScanner;
	jscpdClient: JscpdClient;
	typeCoverageClient: TypeCoverageClient;
	depChecker: DependencyChecker;
	testRunnerClient: TestRunnerClient;
	metricsClient: MetricsClient;
	complexityClient: ComplexityClient;
	goClient: GoClient;
	govulncheckClient: GovulncheckClient;
	gitleaksClient: GitleaksClient;
	rustClient: RustClient;
	agentBehaviorClient: AgentBehaviorClient;
}

let bootstrapPromise: Promise<BootstrapClients> | null = null;

export function loadBootstrapClients(): Promise<BootstrapClients> {
	bootstrapPromise ??= (async () => {
		const [
			ruffMod,
			biomeMod,
			knipMod,
			todoMod,
			jscpdMod,
			typeCoverageMod,
			depCheckerMod,
			testRunnerMod,
			metricsMod,
			complexityMod,
			goMod,
			govulncheckMod,
			gitleaksMod,
			rustMod,
			agentBehaviorMod,
		] = await Promise.all([
			import("./ruff-client.js"),
			import("./biome-client.js"),
			import("./knip-client.js"),
			import("./todo-scanner.js"),
			import("./jscpd-client.js"),
			import("./type-coverage-client.js"),
			import("./dependency-checker.js"),
			import("./test-runner-client.js"),
			import("./metrics-client.js"),
			import("./complexity-client.js"),
			import("./go-client.js"),
			import("./govulncheck-client.js"),
			import("./gitleaks-client.js"),
			import("./rust-client.js"),
			import("./agent-behavior-client.js"),
		]);

		return {
			ruffClient: new ruffMod.RuffClient(),
			biomeClient: new biomeMod.BiomeClient(),
			knipClient: new knipMod.KnipClient(),
			todoScanner: new todoMod.TodoScanner(),
			jscpdClient: new jscpdMod.JscpdClient(),
			typeCoverageClient: new typeCoverageMod.TypeCoverageClient(),
			depChecker: new depCheckerMod.DependencyChecker(),
			testRunnerClient: new testRunnerMod.TestRunnerClient(),
			metricsClient: new metricsMod.MetricsClient(),
			complexityClient: new complexityMod.ComplexityClient(),
			goClient: new goMod.GoClient(),
			govulncheckClient: new govulncheckMod.GovulncheckClient(),
			gitleaksClient: new gitleaksMod.GitleaksClient(),
			rustClient: new rustMod.RustClient(),
			agentBehaviorClient: new agentBehaviorMod.AgentBehaviorClient(),
		};
	})();

	return bootstrapPromise;
}
