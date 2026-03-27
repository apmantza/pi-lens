/**
 * Auto-loop engine for pi-lens fix and refactor commands.
 *
 * Provides automatic iteration without requiring the user to manually
 * re-run the command each time. Uses pi's event system (agent_end)
 * to trigger the next iteration automatically.
 *
 * Flow:
 * 1. Agent or user starts loop (e.g., "/lens-booboo-fix --loop")
 * 2. handleFix runs, generates plan, sends via sendUserMessage
 * 3. Agent sees plan and applies fixes
 * 4. agent_end fires → auto-loop checks for more work
 * 5. If more work: sends follow-up "run /lens-booboo-fix --loop again"
 * 6. Repeat until done or max iterations
 *
 * Inspired by pi-review-loop's event-driven approach.
 */
export function createAutoLoop(pi, config) {
    let state = {
        active: false,
        iteration: 0,
        maxIterations: config.maxIterations,
    };
    const updateStatus = (ctx) => {
        if (state.active) {
            ctx.ui.setStatus(`loop-${config.name}`, `${config.name} (${state.iteration + 1}/${state.maxIterations})`);
        }
        else {
            ctx.ui.setStatus(`loop-${config.name}`, undefined);
        }
    };
    const start = (ctx) => {
        if (state.active) {
            ctx.ui.notify(`${config.name} loop is already running`, "warning");
            return;
        }
        state = {
            active: true,
            iteration: 0,
            maxIterations: config.maxIterations,
        };
        updateStatus(ctx);
        ctx.ui.notify(`🔄 Starting ${config.name} auto-loop (max ${state.maxIterations} iterations)...`, "info");
        // First iteration is triggered by the command itself
        // The agent_end handler will handle subsequent iterations
    };
    const stop = (ctx, reason) => {
        const wasActive = state.active;
        state = { active: false, iteration: 0, maxIterations: config.maxIterations };
        updateStatus(ctx);
        if (wasActive) {
            ctx.ui.notify(`✅ ${config.name} loop ${reason}`, "info");
        }
    };
    const complete = (ctx, reason) => {
        stop(ctx, reason);
    };
    const getState = () => ({ ...state });
    const incrementIteration = () => {
        state.iteration++;
    };
    // --- Event Handlers ---
    // Handle user interruption (any manual input stops the loop)
    pi.on("input", async (event, ctx) => {
        if (!ctx.hasUI)
            return { action: "continue" };
        if (!state.active)
            return { action: "continue" };
        // User typed something manually → stop the auto-loop
        if (event.source === "interactive") {
            stop(ctx, "stopped (user interrupted)");
        }
        return { action: "continue" };
    });
    // Handle end of agent turn → check if we should continue
    pi.on("agent_end", async (event, ctx) => {
        if (!ctx.hasUI)
            return;
        if (!state.active)
            return;
        const assistantMessages = event.messages.filter((m) => m.role === "assistant");
        const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];
        if (!lastAssistantMessage) {
            stop(ctx, "stopped (no response)");
            return;
        }
        const textContent = lastAssistantMessage.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
        if (!textContent.trim()) {
            stop(ctx, "stopped (empty response)");
            return;
        }
        // Check for completion patterns (explicit success)
        if (config.completionPatterns) {
            const hasCompletion = config.completionPatterns.some((p) => p.test(textContent));
            if (hasCompletion) {
                complete(ctx, "completed successfully");
                return;
            }
        }
        // Check for exit patterns (could be success or stopped)
        const hasExit = config.exitPatterns.some((p) => p.test(textContent));
        if (hasExit) {
            complete(ctx, "completed - no more work");
            return;
        }
        // Check max iterations
        incrementIteration();
        if (state.iteration >= state.maxIterations) {
            stop(ctx, `stopped (max iterations ${state.maxIterations} reached)`);
            return;
        }
        // Continue to next iteration - send command as follow-up
        updateStatus(ctx);
        pi.sendUserMessage(`🔄 Auto-loop iteration ${state.iteration + 1}/${state.maxIterations}. Run ${config.command} to continue.`, { deliverAs: "followUp" });
    });
    return {
        start,
        stop,
        getState,
        setMaxIterations: (n) => {
            state.maxIterations = n;
        },
    };
}
