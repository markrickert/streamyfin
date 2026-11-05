/**
 * Posts or updates the build status comment on a pull request: one row per
 * build target, with its state and, once it is built, a download link.
 *
 * Each build and repack job in `build-apps.yml` runs this as its last step, via
 * `.github/actions/refresh-pr-comment`, so the comment changes the moment a
 * build ends instead of after another job waits for a runner. The
 * `🧬 Native Fingerprint` job runs it first to post the placeholder, so the
 * build jobs only ever update an existing comment. `artifact-comment.yml` runs
 * it once more when the whole Build Apps run completes, which settles the final
 * state.
 *
 * A job that runs this is still in progress for the API, and so is any job
 * that ran it moments earlier and is in its post steps. `settleJobs` reads such
 * a job as finished from its steps, or the last job to end would stay
 * "Building" until the backstop run.
 */

/** The step name every caller in `build-apps.yml` must use for this script. */
export const REFRESH_STEP = "🔄 Refresh PR build comment";

/** Hidden marker that identifies the comment to update. */
export const COMMENT_MARKER = "<!-- streamyfin-artifact-comment -->";

export interface Step {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
}

export interface Job {
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  started_at: string | null;
  completed_at: string | null;
  runner_name: string | null;
  steps?: Step[];
}

export interface Run {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  run_started_at?: string;
  updated_at: string;
}

export interface Artifact {
  id: number;
  name: string;
  size_in_bytes: number;
  workflow_run: { id: number };
}

export interface BuildStatus {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  started_at: string | null;
  completed_at: string | null;
}

/** The job this script runs in, when it runs inside a Build Apps job. */
export interface SelfJob {
  runId: number;
  runnerName: string | undefined;
  now: string;
}

/**
 * Each target lists its build job and its repack job: either may hold the
 * artifact while the other sits skipped.
 */
export const JOB_MAPPINGS: Record<string, string[]> = {
  "Android Phone": [
    "🤖 Build Android APK (Phone)",
    "🤖 Repack Android APK (Phone)",
  ],
  "Android TV": ["🤖 Build Android APK (TV)", "🤖 Repack Android APK (TV)"],
  iOS: ["🍎 Build iOS IPA (Phone)", "🍎 Repack iOS IPA (Phone)"],
  "iOS Unsigned": [
    "🍎 Build iOS IPA (Phone - Unsigned)",
    "🍎 Repack iOS IPA (Phone - Unsigned)",
  ],
  "tvOS Unsigned": [
    "🍎 Build tvOS IPA (Unsigned)",
    "🍎 Repack tvOS IPA (Unsigned)",
  ],
};

const BUILD_TARGETS = [
  {
    name: "Android Phone",
    platform: "🤖",
    device: "📱 Phone",
    artifactPattern: /android.*phone/i,
  },
  {
    name: "Android TV",
    platform: "🤖",
    device: "📺 TV",
    artifactPattern: /android.*tv/i,
  },
  {
    name: "iOS",
    platform: "🍎",
    device: "📱 Phone",
    artifactPattern: /^(?!.*unsigned).*ios.*phone.*ipa/i,
  },
  {
    name: "iOS Unsigned",
    platform: "🍎",
    device: "📱 Phone Unsigned",
    artifactPattern: /ios.*phone.*unsigned/i,
  },
  {
    name: "tvOS Unsigned",
    platform: "🍎",
    device: "📺 TV Unsigned",
    artifactPattern: /ios.*tv.*unsigned/i,
  },
];

/**
 * Reads a job as finished once it has reached its refresh step, or once it is
 * the job running this script. Its conclusion comes from the steps before.
 */
export const settleJobs = (jobs: Job[], self: SelfJob | undefined): Job[] =>
  jobs.map((job) => {
    if (job.status === "completed") return job;
    const refresh = job.steps?.find((s) => s.name === REFRESH_STEP);
    const isSelf =
      self !== undefined &&
      self.runnerName !== undefined &&
      job.run_id === self.runId &&
      job.runner_name === self.runnerName;
    // A step not started yet is "pending" in the jobs API.
    const reached =
      refresh?.status === "in_progress" || refresh?.status === "completed";
    if (!isSelf && !reached) return job;
    const conclusions = (job.steps ?? [])
      .filter((s) => s !== refresh)
      .map((s) => s.conclusion);
    const conclusion = conclusions.includes("failure")
      ? "failure"
      : conclusions.includes("cancelled")
        ? "cancelled"
        : "success";
    return {
      ...job,
      status: "completed",
      conclusion,
      completed_at: refresh?.started_at ?? self?.now ?? null,
    };
  });

/**
 * Picks the run to report: an active one first, then a completed one that was
 * not cancelled, then the newest.
 */
export const findBestRun = (runs: Run[]): Run | undefined => {
  const sorted = runs
    .filter((run) => run.name.includes("Build Apps"))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return (
    sorted.find((run) => run.status === "in_progress") ??
    sorted.find((run) => run.status === "queued") ??
    sorted.find(
      (run) => run.status === "completed" && run.conclusion !== "cancelled",
    ) ??
    sorted[0]
  );
};

/**
 * Prefers an exact name match, so '...(Phone)' never swallows
 * '...(Phone - Unsigned)'. Among a target's two jobs it prefers the live one,
 * then the successful one, so a skipped job never stands in for the one that
 * ran.
 */
export const findJobForTarget = (
  jobs: Job[],
  jobNames: string[],
): Job | undefined => {
  const exact = jobs.filter((j) => jobNames.includes(j.name));
  const pool = exact.length
    ? exact
    : jobs.filter((j) => jobNames.some((name) => j.name.includes(name)));
  return (
    pool.find((j) => j.status !== "completed") ??
    pool.find((j) => j.conclusion === "success") ??
    pool.find((j) => j.conclusion !== "skipped") ??
    pool[0]
  );
};

const runStatus = (run: Run): BuildStatus => ({
  name: run.name,
  status: run.status,
  conclusion: run.conclusion,
  url: run.html_url,
  started_at: run.run_started_at ?? null,
  completed_at: run.updated_at,
});

/** Maps each build target to its job's status, or the run's when it has none. */
export const buildStatuses = (
  run: Run,
  jobs: Job[] | undefined,
): Record<string, BuildStatus> => {
  const statuses: Record<string, BuildStatus> = {};
  for (const [target, jobNames] of Object.entries(JOB_MAPPINGS)) {
    const job = jobs && findJobForTarget(jobs, jobNames);
    statuses[target] = job
      ? {
          name: job.name,
          status: job.status,
          conclusion: job.conclusion,
          url: job.html_url,
          started_at: job.started_at,
          completed_at: job.completed_at,
        }
      : runStatus(run);
  }
  return statuses;
};

/** Formats a millisecond duration as "Xm Ys". */
export const fmtDuration = (ms: number) =>
  `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;

const targetRow = (
  status: BuildStatus | undefined,
  artifact: Artifact | undefined,
  fileType: string,
  referenceDurations: Record<string, number>,
  repository: string,
): [string, string] => {
  if (!status) return ["⏳ Pending", "*Waiting for build...*"];
  const ref = referenceDurations[status.name];
  if (status.conclusion === "success" && artifact) {
    const link = `https://github.com/${repository}/actions/runs/${artifact.workflow_run.id}/artifacts/${artifact.id}`;
    const size = `(${(artifact.size_in_bytes / (1024 * 1024)).toFixed(1)} MB)`;
    const duration =
      status.started_at && status.completed_at
        ? ` - ${fmtDuration(new Date(status.completed_at).getTime() - new Date(status.started_at).getTime())}`
        : "";
    return [
      "✅ Complete",
      `[📥 Download ${fileType}](${link}) ${size}${duration}`,
    ];
  }
  if (status.conclusion === "failure")
    return [`❌ [Failed](${status.url})`, "*Build failed*"];
  if (status.conclusion === "cancelled")
    return [`⚪ [Cancelled](${status.url})`, "*Build cancelled*"];
  if (status.status === "in_progress")
    return [
      `🔄 [Building...](${status.url})`,
      ref
        ? `*Building… ~${fmtDuration(ref)} (avg on develop)*`
        : "*Build in progress...*",
    ];
  if (status.status === "queued")
    return [
      `⏳ [Queued](${status.url})`,
      ref
        ? `*Waiting to start… ~${fmtDuration(ref)} once running (avg on develop)*`
        : "*Waiting to start...*",
    ];
  if (status.status === "completed" && !status.conclusion)
    return [`🔄 [Finishing...](${status.url})`, "*Finalizing build...*"];
  if (status.status === "completed" && status.conclusion === "success")
    return [
      `⏳ [Processing artifacts...](${status.url})`,
      "*Preparing download...*",
    ];
  const pending = status.conclusion || "pending";
  return [
    `❓ [${status.status}/${pending}](${status.url})`,
    `*Status: ${status.status}, Conclusion: ${pending}*`,
  ];
};

export interface CommentInput {
  repository: string;
  prNumber: number;
  sha: string;
  statuses: Record<string, BuildStatus>;
  artifacts: Artifact[];
  referenceDurations: Record<string, number>;
  runUrl: string;
}

export const renderComment = ({
  repository,
  prNumber,
  sha,
  statuses,
  artifacts,
  referenceDurations,
  runUrl,
}: CommentInput): string => {
  let body = `## 🔧 Build Status for PR #${prNumber}\n\n`;
  body += `🔗 **Commit**: [\`${sha.substring(0, 7)}\`](https://github.com/${repository}/commit/${sha})\n\n`;
  body += "### 📦 Build Artifacts\n\n";
  body += "| Platform | Device | Status | Download |\n";
  body += "|----------|--------|--------|---------|\n";

  for (const target of BUILD_TARGETS) {
    const artifact = artifacts.find((a) => target.artifactPattern.test(a.name));
    const fileType = target.name.includes("Android") ? "APK" : "IPA";
    const [status, download] = targetRow(
      statuses[target.name],
      artifact,
      fileType,
      referenceDurations,
      repository,
    );
    body += `| ${target.platform} ${target.name} | ${target.device} | ${status} | ${download} |\n`;
  }

  body += "\n";

  // Always shown, even mid-build, so testers know what to expect before the
  // downloads are ready.
  body += "<details>\n";
  body += "<summary>📦 Build details &amp; device compatibility</summary>\n\n";
  body +=
    "These CI builds are trimmed for size and speed. What that means for installing them:\n\n";
  body += "| Artifact | Architectures | Installs on |\n";
  body += "|---|---|---|\n";
  body +=
    "| 🤖 Android Phone APK | `arm64-v8a` | Every 64-bit Android phone (all since ~2017). **Not** an x86_64 emulator or a 32-bit device. |\n";
  body +=
    "| 📺 Android TV APK | `arm64-v8a` + `armeabi-v7a` | Modern boxes **and** older / cheap 32-bit Android TV sticks. No x86_64. |\n";
  body +=
    "| 🍎 iOS / tvOS IPA | `arm64` | iPhone / Apple TV (all current devices). |\n\n";
  body +=
    "**Why no x86_64?** That slice only runs on Android emulators / Chromebooks, never a real phone or TV box — dropping it shrinks the APK and speeds up the build. Local `bun run android` is unaffected (it still builds x86_64 from `app.json`).\n\n";
  body +=
    "**Runners:** Android on `ubuntu-26.04`; iOS / tvOS on Apple Silicon (`macos-26`). The size/speed win comes from the ABI trim above, not the runner.\n";
  body += "</details>\n\n";

  // Installation instructions only matter once something is downloadable.
  if (artifacts.length > 0) {
    body += "### 🔧 Installation Instructions\n\n";
    body +=
      '- **Android APK**: Download and install directly on your device (enable "Install from unknown sources")\n';
    body +=
      "- **iOS IPA**: Install using [AltStore](https://altstore.io/), [Sideloadly](https://sideloadly.io/), or Xcode\n\n";
    body += "> ⚠️ **Note**: Artifacts expire in 7 days from build date\n\n";
  } else {
    body +=
      "⏳ **Builds are starting up...** This comment will update automatically as each build completes.\n\n";
  }

  body += `<sub>*Auto-generated by [GitHub Actions](${runUrl})*</sub>`;
  body += `\n${COMMENT_MARKER}`;
  return body;
};

class GitHubError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`GitHub answered ${status} for ${url}`);
  }
}

const github = async <T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> => {
  const url = `https://api.github.com${path}`;
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) throw new GitHubError(response.status, url);
  return (await response.json()) as T;
};

interface PullRequest {
  number: number;
  head: { sha: string; repo: { full_name: string } | null };
}

interface EventPayload {
  pull_request?: PullRequest;
  workflow_run?: {
    head_sha: string;
    head_repository?: { full_name: string };
  };
}

const findPullRequest = async (
  token: string,
  repo: string,
  eventName: string,
  payload: EventPayload,
  sha: string,
): Promise<{ pr: PullRequest; sha: string } | undefined> => {
  if (eventName === "pull_request" && payload.pull_request) {
    return { pr: payload.pull_request, sha: payload.pull_request.head.sha };
  }
  if (eventName === "workflow_run" && payload.workflow_run) {
    const commit = payload.workflow_run.head_sha;
    const prs = await github<PullRequest[]>(
      token,
      `/repos/${repo}/commits/${commit}/pulls`,
    );
    return prs[0] && { pr: prs[0], sha: commit };
  }
  if (eventName === "workflow_dispatch") {
    // Manual testing: the PR for this commit, else the latest open one.
    const prs = await github<PullRequest[]>(
      token,
      `/repos/${repo}/commits/${sha}/pulls`,
    );
    const pr =
      prs[0] ??
      (
        await github<PullRequest[]>(
          token,
          `/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=1`,
        )
      )[0];
    return pr && { pr, sha: pr.head.sha };
  }
  console.log("Unsupported event type:", eventName);
  return undefined;
};

/**
 * Durations of the latest successful `develop` build, by job name, for the ETA
 * of a running target. A repack takes minutes where a full build takes much
 * longer, so an ETA must come from the same kind of job. Best effort: a
 * failure only drops the ETA.
 */
const fetchReferenceDurations = async (
  token: string,
  repo: string,
): Promise<Record<string, number>> => {
  const durations: Record<string, number> = {};
  try {
    const { workflow_runs } = await github<{ workflow_runs: Run[] }>(
      token,
      `/repos/${repo}/actions/workflows/build-apps.yml/runs?branch=develop&status=success&per_page=1`,
    );
    if (!workflow_runs[0]) return durations;
    const { jobs } = await github<{ jobs: Job[] }>(
      token,
      `/repos/${repo}/actions/runs/${workflow_runs[0].id}/jobs?per_page=100`,
    );
    const mapped = new Set(Object.values(JOB_MAPPINGS).flat());
    for (const job of jobs) {
      if (
        mapped.has(job.name) &&
        job.conclusion === "success" &&
        job.started_at &&
        job.completed_at
      ) {
        durations[job.name] =
          new Date(job.completed_at).getTime() -
          new Date(job.started_at).getTime();
      }
    }
  } catch (error) {
    console.log("Failed to fetch develop reference durations:", error);
  }
  return durations;
};

const upsertComment = async (
  token: string,
  repo: string,
  prNumber: number,
  body: string,
) => {
  for (let page = 1; ; page += 1) {
    const comments = await github<
      { id: number; body?: string; user: { type: string } }[]
    >(
      token,
      `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
    );
    const existing = comments.find(
      (c) => c.user.type === "Bot" && c.body?.includes(COMMENT_MARKER),
    );
    if (existing) {
      await github(token, `/repos/${repo}/issues/comments/${existing.id}`, {
        method: "PATCH",
        body: { body },
      });
      console.log(`Updated comment ${existing.id} on PR #${prNumber}`);
      return;
    }
    if (comments.length < 100) break;
  }
  await github(token, `/repos/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    body: { body },
  });
  console.log(`Created a comment on PR #${prNumber}`);
};

/**
 * Usage: `bun scripts/ci/artifact-comment.ts`
 *
 * Reads the standard Actions variables: `GITHUB_TOKEN`, `GITHUB_REPOSITORY`,
 * `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_SHA`, `GITHUB_RUN_ID`,
 * `GITHUB_SERVER_URL` and `RUNNER_NAME`.
 */
const main = async () => {
  const env = process.env;
  const token = env.GITHUB_TOKEN ?? "";
  const repo = env.GITHUB_REPOSITORY ?? "";
  const eventName = env.GITHUB_EVENT_NAME ?? "";
  const payload: EventPayload = env.GITHUB_EVENT_PATH
    ? JSON.parse(await Bun.file(env.GITHUB_EVENT_PATH).text())
    : {};

  // A fork's token is read-only: commenting would only fail.
  const headRepo =
    payload.pull_request?.head.repo?.full_name ??
    payload.workflow_run?.head_repository?.full_name;
  if (headRepo && headRepo !== repo) {
    console.log(`Skipping the build comment for fork ${headRepo}`);
    return;
  }

  const found = await findPullRequest(
    token,
    repo,
    eventName,
    payload,
    env.GITHUB_SHA ?? "",
  );
  if (!found) {
    console.log("No pull request found");
    return;
  }
  const { pr, sha } = found;
  console.log(`Processing PR #${pr.number} for commit ${sha.substring(0, 7)}`);

  const { workflow_runs } = await github<{ workflow_runs: Run[] }>(
    token,
    `/repos/${repo}/actions/runs?head_sha=${sha}&per_page=30`,
  );
  const run = findBestRun(workflow_runs);

  let statuses: Record<string, BuildStatus> = {};
  let artifacts: Artifact[] = [];
  if (run) {
    let jobs: Job[] | undefined;
    try {
      const body = await github<{ jobs: Job[] }>(
        token,
        `/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
      );
      jobs = settleJobs(
        body.jobs,
        eventName === "pull_request"
          ? {
              runId: Number(env.GITHUB_RUN_ID),
              runnerName: env.RUNNER_NAME,
              now: new Date().toISOString(),
            }
          : undefined,
      );
      for (const job of jobs) {
        console.log(`- ${job.name}: ${job.status}/${job.conclusion ?? "none"}`);
      }
      const allCancelled = jobs.every(
        (j) => j.status === "completed" && j.conclusion === "cancelled",
      );
      if (allCancelled && run.conclusion === "cancelled") {
        console.log("All jobs are cancelled, leaving the comment alone");
        return;
      }
    } catch (error) {
      console.log(`Failed to get jobs for run ${run.id}:`, error);
    }
    statuses = buildStatuses(run, jobs);

    if (
      run.status === "completed" ||
      Object.values(statuses).some((s) => s.conclusion === "success")
    ) {
      try {
        const body = await github<{ artifacts: Artifact[] }>(
          token,
          `/repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`,
        );
        artifacts = body.artifacts;
      } catch (error) {
        console.log(`Failed to get artifacts for run ${run.id}:`, error);
      }
    }
  }

  const body = renderComment({
    repository: repo,
    prNumber: pr.number,
    sha,
    statuses,
    artifacts,
    referenceDurations: await fetchReferenceDurations(token, repo),
    runUrl: `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`,
  });

  try {
    await upsertComment(token, repo, pr.number, body);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 403) {
      console.log("Permission denied, skipping the comment:", error.message);
      return;
    }
    throw error;
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
