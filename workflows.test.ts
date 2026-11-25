import { spawnSync } from "node:child_process";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import ignore from "ignore";
import { PLATFORMS } from "./e2e/suites/screenshots/lib/core";

// The CI workflows name modules, paths and commands by hand, and nothing fails
// when one of those lists falls behind the tree: the workflow stays green while
// it checks less than its comments say. These tests pin each list to what it
// stands for, so the drift fails here instead.

const root = __dirname;

const readWorkflow = (name: string) =>
  readFileSync(join(root, ".github/workflows", name), "utf8");

/**
 * The text without YAML and shell comments: a name that is only mentioned
 * does not count.
 */
const withoutComments = (text: string) => text.replace(/(^|\s)#.*$/gm, "$1");

/**
 * The items of the YAML list under `key:`, up to the first line that is not
 * one.
 */
const listUnder = (text: string, key: string) => {
  const lines = withoutComments(text).split("\n");
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  const items: string[] = [];
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const item = line.match(/^\s*- (["']?)(.+)\1\s*$/);
    if (!item) break;
    items.push(item[2]);
  }
  return items;
};

describe("native-tests.yml", () => {
  // Gradle runs the tasks the command names and no others, so a module left
  // out passes CI whatever a pull request breaks in it. The first version ran
  // mpv-player alone while exoplayer-player and background-downloader had
  // suites of their own, ForegroundPromotionTest among them.
  const tasks = [
    ...withoutComments(readWorkflow("native-tests.yml")).matchAll(
      /:([\w-]+):testDebugUnitTest\b/g,
    ),
  ].map((match) => match[1]);
  const modulesWithJvmTests = readdirSync(join(root, "modules"), {
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(root, "modules", entry.name, "android/src/test")),
    )
    .map((entry) => entry.name);

  test("runs the JVM tests of every module that has some", () => {
    expect(modulesWithJvmTests).not.toEqual([]);
    // A non-empty list here names the modules to add to the Gradle command,
    // as :<module>:testDebugUnitTest.
    expect(modulesWithJvmTests.filter((name) => !tasks.includes(name))).toEqual(
      [],
    );
  });

  // The standalone Swift checks (scripts/ios/test-*.sh) need swiftc, so only
  // a macOS runner can run them; the runner script picks up every check, a new
  // one included.
  test("runs every standalone Swift check on macOS", () => {
    const workflow = withoutComments(readWorkflow("native-tests.yml"));
    expect(workflow).toMatch(/runs-on: macos-/);
    expect(workflow).toContain("bash scripts/ios/run-native-checks.sh");
  });

  // The JUnit and Swift readers replay the receiver vectors, and the Swift
  // checks live outside modules/: a change to any of them must start the job.
  test("starts on a change to what the native checks read", () => {
    const rules = listUnder(readWorkflow("native-tests.yml"), "modules");
    expect(rules).toEqual(
      expect.arrayContaining([
        "modules/**",
        "tests/native/**",
        "scripts/ios/**",
        "e2e/fixtures/receiver-protocol/**",
      ]),
    );
  });
});

/**
 * The files of the repository: the tree without .git and without what a
 * .gitignore leaves out, each read from its own directory. Walked in-process
 * rather than asked of `git ls-files`: see bun-test-discovery-leaks-fds.
 */
const repositoryFiles = (
  dir = "",
  rules: { dir: string; ignore: ReturnType<typeof ignore> }[] = [],
): string[] => {
  const gitignore = join(root, dir, ".gitignore");
  const inScope = existsSync(gitignore)
    ? [...rules, { dir, ignore: ignore().add(readFileSync(gitignore, "utf8")) }]
    : rules;
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch (error) {
    // Gone since its parent was listed: another test's temporary directory.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const path = posix.join(dir, entry.name);
    const directory = entry.isDirectory();
    const ignored =
      entry.name === ".git" ||
      inScope.some((rule) =>
        rule.ignore.ignores(
          `${rule.dir ? posix.relative(rule.dir, path) : path}${directory ? "/" : ""}`,
        ),
      );
    if (ignored) return [];
    return directory ? repositoryFiles(path, inScope) : [path];
  });
};

// The Cast API: the library, the receiver constants, and the module's own cast
// API, meant to take over from the library.
const CAST_PACKAGE = "react-native-google-cast";
const CAST_SOURCES = ["constants/Cast", "modules/mpv-player/src/cast"];

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
// Specs and test doubles never reach the APK the smoke flow drives.
const SPEC_OR_DOUBLE = /\.(test|perf-test)\.[cm]?[jt]sx?$|^test-utils\//;
// The specifier of an import, an export from, an import() or a require().
const IMPORT = /\b(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;

const isCastSource = (path: string) =>
  CAST_SOURCES.some(
    (source) =>
      path === source ||
      path.startsWith(`${source}/`) ||
      path.startsWith(`${source}.`),
  );

const importsCastApi = (file: string, specifier: string) => {
  if (specifier.startsWith("@/")) return isCastSource(specifier.slice(2));
  if (specifier.startsWith(".")) {
    return isCastSource(posix.join(posix.dirname(file), specifier));
  }
  return specifier === CAST_PACKAGE || specifier.startsWith(`${CAST_PACKAGE}/`);
};

/**
 * Whether `file`, whose text is `source`, is part of the Cast API or imports
 * it.
 */
const usesCastApi = (file: string, source: string) =>
  isCastSource(file) ||
  [...source.matchAll(IMPORT)].some(([, specifier]) =>
    importsCastApi(file, specifier),
  );

/**
 * A source file of the walk, read now. A file gone by the time it is read,
 * another test's temporary one, is not part of the repository: undefined.
 */
const sourceOf = (file: string) => {
  if (!SOURCE_FILE.test(file) || SPEC_OR_DOUBLE.test(file)) return undefined;
  try {
    return readFileSync(join(root, file), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

/** The source files among `files` that use the Cast API. */
const castCodeIn = (files: string[]) =>
  files.filter((file) => {
    const source = sourceOf(file);
    return source !== undefined && usesCastApi(file, source);
  });

/** The source files among `files` that carry one of the test ids `ids`. */
const screensDrivenBy = (ids: string[], files: string[]) =>
  files.filter((file) => {
    const source = sourceOf(file);
    return (
      source !== undefined &&
      ids.some((id) => source.includes(`testID='${id}'`))
    );
  });

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether the filter counts `file` under `rule`. dorny/paths-filter matches
 * with picomatch and `dot: true`, which compares the two strings first and
 * then reads the rule as a glob. Of the glob syntax only `*` and `**` are
 * modelled; the spelling test below fails on the rest.
 */
const matches = (rule: string, file: string) => {
  if (rule === file) return true;
  const segments = rule.split("/");
  const pattern = segments
    .map((segment, index) => {
      const last = index === segments.length - 1;
      if (segment === "**") return last ? ".*" : "(?:[^/]*/)*";
      const name = segment.split("*").map(escapeRegExp).join("[^/]*");
      return last ? name : `${name}/`;
    })
    .join("");
  return new RegExp(`^${pattern}$`).test(file);
};

// picomatch reads ( ) [ ] { } ? ! + @ as glob syntax: `app/(auth)/**` matches
// app/auth/, not the route group. A rule that is a path of the repository is
// safe, the string comparison matches it first.
const GLOB_SYNTAX = /[()[\]{}?!+@]/;

// Free disk space, dependencies, prebuild and the APK build: about 28 minutes
// in the first runs of the workflow.
const MINUTES_BEFORE_THE_EMULATOR = 30;

describe("e2e-tier1-android.yml", () => {
  const workflow = readWorkflow("e2e-tier1-android.yml");

  describe("the cast filter", () => {
    // The emulator job costs half an hour, so it runs only on pull requests
    // that touch cast code. The first filter named a components/cast/ that
    // never existed and missed JellyfinCastStopReporter, which every launch on
    // a phone mounts: a change there would have skipped the smoke flow.
    const rules = listUnder(workflow, "cast");
    const files = repositoryFiles();
    const castCode = castCodeIn(files);

    test("runs on its own workflow", () => {
      expect(rules).toContain(".github/workflows/e2e-tier1-android.yml");
    });

    test("covers every file `shots.ts maestro-path` loads", () => {
      for (const file of [
        "e2e/suites/screenshots/lib/tooling.ts",
        "e2e/suites/screenshots/shots.ts",
        "scripts/reassure-baseline.ts",
      ]) {
        expect(rules.some((rule) => matches(rule, file))).toBe(true);
      }
    });

    // The TV font size rule's test writes a probe under components/tv/ and
    // removes it, and Jest runs the two files at once: the walk listed the
    // probe, then reading it failed with ENOENT (seen 2026-11-03).
    test("passes over a file removed between the walk and its read", () => {
      expect(castCodeIn(["components/tv/.lint-probe-gone/Probe.tsx"])).toEqual(
        [],
      );
      expect(
        screensDrivenBy(
          ["server-url"],
          ["components/tv/.lint-probe-gone/Probe.tsx"],
        ),
      ).toEqual([]);
    });

    // The same probe's directory can go between the listing of components/tv/
    // and its own.
    test("passes over a directory removed between the walk and its read", () => {
      expect(repositoryFiles("components/tv/.lint-probe-gone")).toEqual([]);
    });

    test("covers every file that uses the Cast API", () => {
      // A non-empty list here names the files to add to the filter.
      expect(
        castCode.filter((file) => !rules.some((rule) => matches(rule, file))),
      ).toEqual([]);
    });

    test("covers the screen the smoke flow drives", () => {
      // The smoke flow finds the server screen by its test ids: a change to
      // that screen would otherwise skip the flow that depends on it.
      const flow = readFileSync(
        join(root, "e2e/suites/cast/flows/smoke-launch.yml"),
        "utf8",
      );
      const ids = [...flow.matchAll(/id: "([^"]+)"/g)].map((match) => match[1]);
      const screens = screensDrivenBy(ids, files);
      expect(screens).not.toEqual([]);
      expect(
        screens.filter((file) => !rules.some((rule) => matches(rule, file))),
      ).toEqual([]);
    });

    test("names only rules that match a file", () => {
      // A non-empty list here names rules left behind by a typo or a move.
      expect(
        rules.filter((rule) => !files.some((file) => matches(rule, file))),
      ).toEqual([]);
    });

    test("spells its globs the way the filter reads them", () => {
      expect(
        rules.filter((rule) => GLOB_SYNTAX.test(rule) && !files.includes(rule)),
      ).toEqual([]);
    });

    test.each([
      [
        "the library",
        "components/Chromecast.tsx",
        'import { CastButton } from "react-native-google-cast";',
      ],
      [
        "the library through require",
        "app/_layout.tsx",
        'const GoogleCast = require("react-native-google-cast");',
      ],
      [
        "the receiver constants",
        "hooks/useMusicCast.ts",
        'import { RECEIVER_LOAD_TIMEOUT_MS } from "@/constants/Cast";',
      ],
      [
        "the module's cast API",
        "components/Chromecast.tsx",
        'import { CastButton } from "@/modules/mpv-player/src/cast";',
      ],
      [
        "the module's cast API from inside the module",
        "modules/mpv-player/src/index.ts",
        'export * from "./cast/session";',
      ],
    ])("counts a file that imports %s", (_, file, source) => {
      expect(usesCastApi(file, source)).toBe(true);
    });

    test("does not count a file that imports a namesake", () => {
      expect(
        usesCastApi(
          "components/Casting.tsx",
          'import { CASTING } from "@/constants/Casting";',
        ),
      ).toBe(false);
    });
  });

  describe("the emulator steps", () => {
    // A hung attempt that runs the job into its timeout cancels the job, and a
    // cancelled job skips the retry and the upload of the evidence.
    const job = workflow.slice(workflow.indexOf("\n  maestro:"));
    const minutes = (text: string) =>
      Number(text.match(/^\s*timeout-minutes:\s*(\d+)/m)?.[1]);
    const emulatorSteps = job
      .split(/\n(?=[ \t]*- name: )/)
      .filter((step) => step.includes("reactivecircus/android-emulator-runner"))
      .map((step) => ({
        name: step.match(/- name: (.+)/)?.[1],
        step: withoutComments(step),
      }));

    test.each(emulatorSteps)(
      "$name ends a hung attempt as a failure",
      ({ step }) => {
        // Maestro alone waits on a stalled device for as long as the job lets
        // it; maestro.py stops it and fails the attempt, and the runner then
        // shuts the emulator down before the retry boots one.
        expect(step).not.toMatch(/\bmaestro\s+test\b/);
        const flowSeconds = Number(
          step.match(/e2e\/bench\/maestro\.py .*--timeout[ =](\d+)/)?.[1],
        );
        // The step's own bound, which covers the boot and the install too,
        // comes after it.
        expect(flowSeconds).toBeLessThan(minutes(step) * 60);
      },
    );

    test("both attempts fit in the job after the build", () => {
      const attempts = emulatorSteps.reduce(
        (sum, { step }) => sum + minutes(step),
        0,
      );
      expect(attempts).toBeLessThanOrEqual(
        minutes(job) - MINUTES_BEFORE_THE_EMULATOR,
      );
    });

    test.each(emulatorSteps)(
      "$name passes the pinned binary to maestro.py",
      ({ step }) => {
        expect(step).toMatch(
          /e2e\/bench\/maestro\.py\s+.*--maestro\s+"\$MAESTRO_BIN"/,
        );
      },
    );
  });

  describe("the pinned Maestro", () => {
    const clean = withoutComments(workflow);

    test("installs via shots.ts maestro-path rather than get.maestro.mobile.dev", () => {
      expect(clean).not.toContain("get.maestro.mobile.dev");
      expect(clean).toContain("e2e/suites/screenshots/shots.ts maestro-path");
    });

    test("is installed before the first emulator step", () => {
      expect(clean.indexOf("shots.ts maestro-path")).toBeGreaterThan(-1);
      expect(clean.indexOf("shots.ts maestro-path")).toBeLessThan(
        clean.indexOf("reactivecircus/android-emulator-runner"),
      );
    });

    test("passes the pinned binary to both smoke attempts", () => {
      expect(clean.match(/--maestro "\$MAESTRO_BIN"/g)).toHaveLength(2);
    });
  });
});

const { load: loadYaml } = require("js-yaml") as {
  load: (src: string) => Record<string, unknown>;
};

describe.each([
  "native-tests.yml",
  "e2e-tier1-android.yml",
  "e2e-screenshots.yml",
])("%s checkouts", (name) => {
  // Every job installs and builds the pull request's own code after its
  // checkout, which would otherwise leave a usable token in .git/config, as
  // build-apps.yml already avoids.
  const checkouts = withoutComments(readWorkflow(name))
    .split(/\n(?=[ \t]*- (?:name|uses): )/)
    .filter((step) => /uses: actions\/checkout@/.test(step));

  test("none keeps the token after the checkout", () => {
    expect(checkouts).not.toEqual([]);
    expect(
      checkouts.filter((step) => !/persist-credentials: false\b/.test(step)),
    ).toEqual([]);
  });
});

describe("e2e-screenshots.yml", () => {
  type Step = {
    id?: string;
    name?: string;
    if?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
  };
  type Job = {
    if?: string;
    needs?: string | string[];
    "runs-on"?: string;
    outputs?: Record<string, string>;
    permissions?: Record<string, string>;
    strategy?: { "fail-fast"?: boolean; matrix?: string };
    steps?: Step[];
  };
  const rawWorkflow = readWorkflow("e2e-screenshots.yml");
  const workflow = loadYaml(rawWorkflow) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    concurrency: { group: string; "cancel-in-progress": string | boolean };
    jobs: Record<string, Job>;
  };

  test("triggers on develop pushes and on demand", () => {
    expect(Object.keys(workflow.on).sort()).toEqual([
      "pull_request",
      "push",
      "workflow_dispatch",
    ]);
    expect((workflow.on.push as { branches?: string[] }).branches).toEqual([
      "develop",
    ]);
    const pr = workflow.on.pull_request as {
      types?: string[];
      branches?: string[];
    };
    expect(pr.types).toEqual(["labeled"]);
    expect(pr.branches).toEqual(["develop", "master"]);
    expect(workflow.jobs.plan.if).toContain(
      "github.event.label.name == 'run-screenshots'",
    );
    const dispatch = workflow.on.workflow_dispatch as {
      inputs?: {
        before?: { required?: boolean };
        after?: unknown;
        platforms?: { default?: string };
      };
    };
    expect(dispatch.inputs?.before?.required).toBe(true);
    expect(dispatch.inputs?.after).toBeDefined();
    expect(
      dispatch.inputs?.platforms?.default
        ?.split(",")
        .map((p) => p.trim())
        .sort(),
    ).toEqual([...PLATFORMS].sort());
  });

  test("uses minimal read permissions and the expected runner per job", () => {
    // The native Apple silicon fixture and tvOS 27.2 simulator require xcode-27;
    // Intel runners cannot run the arm64 fixture.
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.apple.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
    expect(workflow.jobs.android.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
    expect(workflow.jobs.plan["runs-on"]).toBe("ubuntu-26.04");
    expect(workflow.jobs.apple["runs-on"]).toBe("xcode-27");
    expect(workflow.jobs.android["runs-on"]).toBe("ubuntu-26.04");
  });

  test("another label never cancels a running comparison", () => {
    // Every label fires a run; one sharing the group would cancel the screenshot job.
    expect(workflow.concurrency.group).toContain("github.event.label.name");
  });

  test("a develop push never cancels the comparison of the push before it", () => {
    expect(workflow.concurrency["cancel-in-progress"]).toContain(
      "github.event_name != 'push'",
    );
  });

  test("plan job covers every suite platform", () => {
    const planScript = workflow.jobs.plan.steps?.[0]?.run ?? "";
    const appleBlock = planScript.match(/APPLE\s*=\s*\{([\s\S]*?)\n\}/)?.[1];
    const androidBlock = planScript.match(
      /ANDROID\s*=\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(appleBlock).toBeDefined();
    expect(androidBlock).toBeDefined();

    const extractKeys = (block: string) =>
      [...block.matchAll(/^\s*"([^"]+)":\s*\{/gm)].map((m) => m[1]);
    const planned = [
      ...extractKeys(appleBlock!),
      ...extractKeys(androidBlock!),
    ];
    expect(planned.sort()).toEqual([...PLATFORMS].sort());

    expect(workflow.jobs.apple.strategy?.["fail-fast"]).toBe(false);
    expect(workflow.jobs.apple.strategy?.matrix).toContain(
      "needs.plan.outputs.apple",
    );
    expect(workflow.jobs.android.strategy?.["fail-fast"]).toBe(false);
    expect(workflow.jobs.android.strategy?.matrix).toContain(
      "needs.plan.outputs.android",
    );
  });

  test("every Android matrix entry has a non-empty emulator profile", () => {
    const planScript = workflow.jobs.plan.steps?.[0]?.run ?? "";
    const androidBlock = planScript.match(
      /ANDROID\s*=\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(androidBlock).toBeDefined();

    const entries = [...androidBlock!.matchAll(/"([^"]+)":\s*\{([^}]+)\}/g)];
    expect(entries.length).toBeGreaterThan(0);
    for (const [, name, body] of entries) {
      const profile = body.match(/"profile":\s*"([^"]*)"/)?.[1] ?? "";
      expect({ name, hasProfile: profile.trim().length > 0 }).toEqual({
        name,
        hasProfile: true,
      });
    }
  });

  test("android emulator step pins the same action SHA as e2e-tier1-android.yml", () => {
    const tier1Pin = readWorkflow("e2e-tier1-android.yml").match(
      /uses:\s*(reactivecircus\/android-emulator-runner@[0-9a-f]{40})/,
    )?.[1];
    expect(tier1Pin).toBeDefined();

    const emulatorStep = workflow.jobs.android.steps?.find((step) =>
      step.uses?.startsWith("reactivecircus/android-emulator-runner@"),
    );
    expect(emulatorStep?.uses).toBe(tier1Pin);
  });

  test.each(["apple", "android"] as const)(
    "%s shares dev clients via fingerprint artifacts instead of actions/cache",
    (jobName) => {
      const steps = workflow.jobs[jobName].steps ?? [];
      expect(
        steps.some(
          (step) =>
            step.uses?.startsWith("actions/cache@") &&
            String(step.with?.path ?? "").includes("build-cache"),
        ),
      ).toBe(false);
      expect(rawWorkflow).not.toContain("prune-build-cache");

      const runStep = steps.find(
        (step) =>
          step.run?.includes("e2e:shots") ||
          String(step.with?.script ?? "").includes("e2e:shots"),
      );
      expect(runStep?.env?.GH_TOKEN).toMatch(/^\$\{\{\s*github\.token\s*\}\}$/);
      expect(runStep?.env?.SHOTS_BUILD_CACHE_FETCH).toContain(
        "fetch-dev-client.py",
      );
      expect(runStep?.env?.SHOTS_PASS_TIMEOUT_SECONDS).toBe("2700");

      expect(workflow.jobs.plan.outputs?.trusted).toBe(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
        "${{ github.event_name == 'push' || github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.id == github.repository_id) }}",
      );

      const prepareStep = steps.find((step) => step.id === "dev-clients");
      expect(prepareStep).toBeDefined();
      expect(prepareStep?.if).toBe(
        "always() && needs.plan.outputs.trusted == 'true'",
      );

      const clientUploads = steps.filter(
        (step) =>
          step.uses?.startsWith("actions/upload-artifact@") &&
          String(step.with?.name ?? "").startsWith("shots-dev-client-"),
      );
      expect(clientUploads).toHaveLength(2);
      for (const upload of clientUploads) {
        expect(upload.with?.["retention-days"]).toBe(90);
        expect(upload.if).toMatch(
          /^always\(\) && needs\.plan\.outputs\.trusted == 'true' && steps\.dev-clients\.outputs\.(before|after)_hash != ''$/,
        );
      }
    },
  );
});

/** The script of the step named `name`, as bash is given it. */
const runOf = (text: string, name: string) => {
  const lines = text.split("\n");
  const step = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  const run = lines.findIndex(
    (line, i) => i > step && /^\s*run: \|$/.test(line),
  );
  const indent = lines[run].search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    body.push(line.slice(indent + 2));
  }
  return body.join("\n");
};

// The two jobs that comment run on workflow_run, with a token that can write,
// on an artifact the PR's own run made and could fill with anything, links
// included. unzip writes every entry it is given, so each job lists the zip
// first, stops on anything but the files it reads, and unpacks only those.
describe.each([
  [
    "plugin-parity-comment.yml",
    "📂 Unpack the report",
    ["pr-number", "report.json"],
  ],
  ["perf-comment.yml", "📂 Unpack results", ["comment.md", "pr-number"]],
])("%s", (name, step, files) => {
  const script = runOf(readWorkflow(name), step);

  // The step as GitHub runs it, with unzip standing in: -Z1 lists the entries
  // given, and anything else it is asked is written to a log.
  const unpack = (entries: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "unpack-"));
    try {
      mkdirSync(join(dir, "bin"));
      writeFileSync(
        join(dir, "bin/unzip"),
        '#!/bin/sh\nif [ "$1" = -Z1 ]; then printf "%s\\n" $ENTRIES; else echo "$*" >> "$LOG"; fi\n',
        { mode: 0o755 },
      );
      const result = spawnSync("bash", ["-eo", "pipefail", "-c", script], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          RUNNER_TEMP: dir,
          ENTRIES: entries.join(" "),
          LOG: join(dir, "log"),
        },
      });
      const log = join(dir, "log");
      return {
        code: result.status,
        asked: existsSync(log) ? readFileSync(log, "utf8").trim() : "",
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("unpacks the two files it reads, flat, in whatever order the zip has them", () => {
    const { code, asked } = unpack([...files].reverse());

    expect(code).toBe(0);
    expect(asked.split(/\s+/)).toEqual([
      "-o",
      "-j",
      expect.stringMatching(/\.zip$/),
      ...files,
      "-d",
      expect.any(String),
    ]);
  });

  test.each([
    ["an extra entry", [...files, "node_modules/.bin/bun"]],
    ["one of them missing", files.slice(0, 1)],
    ["one of them twice", [...files, files[0]]],
  ])(
    "stops on an artifact with %s, before unpacking anything",
    (_, entries) => {
      const { code, asked } = unpack(entries);

      expect(code).not.toBe(0);
      expect(asked).toBe("");
    },
  );
});

describe("linting.yml", () => {
  // CONTRIBUTING.md asks for `bun run test` before a pull request, and CI runs
  // the same commands as one job each. Both lists are kept by hand: CI gained
  // the bench's own tests and the local gate did not.
  const ciCommands = listUnder(readWorkflow("linting.yml"), "command");
  const localGate: string[] = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  )
    .scripts.test.split("&&")
    .map((command: string) => command.trim().replace(/^bun run /, ""));
  // Biome without its fixes; the local gate runs the same rules through `lint`.
  const CI_ONLY = ["check"];

  test("bun run test runs every command of the CI gate", () => {
    expect(ciCommands).toContain("test:unit");
    // A non-empty list here names the scripts to chain into `test` in
    // package.json.
    expect(
      ciCommands.filter(
        (command) => !CI_ONLY.includes(command) && !localGate.includes(command),
      ),
    ).toEqual([]);
  });
});
