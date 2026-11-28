import fs, {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { type FetchLike, fetchVariant, prune, resolveCacheDir } from "./fetch";
import type { RunProcess } from "./process";
import { artifactName, variantById } from "./variants";

const apkVariant = variantById("android-phone-debug-device-debugkey")!;
const appVariant = variantById("ios-phone-debug-simulator-unsigned")!;

const itUnlessRoot = process.getuid?.() === 0 ? it.skip : it;

const makeTempDir = () => mkdtempSync(join(tmpdir(), "streamyfin-cache-test-"));

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const makeArtifact = (
  name: string,
  overrides: Partial<{
    id: number;
    created_at: string;
    head_repository_id: number;
    repository_id: number;
    archive_download_url: string;
  }> = {},
) => ({
  id: overrides.id ?? 42,
  name,
  expired: false,
  created_at: overrides.created_at ?? "2026-11-20T00:00:00Z",
  expires_at: "2027-02-20T00:00:00Z",
  archive_download_url:
    overrides.archive_download_url ??
    `https://api.github.com/repos/o/r/actions/artifacts/${overrides.id ?? 42}/zip`,
  workflow_run: {
    id: 99,
    head_branch: "develop",
    head_repository_id: overrides.head_repository_id ?? 1000,
    head_sha: "abc",
    repository_id: overrides.repository_id ?? 1000,
  },
});

const mockArtifactsFetch = (): FetchLike => async (url) => {
  if (url.includes("/actions/artifacts?")) {
    const name = decodeURIComponent(
      new URL(url).searchParams.get("name") ?? "",
    );
    return jsonResponse({
      total_count: 1,
      artifacts: [makeArtifact(name)],
    });
  }
  return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
};

const hasTempEntries = (dir: string): boolean =>
  readdirSync(dir).some(
    (entry) => entry.startsWith(".tmp-") || entry.startsWith(".trash-"),
  );

const makeApkRun = (binaryName = "app.apk"): RunProcess => {
  return (cmd, args) => {
    if (cmd === "unzip" && args[0] === "-Z1") {
      return { status: 0, stdout: `${binaryName}\n`, stderr: "" };
    }
    if (cmd === "unzip" && args[0] === "-q") {
      writeFileSync(join(args[3], binaryName), "apk-bytes");
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected command: ${cmd} ${args.join(" ")}`);
  };
};

const makeAppRun = (marker?: string): RunProcess => {
  return (cmd, args) => {
    if (cmd === "unzip" && args[0] === "-Z1") {
      return { status: 0, stdout: "Streamyfin.app.tar\n", stderr: "" };
    }
    if (cmd === "unzip" && args[0] === "-q") {
      writeFileSync(join(args[3], "Streamyfin.app.tar"), "tar");
      return { status: 0, stdout: "", stderr: "" };
    }
    if (cmd === "tar" && args[0] === "-tf") {
      return {
        status: 0,
        stdout: "Streamyfin.app/Info.plist\n",
        stderr: "",
      };
    }
    if (cmd === "tar" && args[0] === "-xf") {
      const dest = args[3];
      mkdirSync(join(dest, "Streamyfin.app"), { recursive: true });
      writeFileSync(join(dest, "Streamyfin.app", "Info.plist"), "plist");
      if (marker) {
        writeFileSync(join(dest, "Streamyfin.app", marker), "marker");
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected command: ${cmd} ${args.join(" ")}`);
  };
};

const restorePermissions = (dir: string) => {
  if (!existsSync(dir)) return;
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) restorePermissions(fullPath);
  }
};

describe("resolveCacheDir", () => {
  it("uses macOS Library/Caches on darwin and XDG_CACHE_HOME elsewhere", () => {
    expect(
      resolveCacheDir({
        env: {},
        homedir: () => "/Users/dev",
        platform: () => "darwin",
      }),
    ).toBe("/Users/dev/Library/Caches/streamyfin-native");

    expect(
      resolveCacheDir({
        env: { XDG_CACHE_HOME: "/tmp/xdg" },
        homedir: () => "/home/dev",
        platform: () => "linux",
      }),
    ).toBe("/tmp/xdg/streamyfin-native");
  });
});

// Cache entries are namespaced by repository slug (fetch.ts): the default
// streamyfin/streamyfin slug prefixes every entry the tests install.
const en = (name: string) => `streamyfin_streamyfin--${name}`;

describe("fetchVariant", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = makeTempDir();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    restorePermissions(cacheDir);
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("returns a miss with a reason when no GitHub token is available", async () => {
    const run: RunProcess = () => ({
      status: 1,
      stdout: "",
      stderr: "no auth",
    });
    const result = await fetchVariant(apkVariant, "hash1", {
      cacheDir,
      env: {},
      run,
    });
    expect(result.path).toBeNull();
    expect(result.reason).toMatch(/token/i);
  });

  it("falls back to gh auth token when GITHUB_TOKEN is unset", async () => {
    const name = artifactName(apkVariant, "hash-gh");
    let sawTokenHeader: string | null = null;
    const fetchOk: FetchLike = async (url, init) => {
      const headers = new Headers(init?.headers);
      if (url.includes("/actions/artifacts?")) {
        sawTokenHeader = headers.get("authorization");
      }
      return mockArtifactsFetch()(url);
    };
    const apkRun = makeApkRun();
    const run: RunProcess = (cmd, args, options) => {
      if (cmd === "gh" && args[0] === "auth" && args[1] === "token") {
        return { status: 0, stdout: "gh-cli-token\n", stderr: "" };
      }
      return apkRun(cmd, args, options);
    };

    const result = await fetchVariant(apkVariant, "hash-gh", {
      cacheDir,
      env: {},
      fetch: fetchOk,
      repositoryId: 1000,
      run,
    });

    expect(result.path).toBe(join(cacheDir, en(name), "app.apk"));
    expect(sawTokenHeader).toBe("Bearer gh-cli-token");
  });

  it("uses STREAMYFIN_BUILD_CACHE_REPO in GitHub API request URLs", async () => {
    const name = artifactName(apkVariant, "hash-repo");
    const requestedUrls: string[] = [];
    const fetchOk: FetchLike = async (url) => {
      requestedUrls.push(url);
      if (url === "https://api.github.com/repos/custom-org/custom-repo") {
        return jsonResponse({ id: 777 });
      }
      if (
        url.startsWith(
          "https://api.github.com/repos/custom-org/custom-repo/actions/artifacts?",
        )
      ) {
        return jsonResponse({
          total_count: 1,
          artifacts: [
            makeArtifact(name, {
              head_repository_id: 777,
              repository_id: 777,
            }),
          ],
        });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    };

    const result = await fetchVariant(apkVariant, "hash-repo", {
      cacheDir,
      env: {
        GITHUB_TOKEN: "tok",
        STREAMYFIN_BUILD_CACHE_REPO: "custom-org/custom-repo",
      },
      fetch: fetchOk,
      run: makeApkRun(),
    });

    expect(result.path).toBe(
      join(cacheDir, `custom-org_custom-repo--${name}`, "app.apk"),
    );
    // The same variant and fingerprint from streamyfin/streamyfin lands in a
    // different entry, so fork and upstream binaries never collide.
    expect(result.path).not.toBe(join(cacheDir, en(name), "app.apk"));
    expect(requestedUrls[0]).toBe(
      "https://api.github.com/repos/custom-org/custom-repo",
    );
    expect(requestedUrls[1]).toContain(
      "https://api.github.com/repos/custom-org/custom-repo/actions/artifacts?",
    );
  });

  it("paginates artifact listings to page 2 when page 1 has 100 items", async () => {
    const name = artifactName(apkVariant, "hash-page");
    const pageUrls: string[] = [];
    const page1Artifacts = Array.from({ length: 100 }, (_, i) =>
      makeArtifact(name, {
        id: i + 1,
        head_repository_id: 9999,
      }),
    );
    const page2Artifact = makeArtifact(name, {
      id: 201,
      archive_download_url:
        "https://api.github.com/repos/o/r/artifacts/201/zip",
    });

    const fetchOk: FetchLike = async (url) => {
      if (url.includes("/actions/artifacts?")) {
        pageUrls.push(url);
        if (new URL(url).searchParams.get("page") === "1") {
          return jsonResponse({ total_count: 101, artifacts: page1Artifacts });
        }
        return jsonResponse({ total_count: 101, artifacts: [page2Artifact] });
      }
      expect(url).toBe("https://api.github.com/repos/o/r/artifacts/201/zip");
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    };

    const result = await fetchVariant(apkVariant, "hash-page", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: fetchOk,
      repositoryId: 1000,
      run: makeApkRun(),
    });

    expect(result).toEqual({ path: join(cacheDir, en(name), "app.apk") });
    expect(pageUrls).toHaveLength(2);
    expect(pageUrls[0]).toContain("page=1");
    expect(pageUrls[1]).toContain("page=2");
  });

  it("returns a miss when artifact list contains only fork artifacts", async () => {
    const name = artifactName(apkVariant, "hash-fork");
    let downloadCalled = false;
    const fetchForkOnly: FetchLike = async (url) => {
      if (url.includes("/actions/artifacts?")) {
        return jsonResponse({
          total_count: 1,
          artifacts: [makeArtifact(name, { head_repository_id: 9999 })],
        });
      }
      downloadCalled = true;
      return new Response(new Uint8Array([1]), { status: 200 });
    };

    const result = await fetchVariant(apkVariant, "hash-fork", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: fetchForkOnly,
      repositoryId: 1000,
    });

    expect(result.path).toBeNull();
    expect(result.reason).toContain("No cached");
    expect(downloadCalled).toBe(false);
  });

  it("returns a miss on 404 or network error without throwing", async () => {
    const fetch404: FetchLike = async () =>
      new Response("Not Found", { status: 404 });
    const res404 = await fetchVariant(apkVariant, "hash1", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: fetch404,
      repositoryId: 1000,
    });
    expect(res404.path).toBeNull();
    expect(res404.reason).toContain("404");

    const fetchErr: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    const resErr = await fetchVariant(apkVariant, "hash1", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: fetchErr,
      repositoryId: 1000,
    });
    expect(resErr.path).toBeNull();
    expect(resErr.reason).toContain("ECONNRESET");
  });

  it("follows 302 redirect on artifact download without sending Authorization header", async () => {
    const name = artifactName(apkVariant, "hash-redir");
    const calls: Array<{
      url: string;
      redirect?: RequestRedirect;
      auth: string | null;
    }> = [];

    const fetchRedirect: FetchLike = async (url, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      calls.push({ url, redirect: init?.redirect, auth });
      if (url.includes("/actions/artifacts?")) {
        return jsonResponse({
          total_count: 1,
          artifacts: [makeArtifact(name)],
        });
      }
      if (url.includes("/actions/artifacts/42/zip")) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://blob.example/artifact.zip?sig=secret" },
        });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    };

    const result = await fetchVariant(apkVariant, "hash-redir", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: fetchRedirect,
      repositoryId: 1000,
      run: makeApkRun(),
    });

    expect(result.path).toBe(join(cacheDir, en(name), "app.apk"));
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual({
      url: "https://api.github.com/repos/o/r/actions/artifacts/42/zip",
      redirect: "manual",
      auth: "Bearer tok",
    });
    expect(calls[2].url).toBe("https://blob.example/artifact.zip?sig=secret");
    expect(calls[2].auth).toBeNull();
  });

  it("accepts a direct 200 response on artifact download without redirect", async () => {
    const name = artifactName(apkVariant, "hash-200");
    let downloadRedirectMode: RequestRedirect | undefined;
    const fetchDirect: FetchLike = async (url, init) => {
      if (url.includes("/actions/artifacts?")) {
        return jsonResponse({
          total_count: 1,
          artifacts: [makeArtifact(name)],
        });
      }
      downloadRedirectMode = init?.redirect;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    };

    const result = await fetchVariant(apkVariant, "hash-200", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: fetchDirect,
      repositoryId: 1000,
      run: makeApkRun(),
    });

    expect(result.path).toBe(join(cacheDir, en(name), "app.apk"));
    expect(downloadRedirectMode).toBe("manual");
  });

  it("returns a miss on 410 Gone when downloading an artifact", async () => {
    const name = artifactName(apkVariant, "hash-410");
    const fetch410: FetchLike = async (url) => {
      if (url.includes("/actions/artifacts?")) {
        return jsonResponse({
          total_count: 1,
          artifacts: [makeArtifact(name)],
        });
      }
      return new Response("Gone", { status: 410 });
    };

    const result = await fetchVariant(apkVariant, "hash-410", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: fetch410,
      repositoryId: 1000,
    });

    expect(result.path).toBeNull();
    expect(result.reason).toContain("410");
    expect(hasTempEntries(cacheDir)).toBe(false);
  });

  it("streams multi-chunk response bodies to disk without calling arrayBuffer", async () => {
    const name = artifactName(apkVariant, "hash-stream");
    let arrayBufferCalled = false;
    let streamedBytes: Buffer | null = null;

    const fetchStream: FetchLike = async (url) => {
      if (url.includes("/actions/artifacts?")) {
        return jsonResponse({
          total_count: 1,
          artifacts: [makeArtifact(name)],
        });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([10, 20]));
          controller.enqueue(new Uint8Array([30, 40, 50]));
          controller.close();
        },
      });
      const response = new Response(stream, { status: 200 });
      response.arrayBuffer = async () => {
        arrayBufferCalled = true;
        throw new Error("arrayBuffer should not be called");
      };
      return response;
    };

    const run: RunProcess = (cmd, args) => {
      if (cmd === "unzip" && args[0] === "-Z1") {
        streamedBytes = fs.readFileSync(args[1]);
        return { status: 0, stdout: "app.apk\n", stderr: "" };
      }
      if (cmd === "unzip" && args[0] === "-q") {
        writeFileSync(join(args[3], "app.apk"), "apk");
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };

    const result = await fetchVariant(apkVariant, "hash-stream", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: fetchStream,
      repositoryId: 1000,
      run,
    });

    expect(result.path).toBe(join(cacheDir, en(name), "app.apk"));
    expect(arrayBufferCalled).toBe(false);
    expect(streamedBytes).toEqual(Buffer.from([10, 20, 30, 40, 50]));
  });

  itUnlessRoot(
    "returns a miss naming the step and EACCES when cacheDir is read-only",
    async () => {
      chmodSync(cacheDir, 0o500);
      const result = await fetchVariant(apkVariant, "hash-ro", {
        cacheDir,
        env: { GITHUB_TOKEN: "tok" },
        fetch: mockArtifactsFetch(),
        repositoryId: 1000,
      });

      expect(result.path).toBeNull();
      expect(result.reason).toContain("create temp directory");
      expect(result.reason).toContain("EACCES");
    },
  );

  it("returns a miss naming the step and ENOSPC when writing the download fails", async () => {
    jest.spyOn(fs, "createWriteStream").mockImplementationOnce(
      () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            callback(
              Object.assign(new Error("ENOSPC: no space left on device"), {
                code: "ENOSPC",
              }),
            );
          },
        }) as unknown as fs.WriteStream,
    );

    const result = await fetchVariant(apkVariant, "hash-enospc", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: mockArtifactsFetch(),
      repositoryId: 1000,
    });

    expect(result.path).toBeNull();
    expect(result.reason).toContain("stream download");
    expect(result.reason).toContain("ENOSPC");
    expect(hasTempEntries(cacheDir)).toBe(false);
  });

  it("still returns a cache hit when updating atime fails", async () => {
    const name = artifactName(apkVariant, "hash-hit-ro");
    const entryDir = join(cacheDir, en(name));
    mkdirSync(entryDir, { recursive: true });
    const binaryPath = join(entryDir, "app.apk");
    writeFileSync(binaryPath, "apk");

    jest.spyOn(fs, "utimesSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      });
    });

    const result = await fetchVariant(apkVariant, "hash-hit-ro", {
      cacheDir,
      env: {},
      now: () => 1_700_000_000_000,
    });

    expect(result.path).toBe(binaryPath);
  });

  it("updates the entry atime on a cache hit", async () => {
    const name = artifactName(apkVariant, "hash-atime");
    const entryDir = join(cacheDir, en(name));
    mkdirSync(entryDir, { recursive: true });
    const binaryPath = join(entryDir, "app.apk");
    writeFileSync(binaryPath, "apk");

    const oldTs = 1_600_000_000;
    utimesSync(entryDir, oldTs, oldTs);

    const hitMs = 1_700_000_000_000;
    let fetchCalled = false;
    const result = await fetchVariant(apkVariant, "hash-atime", {
      cacheDir,
      env: {},
      now: () => hitMs,
      fetch: async () => {
        fetchCalled = true;
        throw new Error("should not fetch on cache hit");
      },
    });

    expect(result.path).toBe(binaryPath);
    expect(fetchCalled).toBe(false);
    expect(statSync(entryDir).atimeMs).toBe(hitMs);
  });

  it("keeps the winning concurrent fetch entry when rename hits ENOTEMPTY/EEXIST", async () => {
    const name = artifactName(appVariant, "hash-race");
    const entryDir = join(cacheDir, en(name));

    const baseRun = makeAppRun("ours-marker");
    const racingRun: RunProcess = (cmd, args, options) => {
      if (cmd === "tar" && args[0] === "-xf") {
        // Simulate another process finishing and populating entryDir first.
        const winnerApp = join(entryDir, "Streamyfin.app");
        mkdirSync(winnerApp, { recursive: true });
        writeFileSync(join(winnerApp, "Info.plist"), "plist");
        writeFileSync(join(winnerApp, "winner-marker"), "winner");
      }
      return baseRun(cmd, args, options);
    };

    const result = await fetchVariant(appVariant, "hash-race", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: mockArtifactsFetch(),
      repositoryId: 1000,
      run: racingRun,
    });

    expect(result.path).toBe(join(entryDir, "Streamyfin.app"));
    expect(existsSync(join(entryDir, "Streamyfin.app", "winner-marker"))).toBe(
      true,
    );
    expect(existsSync(join(entryDir, "Streamyfin.app", "ours-marker"))).toBe(
      false,
    );
    expect(hasTempEntries(cacheDir)).toBe(false);
  });

  it("replaces an invalid existing cache entry via .trash-* when it has 0 or 2 binaries", async () => {
    const fetchOk = mockArtifactsFetch();

    // Case 1: existing directory with 0 binaries
    const emptyName = artifactName(apkVariant, "hash-invalid-0");
    const emptyEntry = join(cacheDir, en(emptyName));
    mkdirSync(emptyEntry, { recursive: true });
    writeFileSync(join(emptyEntry, "stale.txt"), "stale");

    const res0 = await fetchVariant(apkVariant, "hash-invalid-0", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: fetchOk,
      repositoryId: 1000,
      run: makeApkRun("fresh.apk"),
    });
    expect(res0.path).toBe(join(emptyEntry, "fresh.apk"));
    expect(readdirSync(emptyEntry).sort()).toEqual([
      ".streamyfin-cache-entry",
      "fresh.apk",
    ]);
    expect(hasTempEntries(cacheDir)).toBe(false);

    // Case 2: existing directory with 2 binaries
    const twoName = artifactName(apkVariant, "hash-invalid-2");
    const twoEntry = join(cacheDir, en(twoName));
    mkdirSync(twoEntry, { recursive: true });
    writeFileSync(join(twoEntry, "a.apk"), "a");
    writeFileSync(join(twoEntry, "b.apk"), "b");

    const res2 = await fetchVariant(apkVariant, "hash-invalid-2", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: fetchOk,
      repositoryId: 1000,
      run: makeApkRun("fresh.apk"),
    });
    expect(res2.path).toBe(join(twoEntry, "fresh.apk"));
    expect(readdirSync(twoEntry).sort()).toEqual([
      ".streamyfin-cache-entry",
      "fresh.apk",
    ]);
    expect(hasTempEntries(cacheDir)).toBe(false);
  });

  it("rejects archive entries with path traversal or absolute paths", async () => {
    const fetchOk = mockArtifactsFetch();

    for (const unsafeEntry of [
      "../evil.apk",
      "/etc/passwd",
      "sub/../../out.apk",
    ]) {
      const run: RunProcess = (cmd, args) => {
        if (cmd === "unzip" && args[0] === "-Z1") {
          return { status: 0, stdout: `${unsafeEntry}\n`, stderr: "" };
        }
        throw new Error(`Should not extract unsafe archive (${cmd})`);
      };

      const result = await fetchVariant(apkVariant, "hash1", {
        cacheDir,
        env: { GITHUB_TOKEN: "tok" },
        fetch: fetchOk,
        repositoryId: 1000,
        run,
      });
      expect(result.path).toBeNull();
      expect(result.reason).toContain("unsafe");
      expect(hasTempEntries(cacheDir)).toBe(false);
    }
  });

  it("rejects a tar entry containing .. without extracting", async () => {
    const run: RunProcess = (cmd, args) => {
      if (cmd === "unzip" && args[0] === "-Z1") {
        return { status: 0, stdout: "Streamyfin.app.tar\n", stderr: "" };
      }
      if (cmd === "unzip" && args[0] === "-q") {
        writeFileSync(join(args[3], "Streamyfin.app.tar"), "tar");
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "tar" && args[0] === "-tf") {
        return { status: 0, stdout: "Streamyfin.app/../../evil\n", stderr: "" };
      }
      throw new Error(`Should not extract unsafe tar (${cmd})`);
    };

    const result = await fetchVariant(appVariant, "hash-tar-dotdot", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: mockArtifactsFetch(),
      repositoryId: 1000,
      run,
    });

    expect(result.path).toBeNull();
    expect(result.reason).toContain("unsafe");
    expect(hasTempEntries(cacheDir)).toBe(false);
  });

  it("rejects extracted symlinks pointing outside root or absolute, and cleans up temp dir", async () => {
    const fetchOk = mockArtifactsFetch();

    for (const symlinkTarget of ["../../outside-secret", "/etc/passwd"]) {
      const run: RunProcess = (cmd, args) => {
        if (cmd === "unzip" && args[0] === "-Z1") {
          return { status: 0, stdout: "app.apk\nlink\n", stderr: "" };
        }
        if (cmd === "unzip" && args[0] === "-q") {
          writeFileSync(join(args[3], "app.apk"), "apk");
          symlinkSync(symlinkTarget, join(args[3], "link"));
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`Unexpected command: ${cmd}`);
      };

      const result = await fetchVariant(apkVariant, "hash-symlink", {
        cacheDir,
        env: { GITHUB_TOKEN: "tok" },
        fetch: fetchOk,
        repositoryId: 1000,
        run,
      });

      expect(result.path).toBeNull();
      expect(result.reason).toContain("symlink");
      expect(hasTempEntries(cacheDir)).toBe(false);
    }
  });

  it("rejects symlinks escaping the tar extraction root and allows valid internal symlinks in .app bundles", async () => {
    const fetchOk = mockArtifactsFetch();

    const runEscapingTar: RunProcess = (cmd, args) => {
      if (cmd === "unzip" && args[0] === "-Z1") {
        return { status: 0, stdout: "Streamyfin.app.tar\n", stderr: "" };
      }
      if (cmd === "unzip" && args[0] === "-q") {
        writeFileSync(join(args[3], "Streamyfin.app.tar"), "tar");
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "tar" && args[0] === "-tf") {
        return { status: 0, stdout: "Streamyfin.app/Info.plist\n", stderr: "" };
      }
      if (cmd === "tar" && args[0] === "-xf") {
        const dest = args[3];
        mkdirSync(join(dest, "Streamyfin.app"), { recursive: true });
        writeFileSync(join(dest, "Streamyfin.app", "Info.plist"), "plist");
        symlinkSync("../../outside", join(dest, "Streamyfin.app", "escape"));
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };

    const escaped = await fetchVariant(appVariant, "hash-tar-symlink", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: fetchOk,
      repositoryId: 1000,
      run: runEscapingTar,
    });
    expect(escaped.path).toBeNull();
    expect(escaped.reason).toContain("symlink");
    expect(hasTempEntries(cacheDir)).toBe(false);

    const runValidInternalSymlink: RunProcess = (cmd, args) => {
      if (cmd === "unzip" && args[0] === "-Z1") {
        return { status: 0, stdout: "Streamyfin.app.tar\n", stderr: "" };
      }
      if (cmd === "unzip" && args[0] === "-q") {
        writeFileSync(join(args[3], "Streamyfin.app.tar"), "tar");
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "tar" && args[0] === "-tf") {
        return { status: 0, stdout: "Streamyfin.app/Info.plist\n", stderr: "" };
      }
      if (cmd === "tar" && args[0] === "-xf") {
        const dest = args[3];
        const frameworkDir = join(
          dest,
          "Streamyfin.app",
          "Frameworks",
          "Foo.framework",
        );
        mkdirSync(join(frameworkDir, "Versions", "A"), { recursive: true });
        writeFileSync(join(frameworkDir, "Versions", "A", "Foo"), "bin");
        symlinkSync("Versions/A/Foo", join(frameworkDir, "Foo"));
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };

    const validName = artifactName(appVariant, "hash-tar-valid-symlink");
    const valid = await fetchVariant(appVariant, "hash-tar-valid-symlink", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: fetchOk,
      repositoryId: 1000,
      run: runValidInternalSymlink,
    });
    expect(valid.path).toBe(join(cacheDir, en(validName), "Streamyfin.app"));
  });

  it("rejects a symlink inside .app that points at a sibling outside the bundle", async () => {
    // The sibling exists inside the extraction root, so the untarred tree
    // passes validation — but once staged alone, the .app's symlink dangles.
    const run: RunProcess = (cmd, args) => {
      if (cmd === "unzip" && args[0] === "-Z1") {
        return { status: 0, stdout: "Streamyfin.app.tar\n", stderr: "" };
      }
      if (cmd === "unzip" && args[0] === "-q") {
        writeFileSync(join(args[3], "Streamyfin.app.tar"), "tar");
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "tar" && args[0] === "-tf") {
        return {
          status: 0,
          stdout: "Streamyfin.app/Info.plist\nshared/lib.dylib\n",
          stderr: "",
        };
      }
      if (cmd === "tar" && args[0] === "-xf") {
        const dest = args[3];
        mkdirSync(join(dest, "Streamyfin.app"), { recursive: true });
        writeFileSync(join(dest, "Streamyfin.app", "Info.plist"), "plist");
        mkdirSync(join(dest, "shared"), { recursive: true });
        writeFileSync(join(dest, "shared", "lib.dylib"), "lib");
        symlinkSync(
          "../shared/lib.dylib",
          join(dest, "Streamyfin.app", "lib.dylib"),
        );
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };

    const result = await fetchVariant(appVariant, "hash-app-escape-symlink", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: mockArtifactsFetch(),
      repositoryId: 1000,
      run,
    });
    expect(result.path).toBeNull();
    expect(result.reason).toContain("symlink");
    expect(hasTempEntries(cacheDir)).toBe(false);
  });

  it("rejects extracted hard-link entries and cleans up temp dir", async () => {
    const outsideFile = join(cacheDir, "outside.txt");
    writeFileSync(outsideFile, "secret");

    const run: RunProcess = (cmd, args) => {
      if (cmd === "unzip" && args[0] === "-Z1") {
        return { status: 0, stdout: "app.apk\n", stderr: "" };
      }
      if (cmd === "unzip" && args[0] === "-q") {
        linkSync(outsideFile, join(args[3], "app.apk"));
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };

    const result = await fetchVariant(apkVariant, "hash-hardlink", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: mockArtifactsFetch(),
      repositoryId: 1000,
      run,
    });

    expect(result.path).toBeNull();
    expect(result.reason).toContain("hard-link");
    expect(hasTempEntries(cacheDir)).toBe(false);
  });

  it("returns a miss and leaves no temp dir when extracted archive has 0 or 2 binaries", async () => {
    const fetchOk = mockArtifactsFetch();

    const runZero: RunProcess = (cmd, args) => {
      if (cmd === "unzip" && args[0] === "-Z1") {
        return { status: 0, stdout: "README.txt\n", stderr: "" };
      }
      if (cmd === "unzip" && args[0] === "-q") {
        writeFileSync(join(args[3], "README.txt"), "none");
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };

    const resZero = await fetchVariant(apkVariant, "hash-0-bin", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: fetchOk,
      repositoryId: 1000,
      run: runZero,
    });
    expect(resZero.path).toBeNull();
    expect(resZero.reason).toContain("found 0");
    expect(hasTempEntries(cacheDir)).toBe(false);

    const runTwo: RunProcess = (cmd, args) => {
      if (cmd === "unzip" && args[0] === "-Z1") {
        return { status: 0, stdout: "a.apk\nb.apk\n", stderr: "" };
      }
      if (cmd === "unzip" && args[0] === "-q") {
        writeFileSync(join(args[3], "a.apk"), "a");
        writeFileSync(join(args[3], "b.apk"), "b");
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };

    const resTwo = await fetchVariant(apkVariant, "hash-2-bin", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: fetchOk,
      repositoryId: 1000,
      run: runTwo,
    });
    expect(resTwo.path).toBeNull();
    expect(resTwo.reason).toContain("found 2");
    expect(hasTempEntries(cacheDir)).toBe(false);
  });

  it("returns a miss and cleans up temp dir on non-zero unzip or tar exit", async () => {
    const fetchOk = mockArtifactsFetch();

    const runBadUnzip: RunProcess = (cmd, args) => {
      if (cmd === "unzip" && args[0] === "-Z1") {
        return { status: 0, stdout: "app.apk\n", stderr: "" };
      }
      if (cmd === "unzip" && args[0] === "-q") {
        writeFileSync(join(args[3], "partial.apk"), "partial");
        return { status: 2, stdout: "", stderr: "corrupt zip" };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };

    const resUnzip = await fetchVariant(apkVariant, "hash-bad-unzip", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: fetchOk,
      repositoryId: 1000,
      run: runBadUnzip,
    });
    expect(resUnzip.path).toBeNull();
    expect(resUnzip.reason).toMatch(/extract zip/i);
    expect(hasTempEntries(cacheDir)).toBe(false);

    const runBadTar: RunProcess = (cmd, args) => {
      if (cmd === "unzip" && args[0] === "-Z1") {
        return { status: 0, stdout: "Streamyfin.app.tar\n", stderr: "" };
      }
      if (cmd === "unzip" && args[0] === "-q") {
        writeFileSync(join(args[3], "Streamyfin.app.tar"), "tar");
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "tar" && args[0] === "-tf") {
        return { status: 0, stdout: "Streamyfin.app/Info.plist\n", stderr: "" };
      }
      if (cmd === "tar" && args[0] === "-xf") {
        mkdirSync(join(args[3], "partial"), { recursive: true });
        return { status: 1, stdout: "", stderr: "tar failed" };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };

    const resTar = await fetchVariant(appVariant, "hash-bad-tar", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: fetchOk,
      repositoryId: 1000,
      run: runBadTar,
    });
    expect(resTar.path).toBeNull();
    expect(resTar.reason).toMatch(/extract tar/i);
    expect(hasTempEntries(cacheDir)).toBe(false);
  });

  it("downloads, extracts, caches, and serves subsequent hits from disk", async () => {
    const name = artifactName(appVariant, "hash2");
    let fetchCalls = 0;
    const baseFetch = mockArtifactsFetch();
    const fetchOk: FetchLike = async (url, init) => {
      fetchCalls += 1;
      return baseFetch(url, init);
    };

    const first = await fetchVariant(appVariant, "hash2", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: fetchOk,
      repositoryId: 1000,
      now: () => 1_700_000_000_000,
      run: makeAppRun(),
    });
    expect(first.path).toBe(join(cacheDir, en(name), "Streamyfin.app"));
    expect(fetchCalls).toBe(2);

    const second = await fetchVariant(appVariant, "hash2", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: fetchOk,
      repositoryId: 1000,
      now: () => 1_700_000_100_000,
      run: makeAppRun(),
    });
    expect(second.path).toBe(first.path);
    expect(fetchCalls).toBe(2);
  });

  it("surfaces TypeError name and first stack frame in reason and writes stack to stderr when debug is enabled", async () => {
    const stderrChunks: string[] = [];
    const throwTypeError: FetchLike = async () => {
      throw new TypeError("broken injected dep");
    };

    const quietResult = await fetchVariant(apkVariant, "hash-typeerror", {
      cacheDir,
      env: { GITHUB_TOKEN: "tok" },
      fetch: throwTypeError,
      repositoryId: 1000,
      stderr: (chunk) => {
        stderrChunks.push(chunk);
      },
    });

    expect(quietResult.path).toBeNull();
    expect(quietResult.reason).toContain("TypeError");
    expect(quietResult.reason).toContain("broken injected dep");
    expect(quietResult.reason).toMatch(/fetch\.test\.ts:\d+/);
    expect(stderrChunks).toEqual([]);

    const debugResult = await fetchVariant(apkVariant, "hash-typeerror", {
      cacheDir,
      env: {
        GITHUB_TOKEN: "tok",
        STREAMYFIN_BUILD_CACHE_DEBUG: "1",
      },
      fetch: throwTypeError,
      repositoryId: 1000,
      stderr: (chunk) => {
        stderrChunks.push(chunk);
      },
    });

    expect(debugResult.path).toBeNull();
    expect(debugResult.reason).toContain("TypeError");
    expect(debugResult.reason).toMatch(/fetch\.test\.ts:\d+/);
    const stderrOutput = stderrChunks.join("");
    expect(stderrOutput).toContain("TypeError: broken injected dep");
    expect(stderrOutput).toMatch(/fetch\.test\.ts:\d+/);
  });
});

describe("prune", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = makeTempDir();
  });

  afterEach(() => {
    restorePermissions(cacheDir);
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("removes entries older than 7 days and then least-recently-accessed over budget", () => {
    const nowMs = 1_700_000_000_000;
    const dayMs = 24 * 60 * 60 * 1000;

    const createEntry = (name: string, bytes: number, ageMs: number) => {
      const dir = join(cacheDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".streamyfin-cache-entry"), "");
      writeFileSync(join(dir, "app.apk"), Buffer.alloc(bytes, 1));
      const ts = (nowMs - ageMs) / 1000;
      utimesSync(dir, ts, ts);
    };

    createEntry("expired-entry", 100, 8 * dayMs);
    createEntry("older-lru", 600, 3 * dayMs);
    createEntry("newer-lru", 600, 1 * dayMs);

    // Budget = 1000 bytes (approx 1e-6 GB) so older-lru must be evicted after expired-entry.
    const maxGb = String(1000 / (1024 * 1024 * 1024));
    const result = prune({
      cacheDir,
      env: { STREAMYFIN_BUILD_CACHE_MAX_GB: maxGb },
      now: () => nowMs,
    });

    expect(result.removed).toEqual(["expired-entry", "older-lru"]);
    expect(result.remainingBytes).toBe(600);
    expect(result.freedBytes).toBe(700);
  });

  it("keeps entries just under 7 days and removes entries just over 7 days", () => {
    const nowMs = 1_700_000_000_000;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    const createEntry = (name: string, ageMs: number) => {
      const dir = join(cacheDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".streamyfin-cache-entry"), "");
      writeFileSync(join(dir, "app.apk"), Buffer.alloc(100, 1));
      const ts = (nowMs - ageMs) / 1000;
      utimesSync(dir, ts, ts);
    };

    createEntry("just-under", sevenDaysMs - 1000);
    createEntry("just-over", sevenDaysMs + 1000);

    const result = prune({
      cacheDir,
      env: {},
      now: () => nowMs,
    });

    expect(result.removed).toEqual(["just-over"]);
    expect(existsSync(join(cacheDir, "just-under"))).toBe(true);
    expect(existsSync(join(cacheDir, "just-over"))).toBe(false);
    expect(result.remainingBytes).toBe(100);
  });

  it("removes .tmp-* and .trash-* entries older than 1 hour while keeping newer ones and counting cache entries", () => {
    const nowMs = 1_700_000_000_000;
    const hourMs = 60 * 60 * 1000;

    const createDir = (
      name: string,
      bytes: number,
      ageMs: number,
      owned = false,
    ) => {
      const dir = join(cacheDir, name);
      mkdirSync(dir, { recursive: true });
      if (owned) writeFileSync(join(dir, ".streamyfin-cache-entry"), "");
      writeFileSync(join(dir, "file.bin"), Buffer.alloc(bytes, 1));
      const ts = (nowMs - ageMs) / 1000;
      utimesSync(dir, ts, ts);
    };

    createDir(".tmp-leaked", 500, hourMs + 60_000);
    createDir(".trash-leaked", 500, hourMs + 60_000);
    createDir(".tmp-active", 500, hourMs - 60_000);
    createDir(".trash-recent", 500, hourMs - 60_000);
    createDir("live-entry", 400, 10_000, true);

    const result = prune({
      cacheDir,
      env: {},
      now: () => nowMs,
    });

    expect(result.removed.sort()).toEqual([".tmp-leaked", ".trash-leaked"]);
    expect(existsSync(join(cacheDir, ".tmp-active"))).toBe(true);
    expect(existsSync(join(cacheDir, ".trash-recent"))).toBe(true);
    expect(existsSync(join(cacheDir, "live-entry"))).toBe(true);
    expect(result.remainingBytes).toBe(400);
  });

  it("never deletes directories the build cache did not write", () => {
    const nowMs = 1_700_000_000_000;
    const dayMs = 24 * 60 * 60 * 1000;

    // A shared STREAMYFIN_BUILD_CACHE_DIR can hold anything; none of these
    // are build-cache entries: no marker file, no streamyfin- name.
    for (const foreign of ["backups", "other-tool", "expired-entry"]) {
      const dir = join(cacheDir, foreign);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "data.bin"), Buffer.alloc(100, 1));
      const ts = (nowMs - 30 * dayMs) / 1000;
      utimesSync(dir, ts, ts);
    }
    // A legacy entry from before the marker existed is still ours: it matches
    // the build-cache entry name shape.
    const legacy = join(
      cacheDir,
      "streamyfin-android-phone-debug-device-debugkey-r1-fp-old",
    );
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "app.apk"), Buffer.alloc(100, 1));
    const ts = (nowMs - 30 * dayMs) / 1000;
    utimesSync(legacy, ts, ts);

    const result = prune({ cacheDir, env: {}, now: () => nowMs });

    expect(result.removed).toEqual([
      "streamyfin-android-phone-debug-device-debugkey-r1-fp-old",
    ]);
    for (const foreign of ["backups", "other-tool", "expired-entry"]) {
      expect(existsSync(join(cacheDir, foreign))).toBe(true);
    }
    expect(result.freedBytes).toBe(100);
  });

  it("enforces the default 10 GB cap when STREAMYFIN_BUILD_CACHE_MAX_GB is unset", () => {
    const nowMs = 1_700_000_000_000;
    const sixGb = 6 * 1024 * 1024 * 1024;

    const createSparseEntry = (name: string, ageMs: number) => {
      const dir = join(cacheDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".streamyfin-cache-entry"), "");
      const filePath = join(dir, "app.apk");
      writeFileSync(filePath, "");
      truncateSync(filePath, sixGb);
      const ts = (nowMs - ageMs) / 1000;
      utimesSync(dir, ts, ts);
    };

    createSparseEntry("older-6gb", 20_000);
    createSparseEntry("newer-6gb", 10_000);

    const result = prune({
      cacheDir,
      env: {},
      now: () => nowMs,
    });

    expect(result.removed).toEqual(["older-6gb"]);
    expect(result.remainingBytes).toBe(sixGb);
    expect(existsSync(join(cacheDir, "newer-6gb"))).toBe(true);
  });

  itUnlessRoot(
    "records EACCES on a read-only entry while pruning remaining entries",
    () => {
      const nowMs = 1_700_000_000_000;
      const dayMs = 24 * 60 * 60 * 1000;

      const createEntry = (name: string, bytes: number, ageMs: number) => {
        const dir = join(cacheDir, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, ".streamyfin-cache-entry"), "");
        writeFileSync(join(dir, "app.apk"), Buffer.alloc(bytes, 1));
        const ts = (nowMs - ageMs) / 1000;
        utimesSync(dir, ts, ts);
        return dir;
      };

      const lockedPath = createEntry("locked-entry", 200, 8 * dayMs);
      createEntry("expired-ok", 300, 8 * dayMs);
      createEntry("live-entry", 400, 1 * dayMs);

      // 0o500 allows statSync/readdirSync for sizing while blocking unlink inside locked-entry.
      chmodSync(lockedPath, 0o500);

      const result = prune({
        cacheDir,
        env: {},
        now: () => nowMs,
      });

      expect(result.removed).toEqual(["expired-ok"]);
      expect(result.skipped).toEqual([
        { name: "locked-entry", code: "EACCES" },
      ]);
      expect(result.remainingBytes).toBe(600);
      expect(existsSync(join(cacheDir, "expired-ok"))).toBe(false);
      expect(existsSync(join(cacheDir, "live-entry"))).toBe(true);
      expect(existsSync(lockedPath)).toBe(true);
    },
  );
});
