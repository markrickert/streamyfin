import type { Artifact } from "../build-cache/pick";
import { artifactName, VARIANTS, variantById } from "../build-cache/variants";
import {
  COMMENT_MARKER,
  type Deps,
  extractRunFingerprints,
  fillFingerprints,
  flattenJobs,
  type RenderModel,
  referenceDurations,
  renderComment,
  resolvePrContext,
  resolveVariantStates,
  runUpdate,
  stripCallerPrefix,
  upsertComment,
  VARIANT_META,
  type VariantState,
} from "./build-comment";

const REPO = "streamyfin/streamyfin";
const REPO_ID = 1000;

interface RecordedCall {
  method: string;
  url: string;
  body?: unknown;
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(
    body === undefined || status === 204 ? null : JSON.stringify(body),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );

/** A scriptable fetch fake routing GitHub API calls by method + substring. */
const makeFakeFetch = () => {
  const state = {
    calls: [] as RecordedCall[],
    routes: [] as Array<{
      match: (method: string, url: string) => boolean;
      respond: () => { status: number; body?: unknown };
      once?: boolean;
      used?: boolean;
    }>,
  };
  const fetchFn = async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    state.calls.push(call);
    const route = state.routes.find(
      (r) => !r.used && r.match(call.method, url),
    );
    if (!route) {
      return jsonResponse(404, { message: `unrouted: ${call.method} ${url}` });
    }
    if (route.once) route.used = true;
    const out = route.respond();
    return jsonResponse(out.status, out.body);
  };
  const on = (
    method: string,
    needle: string | RegExp,
    body: unknown,
    opts: { once?: boolean; status?: number } = {},
  ) => {
    state.routes.push({
      match: (m, url) =>
        m === method &&
        (typeof needle === "string" ? url.includes(needle) : needle.test(url)),
      respond: () => ({ status: opts.status ?? 200, body }),
      once: opts.once,
    });
  };
  return { state, fetchFn, on };
};

const baseDeps = (
  fake: ReturnType<typeof makeFakeFetch>,
  overrides: Partial<Deps> = {},
): Deps => ({
  token: "token",
  repo: REPO,
  fetchFn: fake.fetchFn as never,
  log: () => {},
  env: {},
  ...overrides,
});

let artifactSeq = 1;
const artifact = (
  name: string,
  overrides: Partial<Artifact> & { size_in_bytes?: number } = {},
): Artifact & { size_in_bytes?: number } => {
  const id = artifactSeq++;
  return {
    id,
    name,
    expired: false,
    created_at: "2026-01-14T12:00:00Z",
    workflow_run: {
      id: 500,
      head_branch: "develop",
      head_repository_id: REPO_ID,
      head_sha: "abc",
      repository_id: REPO_ID,
    },
    size_in_bytes: 20 * 1024 * 1024,
    ...overrides,
  };
};

// ---------------------------------------------------------------------------
// Metadata coverage
// ---------------------------------------------------------------------------

describe("VARIANT_META", () => {
  it("covers every variant exactly once, with no orphans", () => {
    for (const variant of VARIANTS) {
      expect(VARIANT_META[variant.id]).toBeDefined();
    }
    expect(Object.keys(VARIANT_META).sort()).toEqual(
      VARIANTS.map((v) => v.id).sort(),
    );
    expect(VARIANTS).toHaveLength(13);
  });

  it("marks the 5 repack variants with repack jobs and the 8 ensure without", () => {
    const repack = VARIANTS.filter((v) => v.mode === "repack");
    const ensure = VARIANTS.filter((v) => v.mode === "ensure");
    expect(repack).toHaveLength(5);
    expect(ensure).toHaveLength(8);
    for (const variant of repack) {
      expect(VARIANT_META[variant.id].repackJob).toBeTruthy();
    }
    for (const variant of ensure) {
      expect(VARIANT_META[variant.id].repackJob).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Job flattening
// ---------------------------------------------------------------------------

describe("flattenJobs", () => {
  it("flattens all 8 grouped build jobs into their steps", () => {
    const groups = [
      "Build Apple variants",
      "Build Android variants",
      "Build Android phone",
      "Build Android TV",
      "Build iOS device",
      "Build tvOS device",
      "Build iOS simulators",
      "Build tvOS simulators",
    ];
    const jobs = groups.map((name, i) => ({
      name: `caller / ${name}`,
      status: "completed",
      conclusion: "success",
      steps: [
        { name: `step-${i}`, status: "completed", conclusion: "success" },
      ],
    }));
    const flat = flattenJobs(jobs);
    expect(flat).toHaveLength(groups.length);
    expect(flat.map((f) => f.name)).toEqual(groups.map((_, i) => `step-${i}`));
  });

  it("passes non-grouped jobs through with the caller prefix stripped", () => {
    const flat = flattenJobs([
      {
        name: "ios-phone / 🍎 Repack iOS IPA (Phone)",
        status: "completed",
        conclusion: "success",
      },
    ]);
    expect(flat[0].name).toBe("🍎 Repack iOS IPA (Phone)");
  });

  it("keeps step-level status and timing on the flattened entry", () => {
    const flat = flattenJobs([
      {
        name: "Build Android phone",
        status: "completed",
        conclusion: "success",
        html_url: "https://example.com/job",
        steps: [
          {
            name: "🤖 Build Android APK (Phone) · build",
            status: "in_progress",
            conclusion: null,
            started_at: "2026-01-15T11:00:00Z",
            completed_at: "2026-01-15T11:10:00Z",
          },
        ],
      },
    ]);
    expect(flat[0].status).toBe("in_progress");
    expect(flat[0].html_url).toBe("https://example.com/job");
  });
});

describe("stripCallerPrefix", () => {
  it("strips and leaves plain names alone", () => {
    expect(stripCallerPrefix("a / b")).toBe("b");
    expect(stripCallerPrefix("plain")).toBe("plain");
  });
});

// ---------------------------------------------------------------------------
// Status resolution
// ---------------------------------------------------------------------------

const RESOLVE_BASE = {
  runArtifacts: [] as Artifact[],
  cachedArtifacts: new Map<string, Artifact | undefined>(),
  referenceDurations: {} as Record<string, number>,
};

const stateFor = (states: VariantState[], id: string): VariantState => {
  const state = states.find((s) => s.variant.id === id);
  if (!state) throw new Error(`no state for ${id}`);
  return state;
};

describe("resolveVariantStates", () => {
  const ANDROID_PHONE_STEP = "🤖 Build Android APK (Phone) · build";
  const ANDROID_PHONE_REPACK = "🤖 Repack Android APK (Phone)";

  it("reports a repack variant built by the repack job as repack", () => {
    const art = artifact(
      "streamyfin-android-phone-release-device-debugkey-r1-fp-abc",
    );
    const states = resolveVariantStates({
      ...RESOLVE_BASE,
      runArtifacts: [art],
      jobs: [
        {
          name: ANDROID_PHONE_REPACK,
          status: "completed",
          conclusion: "success",
        },
      ],
    });
    const state = stateFor(states, "android-phone-release-device-debugkey");
    expect(state.status).toBe("ready");
    expect(state.buildSource).toBe("repack");
  });

  it("reports a repack variant built by the full build step as full build", () => {
    const art = artifact(
      "streamyfin-android-phone-release-device-debugkey-r1-fp-abc",
    );
    const states = resolveVariantStates({
      ...RESOLVE_BASE,
      runArtifacts: [art],
      jobs: [
        {
          name: "Build Android phone",
          status: "completed",
          conclusion: "success",
          steps: [
            {
              name: ANDROID_PHONE_STEP,
              status: "completed",
              conclusion: "success",
            },
          ],
        },
        {
          name: ANDROID_PHONE_REPACK,
          status: "completed",
          conclusion: "skipped",
        },
      ],
    });
    const state = stateFor(states, "android-phone-release-device-debugkey");
    expect(state.status).toBe("ready");
    expect(state.buildSource).toBe("full");
  });

  it("reports an ensure variant from the run artifacts as built", () => {
    const art = artifact(
      "streamyfin-ios-phone-debug-simulator-unsigned-r1-fp-x",
    );
    const states = resolveVariantStates({
      ...RESOLVE_BASE,
      runArtifacts: [art],
      jobs: [],
    });
    const state = stateFor(states, "ios-phone-debug-simulator-unsigned");
    expect(state.status).toBe("ready");
    expect(state.buildSource).toBeNull();
  });

  it("reports an ensure variant resolved from cache as cached", () => {
    const cached = artifact(
      "streamyfin-ios-phone-debug-simulator-unsigned-r1-fp-x",
    );
    const states = resolveVariantStates({
      ...RESOLVE_BASE,
      cachedArtifacts: new Map([
        ["ios-phone-debug-simulator-unsigned", cached],
      ]),
      jobs: [],
    });
    const state = stateFor(states, "ios-phone-debug-simulator-unsigned");
    expect(state.status).toBe("ready");
    expect(state.buildSource).toBe("cached");
  });

  it("keeps signed iOS pending before planning finishes", () => {
    expect(
      stateFor(
        resolveVariantStates({ ...RESOLVE_BASE, jobs: [] }),
        "ios-phone-release-device-signed",
      ).status,
    ).toBe("pending");

    const states = resolveVariantStates({
      ...RESOLVE_BASE,
      jobs: [
        {
          name: "Plan full native builds",
          status: "in_progress",
          conclusion: null,
        },
      ],
    });
    expect(stateFor(states, "ios-phone-release-device-signed").status).toBe(
      "pending",
    );
  });

  it("marks signed iOS as skipped once planning finished with jobs skipped or absent", () => {
    const states = resolveVariantStates({
      ...RESOLVE_BASE,
      jobs: [
        {
          name: "Plan full native builds",
          status: "completed",
          conclusion: "success",
        },
        {
          name: "🍎 Repack iOS IPA (Phone)",
          status: "completed",
          conclusion: "skipped",
        },
      ],
    });
    expect(stateFor(states, "ios-phone-release-device-signed").status).toBe(
      "skipped",
    );
  });

  it("marks signed iOS skipped when the gate completes successfully without it", () => {
    const states = resolveVariantStates({
      ...RESOLVE_BASE,
      jobs: [
        {
          name: "🍎 Build iOS IPA (Phone)",
          status: "completed",
          conclusion: "success",
        },
        {
          name: "🍎 Repack iOS IPA (Phone)",
          status: "completed",
          conclusion: "skipped",
        },
      ],
    });
    expect(stateFor(states, "ios-phone-release-device-signed").status).toBe(
      "skipped",
    );
  });

  it("uses the full-build ETA when the full-build step is in progress", () => {
    const step = "🤖 Build Android APK (Phone) · build";
    const states = resolveVariantStates({
      ...RESOLVE_BASE,
      referenceDurations: {
        "🤖 Repack Android APK (Phone)": 120000,
        [step]: 2100000,
      },
      jobs: [
        {
          name: "Build Android phone",
          status: "in_progress",
          conclusion: null,
          steps: [{ name: step, status: "in_progress", conclusion: null }],
        },
      ],
    });
    const state = stateFor(states, "android-phone-release-device-debugkey");
    expect(state.etaMs).toBe(2100000);
  });

  it("uses the repack ETA when the repack job is in progress", () => {
    const states = resolveVariantStates({
      ...RESOLVE_BASE,
      referenceDurations: {
        "🤖 Repack Android APK (Phone)": 120000,
        "🤖 Build Android APK (Phone) · build": 2100000,
      },
      jobs: [
        {
          name: "🤖 Repack Android APK (Phone)",
          status: "in_progress",
          conclusion: null,
        },
      ],
    });
    const state = stateFor(states, "android-phone-release-device-debugkey");
    expect(state.etaMs).toBe(120000);
  });

  it("does not match a short unrelated job name like 'build'", () => {
    const states = resolveVariantStates({
      ...RESOLVE_BASE,
      jobs: [{ name: "build", status: "completed", conclusion: "success" }],
    });
    for (const state of states) {
      expect(state.job?.name).not.toBe("build");
      expect(state.status).toBe("pending");
    }
  });

  it("reports failed and queued steps", () => {
    const states = resolveVariantStates({
      ...RESOLVE_BASE,
      jobs: [
        {
          name: "Build Android TV",
          status: "completed",
          conclusion: "failure",
          steps: [
            {
              name: "🤖 Build Android APK (TV) · build",
              status: "completed",
              conclusion: "failure",
            },
          ],
        },
        {
          name: "🛠️ Build dev client (iOS simulator)",
          status: "queued",
          conclusion: null,
        },
      ],
    });
    expect(stateFor(states, "android-tv-release-device-debugkey").status).toBe(
      "failed",
    );
    expect(stateFor(states, "ios-phone-debug-simulator-unsigned").status).toBe(
      "queued",
    );
  });
});

// ---------------------------------------------------------------------------
// Fingerprints and durations
// ---------------------------------------------------------------------------

describe("extractRunFingerprints", () => {
  it("maps os-form keys from artifact names", () => {
    const fps = extractRunFingerprints([
      { name: "streamyfin-ios-phone-release-device-signed-r1-fp-deadbeef" },
      { name: "streamyfin-android-tv-debug-device-debugkey-r1-fp-cafe" },
    ]);
    expect(fps["ios-phone"]).toBe("deadbeef");
    expect(fps["android-tv"]).toBe("cafe");
  });
});

describe("fillFingerprints", () => {
  it("computes missing pairs and never throws on failure", () => {
    const deps: Deps = {
      token: "",
      repo: REPO,
      log: () => {},
      hashForFn: ({ os, form }) => {
        if (os === "android") throw new Error("no native env");
        return `${os}-${form}-hash`;
      },
    };
    const fps = fillFingerprints(deps, { "android-phone": "existing" });
    expect(fps["ios-phone"]).toBe("ios-phone-hash");
    expect(fps["ios-tv"]).toBe("ios-tv-hash");
    expect(fps["android-phone"]).toBe("existing");
    expect(fps["android-tv"]).toBeUndefined();
  });
});

describe("referenceDurations", () => {
  it("collects durations of successful flattened jobs and steps", () => {
    const durations = referenceDurations([
      {
        name: "🤖 Repack Android APK (Phone)",
        status: "completed",
        conclusion: "success",
        started_at: "2026-01-10T10:00:00Z",
        completed_at: "2026-01-10T10:03:00Z",
      },
      {
        name: "Build Android phone",
        status: "completed",
        conclusion: "success",
        steps: [
          {
            name: "🛠️ Build dev client (Android phone)",
            status: "completed",
            conclusion: "success",
            started_at: "2026-01-10T10:00:00Z",
            completed_at: "2026-01-10T10:30:00Z",
          },
        ],
      },
    ]);
    expect(durations["🤖 Repack Android APK (Phone)"]).toBe(180000);
    expect(durations["🛠️ Build dev client (Android phone)"]).toBe(1800000);
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const baseModel = (states: VariantState[]): RenderModel => ({
  prNumber: 42,
  headSha: "abc1234567890",
  states,
  repo: REPO,
});

const makeState = (
  id: string,
  overrides: Partial<VariantState> = {},
): VariantState => {
  const variant = variantById(id);
  if (!variant) throw new Error(`unknown variant ${id}`);
  return {
    variant,
    meta: VARIANT_META[id],
    status: "pending",
    buildSource: null,
    ...overrides,
  };
};

describe("renderComment", () => {
  it("renders a cold run with all 13 rows in both tables", () => {
    const states = VARIANTS.map((v) =>
      makeState(v.id, {
        status: "building",
        etaMs: 600000,
        jobUrl: "https://example.com/run",
      }),
    );
    const body = renderComment(baseModel(states));
    expect(body).toContain("## 🔧 Build Status for PR #42");
    expect(body).toContain("### 📦 PR Device Builds");
    expect(body).toContain("### 🛠️ Simulators, Dev Clients & Universal Builds");
    expect(body.match(/🔄 \[Building…\]/g)?.length).toBeGreaterThanOrEqual(10);
    expect(body).toContain("avg on develop");
    expect(body).toContain("Builds are starting up");
    expect(body).toContain(COMMENT_MARKER);
    expect(body).toContain("ubuntu-26.04");
    expect(body).toContain("xcode-27");
    expect(body).toContain(
      "Fetch locally: `bun scripts/build-cache/cli.ts fetch <variant-id>`",
    );
  });

  it("renders a warm run with direct Actions download links", () => {
    const states = VARIANTS.map((v) => {
      if (v.mode === "repack") {
        return makeState(v.id, {
          status: "ready",
          buildSource: "repack",
          artifact: artifact(artifactName(v, "fp")),
          durationMs: 120000,
        });
      }
      return makeState(v.id, {
        status: "ready",
        buildSource: "cached",
        cachedArtifact: artifact(artifactName(v, "fp")),
      });
    });
    const body = renderComment(baseModel(states));
    expect(body.match(/✅ Repack/g)?.length).toBe(5);
    expect(body.match(/✅ Cached/g)?.length).toBe(8);
    expect(body).toContain(
      "https://github.com/streamyfin/streamyfin/actions/runs/500/artifacts/",
    );
    expect(body).toContain("20.0 MB");
    expect(body).not.toContain("20971520.0 MB");
    expect(body).toContain("2m 0s");
    expect(body).toContain("### 🔧 Installation Instructions");
    expect(body).not.toContain("Builds are starting up");
  });

  it("renders skipped signed iOS with the no-credentials note", () => {
    const states = VARIANTS.map((v) =>
      makeState(v.id, {
        status:
          v.id === "ios-phone-release-device-signed" ? "skipped" : "building",
      }),
    );
    const body = renderComment(baseModel(states));
    expect(body).toContain("⏭️ Skipped");
    expect(body).toContain("*No signing credentials*");
  });

  it("documents accurate ABIs and retention in the details block", () => {
    const body = renderComment(baseModel(VARIANTS.map((v) => makeState(v.id))));
    expect(body).toContain("`arm64-v8a` + `armeabi-v7a`");
    expect(body).toContain("`x86_64` (universal, 4 ABIs)");
    expect(body).toContain("expire after 7 days");
    expect(body).toContain("kept up to 90 days");
    expect(body).toContain("`arm64` (simulator slice only)");
  });
});

// ---------------------------------------------------------------------------
// upsertComment
// ---------------------------------------------------------------------------

describe("upsertComment", () => {
  it("paginates comments and updates the existing bot comment", async () => {
    const fake = makeFakeFetch();
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: `comment ${i}`,
      user: { type: "User" },
    }));
    fake.state.routes.push({
      match: (m, url) =>
        m === "GET" &&
        url.includes("/issues/42/comments") &&
        url.endsWith("page=1"),
      respond: () => ({ status: 200, body: page1 }),
    });
    fake.state.routes.push({
      match: (m, url) =>
        m === "GET" &&
        url.includes("/issues/42/comments") &&
        url.endsWith("page=2"),
      respond: () => ({
        status: 200,
        body: [{ id: 555, body: `x ${COMMENT_MARKER}`, user: { type: "Bot" } }],
      }),
    });
    fake.on("PATCH", "/issues/comments/555", { id: 555 });
    await upsertComment(baseDeps(fake), 42, "new body");
    const patch = fake.state.calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
    expect((patch!.body as { body: string }).body).toBe("new body");
    expect(
      fake.state.calls.some(
        (c) => c.method === "POST" && c.url.includes("/issues/42/comments"),
      ),
    ).toBe(false);
  });

  it("creates a comment when none exists", async () => {
    const fake = makeFakeFetch();
    fake.on("GET", "/issues/42/comments", []);
    fake.on("POST", "/issues/42/comments", { id: 1 });
    await upsertComment(baseDeps(fake), 42, "body");
    expect(
      fake.state.calls.some(
        (c) => c.method === "POST" && c.url.includes("/issues/42/comments"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolvePrContext
// ---------------------------------------------------------------------------

describe("resolvePrContext", () => {
  it("uses the pull_request payload directly", async () => {
    const fake = makeFakeFetch();
    const deps = baseDeps(fake, {
      env: { GITHUB_REPOSITORY_ID: String(REPO_ID) },
    });
    const ctx = await resolvePrContext(deps, {
      pull_request: {
        number: 5,
        head: { sha: "sha5", ref: "feat/five", repo: { id: REPO_ID } },
      },
    });
    expect(ctx).toEqual({
      prNumber: 5,
      headSha: "sha5",
      repositoryId: REPO_ID,
      prHeadRef: "feat/five",
      prHeadRepositoryId: REPO_ID,
    });
  });

  it("resolves workflow_run through commits/<sha>/pulls", async () => {
    const fake = makeFakeFetch();
    fake.on("GET", "/commits/runsha/pulls", [
      {
        number: 8,
        head: { sha: "runsha", ref: "feat/eight", repo: { id: REPO_ID } },
      },
    ]);
    const deps = baseDeps(fake, {
      env: { GITHUB_REPOSITORY_ID: String(REPO_ID) },
    });
    const ctx = await resolvePrContext(deps, {
      workflow_run: { head_sha: "runsha" },
    });
    expect(ctx?.prNumber).toBe(8);
    expect(ctx?.headSha).toBe("runsha");
    expect(ctx?.prHeadRef).toBe("feat/eight");
  });

  it("prefers the pull request GITHUB_SHA belongs to on workflow_dispatch", async () => {
    const fake = makeFakeFetch();
    fake.on("GET", "/commits/sha-of-pr-7/pulls", [
      {
        number: 7,
        head: { sha: "sha-of-pr-7", ref: "feat/seven", repo: { id: REPO_ID } },
      },
    ]);
    fake.on("GET", "/pulls?state=open", [
      {
        number: 99,
        head: { sha: "other", ref: "feat/other", repo: { id: REPO_ID } },
      },
    ]);
    const deps = baseDeps(fake, {
      env: { GITHUB_REPOSITORY_ID: String(REPO_ID), GITHUB_SHA: "sha-of-pr-7" },
    });
    const ctx = await resolvePrContext(deps, {});
    expect(ctx?.prNumber).toBe(7);
    expect(
      fake.state.calls.some((c) => c.url.includes("/pulls?state=open")),
    ).toBe(false);
  });

  it("falls back to the latest open PR when GITHUB_SHA matches none", async () => {
    const fake = makeFakeFetch();
    fake.on("GET", "/commits/unmatched/pulls", []);
    fake.on("GET", "/pulls?state=open", [
      {
        number: 99,
        head: { sha: "other", ref: "feat/other", repo: { id: REPO_ID } },
      },
    ]);
    const deps = baseDeps(fake, {
      env: { GITHUB_REPOSITORY_ID: String(REPO_ID), GITHUB_SHA: "unmatched" },
    });
    const ctx = await resolvePrContext(deps, {});
    expect(ctx?.prNumber).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// runUpdate integration (scripted fetch)
// ---------------------------------------------------------------------------

describe("runUpdate", () => {
  const FP = "fpabc";
  const HEAD_SHA = "abc1234567890abcdef";

  const wireRunUpdate = (
    fake: ReturnType<typeof makeFakeFetch>,
    opts: {
      jobs?: unknown[];
      runArtifacts?: unknown[];
      cachedArtifactsByName?: Record<string, unknown[]>;
    } = {},
  ) => {
    const runArtifacts = opts.runArtifacts ?? [];
    fake.on("GET", "/actions/runs?", {
      workflow_runs: [
        {
          id: 500,
          name: "🏗️ Build Apps",
          status: "in_progress",
          conclusion: null,
          html_url: "https://github.com/streamyfin/streamyfin/actions/runs/500",
          head_sha: HEAD_SHA,
          created_at: "2026-01-15T10:00:00Z",
        },
      ],
    });
    fake.on("GET", "/actions/runs/500/jobs", {
      jobs: opts.jobs ?? [],
      total_count: (opts.jobs ?? []).length,
    });
    fake.on("GET", "/actions/runs/500/artifacts", { artifacts: runArtifacts });
    fake.on("GET", "/actions/workflows/build-apps.yml/runs", {
      workflow_runs: [],
    });
    for (const [name, artifacts] of Object.entries(
      opts.cachedArtifactsByName ?? {},
    )) {
      fake.state.routes.push({
        match: (m, url) =>
          m === "GET" &&
          url.includes(`/actions/artifacts?name=${encodeURIComponent(name)}`),
        respond: () => ({
          status: 200,
          body: { total_count: artifacts.length, artifacts },
        }),
      });
    }
    // Artifact lookups for names not otherwise routed → empty.
    fake.state.routes.push({
      match: (m, url) =>
        m === "GET" && url.includes("/actions/artifacts?name="),
      respond: () => ({ status: 200, body: { total_count: 0, artifacts: [] } }),
    });
    fake.on("GET", "/pulls/42/commits", [{ sha: HEAD_SHA }]);
    fake.on("GET", "/issues/42/comments", []);
    fake.on("POST", "/issues/42/comments", { id: 1 });
  };

  const updateArgs = {
    prNumber: 42,
    headSha: HEAD_SHA,
    repositoryId: REPO_ID,
    prHeadRef: "feat/x",
    prHeadRepositoryId: REPO_ID,
  };

  it("cold run: posts comment with rows building or pending", async () => {
    const fake = makeFakeFetch();
    wireRunUpdate(fake, {
      jobs: [
        {
          name: "Build Android phone",
          status: "in_progress",
          conclusion: null,
          html_url: "https://x/job",
          steps: [
            {
              name: "🤖 Build Android APK (Phone) · build",
              status: "in_progress",
              conclusion: null,
            },
          ],
        },
      ],
    });
    const deps = baseDeps(fake, { hashForFn: () => FP });
    const body = await runUpdate(deps, updateArgs);
    expect(body).toContain("## 🔧 Build Status for PR #42");
    expect(body).toContain("🔄 [Building…]");
    expect(body).not.toContain("⏭️ Skipped"); // planning has not finished yet
    expect(body).toContain("Builds are starting up");
    const post = fake.state.calls.find(
      (c) => c.method === "POST" && c.url.includes("/issues/42/comments"),
    );
    expect(post).toBeDefined();
    expect((post!.body as { body: string }).body).toContain(COMMENT_MARKER);
  });

  it("warm run: links run artifacts and cached ensure artifacts", async () => {
    const fake = makeFakeFetch();
    const repackArtifact = artifact(
      "streamyfin-android-phone-release-device-debugkey-r1-fp-fpabc",
      {
        workflow_run: {
          id: 500,
          head_branch: "feat/x",
          head_repository_id: REPO_ID,
          head_sha: HEAD_SHA,
          repository_id: REPO_ID,
        },
      },
    );
    const cachedName = artifactName(
      variantById("ios-phone-debug-simulator-unsigned")!,
      FP,
    );
    const cached = artifact(cachedName);
    wireRunUpdate(fake, {
      jobs: [
        {
          name: "🤖 Repack Android APK (Phone)",
          status: "completed",
          conclusion: "success",
          html_url: "https://x/job",
          started_at: "2026-01-15T10:00:00Z",
          completed_at: "2026-01-15T10:02:00Z",
        },
      ],
      runArtifacts: [repackArtifact],
      cachedArtifactsByName: { [cachedName]: [cached] },
    });
    const deps = baseDeps(fake, { hashForFn: () => FP });
    const body = await runUpdate(deps, updateArgs);

    expect(body).toContain("✅ Repack");
    expect(body).toContain("✅ Cached");
    expect(body).toContain(
      `[📥 Download APK](https://github.com/streamyfin/streamyfin/actions/runs/500/artifacts/${repackArtifact.id})`,
    );
    expect(body).toContain(
      `[📥 Download TAR](https://github.com/streamyfin/streamyfin/actions/runs/500/artifacts/${cached.id})`,
    );
    expect(body).toContain("20.0 MB");
    expect(body).toContain("2m 0s");
    expect(body).toContain("### 🔧 Installation Instructions");
  });
});
