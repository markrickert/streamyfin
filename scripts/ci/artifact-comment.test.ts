import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Artifact,
  buildStatuses,
  findJobForTarget,
  type Job,
  REFRESH_STEP,
  type Run,
  renderComment,
  type Step,
  settleJobs,
} from "./artifact-comment";

const RUN_ID = 42;
const NOW = "2026-11-05T12:10:00Z";

const step = (
  name: string,
  status: string,
  conclusion: string | null = null,
  started_at: string | null = "2026-11-05T12:09:00Z",
): Step => ({ name, status, conclusion, started_at });

const job = (overrides: Partial<Job> = {}): Job => ({
  run_id: RUN_ID,
  name: "🤖 Build Android APK (Phone)",
  status: "in_progress",
  conclusion: null,
  html_url: "https://github.com/o/r/actions/runs/42/job/1",
  started_at: "2026-11-05T12:00:00Z",
  completed_at: null,
  runner_name: "GitHub Actions 1",
  steps: [step("📥 Checkout code", "completed", "success")],
  ...overrides,
});

const run: Run = {
  id: RUN_ID,
  name: "🏗️ Build Apps",
  status: "in_progress",
  conclusion: null,
  html_url: "https://github.com/o/r/actions/runs/42",
  created_at: "2026-11-05T11:59:00Z",
  updated_at: "2026-11-05T12:05:00Z",
};

const self = (runnerName = "GitHub Actions 1") => ({
  runId: RUN_ID,
  runnerName,
  now: NOW,
});

describe("settleJobs", () => {
  it("reads a job that reached its refresh step as finished", () => {
    const [settled] = settleJobs(
      [
        job({
          runner_name: "GitHub Actions 9",
          steps: [
            step("📤 Upload APK artifact", "completed", "success"),
            step(REFRESH_STEP, "in_progress", null, "2026-11-05T12:08:00Z"),
          ],
        }),
      ],
      self(),
    );
    expect(settled.status).toBe("completed");
    expect(settled.conclusion).toBe("success");
    expect(settled.completed_at).toBe("2026-11-05T12:08:00Z");
  });

  it("reads the job running the script as finished before the API shows its step", () => {
    const [settled] = settleJobs([job()], self());
    expect(settled.status).toBe("completed");
    expect(settled.conclusion).toBe("success");
    expect(settled.completed_at).toBe(NOW);
  });

  it("carries a failed step into the conclusion", () => {
    const [settled] = settleJobs(
      [
        job({
          steps: [
            step("🏗️ Build", "completed", "failure"),
            step("📤 Upload APK artifact", "completed", "skipped"),
            step(REFRESH_STEP, "in_progress"),
          ],
        }),
      ],
      self(),
    );
    expect(settled.conclusion).toBe("failure");
  });

  it("leaves a job that has not reached its refresh step in progress", () => {
    const building = job({
      runner_name: "GitHub Actions 9",
      steps: [
        step("🏗️ Build", "in_progress"),
        step(REFRESH_STEP, "pending", null, null),
      ],
    });
    expect(settleJobs([building], self())).toEqual([building]);
  });

  it("leaves every job alone outside a Build Apps job", () => {
    const building = job();
    expect(settleJobs([building], undefined)).toEqual([building]);
  });

  it("never touches a completed job", () => {
    const done = job({ status: "completed", conclusion: "failure" });
    expect(settleJobs([done], self())).toEqual([done]);
  });
});

describe("findJobForTarget", () => {
  it("prefers the repack that ran over the skipped build", () => {
    const repack = job({
      name: "🤖 Repack Android APK (Phone)",
      status: "completed",
      conclusion: "success",
    });
    const skipped = job({ status: "completed", conclusion: "skipped" });
    expect(
      findJobForTarget(
        [skipped, repack],
        ["🤖 Build Android APK (Phone)", "🤖 Repack Android APK (Phone)"],
      ),
    ).toBe(repack);
  });

  it("never matches the unsigned job for the signed target", () => {
    const unsigned = job({ name: "🍎 Build iOS IPA (Phone - Unsigned)" });
    const signed = job({ name: "🍎 Build iOS IPA (Phone)" });
    expect(
      findJobForTarget([unsigned, signed], ["🍎 Build iOS IPA (Phone)"]),
    ).toBe(signed);
  });
});

describe("renderComment", () => {
  const artifact: Artifact = {
    id: 7,
    name: "streamyfin-android-phone-apk-fp-abc",
    size_in_bytes: 50 * 1024 * 1024,
    workflow_run: { id: RUN_ID },
  };

  it("shows the job running the script as complete with its download", () => {
    const jobs = settleJobs(
      [
        job({
          steps: [
            step("📤 Upload APK artifact", "completed", "success"),
            step(REFRESH_STEP, "in_progress", null, "2026-11-05T12:08:00Z"),
          ],
        }),
      ],
      self(),
    );
    const body = renderComment({
      repository: "o/r",
      prNumber: 12,
      sha: "abcdef1234567",
      statuses: buildStatuses(run, jobs),
      artifacts: [artifact],
      referenceDurations: {},
      runUrl: "https://github.com/o/r/actions/runs/42",
    });
    expect(body).toContain(
      "| 🤖 Android Phone | 📱 Phone | ✅ Complete | [📥 Download APK](https://github.com/o/r/actions/runs/42/artifacts/7) (50.0 MB) - 8m 0s |",
    );
    expect(body).toContain("<!-- streamyfin-artifact-comment -->");
  });

  it("shows the placeholder before any artifact exists", () => {
    const body = renderComment({
      repository: "o/r",
      prNumber: 12,
      sha: "abcdef1234567",
      statuses: {},
      artifacts: [],
      referenceDurations: {},
      runUrl: "https://github.com/o/r/actions/runs/42",
    });
    expect(body).toContain("| 🍎 iOS | 📱 Phone | ⏳ Pending |");
    expect(body).toContain("Builds are starting up");
  });
});

describe("build-apps.yml", () => {
  it("names every refresh step the way settleJobs looks for it", () => {
    const workflow = readFileSync(
      join(__dirname, "../../.github/workflows/build-apps.yml"),
      "utf8",
    );
    const names = [
      ...workflow.matchAll(
        /- name: (.+)\n\s+uses: \.\/\.github\/actions\/refresh-pr-comment/g,
      ),
    ].map((m) => m[1]);
    const callers = workflow.match(
      /uses: \.\/\.github\/actions\/refresh-pr-comment/g,
    );
    expect(names.length).toBe(callers?.length);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names)).toEqual(new Set([REFRESH_STEP]));
  });
});
