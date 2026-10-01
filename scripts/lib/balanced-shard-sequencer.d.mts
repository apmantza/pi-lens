import type { TestSpecification } from "vitest/node";
import { BaseSequencer } from "vitest/node";

export declare class BalancedShardSequencer extends BaseSequencer {
	shard(files: TestSpecification[]): Promise<TestSpecification[]>;
}
