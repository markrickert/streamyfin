import type { Artifact } from "../build-cache/pick";
import { artifactName, VARIANTS, variantById } from "../build-cache/variants";
import {
  COMMENT_MARKER,
  type Deps,
  extractRunFingerprints,
  fillFingerprints,
  findLatestAppsRun,
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

  it("marks the 9 repack variants with repack jobs and the 4 dev clients without", () => {
    const repack = VARIANTS.filter((v) => v.mode === "repack");
    const ensure = VARIANTS.filter((v) => v.mode === "ensure");
    expect(repack).toHaveLength(9);
    expect(ensure).toHaveLength(4);
    for (const variant of repack) {
      expect(VARIANT_META[variant.id].repackJob).toBeTruthy();
    }
    for (const variant of ensure) {
      expect(VARIANT_META[variant.id].repackJob).toBeUndefined();
    }
    expect(ensure.map((v) => v.id).sort()).toEqual([
      "android-phone-debug-device-debugkey",
      "android-tv-debug-device-debugkey",
      "ios-phone-debug-simulator-unsigned",
      "ios-tv-debug-simulator-unsigned",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Job flattening
// ---------------------------------------------------------------------------

describe("flattenJobs", () => {
  it("flattens the 6 grouped build jobs into their steps", () => {
    const groups = [
      "🤖 Build Android Phone",
      "🤖 Build Android TV",
      "🍎 Build iOS Device",
      "🍎 Build tvOS Device",
      "🍎 Build iOS Simulators",
      "🍎 Build tvOS Simulators",
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

  it("still flattens the pre-emoji grouped job names from earlier runs", () => {
    for (const name of [
      "Build Android phone",
      "Build Android TV",
      "Build iOS device",
      "Build tvOS device",
      "Build iOS simulators",
      "Build tvOS simulators",
    ]) {
      const flat = flattenJobs([
        {
          name,
          status: "completed",
          conclusion: "success",
          steps: [{ name: "step", status: "completed", conclusion: "success" }],
        },
      ]);
      expect(flat[0].name).toBe("step");
    }
  });

  it("passes non-grouped jobs through with the caller prefix stripped", () => {
    const flat = flattenJobs([
      {
        name: "ios-phone / 🍎 Repack iOS Phone (Signed IPA)",
        status: "completed",
        conclusion: "success",
      },
    ]);
    expect(flat[0].name).toBe("🍎 Repack iOS Phone (Signed IPA)");
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
            name: "🤖 Build Android Phone (Release APK)",
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
  const ANDROID_PHONE_STEP = "🤖 Build Android Phone (Release APK)";
  const ANDROID_PHONE_REPACK = "🤖 Repack Android Phone (Release APK)";

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
          name: "🍎 Repack iOS Phone (Signed IPA)",
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
          name: "🍎 Repack iOS Phone (Signed IPA)",
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
    const step = "🤖 Build Android Phone (Release APK)";
    const states = resolveVariantStates({
      ...RESOLVE_BASE,
      referenceDurations: {
        "🤖 Repack Android Phone (Release APK)": 120000,
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
        "🤖 Repack Android Phone (Release APK)": 120000,
        "🤖 Build Android Phone (Release APK)": 2100000,
      },
      jobs: [
        {
          name: "🤖 Repack Android Phone (Release APK)",
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
              name: "🤖 Build Android TV (Release APK)",
              status: "completed",
              conclusion: "failure",
            },
          ],
        },
        {
          name: "🍎 Build iOS Phone (Simulator Debug)",
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

  it("fails unfulfilled variants when their grouped job dies in setup", () => {
    const states = resolveVariantStates({
      ...RESOLVE_BASE,
      jobs: [
        {
          name: "🤖 Build Android Phone",
          status: "completed",
          conclusion: "failure",
          html_url: "https://example.com/job/1",
          steps: [
            {
              name: "📦 Install dependencies",
              status: "completed",
              conclusion: "failure",
            },
            {
              name: "🤖 Build Android Phone (Release APK)",
              status: "completed",
              conclusion: "skipped",
            },
          ],
        },
      ],
    });
    const state = stateFor(states, "android-phone-release-device-debugkey");
    expect(state.status).toBe("failed");
    expect(state.jobUrl).toBe("https://example.com/job/1");
  });

  it("fails unfulfilled variants when the grouped job dies before recording steps", () => {
    const states = resolveVariantStates({
      ...RESOLVE_BASE,
      jobs: [
        {
          name: "🤖 Build Android Phone",
          status: "completed",
          conclusion: "failure",
          html_url: "https://example.com/job/2",
          steps: [],
        },
      ],
    });
    const state = stateFor(states, "android-phone-release-device-debugkey");
    expect(state.status).toBe("failed");
    expect(state.jobUrl).toBe("https://example.com/job/2");
  });

  it("keeps fulfilled variants ready when their grouped job fails", () => {
    const repacked = artifact(
      "streamyfin-android-phone-release-device-debugkey-r1-fp-abc",
    );
    const cachedDebug = artifact(
      "streamyfin-android-phone-debug-device-debugkey-r1-fp-x",
    );
    const states = resolveVariantStates({
      ...RESOLVE_BASE,
      runArtifacts: [repacked],
      cachedArtifacts: new Map([
        ["android-phone-debug-device-debugkey", cachedDebug],
      ]),
      jobs: [
        {
          name: "🤖 Repack Android Phone (Release APK)",
          status: "completed",
          conclusion: "success",
        },
        {
          name: "🤖 Build Android Phone",
          status: "completed",
          conclusion: "failure",
          html_url: "https://example.com/job/3",
          steps: [
            {
              name: "📦 Install dependencies",
              status: "completed",
              conclusion: "failure",
            },
            {
              name: "🤖 Build Android Phone (Universal Release APK)",
              status: "completed",
              conclusion: "skipped",
            },
          ],
        },
      ],
    });
    const repackState = stateFor(
      states,
      "android-phone-release-device-debugkey",
    );
    expect(repackState.status).toBe("ready");
    expect(repackState.buildSource).toBe("repack");
    const debugState = stateFor(states, "android-phone-debug-device-debugkey");
    expect(debugState.status).toBe("ready");
    expect(debugState.buildSource).toBe("cached");
    const universal = stateFor(
      states,
      "android-phone-release-device-debugkey-universal",
    );
    expect(universal.status).toBe("failed");
    expect(universal.jobUrl).toBe("https://example.com/job/3");
  });

  it("keeps signed iOS skipped on a fork when the unsigned build fails", () => {
    const states = resolveVariantStates({
      ...RESOLVE_BASE,
      jobs: [
        {
          name: "🗺️ Plan full native builds",
          status: "completed",
          conclusion: "success",
        },
        {
          name: "🍎 Build iOS IPA (Phone)",
          status: "completed",
          conclusion: "success",
        },
        {
          name: "🍎 Build iOS Phone (Device)",
          status: "completed",
          conclusion: "failure",
          html_url: "https://example.com/job/4",
          steps: [
            {
              name: "🍎 Build iOS Phone (Unsigned IPA)",
              status: "completed",
              conclusion: "failure",
            },
            {
              name: "🍎 Build iOS Phone (Signed IPA)",
              status: "completed",
              conclusion: "skipped",
            },
          ],
        },
      ],
    });
    expect(stateFor(states, "ios-phone-release-device-signed").status).toBe(
      "skipped",
    );
    expect(stateFor(states, "ios-phone-release-device-unsigned").status).toBe(
      "failed",
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
        name: "🤖 Repack Android Phone (Release APK)",
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
            name: "🤖 Build Android Phone (Debug APK)",
            status: "completed",
            conclusion: "success",
            started_at: "2026-01-10T10:00:00Z",
            completed_at: "2026-01-10T10:30:00Z",
          },
        ],
      },
    ]);
    expect(durations["🤖 Repack Android Phone (Release APK)"]).toBe(180000);
    expect(durations["🤖 Build Android Phone (Debug APK)"]).toBe(1800000);
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
    expect(body).toContain("### 📦 PR Builds");
    expect(body).toContain("### 🛠️ Dev Clients (connect to local Metro)");
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
    expect(body.match(/✅ Repack/g)?.length).toBe(9);
    expect(body.match(/✅ Cached/g)?.length).toBe(4);
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

  it("places the 9 repack variants in PR Builds and the 4 dev clients under Dev Clients", () => {
    const body = renderComment(baseModel(VARIANTS.map((v) => makeState(v.id))));
    const prSection = body.split("### 📦 PR Builds")[1].split("### 🛠️")[0];
    const devSection = body
      .split("### 🛠️ Dev Clients (connect to local Metro)")[1]
      .split("<details>")[0];
    // Platform labels repeat across variants, so rows are matched by the
    // label + target pair, which is unique per variant.
    for (const variant of VARIANTS) {
      const meta = VARIANT_META[variant.id];
      const row = `| ${meta.icon} ${meta.label} | ${meta.target} |`;
      if (variant.mode === "repack") {
        expect(prSection).toContain(row);
        expect(devSection).not.toContain(row);
      } else {
        expect(devSection).toContain(row);
        expect(prSection).not.toContain(row);
      }
    }
  });

  it("never marks the promoted release variants as cached", () => {
    const states = VARIANTS.map((v) => {
      if (v.mode === "ensure") {
        return makeState(v.id, {
          status: "ready",
          buildSource: "cached",
          cachedArtifact: artifact(artifactName(v, "fp")),
        });
      }
      return makeState(v.id);
    });
    const body = renderComment(baseModel(states));
    const prSection = body.split("### 📦 PR Builds")[1].split("### 🛠️")[0];
    expect(prSection).not.toContain("✅ Cached");
    expect(body.match(/✅ Cached/g)?.length).toBe(4);
    for (const id of [
      "ios-phone-release-simulator-unsigned",
      "ios-tv-release-simulator-unsigned",
      "android-phone-release-device-debugkey-universal",
      "android-tv-release-device-debugkey-universal",
    ]) {
      const meta = VARIANT_META[id];
      const row = prSection
        .split("\n")
        .find(
          (line) => line.includes(meta.label) && line.includes(meta.target),
        );
      expect(row).toContain("⏳ Pending");
    }
  });

  it("marks a promoted release variant as repack once its repack job finishes", () => {
    for (const [id, repackJob] of [
      [
        "ios-phone-release-simulator-unsigned",
        "🍎 Repack iOS Phone (Simulator Release)",
      ],
      [
        "ios-tv-release-simulator-unsigned",
        "🍎 Repack iOS TV (Simulator Release)",
      ],
      [
        "android-phone-release-device-debugkey-universal",
        "🤖 Repack Android Phone (Universal Release APK)",
      ],
      [
        "android-tv-release-device-debugkey-universal",
        "🤖 Repack Android TV (Universal Release APK)",
      ],
    ] as const) {
      const art = artifact(artifactName(variantById(id)!, "abc"));
      const states = resolveVariantStates({
        ...RESOLVE_BASE,
        runArtifacts: [art],
        jobs: [{ name: repackJob, status: "completed", conclusion: "success" }],
      });
      const state = stateFor(states, id);
      expect(state.status).toBe("ready");
      expect(state.buildSource).toBe("repack");
    }
  });

  it("keeps the promoted release variants pending before their repack runs", () => {
    const states = resolveVariantStates({ ...RESOLVE_BASE, jobs: [] });
    for (const id of [
      "ios-phone-release-simulator-unsigned",
      "ios-tv-release-simulator-unsigned",
      "android-phone-release-device-debugkey-universal",
      "android-tv-release-device-debugkey-universal",
    ]) {
      expect(stateFor(states, id).status).toBe("pending");
    }
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
              name: "🤖 Build Android Phone (Release APK)",
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
    const cached = artifact(cachedName, {
      workflow_run: {
        id: 777,
        head_branch: "develop",
        head_repository_id: REPO_ID,
        head_sha: "dev-sha",
        repository_id: REPO_ID,
      },
    });
    wireRunUpdate(fake, {
      jobs: [
        {
          name: "🤖 Repack Android Phone (Release APK)",
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
      `[📥 Download TAR](https://github.com/streamyfin/streamyfin/actions/runs/777/artifacts/${cached.id})`,
    );
    expect(body).toContain("20.0 MB");
    expect(body).toContain("2m 0s");
    expect(body).toContain("### 🔧 Installation Instructions");
  });

  it("hashes the checkout only when CHECKED_OUT_SHA matches the target head", async () => {
    for (const [checkedOut, expectedCalls] of [
      [HEAD_SHA, 4],
      ["deadbeefdeadbeef", 0],
    ] as const) {
      const fake = makeFakeFetch();
      wireRunUpdate(fake);
      const hashForFn = jest.fn(() => FP);
      const deps = baseDeps(fake, {
        hashForFn,
        env: { CHECKED_OUT_SHA: checkedOut },
      });
      await runUpdate(deps, updateArgs);
      expect(hashForFn).toHaveBeenCalledTimes(expectedCalls);
    }
  });

  it("hashes the checkout when CHECKED_OUT_SHA is unset", async () => {
    const fake = makeFakeFetch();
    wireRunUpdate(fake);
    const hashForFn = jest.fn(() => FP);
    await runUpdate(baseDeps(fake, { hashForFn, env: {} }), updateArgs);
    expect(hashForFn).toHaveBeenCalledTimes(4);
  });

  it("still posts the comment when listing the PR commits fails", async () => {
    const fake = makeFakeFetch();
    wireRunUpdate(fake);
    // No route for /pulls/42/commits: the fake answers 404, the lookup throws,
    // and the comment must still post with whatever the run produced.
    fake.state.routes = fake.state.routes.filter(
      (r) => !r.match("GET", "https://api.github.com/repos/x/pulls/42/commits"),
    );
    const deps = baseDeps(fake, { hashForFn: () => FP });
    const body = await runUpdate(deps, updateArgs);
    expect(body).toContain("## 🔧 Build Status for PR #42");
    expect(body).toContain(COMMENT_MARKER);
    const post = fake.state.calls.find(
      (c) => c.method === "POST" && c.url.includes("/issues/42/comments"),
    );
    expect(post).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// CodeRabbit regression tests
// ---------------------------------------------------------------------------

describe("artifactPattern regression (unhashed fallback artifacts)", () => {
  it("matches an unhashed fallback artifact as the variant's own", () => {
    const fallback = artifact(
      "streamyfin-android-phone-release-device-debugkey-unhashed-123-2",
    );
    const states = resolveVariantStates({
      ...RESOLVE_BASE,
      runArtifacts: [fallback],
      jobs: [
        {
          name: "🤖 Repack Android Phone (Release APK)",
          status: "completed",
          conclusion: "success",
        },
      ],
    });
    const state = stateFor(states, "android-phone-release-device-debugkey");
    expect(state.status).toBe("ready");
    expect(state.artifact?.name).toBe(fallback.name);
  });

  it("extracts no fingerprint from unhashed artifact names", () => {
    expect(
      extractRunFingerprints([
        {
          name: "streamyfin-android-phone-release-device-debugkey-unhashed-123-2",
        },
      ]),
    ).toEqual({});
  });
});

describe("expired current-run artifacts", () => {
  it("never beats a valid cached artifact and never renders a dead link", () => {
    const expiredCurrent = artifact(
      "streamyfin-ios-phone-debug-simulator-unsigned-r1-fp-x",
      { expired: true },
    );
    const cached = artifact(
      "streamyfin-ios-phone-debug-simulator-unsigned-r1-fp-x",
    );
    const states = resolveVariantStates({
      ...RESOLVE_BASE,
      runArtifacts: [expiredCurrent],
      cachedArtifacts: new Map([
        ["ios-phone-debug-simulator-unsigned", cached],
      ]),
      jobs: [],
    });
    const state = stateFor(states, "ios-phone-debug-simulator-unsigned");
    expect(state.artifact).toBeUndefined();
    expect(state.buildSource).toBe("cached");
    expect(state.cachedArtifact).toBe(cached);
  });
});

describe("failed signing gate", () => {
  it("reports the signed iOS build as failed, not skipped, when its gate fails", () => {
    const states = resolveVariantStates({
      ...RESOLVE_BASE,
      jobs: [
        {
          name: "🗺️ Plan full native builds",
          status: "completed",
          conclusion: "success",
        },
        {
          name: "🍎 Build iOS IPA (Phone)",
          status: "completed",
          conclusion: "failure",
          html_url: "https://x/gate",
        },
      ],
    });
    const state = stateFor(states, "ios-phone-release-device-signed");
    expect(state.status).toBe("failed");
    expect(state.job?.name).toBe("🍎 Build iOS IPA (Phone)");
    expect(state.jobUrl).toBe("https://x/gate");
  });
});

describe("findLatestAppsRun scoping", () => {
  const deps = (fake: ReturnType<typeof makeFakeFetch>) => baseDeps(fake);
  const runFixture = (overrides: Record<string, unknown>) => ({
    id: 1,
    name: "🏗️ Build Apps",
    status: "completed",
    conclusion: "success",
    html_url: "https://x/run",
    head_sha: "sha",
    created_at: "2026-01-15T10:00:00Z",
    ...overrides,
  });
  const args = {
    prNumber: 42,
    headSha: "sha",
    repositoryId: REPO_ID,
    prHeadRef: "feat/x",
    prHeadRepositoryId: REPO_ID,
  };

  it("fetches the trigger run directly when triggerRunId is set", async () => {
    const fake = makeFakeFetch();
    fake.on("GET", "/actions/runs/900", runFixture({ id: 900 }));
    const run = await findLatestAppsRun(deps(fake), {
      ...args,
      triggerRunId: 900,
    });
    expect(run?.id).toBe(900);
    expect(fake.state.calls.some((c) => c.url.includes("head_sha="))).toBe(
      false,
    );
  });

  it("prefers this PR's runs over a develop push at the same commit", async () => {
    const fake = makeFakeFetch();
    fake.on("GET", "/actions/runs?", {
      workflow_runs: [
        runFixture({
          id: 1,
          status: "in_progress",
          conclusion: null,
          event: "push",
          head_branch: "develop",
          head_repository: { id: REPO_ID },
          created_at: "2026-01-15T11:00:00Z",
        }),
        runFixture({
          id: 2,
          status: "queued",
          conclusion: null,
          event: "pull_request",
          head_branch: "feat/x",
          head_repository: { id: REPO_ID },
          created_at: "2026-01-15T10:00:00Z",
        }),
      ],
    });
    const run = await findLatestAppsRun(deps(fake), args);
    expect(run?.id).toBe(2);
  });

  it("links nothing when only an unrelated push run exists for the commit", async () => {
    const fake = makeFakeFetch();
    fake.on("GET", "/actions/runs?", {
      workflow_runs: [
        runFixture({
          id: 3,
          event: "push",
          head_branch: "develop",
          head_repository: { id: REPO_ID },
        }),
      ],
    });
    const run = await findLatestAppsRun(deps(fake), args);
    expect(run).toBeUndefined();
  });
});

describe("resolvePrContext metadata scoping", () => {
  it("workflow_run fetches the selected PR instead of substituting another", async () => {
    const fake = makeFakeFetch();
    // The commit's pulls list names a different PR; metadata must come from
    // the selected one via /pulls/<number>, never from the wrong PR.
    fake.on("GET", "/commits/runsha/pulls", [
      {
        number: 55,
        head: { sha: "runsha", ref: "feat/wrong", repo: { id: REPO_ID } },
      },
    ]);
    fake.on("GET", "/pulls/8", {
      number: 8,
      head: { sha: "runsha", ref: "feat/right", repo: { id: 999 } },
    });
    const ctx = await resolvePrContext(baseDeps(fake), {
      workflow_run: {
        id: 700,
        name: "🏗️ Build Apps",
        head_sha: "runsha",
        pull_requests: [{ number: 8 }],
      },
    });
    expect(ctx?.prNumber).toBe(8);
    expect(ctx?.prHeadRef).toBe("feat/right");
    expect(ctx?.prHeadRepositoryId).toBe(999);
    expect(ctx?.triggerRunId).toBe(700);
  });

  it("workflow_run leaves head metadata empty when the PR fetch fails", async () => {
    const fake = makeFakeFetch();
    fake.on("GET", "/commits/runsha/pulls", [
      {
        number: 55,
        head: { sha: "runsha", ref: "feat/wrong", repo: { id: REPO_ID } },
      },
    ]);
    const ctx = await resolvePrContext(baseDeps(fake), {
      workflow_run: {
        head_sha: "runsha",
        pull_requests: [{ number: 8 }],
      },
    });
    expect(ctx?.prNumber).toBe(8);
    expect(ctx?.prHeadRef).toBeUndefined();
    expect(ctx?.triggerRunId).toBeUndefined();
  });

  it("workflow_dispatch matches the dispatched branch among PRs sharing a commit", async () => {
    const fake = makeFakeFetch();
    fake.on("GET", "/commits/shared-sha/pulls", [
      {
        number: 7,
        state: "open",
        head: { sha: "shared-sha", ref: "feat/seven", repo: { id: REPO_ID } },
      },
      {
        number: 8,
        state: "open",
        head: { sha: "shared-sha", ref: "feat/eight", repo: { id: REPO_ID } },
      },
    ]);
    const deps = baseDeps(fake, {
      env: {
        GITHUB_REPOSITORY_ID: String(REPO_ID),
        GITHUB_SHA: "shared-sha",
        GITHUB_REF_NAME: "feat/eight",
      },
    });
    const ctx = await resolvePrContext(deps, {});
    expect(ctx?.prNumber).toBe(8);
  });

  it("workflow_dispatch ignores closed pull requests", async () => {
    const fake = makeFakeFetch();
    fake.on("GET", "/commits/shared-sha/pulls", [
      {
        number: 7,
        state: "closed",
        head: { sha: "shared-sha", ref: "feat/seven", repo: { id: REPO_ID } },
      },
    ]);
    fake.on("GET", "/pulls?state=open", [
      {
        number: 99,
        head: { sha: "other", ref: "feat/other", repo: { id: REPO_ID } },
      },
    ]);
    const deps = baseDeps(fake, {
      env: {
        GITHUB_REPOSITORY_ID: String(REPO_ID),
        GITHUB_SHA: "shared-sha",
        GITHUB_REF_NAME: "feat/seven",
      },
    });
    const ctx = await resolvePrContext(deps, {});
    expect(ctx?.prNumber).toBe(99);
  });

  it("workflow_dispatch falls back when several open PRs share the branch match", async () => {
    const fake = makeFakeFetch();
    // Same branch name in the upstream repo and a fork: two matches, no pick.
    fake.on("GET", "/commits/shared-sha/pulls", [
      {
        number: 7,
        state: "open",
        head: { sha: "shared-sha", ref: "feat/x", repo: { id: REPO_ID } },
      },
      {
        number: 8,
        state: "open",
        head: { sha: "shared-sha", ref: "feat/x", repo: { id: REPO_ID } },
      },
    ]);
    fake.on("GET", "/pulls?state=open", [
      {
        number: 99,
        head: { sha: "other", ref: "feat/other", repo: { id: REPO_ID } },
      },
    ]);
    const deps = baseDeps(fake, {
      env: {
        GITHUB_REPOSITORY_ID: String(REPO_ID),
        GITHUB_SHA: "shared-sha",
        GITHUB_REF_NAME: "feat/x",
      },
    });
    const ctx = await resolvePrContext(deps, {});
    expect(ctx?.prNumber).toBe(99);
  });

  it("workflow_dispatch uses a single open associated PR when no ref is set", async () => {
    const fake = makeFakeFetch();
    fake.on("GET", "/commits/sha-of-pr-7/pulls", [
      {
        number: 7,
        state: "open",
        head: { sha: "sha-of-pr-7", ref: "feat/seven", repo: { id: REPO_ID } },
      },
    ]);
    const deps = baseDeps(fake, {
      env: { GITHUB_REPOSITORY_ID: String(REPO_ID), GITHUB_SHA: "sha-of-pr-7" },
    });
    const ctx = await resolvePrContext(deps, {});
    expect(ctx?.prNumber).toBe(7);
  });
});
