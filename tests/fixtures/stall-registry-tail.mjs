// #5745 r5 F5: preloaded through NODE_OPTIONS into an MCP host and the fresh
// worker it forks. It queues a registry write that never lands ahead of the
// process's own, so the worker's exit join reaches its bound.
import { queueRegistryMutation } from "../../clients/instance-registry-tail.js";

void queueRegistryMutation(() => new Promise(() => {}));
