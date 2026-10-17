/**
 * Control for the single active run. Runs are serialised by the console, so
 * one controller at a time is enough.
 *
 *  - cancel: abandons any wait (approval or reply) and stops the agent loop
 *    before its next model or tool call. Nothing unapproved executes.
 *  - conversation: when the last agent of a run finishes, it waits for the
 *    owner's reply instead of ending. A reply continues the SAME agent under
 *    the SAME signed plan, which is how intent enforcement is demonstrated:
 *    anything the reply asks for that was not declared is refused.
 */
let current: { runId: string; controller: AbortController } | null = null;
let replyWaiter: { runId: string; resolve: (text: string | null) => void } | null = null;

export function beginRun(runId: string): AbortSignal {
  current = { runId, controller: new AbortController() };
  return current.controller.signal;
}

export function endRun(runId: string): void {
  if (current?.runId === runId) current = null;
  if (replyWaiter?.runId === runId) {
    replyWaiter.resolve(null);
    replyWaiter = null;
  }
}

export function cancelRun(runId: string): boolean {
  if (!current || current.runId !== runId) return false;
  current.controller.abort(new Error("run cancelled by the owner"));
  if (replyWaiter?.runId === runId) {
    replyWaiter.resolve(null);
    replyWaiter = null;
  }
  return true;
}

export function currentSignal(): AbortSignal | undefined {
  return current?.controller.signal;
}

export function currentRunId(): string | undefined {
  return current?.runId;
}

export function throwIfCancelled(): void {
  const s = currentSignal();
  if (s?.aborted) throw new Error("run cancelled by the owner");
}

/** Wait for the owner's next message in this run. Resolves null on timeout or when the conversation is ended. */
export function awaitReply(timeoutMs: number): Promise<string | null> {
  const runId = current?.runId;
  if (!runId) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (replyWaiter?.runId === runId) replyWaiter = null;
      resolve(null);
    }, timeoutMs);
    replyWaiter = {
      runId,
      resolve: (text) => {
        clearTimeout(timer);
        resolve(text);
      },
    };
  });
}

export function isAwaitingReply(runId?: string): boolean {
  return !!replyWaiter && (!runId || replyWaiter.runId === runId);
}

/** Deliver the owner's reply to the waiting agent. Returns false if nothing is waiting. */
export function deliverReply(text: string): boolean {
  if (!replyWaiter) return false;
  const w = replyWaiter;
  replyWaiter = null;
  w.resolve(text);
  return true;
}

/** End the conversation: the waiting agent finishes and the run completes normally. */
export function endConversation(): boolean {
  if (!replyWaiter) return false;
  const w = replyWaiter;
  replyWaiter = null;
  w.resolve(null);
  return true;
}
