import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type CliDeps, fallbackArtifactName, runCli } from "./cli";
import type { PruneResult } from "./fetch";
import { type FetchLike, listArtifacts } from "./github";
import { type Artifact, pickSource, type RunContext } from "./pick";
import { repoRoot } from "./process";
import type { RepackOptions } from "./repack";
import { artifactName, VARIANTS, variantById } from "./variants";

const isInsideOrSame = (parent: string, target: string): boolean => {
  const rel = relative(resolve(parent), resolve(target));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

const makeHarness = (overrides: Partial<CliDeps> = {}) => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const deps: CliDeps = {
    stdout: (msg) => stdoutChunks.push(msg),
    stderr: (msg) => stderrChunks.push(msg),
    env: { TEST_ENV: "1" },
    ...overrides,
  };
  return {
    deps,
    stdout: () => stdoutChunks.join(""),
    stderr: () => stderrChunks.join(""),
  };
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("build-cache cli", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "streamyfin-cli-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("prints fingerprint hash and exits 0 for hash subcommand", async () => {
    const hashFor = jest.fn(() => "deadbeef");
    const { deps, stdout, stderr } = makeHarness({ hashFor });

    const code = await runCli(["hash", "android", "phone"], deps);

    expect(code).toBe(0);
    expect(stdout().trim()).toBe("deadbeef");
    expect(stderr()).toBe("");
    expect(hashFor).toHaveBeenCalledWith(
      { os: "android", form: "phone" },
      { env: { TEST_ENV: "1" } },
    );
  });

  it("prints <variant>_name=<artifactName> lines for every variant in outputs subcommand", async () => {
    const hashes = {
      "ios-phone": "h-ios",
      "ios-tv": "h-tv",
      "android-phone": "h-and",
      "android-tv": "h-andtv",
    } as const;
    const { deps, stdout, stderr } = makeHarness();

    const code = await runCli(
      [
        "outputs",
        `ios=${hashes["ios-phone"]}`,
        `tv=${hashes["ios-tv"]}`,
        `android=${hashes["android-phone"]}`,
        `android_tv=${hashes["android-tv"]}`,
      ],
      deps,
    );

    expect(code).toBe(0);
    expect(stderr()).toBe("");
    const lines = stdout().trim().split("\n");
    expect(lines).toEqual(
      VARIANTS.map(
        (v) => `${v.id}_name=${artifactName(v, hashes[`${v.os}-${v.form}`])}`,
      ),
    );
  });

  it("prints artifact name and exits 0 for name subcommand", async () => {
    const hashFor = jest.fn(() => "computed123");
    const variant = variantById("android-phone-debug-device-debugkey")!;

    const explicit = makeHarness({ hashFor });
    const explicitCode = await runCli(
      ["name", variant.id, "explicit456"],
      explicit.deps,
    );
    expect(explicitCode).toBe(0);
    expect(explicit.stdout().trim()).toBe(artifactName(variant, "explicit456"));
    expect(hashFor).not.toHaveBeenCalled();

    const computed = makeHarness({ hashFor });
    const computedCode = await runCli(["name", variant.id], computed.deps);
    expect(computedCode).toBe(0);
    expect(computed.stdout().trim()).toBe(artifactName(variant, "computed123"));
    expect(hashFor).toHaveBeenCalledWith(
      { os: "android", form: "phone" },
      { env: { TEST_ENV: "1" } },
    );
  });

  it("prints an unhashed fallback name that no fingerprint pattern matches", async () => {
    for (const variant of VARIANTS) {
      const { deps, stdout, stderr } = makeHarness();
      const code = await runCli(
        ["fallback-name", variant.id, "123456", "2"],
        deps,
      );

      expect(code).toBe(0);
      expect(stderr()).toBe("");
      const name = stdout().trim();
      expect(name).toBe(fallbackArtifactName(variant, "123456", "2"));
      expect(name).toBe(`streamyfin-${variant.id}-unhashed-123456-2`);
      expect(name).toContain("-unhashed-");
      expect(name).not.toContain("-fp-");
      expect(name).not.toMatch(
        new RegExp(`^streamyfin-${variant.id}-r\\d+-fp-`),
      );
      // Every artifactName carries -fp-, so no hash can spell this name.
      expect(artifactName(variant, "unhashed-123456-2")).toContain("-fp-");
    }
  });

  it("rejects fallback-name without a known variant, a run id and an attempt", async () => {
    const id = "android-phone-release-device-debugkey";
    const cases: string[][] = [
      ["fallback-name"],
      ["fallback-name", id],
      ["fallback-name", id, "123"],
      ["fallback-name", id, "123", "2", "extra"],
      ["fallback-name", "nope", "123", "2"],
      ["fallback-name", id, "abc", "2"],
      ["fallback-name", id, "123", "0"],
      ["fallback-name", id, "-1", "2"],
      ["fallback-name", id, "1-fp-abc", "2"],
    ];

    for (const argv of cases) {
      const { deps, stdout, stderr } = makeHarness();
      expect(await runCli(argv, deps)).toBe(64);
      expect(stdout()).toBe("");
      expect(stderr().trim().length).toBeGreaterThan(0);
    }
  });

  it("never selects a fallback-named artifact through pickSource or the artifact-name lookups", async () => {
    const repositoryId = 1000;
    // A fresh fallback build on develop, the most trusted source there is.
    const stored: Artifact[] = VARIANTS.map((variant, index) => ({
      id: index + 1,
      name: fallbackArtifactName(variant, "777", "1"),
      expired: false,
      created_at: "2026-11-26T00:00:00Z",
      expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
      workflow_run: {
        id: 777,
        head_branch: "develop",
        head_repository_id: repositoryId,
        head_sha: "sha-777",
        repository_id: repositoryId,
      },
    }));
    // GitHub's `name` filter matches the whole artifact name.
    const github: FetchLike = async (url) => {
      const name = new URL(url).searchParams.get("name");
      const artifacts = stored.filter((artifact) => artifact.name === name);
      return jsonResponse({ total_count: artifacts.length, artifacts });
    };
    const ctx: RunContext = { repositoryId };

    // Asked for by its own name, the fixture would be picked.
    expect(
      pickSource(await listArtifacts("o/r", stored[0].name, "tok", github), ctx)
        ?.id,
    ).toBe(stored[0].id);

    for (const variant of VARIANTS) {
      for (const hash of ["abc123", "unhashed-777-1", "777-1"]) {
        const listed = await listArtifacts(
          "o/r",
          artifactName(variant, hash),
          "tok",
          github,
        );
        expect(listed).toEqual([]);
        expect(pickSource(listed, ctx, "ci")).toBeUndefined();
        expect(pickSource(listed, ctx, "local")).toBeUndefined();
      }
    }

    for (const variant of VARIANTS.filter((v) => v.mode === "ensure")) {
      const { deps, stdout } = makeHarness({
        fetch: github,
        env: {
          GITHUB_TOKEN: "tok",
          GITHUB_REPOSITORY: "o/r",
          REPOSITORY_ID: String(repositoryId),
        },
      });
      expect(await runCli(["needs-build", variant.id, "abc123"], deps)).toBe(0);
      expect(stdout().trim()).toBe("build");
    }
  });

  it("handles fetch hit (exit 0) and miss (exit 2)", async () => {
    const variant = variantById("android-phone-debug-device-debugkey")!;
    const hitHarness = makeHarness({
      hashFor: () => "hash-hit",
      fetchVariant: async () => ({ path: "/cache/app.apk" }),
    });
    const hitCode = await runCli(["fetch", variant.id], hitHarness.deps);
    expect(hitCode).toBe(0);
    expect(hitHarness.stdout().trim()).toBe("/cache/app.apk");
    expect(hitHarness.stderr()).toBe("");

    const missHarness = makeHarness({
      hashFor: () => "hash-miss",
      fetchVariant: async () => ({ path: null, reason: "No cached artifact" }),
    });
    const missCode = await runCli(["fetch", variant.id], missHarness.deps);
    expect(missCode).toBe(2);
    expect(missHarness.stdout()).toBe("");
    expect(missHarness.stderr()).toContain("No cached artifact");
  });

  it("exits 2 and prints reason to stderr when hashFor fails in name, fetch, or needs-build", async () => {
    const variant = variantById("android-phone-debug-device-debugkey")!;
    const failingHash = () => {
      throw new Error("fingerprint exploded");
    };

    for (const argv of [
      ["name", variant.id],
      ["fetch", variant.id],
      ["needs-build", variant.id],
    ]) {
      const { deps, stdout, stderr } = makeHarness({ hashFor: failingHash });
      const code = await runCli(argv, deps);
      expect(code).toBe(2);
      expect(stdout()).toBe("");
      expect(stderr()).toContain("fingerprint exploded");
    }
  });

  it("handles needs-build printing build or skip with exit 0, and exit 2 on lookup failure", async () => {
    const variant = variantById("ios-phone-debug-simulator-unsigned")!;
    const name = artifactName(variant, "fp123");
    const farFuture = new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const baseEnv = {
      GITHUB_TOKEN: "tok",
      GITHUB_REPOSITORY: "streamyfin/streamyfin",
      REPOSITORY_ID: "1000",
    };

    const skipFetch: FetchLike = async (url) => {
      if (url.includes("/pulls/42/commits")) {
        return jsonResponse([{ sha: "pr-sha-1" }]);
      }
      expect(url).toContain(encodeURIComponent(name));
      return jsonResponse({
        total_count: 1,
        artifacts: [
          {
            id: 1,
            name,
            expired: false,
            created_at: "2026-11-20T00:00:00Z",
            expires_at: farFuture,
            workflow_run: {
              id: 50,
              head_branch: "feat/test",
              head_repository_id: 1000,
              head_sha: "pr-sha-1",
              repository_id: 1000,
            },
          },
        ],
      });
    };

    const skipHarness = makeHarness({
      hashFor: () => "fp123",
      fetch: skipFetch,
      env: {
        ...baseEnv,
        PR_NUMBER: "42",
        PR_HEAD_REF: "feat/test",
        PR_HEAD_REPO_ID: "1000",
      },
    });
    expect(await runCli(["needs-build", variant.id], skipHarness.deps)).toBe(0);
    expect(skipHarness.stdout().trim()).toBe("skip");
    expect(skipHarness.stderr()).toBe("");

    const branchHarness = makeHarness({
      fetch: skipFetch,
      env: {
        ...baseEnv,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF_TYPE: "branch",
        GITHUB_REF_NAME: "feat/test",
      },
    });
    expect(
      await runCli(["needs-build", variant.id, "fp123"], branchHarness.deps),
    ).toBe(0);
    expect(branchHarness.stdout().trim()).toBe("skip");
    expect(branchHarness.stderr()).toBe("");

    const buildHarness = makeHarness({
      hashFor: () => "fp123",
      fetch: async () => jsonResponse({ total_count: 0, artifacts: [] }),
      env: baseEnv,
    });
    expect(await runCli(["needs-build", variant.id], buildHarness.deps)).toBe(
      0,
    );
    expect(buildHarness.stdout().trim()).toBe("build");
    expect(buildHarness.stderr()).toBe("");

    const failHarness = makeHarness({
      hashFor: () => "fp123",
      fetch: async () => new Response("Server Error", { status: 500 }),
      env: baseEnv,
    });
    expect(await runCli(["needs-build", variant.id], failHarness.deps)).toBe(2);
    expect(failHarness.stdout()).toBe("");
    expect(failHarness.stderr()).toContain("500");

    const missingEnvHarness = makeHarness({
      hashFor: () => "fp123",
      env: {},
    });
    expect(
      await runCli(["needs-build", variant.id], missingEnvHarness.deps),
    ).toBe(2);
    expect(missingEnvHarness.stdout()).toBe("");
    expect(missingEnvHarness.stderr().length).toBeGreaterThan(0);
  });

  it("skips hashFor when needs-build receives an explicit hash and calls it when omitted", async () => {
    const variant = variantById("ios-phone-debug-simulator-unsigned")!;
    const baseEnv = {
      GITHUB_TOKEN: "tok",
      GITHUB_REPOSITORY: "streamyfin/streamyfin",
      REPOSITORY_ID: "1000",
    };

    const explicitHashFor = jest.fn(() => "computed-fp");
    const explicitFetch: FetchLike = async (url) => {
      expect(url).toContain(
        encodeURIComponent(artifactName(variant, "explicit-fp")),
      );
      return jsonResponse({ total_count: 0, artifacts: [] });
    };
    const explicitHarness = makeHarness({
      hashFor: explicitHashFor,
      fetch: explicitFetch,
      env: baseEnv,
    });
    expect(
      await runCli(
        ["needs-build", variant.id, "explicit-fp"],
        explicitHarness.deps,
      ),
    ).toBe(0);
    expect(explicitHarness.stdout().trim()).toBe("build");
    expect(explicitHashFor).not.toHaveBeenCalled();

    const omittedHashFor = jest.fn(() => "computed-fp");
    const omittedFetch: FetchLike = async (url) => {
      expect(url).toContain(
        encodeURIComponent(artifactName(variant, "computed-fp")),
      );
      return jsonResponse({ total_count: 0, artifacts: [] });
    };
    const omittedHarness = makeHarness({
      hashFor: omittedHashFor,
      fetch: omittedFetch,
      env: baseEnv,
    });
    expect(await runCli(["needs-build", variant.id], omittedHarness.deps)).toBe(
      0,
    );
    expect(omittedHarness.stdout().trim()).toBe("build");
    expect(omittedHashFor).toHaveBeenCalledWith(
      { os: "ios", form: "phone" },
      { env: baseEnv },
    );
  });

  it("handles repack happy path, --sentry passthrough, tmpdir working dir outside output dir, and miss", async () => {
    const variant = variantById(
      "android-phone-release-device-debugkey-universal",
    )!;
    const outputDir = join(tempDir, "outputs");
    mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, "repacked.apk");
    const sourcePath = join(tempDir, "source.apk");

    let capturedOpts: RepackOptions | undefined;
    let workDirExistedDuringCall = false;

    const okHarness = makeHarness({
      repackVariant: async (opts) => {
        capturedOpts = opts;
        workDirExistedDuringCall = existsSync(opts.workingDirectory);
        return { path: opts.outputPath };
      },
    });

    const okCode = await runCli(
      ["repack", variant.id, sourcePath, outputPath],
      okHarness.deps,
    );

    expect(okCode).toBe(0);
    expect(okHarness.stdout().trim()).toBe(outputPath);
    expect(okHarness.stderr()).toBe("");
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts!.variant.id).toBe(variant.id);
    expect(capturedOpts!.sourcePath).toBe(sourcePath);
    expect(capturedOpts!.outputPath).toBe(outputPath);
    expect(capturedOpts!.projectRoot).toBe(repoRoot());
    expect(capturedOpts!.sentry).toBe(false);
    expect(workDirExistedDuringCall).toBe(true);
    expect(isInsideOrSame(tmpdir(), capturedOpts!.workingDirectory)).toBe(true);
    expect(
      isInsideOrSame(dirname(outputPath), capturedOpts!.workingDirectory),
    ).toBe(false);

    let sentryFlag: boolean | undefined;
    const sentryHarness = makeHarness({
      repackVariant: async (opts) => {
        sentryFlag = opts.sentry;
        return { path: opts.outputPath };
      },
    });
    const sentryCode = await runCli(
      ["repack", variant.id, sourcePath, outputPath, "--sentry"],
      sentryHarness.deps,
    );
    expect(sentryCode).toBe(0);
    expect(sentryFlag).toBe(true);

    const missHarness = makeHarness({
      repackVariant: async () => ({
        path: null,
        reason: "repack-android failed",
      }),
    });
    const missCode = await runCli(
      ["repack", variant.id, sourcePath, outputPath],
      missHarness.deps,
    );
    expect(missCode).toBe(2);
    expect(missHarness.stdout()).toBe("");
    expect(missHarness.stderr()).toContain("repack-android failed");
  });

  it("prints summary for prune and exits 0 when nothing skipped or 1 when entries were skipped", async () => {
    const cleanResult: PruneResult = {
      removed: ["a", "b"],
      remainingBytes: 512,
      freedBytes: 2048,
      skipped: [],
    };
    const cleanHarness = makeHarness({ prune: () => cleanResult });
    const cleanCode = await runCli(["prune"], cleanHarness.deps);
    expect(cleanCode).toBe(0);
    expect(cleanHarness.stdout().trim()).toMatch(
      /^removed 2 entries, freed 2\.0 KB$/,
    );
    expect(cleanHarness.stderr()).toBe("");

    const skippedResult: PruneResult = {
      removed: ["a"],
      remainingBytes: 100,
      freedBytes: 500,
      skipped: [
        { name: "locked-1", code: "EACCES" },
        { name: "busy-2", code: "EBUSY" },
      ],
    };
    const skippedHarness = makeHarness({ prune: () => skippedResult });
    const skippedCode = await runCli(["prune"], skippedHarness.deps);
    expect(skippedCode).toBe(1);
    expect(skippedHarness.stdout().trim()).toMatch(
      /^removed 1 entries, freed 500 B$/,
    );
    expect(skippedHarness.stderr()).toContain("locked-1");
    expect(skippedHarness.stderr()).toContain("EACCES");
    expect(skippedHarness.stderr()).toContain("busy-2");
    expect(skippedHarness.stderr()).toContain("EBUSY");
  });

  it("returns 64 on usage errors and prints valid variant ids on unknown variant", async () => {
    const cases: string[][] = [
      [],
      ["bogus"],
      ["hash", "windows", "phone"],
      ["hash", "ios", "watch"],
      ["name"],
      ["outputs"],
      ["outputs", "ios=a", "tv=b", "android=c"],
      ["outputs", "ios=a", "tv=b", "android=c", "android_tv="],
      ["outputs", "ios=a", "tv=b", "android=c", "android_tv=d", "ios=e"],
      ["outputs", "ios=a", "tv=b", "android=c", "bogus=d"],
      ["fetch"],
      ["needs-build"],
      ["needs-build", "ios-phone-debug-simulator-unsigned", "fp123", "extra"],
      ["repack"],
      ["repack", "android-phone-debug-device-debugkey", "src"],
      ["repack", "android-phone-debug-device-debugkey", "src", "out", "--bad"],
    ];

    for (const argv of cases) {
      const { deps, stdout, stderr } = makeHarness();
      const code = await runCli(argv, deps);
      expect(code).toBe(64);
      expect(stdout()).toBe("");
      expect(stderr().trim().length).toBeGreaterThan(0);
    }

    const unknownHarness = makeHarness();
    const unknownCode = await runCli(
      ["repack", "nope", "src.apk", "out.apk"],
      unknownHarness.deps,
    );
    expect(unknownCode).toBe(64);
    for (const variant of VARIANTS) {
      expect(unknownHarness.stderr()).toContain(variant.id);
    }
  });
});
