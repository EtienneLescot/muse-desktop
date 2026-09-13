/**
 * US-7 multi-agent fan-out: pure helpers, zero imports.
 *
 * There is NO `subagent/spawn` MSP endpoint, so fan-out happens through a
 * single PARENT turn: `/fanout <n> "<task>"` typed in the composer is
 * intercepted at send time (hook `sendInput`) and replaced by one prompt
 * that instructs the model to run N parallel subagents. Children surface
 * afterwards as the existing `subagent` log entries (subagent.ts) — this
 * module never touches transport.
 *
 * Parallelism note: effective lanes follow `cores - 2` clamped to
 * [FANOUT_LANES_MIN, FANOUT_LANES_MAX] (4-8). When the requested count
 * exceeds the lanes, the extras queue FIFO — the hook logs a report-only
 * note, nothing is rejected.
 */

/** Composer command intercepted at send time (never sent to the model). */
export const FANOUT_COMMAND = "/fanout";

/** Smallest accepted agent count. */
export const FANOUT_MIN_AGENTS = 1;

/** Largest accepted agent count (keeps the parent prompt bounded). */
export const FANOUT_MAX_AGENTS = 32;

/** Lower bound of the `cores - 2` parallel-lane clamp. */
export const FANOUT_LANES_MIN = 4;

/** Upper bound of the `cores - 2` parallel-lane clamp. */
export const FANOUT_LANES_MAX = 8;

/**
 * Lanes assumed when the core count is unknown: 8 cores minus 2 = 6.
 * Hence the FIFO note fires when n > 6 by default.
 */
export const FANOUT_DEFAULT_LANES = 6;

/** A validated `/fanout` request: N agents, each running `task`. */
export interface FanoutRequest {
  count: number;
  task: string;
}

/**
 * Effective parallel lanes for a machine: `cores - 2` clamped to [4, 8].
 * Non-finite/non-positive input falls back to 8 cores (6 lanes).
 */
export function fanoutLanes(cores?: number): number {
  const c =
    typeof cores === "number" && Number.isFinite(cores) && cores > 0
      ? Math.floor(cores)
      : 8;
  return Math.min(FANOUT_LANES_MAX, Math.max(FANOUT_LANES_MIN, c - 2));
}

/**
 * Parse a `/fanout <n> <task>` invocation. The task may be wrapped in one
 * layer of single or double quotes (stripped). Returns null for anything
 * else: wrong command, missing/non-integer/out-of-range count, or an
 * empty task after quote-stripping. Never throws.
 */
export function parseFanoutCommand(text: string): FanoutRequest | null {
  const trimmed = text.trim();
  const m = /^\/fanout\s+(\d+)\s+([\s\S]+)$/i.exec(trimmed);
  if (m === null) return null;
  const count = Number.parseInt(m[1] ?? "", 10);
  if (
    !Number.isFinite(count) ||
    count < FANOUT_MIN_AGENTS ||
    count > FANOUT_MAX_AGENTS
  ) {
    return null;
  }
  let task = (m[2] ?? "").trim();
  if (task.length >= 2) {
    const first = task[0];
    const last = task[task.length - 1];
    if (
      (first === '"' && last === '"') ||
      (first === "'" && last === "'")
    ) {
      task = task.slice(1, -1).trim();
    }
  }
  if (task.length === 0) return null;
  return { count, task };
}

/**
 * Build the single parent-turn prompt for a fan-out request. It instructs
 * the model to run N parallel subagents (agent-1..agent-N), each doing the
 * task independently, then merge their reports. Stays a plain string: the
 * hook sends it through the normal `send_input` path.
 */
export function buildFanoutPrompt(req: FanoutRequest): string {
  const lanes = fanoutLanes();
  const lines: string[] = [
    `Fan out to ${req.count} parallel subagents. Each subagent works independently on the same task, then you merge their reports.`,
    "",
    `Task: ${req.task}`,
    "",
    "Agents:",
  ];
  for (let i = 1; i <= req.count; i++) {
    lines.push(`- agent-${i}: ${req.task}`);
  }
  lines.push(
    "",
    "Rules: run the agents in parallel (up to " +
      `${lanes} at once, queue the rest FIFO); every agent reports back ` +
      "concisely; then merge the reports into one result, flagging conflicts.",
  );
  return lines.join("\n");
}

/**
 * Report-only FIFO note when the requested count exceeds the parallel
 * lanes (default 6: `cores - 2` clamped to 4-8). Returns null when
 * everything fits — the caller logs the note, never blocks on it.
 */
export function fanoutQueueNote(
  count: number,
  lanes: number = FANOUT_DEFAULT_LANES,
): string | null {
  if (!Number.isFinite(count) || !Number.isFinite(lanes)) return null;
  if (count <= lanes) return null;
  return (
    `Fan-out: ${count} agents on ${lanes} parallel lanes ` +
    `(cores-2 clamped to 4-8) — extras run FIFO as lanes free up.`
  );
}
