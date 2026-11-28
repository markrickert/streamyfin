/**
 * Posts and updates the PR build comment: per-variant build status for all 13
 * native build types with direct GitHub Actions artifact download links.
 */
import { readFileSync } from "node:fs";
import { hashFor } from "../build-cache/fingerprint";
import {
  type FetchLike,
  fetchPullRequestCommits,
  githubHeaders,
  githubJson,
  listArtifacts,
} from "../build-cache/github";
import {
  type Artifact,
  pickSource,
  type RunContext,
} from "../build-cache/pick";
import { artifactName, VARIANTS, type Variant } from "../build-cache/variants";

export const COMMENT_MARKER = "<!-- streamyfin-artifact-comment -->";

export interface VariantMeta {
  readonly label: string;
  readonly icon: string;
  readonly target: string;
  readonly fileType: "APK" | "IPA" | "TAR";
  readonly repackJob?: string;
  readonly buildStep: string;
}

/** Display metadata for every build variant, keyed by variant id. */
export const VARIANT_META: Record<string, VariantMeta> = {
  "android-phone-release-device-debugkey": {
    label: "Android Phone",
    icon: "🤖",
    target: "📱 Release APK",
    fileType: "APK",
    repackJob: "🤖 Repack Android Phone (Release APK)",
    buildStep: "🤖 Build Android Phone (Release APK)",
  },
  "android-tv-release-device-debugkey": {
    label: "Android TV",
    icon: "🤖",
    target: "📺 Release APK",
    fileType: "APK",
    repackJob: "🤖 Repack Android TV (Release APK)",
    buildStep: "🤖 Build Android TV (Release APK)",
  },
  "ios-phone-release-device-signed": {
    label: "iOS Phone",
    icon: "🍎",
    target: "📱 Signed IPA",
    fileType: "IPA",
    repackJob: "🍎 Repack iOS Phone (Signed IPA)",
    buildStep: "🍎 Build iOS Phone (Signed IPA)",
  },
  "ios-phone-release-device-unsigned": {
    label: "iOS Phone",
    icon: "🍎",
    target: "📱 Unsigned IPA",
    fileType: "IPA",
    repackJob: "🍎 Repack iOS Phone (Unsigned IPA)",
    buildStep: "🍎 Build iOS Phone (Unsigned IPA)",
  },
  "ios-tv-release-device-unsigned": {
    label: "iOS TV",
    icon: "🍎",
    target: "📺 Unsigned IPA",
    fileType: "IPA",
    repackJob: "🍎 Repack iOS TV (Unsigned IPA)",
    buildStep: "🍎 Build iOS TV (Unsigned IPA)",
  },
  "ios-phone-release-simulator-unsigned": {
    label: "iOS Phone",
    icon: "🍎",
    target: "💻 Simulator Release .app",
    fileType: "TAR",
    repackJob: "🍎 Repack iOS Phone (Simulator Release)",
    buildStep: "🍎 Build iOS Phone (Simulator Release)",
  },
  "ios-tv-release-simulator-unsigned": {
    label: "iOS TV",
    icon: "🍎",
    target: "💻 Simulator Release .app",
    fileType: "TAR",
    repackJob: "🍎 Repack iOS TV (Simulator Release)",
    buildStep: "🍎 Build iOS TV (Simulator Release)",
  },
  "android-phone-release-device-debugkey-universal": {
    label: "Android Phone",
    icon: "🤖",
    target: "🌐 Universal Release APK",
    fileType: "APK",
    repackJob: "🤖 Repack Android Phone (Universal Release APK)",
    buildStep: "🤖 Build Android Phone (Universal Release APK)",
  },
  "android-tv-release-device-debugkey-universal": {
    label: "Android TV",
    icon: "🤖",
    target: "🌐 Universal Release APK",
    fileType: "APK",
    repackJob: "🤖 Repack Android TV (Universal Release APK)",
    buildStep: "🤖 Build Android TV (Universal Release APK)",
  },
  "ios-phone-debug-simulator-unsigned": {
    label: "iOS Phone",
    icon: "🍎",
    target: "💻 Simulator Debug .app",
    fileType: "TAR",
    buildStep: "🍎 Build iOS Phone (Simulator Debug)",
  },
  "ios-tv-debug-simulator-unsigned": {
    label: "iOS TV",
    icon: "🍎",
    target: "💻 Simulator Debug .app",
    fileType: "TAR",
    buildStep: "🍎 Build iOS TV (Simulator Debug)",
  },
  "android-phone-debug-device-debugkey": {
    label: "Android Phone",
    icon: "🤖",
    target: "🛠️ Debug APK",
    fileType: "APK",
    buildStep: "🤖 Build Android Phone (Debug APK)",
  },
  "android-tv-debug-device-debugkey": {
    label: "Android TV",
    icon: "🤖",
    target: "🛠️ Debug APK",
    fileType: "APK",
    buildStep: "🤖 Build Android TV (Debug APK)",
  },
};

/** Grouped build jobs whose per-variant results arrive as steps, not jobs. */
export const GROUPED_JOB_NAMES: readonly string[] = [
  "🤖 Build Android Phone",
  "🤖 Build Android TV",
  "🍎 Build iOS Phone (Device)",
  "🍎 Build iOS TV (Device)",
  "🍎 Build iOS Phone (Simulator)",
  "🍎 Build iOS TV (Simulator)",
  // Earlier names, kept so ETA lookup from older develop runs still matches.
  "🍎 Build iOS Device",
  "🍎 Build tvOS Device",
  "🍎 Build iOS Simulators",
  "🍎 Build tvOS Simulators",
  "Build Apple variants",
  "Build Android variants",
  "Build Android phone",
  "Build Android TV",
  "Build iOS device",
  "Build tvOS device",
  "Build iOS simulators",
  "Build tvOS simulators",
];

export interface JobStep {
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface RunJob {
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
  started_at?: string | null;
  completed_at?: string | null;
  steps?: JobStep[];
}

/** A job or a flattened step, treated uniformly for status resolution. */
export interface FlatJob {
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
  started_at?: string | null;
  completed_at?: string | null;
}

/** Strips the `<caller> / ` prefix reusable-workflow jobs arrive with. */
export const stripCallerPrefix = (name: string): string => {
  const idx = name.indexOf(" / ");
  return idx === -1 ? name : name.slice(idx + 3);
};

/**
 * Flattens grouped build jobs into their steps so a matrix group reporting
 * one variant per step is matched by step name. Other jobs pass through.
 */
export const flattenJobs = (jobs: RunJob[]): FlatJob[] =>
  jobs.flatMap((job): FlatJob[] => {
    if (!GROUPED_JOB_NAMES.includes(stripCallerPrefix(job.name))) {
      return [{ ...job, name: stripCallerPrefix(job.name) }];
    }
    return (job.steps ?? []).map((step) => ({
      name: step.name,
      status: step.status,
      conclusion: step.conclusion,
      html_url: job.html_url,
      started_at: step.started_at,
      completed_at: step.completed_at,
    }));
  });

/** Formats a millisecond duration as "Xm Ys". */
export const fmtDuration = (ms: number): string => {
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}m ${sec}s`;
};

const jobDurationMs = (job: FlatJob): number | undefined => {
  if (!job.started_at || !job.completed_at) return undefined;
  const ms = Date.parse(job.completed_at) - Date.parse(job.started_at);
  return Number.isNaN(ms) ? undefined : ms;
};

/**
 * Per-job reference durations from a successful develop run, keyed by the
 * flattened job or step name, so in-progress builds can show a realistic ETA.
 */
export const referenceDurations = (
  refJobs: RunJob[],
): Record<string, number> => {
  const durations: Record<string, number> = {};
  for (const flat of flattenJobs(refJobs)) {
    if (flat.conclusion !== "success") continue;
    const ms = jobDurationMs(flat);
    if (ms !== undefined) durations[flat.name] = ms;
  }
  return durations;
};

/** Extracts `<os>-<form>` fingerprint hashes from artifact names. */
export const extractRunFingerprints = (
  artifacts: ReadonlyArray<Pick<Artifact, "name">>,
): Record<string, string> => {
  const fingerprints: Record<string, string> = {};
  for (const artifact of artifacts) {
    const match = artifact.name.match(
      /^streamyfin-(ios|android)-(phone|tv)-.*-r\d+-fp-(.+)$/,
    );
    if (match) fingerprints[`${match[1]}-${match[2]}`] = match[3];
  }
  return fingerprints;
};

const artifactPattern = (variant: Variant): RegExp =>
  new RegExp(`^streamyfin-${variant.id}-(?:r\\d+-fp-|unhashed-\\d+-\\d+$)`);

export type BuildSource = "repack" | "full" | "cached" | null;

export type VariantStatus =
  | "ready"
  | "building"
  | "queued"
  | "failed"
  | "cancelled"
  | "pending"
  | "skipped"
  | "processing";

export interface VariantState {
  variant: Variant;
  meta: VariantMeta;
  status: VariantStatus;
  buildSource: BuildSource;
  /** Artifact produced by the current run, when present. */
  artifact?: Artifact;
  /** Trusted artifact resolved from an earlier run (ensure variants). */
  cachedArtifact?: Artifact;
  job?: FlatJob;
  jobUrl?: string;
  durationMs?: number;
  etaMs?: number;
}

interface ResolveArgs {
  jobs: RunJob[];
  runArtifacts: Artifact[];
  cachedArtifacts: Map<string, Artifact | undefined>;
  referenceDurations: Record<string, number>;
  runUrl?: string;
}

const findJob = (flatJobs: FlatJob[], names: string[]): FlatJob | undefined => {
  const exact = flatJobs.filter((j) => names.includes(j.name));
  const pool = exact.length
    ? exact
    : flatJobs.filter((j) => names.some((name) => j.name.includes(name)));
  return (
    pool.find((j) => j.status !== "completed") ??
    pool.find((j) => j.conclusion === "success") ??
    pool.find((j) => j.conclusion !== "skipped") ??
    pool[0]
  );
};

const SIGNED_IOS_ID = "ios-phone-release-device-signed";

/**
 * Resolves the display status of every variant from the run's jobs and
 * artifacts. `cachedArtifacts` maps each ensure variant id to the trusted
 * artifact an earlier run produced for the same fingerprint, when one exists.
 */
export const resolveVariantStates = (args: ResolveArgs): VariantState[] => {
  const flatJobs = flattenJobs(args.jobs);
  return VARIANTS.map((variant) => {
    const meta = VARIANT_META[variant.id];
    const names = meta.repackJob
      ? [meta.repackJob, meta.buildStep]
      : [meta.buildStep];
    const job = findJob(flatJobs, names);
    const artifact = args.runArtifacts.find(
      (a) => !a.expired && artifactPattern(variant).test(a.name),
    );
    const cached = args.cachedArtifacts.get(variant.id);
    const etaMs =
      job && job.status !== "completed"
        ? (args.referenceDurations[job.name] ??
          args.referenceDurations[meta.buildStep] ??
          args.referenceDurations[meta.repackJob ?? ""])
        : undefined;

    const base: VariantState = {
      variant,
      meta,
      status: "pending",
      buildSource: null,
      artifact,
      cachedArtifact: cached,
      job,
      jobUrl: job?.html_url ?? args.runUrl,
      durationMs: job ? jobDurationMs(job) : undefined,
      etaMs,
    };

    if (artifact) {
      let buildSource: BuildSource = "full";
      if (variant.mode === "ensure") {
        buildSource = null; // "Built" in the current run
      } else {
        const repackJob = flatJobs.find((j) => j.name === meta.repackJob);
        const buildJob = flatJobs.find((j) => j.name === meta.buildStep);
        if (repackJob?.conclusion === "success") buildSource = "repack";
        else if (buildJob?.conclusion === "success") buildSource = "full";
      }
      return { ...base, status: "ready", buildSource };
    }
    if (variant.mode === "ensure" && cached) {
      return { ...base, status: "ready", buildSource: "cached" };
    }

    // The signed iOS build only runs with signing credentials in place; on a
    // fork or a credential-less run its job is skipped or never appears. That
    // is only certain once the run finished planning: before `Plan full
    // native builds` or the gate completes, absence means pending, not
    // skipped.
    if (variant.id === SIGNED_IOS_ID) {
      const repackJob = flatJobs.find((j) => j.name === meta.repackJob);
      const buildJob = flatJobs.find((j) => j.name === meta.buildStep);
      const anyActive = [repackJob, buildJob].some(
        (j) => j && j.status !== "completed",
      );
      const absentOrSkipped = (j: FlatJob | undefined) =>
        !j || (j.status === "completed" && j.conclusion === "skipped");
      const planJob = flatJobs.find(
        (j) =>
          j.name === "🗺️ Plan full native builds" ||
          j.name === "Plan full native builds",
      );
      const gateJob = flatJobs.find(
        (j) => j.name === "🍎 Build iOS IPA (Phone)",
      );
      const planningFinished =
        planJob?.status === "completed" || gateJob?.status === "completed";
      if (gateJob?.conclusion === "failure") {
        return {
          ...base,
          status: "failed",
          job: gateJob,
          jobUrl: gateJob.html_url ?? base.jobUrl,
        };
      }
      if (
        !anyActive &&
        gateJob?.conclusion !== "failure" &&
        planningFinished &&
        absentOrSkipped(repackJob) &&
        absentOrSkipped(buildJob)
      ) {
        return { ...base, status: "skipped" };
      }
    }

    if (!job) return base;
    if (job.conclusion === "failure") return { ...base, status: "failed" };
    if (job.conclusion === "cancelled") return { ...base, status: "cancelled" };
    if (job.status === "in_progress") return { ...base, status: "building" };
    if (job.status === "queued") return { ...base, status: "queued" };
    if (job.status === "completed" && job.conclusion === "success") {
      return { ...base, status: "processing" };
    }
    return base;
  });
};

// ---------------------------------------------------------------------------
// GitHub REST helpers
// ---------------------------------------------------------------------------

export interface Deps {
  token: string;
  repo: string;
  fetchFn?: FetchLike;
  hashForFn?: typeof hashFor;
  log?: (message: string) => void;
  env?: Record<string, string | undefined>;
}

const ghFetch = (deps: Deps) => deps.fetchFn ?? fetch;
const log = (deps: Deps, message: string) => (deps.log ?? console.log)(message);

/** Performs a GitHub REST request, throwing on non-2xx responses. */
export const ghRequest = async <T>(
  deps: Deps,
  method: string,
  url: string,
  body?: unknown,
): Promise<T> => {
  const response = await ghFetch(deps)(url, {
    method,
    headers: githubHeaders(deps.token),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${method} ${url}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
};

// ---------------------------------------------------------------------------
// Comment rendering
// ---------------------------------------------------------------------------

export interface RenderModel {
  prNumber: number;
  headSha: string;
  states: VariantState[];
  runUrl?: string;
  repo: string;
}

const statusLabel = (state: VariantState): string => {
  const url = state.jobUrl;
  const link = (text: string) => (url ? `[${text}](${url})` : text);
  switch (state.status) {
    case "ready":
      if (state.buildSource === "repack") return "✅ Repack";
      if (state.buildSource === "full") return "✅ Full build";
      if (state.buildSource === "cached") return "✅ Cached";
      return "✅ Built";
    case "building":
      return `🔄 ${link("Building…")}`;
    case "queued":
      return `⏳ ${link("Queued")}`;
    case "failed":
      return `❌ ${link("Failed")}`;
    case "cancelled":
      return `⚪ ${link("Cancelled")}`;
    case "skipped":
      return "⏭️ Skipped";
    case "processing":
      return `⏳ ${link("Processing artifacts…")}`;
    default:
      return "⏳ Pending";
  }
};

const actionsArtifactUrl = (repo: string, artifact: Artifact): string =>
  `https://github.com/${repo}/actions/runs/${artifact.workflow_run.id}/artifacts/${artifact.id}`;

const downloadCell = (model: RenderModel, state: VariantState): string => {
  const artifact = state.artifact ?? state.cachedArtifact;
  if (state.status === "skipped") return "*No signing credentials*";
  if (state.status === "ready" && artifact) {
    const sizeBytes =
      (artifact as { size_in_bytes?: number }).size_in_bytes ?? 0;
    const sizeMb = sizeBytes / (1024 * 1024);
    const parts: string[] = [];
    if (sizeBytes) parts.push(`${sizeMb.toFixed(1)} MB`);
    if (state.artifact && state.durationMs) {
      parts.push(fmtDuration(state.durationMs));
    }
    const suffix = parts.length ? ` (${parts.join(", ")})` : "";
    return `[📥 Download ${state.meta.fileType}](${actionsArtifactUrl(model.repo, artifact)})${suffix}`;
  }
  if (state.status === "building") {
    return state.etaMs
      ? `*Building… ~${fmtDuration(state.etaMs)} (avg on develop)*`
      : "*Build in progress…*";
  }
  if (state.status === "queued") {
    return state.etaMs
      ? `*Waiting to start… ~${fmtDuration(state.etaMs)} once running (avg on develop)*`
      : "*Waiting to start…*";
  }
  if (state.status === "failed") return "*Build failed*";
  if (state.status === "cancelled") return "*Build cancelled*";
  if (state.status === "processing") return "*Preparing download…*";
  return "*Waiting for build…*";
};

/** Renders the full PR build comment markdown. */
export const renderComment = (model: RenderModel): string => {
  const shortSha = model.headSha.slice(0, 7);
  const repack = model.states.filter((s) => s.variant.mode === "repack");
  const ensure = model.states.filter((s) => s.variant.mode === "ensure");

  let body = `## 🔧 Build Status for PR #${model.prNumber}\n\n`;
  body += `🔗 **Commit**: [\`${shortSha}\`](https://github.com/${model.repo}/commit/${model.headSha})\n\n`;

  body += `### 📦 PR Builds\n\n`;
  body += `| Platform | Target | Status | Download |\n`;
  body += `|----------|--------|--------|----------|\n`;
  for (const state of repack) {
    body += `| ${state.meta.icon} ${state.meta.label} | ${state.meta.target} | ${statusLabel(state)} | ${downloadCell(model, state)} |\n`;
  }
  body += `\n`;

  body += `### 🛠️ Dev Clients (connect to local Metro)\n\n`;
  body += `| Platform | Target | Status | Download |\n`;
  body += `|---------|--------|--------|----------|\n`;
  for (const state of ensure) {
    body += `| ${state.meta.icon} ${state.meta.label} | ${state.meta.target} | ${statusLabel(state)} | ${downloadCell(model, state)} |\n`;
  }
  body += `\n`;
  body += `Fetch locally: \`bun scripts/build-cache/cli.ts fetch <variant-id>\`\n\n`;

  body += `<details><summary>📦 Build details &amp; device compatibility</summary>\n\n`;
  body += `These CI builds are trimmed for size and speed. What that means for installing them:\n\n`;
  body += `| Artifact | Architectures | Installs on |\n`;
  body += `|---|---|---|\n`;
  body += `| 🤖 Android Phone release APK (PR build) | \`arm64-v8a\` | Every 64-bit Android phone (all since ~2017). **Not** an x86_64 emulator or a 32-bit device. |\n`;
  body += `| 📺 Android TV release APK (PR build) | \`arm64-v8a\` + \`armeabi-v7a\` | Modern boxes **and** older / cheap 32-bit Android TV sticks. No x86_64. |\n`;
  body += `| 🤖 Android Universal Release & Dev Client APKs | \`arm64-v8a\` + \`armeabi-v7a\` + \`x86\` + \`x86_64\` (universal, 4 ABIs) | Any Android device or emulator, including x86_64 emulators. |\n`;
  body += `| 🍎 iOS Phone / iOS TV IPA | \`arm64\` | All current iOS Phone / iOS TV devices. Sideload with SideStore, AltStore, LiveContainer, or TrollStore. |\n`;
  body += `| 🍎 iOS Phone / iOS TV simulator .app | \`arm64\` (simulator slice only) | Apple Silicon Mac simulators. Install with Expo Orbit or \`xcrun simctl\`. |\n\n`;
  body += `**Why no x86_64 in the PR device APKs?** That slice only runs on Android emulators / Chromebooks, never a real phone or TV box — dropping it shrinks the APK and speeds up the build. The trimmed device APKs drop it, while the Universal Release and Dev Client APKs keep all four ABIs.\n\n`;
  body += `**Retention:** PR builds expire after 7 days. Dev clients are shared across PRs and kept up to 90 days; they rebuild automatically when the native fingerprint changes.\n\n`;
  body += `**Runners:** Android Phone / Android TV on \`ubuntu-26.04\`; iOS Phone / iOS TV on Apple Silicon (\`xcode-27\`, macOS 27 with Xcode 27).\n\n`;
  body += `</details>\n\n`;

  const anyReady = model.states.some((s) => s.status === "ready");
  if (anyReady) {
    body += `### 🔧 Installation Instructions\n\n`;
    body += `- **Android APK**: Download the zip, unzip it, and install the APK on your device (enable "Install from unknown sources")\n`;
    body += `- **iOS Phone / iOS TV IPA**: Sideload with [SideStore](https://sidestore.io/), [AltStore](https://altstore.io/), [Sideloadly](https://sideloadly.io/), LiveContainer, or Xcode\n`;
    body +=
      "- **iOS Phone / iOS TV Simulator `.tar`**: Extract the `.app` and drag it onto a simulator or use Expo Orbit — or fetch locally with `bun scripts/build-cache/cli.ts fetch <variant-id>`\n\n";
  } else {
    body += `⏳ **Builds are starting up...** This comment will update automatically as each build completes.\n\n`;
  }

  const runLink = model.runUrl ?? `https://github.com/${model.repo}/actions`;
  body += `<sub>*Auto-generated by [GitHub Actions](${runLink})*</sub>`;
  body += `\n${COMMENT_MARKER}`;
  return body;
};

// ---------------------------------------------------------------------------
// Comment upsert
// ---------------------------------------------------------------------------

interface IssueComment {
  id: number;
  body?: string;
  user?: { type?: string };
}

/** Creates or updates the marker comment on a pull request. */
export const upsertComment = async (
  deps: Deps,
  prNumber: number,
  body: string,
): Promise<void> => {
  const api = `https://api.github.com/repos/${deps.repo}`;
  const comments: IssueComment[] = [];
  for (let page = 1; ; page += 1) {
    const batch = await ghRequest<IssueComment[]>(
      deps,
      "GET",
      `${api}/issues/${prNumber}/comments?per_page=100&page=${page}`,
    );
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  const existing = comments.find(
    (comment) =>
      comment.user?.type === "Bot" && comment.body?.includes(COMMENT_MARKER),
  );
  if (existing) {
    await ghRequest(deps, "PATCH", `${api}/issues/comments/${existing.id}`, {
      body,
    });
    log(deps, `✅ Updated comment ${existing.id} on PR #${prNumber}`);
  } else {
    await ghRequest(deps, "POST", `${api}/issues/${prNumber}/comments`, {
      body,
    });
    log(deps, `✅ Created comment on PR #${prNumber}`);
  }
};

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
  created_at: string;
  event?: string;
  head_branch?: string;
  head_repository?: { id: number };
}

export interface UpdateArgs {
  prNumber: number;
  headSha: string;
  repositoryId: number;
  prHeadRef?: string;
  prHeadRepositoryId?: number;
  triggerRunId?: number;
}

export const findLatestAppsRun = async (
  deps: Deps,
  args: UpdateArgs,
): Promise<WorkflowRun | undefined> => {
  if (args.triggerRunId) {
    return githubJson<WorkflowRun>(
      `https://api.github.com/repos/${deps.repo}/actions/runs/${args.triggerRunId}`,
      deps.token,
      ghFetch(deps),
    );
  }
  const data = await githubJson<{ workflow_runs: WorkflowRun[] }>(
    `https://api.github.com/repos/${deps.repo}/actions/runs?head_sha=${args.headSha}&per_page=30`,
    deps.token,
    ghFetch(deps),
  );
  const runs = data.workflow_runs
    .filter((run) => run.name.includes("Build Apps"))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  // Scope to this PR's own runs when its head is known, so a develop push or
  // a sibling PR at the same commit never supplies this comment's links. No
  // fallback: better a "builds are starting up" comment than another
  // branch's artifacts.
  const scoped =
    args.prHeadRef || args.prHeadRepositoryId
      ? runs.filter(
          (run) =>
            (!run.event || run.event === "pull_request") &&
            (!args.prHeadRef ||
              !run.head_branch ||
              run.head_branch === args.prHeadRef) &&
            (!args.prHeadRepositoryId ||
              !run.head_repository?.id ||
              run.head_repository.id === args.prHeadRepositoryId),
        )
      : runs;
  const pool = scoped;
  // A cancelled retry must never hide a live or successful build.
  return (
    pool.find((run) => run.status === "in_progress") ??
    pool.find((run) => run.status === "queued") ??
    pool.find(
      (run) => run.status === "completed" && run.conclusion !== "cancelled",
    ) ??
    pool[0]
  );
};

const jobsForRun = async (deps: Deps, runId: number): Promise<RunJob[]> => {
  const jobs: RunJob[] = [];
  for (let page = 1; ; page += 1) {
    const data = await githubJson<{ jobs: RunJob[]; total_count: number }>(
      `https://api.github.com/repos/${deps.repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`,
      deps.token,
      ghFetch(deps),
    );
    jobs.push(...data.jobs);
    if (data.jobs.length < 100) return jobs;
  }
};

const artifactsForRun = async (
  deps: Deps,
  runId: number,
): Promise<Artifact[]> => {
  const artifacts: Artifact[] = [];
  for (let page = 1; ; page += 1) {
    const data = await githubJson<{
      artifacts: (Artifact & { size_in_bytes?: number })[];
    }>(
      `https://api.github.com/repos/${deps.repo}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`,
      deps.token,
      ghFetch(deps),
    );
    artifacts.push(...data.artifacts);
    if (data.artifacts.length < 100) return artifacts;
  }
};

const fetchReferenceDurations = async (
  deps: Deps,
): Promise<Record<string, number>> => {
  try {
    const runs = await githubJson<{ workflow_runs: WorkflowRun[] }>(
      `https://api.github.com/repos/${deps.repo}/actions/workflows/build-apps.yml/runs?branch=develop&status=success&per_page=1`,
      deps.token,
      ghFetch(deps),
    );
    const ref = runs.workflow_runs[0];
    if (!ref) return {};
    return referenceDurations(await jobsForRun(deps, ref.id));
  } catch {
    return {};
  }
};

/** Computes missing `<os>-<form>` fingerprints, never throwing. */
export const fillFingerprints = (
  deps: Deps,
  fingerprints: Record<string, string>,
): Record<string, string> => {
  const hashForFn = deps.hashForFn ?? hashFor;
  const result = { ...fingerprints };
  for (const os of ["ios", "android"] as const) {
    for (const form of ["phone", "tv"] as const) {
      const key = `${os}-${form}`;
      if (result[key]) continue;
      try {
        result[key] = hashForFn({ os, form });
      } catch (error) {
        log(
          deps,
          `⚠️ Could not compute ${key} fingerprint: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return result;
};

/**
 * Refreshes the PR build comment: status of every variant with direct
 * Actions artifact links for the ones that are ready.
 */
export const runUpdate = async (
  deps: Deps,
  args: UpdateArgs,
): Promise<string> => {
  const run = await findLatestAppsRun(deps, args);
  const jobs = run ? await jobsForRun(deps, run.id) : [];
  const runArtifacts = run ? await artifactsForRun(deps, run.id) : [];
  const etaDurations = await fetchReferenceDurations(deps);
  // The checkout matches the target PR only when the workflow resolved it;
  // hashing a mismatched checkout would name cache entries this PR cannot use.
  const extracted = extractRunFingerprints(runArtifacts);
  const checkedOutSha = deps.env?.CHECKED_OUT_SHA?.trim();
  const fingerprints =
    !checkedOutSha || checkedOutSha === args.headSha
      ? fillFingerprints(deps, extracted)
      : extracted;

  // Resolve trusted cached artifacts for ensure variants missing in this run.
  let pullRequest: RunContext["pullRequest"];
  if (args.prHeadRef && args.prHeadRepositoryId) {
    try {
      pullRequest = {
        headRef: args.prHeadRef,
        headRepositoryId: args.prHeadRepositoryId,
        commits: await fetchPullRequestCommits(
          deps.repo,
          args.prNumber,
          deps.token,
          ghFetch(deps),
        ),
      };
    } catch (error) {
      log(
        deps,
        `⚠️ Could not list PR commits; same-PR cache candidates are skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const ctx: RunContext = {
    repositoryId: args.repositoryId,
    pullRequest,
  };
  const cachedArtifacts = new Map<string, Artifact | undefined>();
  for (const variant of VARIANTS.filter((v) => v.mode === "ensure")) {
    const fp = fingerprints[`${variant.os}-${variant.form}`];
    if (!fp) {
      cachedArtifacts.set(variant.id, undefined);
      continue;
    }
    try {
      const name = artifactName(variant, fp);
      const artifacts = await listArtifacts(
        deps.repo,
        name,
        deps.token,
        ghFetch(deps),
      );
      cachedArtifacts.set(variant.id, pickSource(artifacts, ctx, "ci"));
    } catch (error) {
      log(
        deps,
        `⚠️ Artifact lookup for ${variant.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      cachedArtifacts.set(variant.id, undefined);
    }
  }

  const states = resolveVariantStates({
    jobs,
    runArtifacts,
    cachedArtifacts,
    referenceDurations: etaDurations,
    runUrl: run?.html_url,
  });

  const body = renderComment({
    prNumber: args.prNumber,
    headSha: args.headSha,
    states,
    runUrl: run?.html_url,
    repo: deps.repo,
  });
  await upsertComment(deps, args.prNumber, body);
  return body;
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface EventPayload {
  pull_request?: {
    number: number;
    head: { sha: string; ref: string; repo?: { id: number } };
  };
  workflow_run?: {
    id?: number;
    name?: string;
    head_sha: string;
    head_repository?: { id: number };
    pull_requests?: { number: number; head?: { sha: string; ref: string } }[];
  };
}

interface PullEntry {
  number: number;
  state?: string;
  head: { sha: string; ref: string; repo?: { id: number } };
}

export const resolvePrContext = async (
  deps: Deps,
  event: EventPayload,
): Promise<UpdateArgs | null> => {
  const repositoryId = Number(deps.env?.GITHUB_REPOSITORY_ID);
  if (event.pull_request) {
    return {
      prNumber: event.pull_request.number,
      headSha: event.pull_request.head.sha,
      repositoryId,
      prHeadRef: event.pull_request.head.ref,
      prHeadRepositoryId: event.pull_request.head.repo?.id,
    };
  }
  if (event.workflow_run) {
    const headSha = event.workflow_run.head_sha;
    const pulls = await githubJson<PullEntry[]>(
      `https://api.github.com/repos/${deps.repo}/commits/${headSha}/pulls`,
      deps.token,
      ghFetch(deps),
    );
    const pr = event.workflow_run.pull_requests?.[0] ?? pulls[0];
    if (!pr) return null;
    // Head metadata comes from the selected pull request only: substituting
    // another PR's branch would trust the wrong fork's cache artifacts.
    let full = pulls.find((p) => p.number === pr.number);
    if (!full) {
      try {
        full = await githubJson<PullEntry>(
          `https://api.github.com/repos/${deps.repo}/pulls/${pr.number}`,
          deps.token,
          ghFetch(deps),
        );
      } catch {
        full = undefined;
      }
    }
    return {
      prNumber: pr.number,
      headSha,
      repositoryId,
      prHeadRef: full?.head.ref,
      prHeadRepositoryId: full?.head.repo?.id,
      triggerRunId: event.workflow_run.name?.includes("Build Apps")
        ? event.workflow_run.id
        : undefined,
    };
  }
  // Manual dispatch: the refresh-pr-comment nudge dispatches this workflow
  // with --ref set to the PR branch, so GITHUB_SHA names that PR's head
  // commit. Prefer the pull request that commit belongs to over the most
  // recently updated one, or two concurrent PRs overwrite each other.
  const dispatchSha = deps.env?.GITHUB_SHA?.trim();
  if (dispatchSha) {
    try {
      const associated = await githubJson<PullEntry[]>(
        `https://api.github.com/repos/${deps.repo}/commits/${dispatchSha}/pulls`,
        deps.token,
        ghFetch(deps),
      );
      const openAssociated = associated.filter(
        (p) => !p.state || p.state === "open",
      );
      const dispatchRef = deps.env?.GITHUB_REF_NAME?.trim();
      let hit: PullEntry | undefined;
      if (dispatchRef) {
        const matches = openAssociated.filter(
          (p) =>
            p.head.ref === dispatchRef &&
            (!Number.isFinite(repositoryId) ||
              !p.head.repo?.id ||
              p.head.repo.id === repositoryId),
        );
        // Several pull requests can share a head commit across branches;
        // picking one at random would overwrite the other's comment.
        if (matches.length === 1) hit = matches[0];
      } else if (openAssociated.length === 1) {
        hit = openAssociated[0];
      }
      if (hit) {
        return {
          prNumber: hit.number,
          headSha: hit.head.sha,
          repositoryId,
          prHeadRef: hit.head.ref,
          prHeadRepositoryId: hit.head.repo?.id,
        };
      }
    } catch {
      // Fall through to the latest open PR.
    }
  }
  const open = await githubJson<PullEntry[]>(
    `https://api.github.com/repos/${deps.repo}/pulls?state=open&sort=updated&direction=desc&per_page=1`,
    deps.token,
    ghFetch(deps),
  );
  const pr = open[0];
  if (!pr) return null;
  return {
    prNumber: pr.number,
    headSha: pr.head.sha,
    repositoryId,
    prHeadRef: pr.head.ref,
    prHeadRepositoryId: pr.head.repo?.id,
  };
};

const main = async () => {
  const env = process.env;
  const deps: Deps = {
    token: env.GITHUB_TOKEN ?? "",
    repo: env.GITHUB_REPOSITORY ?? "",
    env,
  };
  const eventPath = env.GITHUB_EVENT_PATH;
  const event: EventPayload = eventPath
    ? (JSON.parse(readFileSync(eventPath, "utf8")) as EventPayload)
    : {};
  const args = await resolvePrContext(deps, event);
  if (!args) {
    console.log("No pull request found; nothing to comment on.");
    return;
  }
  await runUpdate(deps, args);
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
