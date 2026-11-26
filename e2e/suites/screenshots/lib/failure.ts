import path from "node:path";
import type { Deps } from "./core";

/**
 * The Maestro command whose failure ended a pass, recovered from the pass's debug
 * output. `maestro --debug-output <outDir> --flatten-debug-output` writes
 * `<outDir>/<flow>/commands.json`: a flat array of every command in start order, each
 * with `metadata.status`/`sequenceNumber`/`depth`, `metadata.error` on failures, and
 * `metadata.artifacts` (screenshot, screen hierarchy) relative to the commands.json
 * folder.
 */
export interface FailedStep {
  /**
   * The file-runFlow chain around the failing command, outermost first. An inline
   * `runFlow: {when: ..., commands: ...}` has no `sourceDescription`, so it occupies a
   * depth without adding a name.
   */
  flows: string[];
  /** The command's single key, e.g. "tapOnElement". */
  command: string;
  /** `metadata.error.message` — unmasked; callers mask secrets before output. */
  message: string;
  /** Absolute paths of the captured artifacts, when Maestro recorded them. */
  screenshot?: string;
  hierarchy?: string;
}

interface CommandEntry {
  command?: Record<string, unknown>;
  metadata?: {
    status?: string;
    sequenceNumber?: number;
    depth?: number;
    error?: { message?: unknown };
    artifacts?: { type?: unknown; path?: unknown }[];
  };
}

/**
 * The failing step of one commands.json. Every ancestor runFlow fails too, so the step
 * is the last FAILED entry that is not a `runFlowCommand`; its chain is the nearest
 * preceding runFlow at each shallower depth.
 */
function stepFrom(
  entries: CommandEntry[],
  dir: string,
): FailedStep | undefined {
  // flowAtDepth[d] is the file name of the runFlow at depth d holding the current
  // command — undefined for an inline runFlow, which has no file to name.
  const flowAtDepth = new Map<number, string | undefined>();
  let step: FailedStep | undefined;
  for (const entry of entries) {
    const depth = entry.metadata?.depth ?? 0;
    for (const level of [...flowAtDepth.keys()])
      if (level > depth) flowAtDepth.delete(level);
    const command = entry.command ?? {};
    const name = Object.keys(command)[0] ?? "";
    // runFlow and retry are containers: they fail when a child fails, so they are
    // never the leaf, and only a file-runFlow adds a name to the chain.
    if (name === "runFlowCommand" || name === "retryCommand") {
      const container = command[name] as
        | { sourceDescription?: unknown }
        | undefined;
      flowAtDepth.set(
        depth,
        typeof container?.sourceDescription === "string"
          ? container.sourceDescription
          : undefined,
      );
      continue;
    }
    if (entry.metadata?.status !== "FAILED") continue;
    const artifact = (type: string) => {
      const found = entry.metadata?.artifacts?.find((a) => a.type === type);
      return typeof found?.path === "string"
        ? path.join(dir, found.path)
        : undefined;
    };
    const message = entry.metadata.error?.message;
    step = {
      flows: Array.from({ length: depth }, (_, level) =>
        flowAtDepth.get(level),
      ).filter((flow): flow is string => flow !== undefined),
      command: name,
      message: typeof message === "string" ? message : "",
      screenshot: artifact("SCREENSHOT"),
      hierarchy: artifact("SCREEN_HIERARCHY"),
    };
  }
  return step;
}

/**
 * The failed step of the pass whose debug output is `outDir` (the pass's `--out`
 * folder). Undefined when no `<outDir>/<flow>/commands.json` exists, none parses, or
 * none contains a failed leaf command — e.g. a pass killed before Maestro wrote.
 */
export function failedStep(d: Deps, outDir: string): FailedStep | undefined {
  if (!d.fs.exists(outDir)) return undefined;
  for (const sub of [...d.fs.list(outDir)].sort()) {
    const file = `${outDir}/${sub}/commands.json`;
    if (!d.fs.exists(file)) continue;
    let entries: CommandEntry[];
    try {
      const parsed: unknown = JSON.parse(d.fs.read(file));
      if (!Array.isArray(parsed)) continue;
      entries = parsed as CommandEntry[];
    } catch {
      continue;
    }
    const step = stepFrom(entries, `${outDir}/${sub}`);
    if (step) return step;
  }
  return undefined;
}

/**
 * "mobile.yml > _tap-more.yml: tapOnElement: <message> (screenshot <rel>, hierarchy <rel>)"
 * — artifact paths made relative to `relativeTo`.
 */
export function describeFailedStep(
  step: FailedStep,
  relativeTo: string,
): string {
  const chain = step.flows.length ? `${step.flows.join(" > ")}: ` : "";
  const artifacts = [
    step.screenshot &&
      `screenshot ${path.relative(relativeTo, step.screenshot)}`,
    step.hierarchy && `hierarchy ${path.relative(relativeTo, step.hierarchy)}`,
  ].filter(Boolean);
  return `${chain}${step.command}: ${step.message}${
    artifacts.length ? ` (${artifacts.join(", ")})` : ""
  }`;
}
