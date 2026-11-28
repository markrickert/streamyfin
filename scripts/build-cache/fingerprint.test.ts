import { hashFor } from "./fingerprint";
import { defaultRun, type RunProcess, repoRoot } from "./process";

const validOutput = (hash = "fp-hash-123") =>
  JSON.stringify({
    hash,
    sources: [{ id: "expoConfig" }, { id: "packageJson" }],
  });

describe("hashFor", () => {
  it("sets EXPO_TV=0 for phone and EXPO_TV=1 for tv", () => {
    const seenEnv: Array<string | undefined> = [];
    const run: RunProcess = (_cmd, _args, { env }) => {
      seenEnv.push(env.EXPO_TV);
      return { status: 0, stdout: validOutput(), stderr: "" };
    };

    hashFor({ os: "ios", form: "phone" }, { run, env: {} });
    hashFor({ os: "ios", form: "tv" }, { run, env: {} });
    expect(seenEnv).toEqual(["0", "1"]);
  });

  it("passes repoRoot as cwd when spawning fingerprint", () => {
    let seenCwd: string | undefined;
    const run: RunProcess = (_cmd, _args, { cwd }) => {
      seenCwd = cwd;
      return { status: 0, stdout: validOutput(), stderr: "" };
    };

    hashFor({ os: "ios", form: "phone" }, { run, env: {} });
    expect(seenCwd).toBe(repoRoot());
  });

  it("adds Android ignore paths only for android and never for ios", () => {
    const calls: Array<readonly string[]> = [];
    const run: RunProcess = (_cmd, args) => {
      calls.push(args);
      return { status: 0, stdout: validOutput(), stderr: "" };
    };

    hashFor({ os: "ios", form: "phone" }, { run, env: {} });
    hashFor({ os: "android", form: "phone" }, { run, env: {} });

    expect(calls[0]).toEqual([
      "@expo/fingerprint",
      "fingerprint:generate",
      "--platform",
      "ios",
    ]);
    expect(calls[1]).toEqual([
      "@expo/fingerprint",
      "fingerprint:generate",
      "--platform",
      "android",
      "--ignore-path",
      "scripts/ios/**/*",
      "--ignore-path",
      "targets/**/*",
    ]);
  });

  it("returns the hash when expoConfig is present in sources", () => {
    const run: RunProcess = () => ({
      status: 0,
      stdout: validOutput("abc987"),
      stderr: "",
    });
    expect(hashFor({ os: "android", form: "tv" }, { run, env: {} })).toBe(
      "abc987",
    );
  });

  it("throws when sources has no expoConfig entry", () => {
    const run: RunProcess = () => ({
      status: 0,
      stdout: JSON.stringify({
        hash: "bad-hash",
        sources: [{ id: "packageJson" }],
      }),
      stderr: "",
    });
    expect(() =>
      hashFor({ os: "ios", form: "phone" }, { run, env: {} }),
    ).toThrow(/Expo config/);
  });

  it("throws when the fingerprint command exits non-zero", () => {
    const run: RunProcess = () => ({
      status: 1,
      stdout: "",
      stderr: "boom",
    });
    expect(() =>
      hashFor({ os: "android", form: "phone" }, { run, env: {} }),
    ).toThrow(/boom/);
  });

  it("folds spawnSync error messages into stderr in defaultRun", () => {
    const result = defaultRun("streamyfin-nonexistent-binary-for-test", [], {
      env: {},
    });
    expect(result.status).toBeNull();
    expect(result.stderr).toContain("ENOENT");
  });
});
