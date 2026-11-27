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
import { join, posix, resolve } from "node:path";
import ignore from "ignore";

import {
  artifactName,
  VARIANTS,
  variantById,
} from "./scripts/build-cache/variants";

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
  });
});

describe.each(["native-tests.yml", "e2e-tier1-android.yml"])(
  "%s checkouts",
  (name) => {
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
  },
);

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

describe("build-apps.yml", () => {
  const buildAppsRaw = readWorkflow("build-apps.yml");
  const nativeVariant = withoutComments(readWorkflow("_native-variant.yml"));
  const groupRaw = readWorkflow("_native-build-group.yml");
  const group = withoutComments(groupRaw);
  const buildActionRaw = readFileSync(
    resolve(__dirname, ".github/actions/build-native-variant/action.yml"),
    "utf8",
  );
  const buildAction = withoutComments(buildActionRaw);
  const buildScript = readFileSync(
    resolve(__dirname, "scripts/build-cache/build-native-variant.sh"),
    "utf8",
  );
  const buildApps = withoutComments(buildAppsRaw);

  /** Splits `jobs:` in a workflow into a map of job id -> raw job block. */
  const jobsOf = (text: string): Map<string, string> => {
    const jobsStart = text.indexOf("\njobs:\n");
    const section =
      jobsStart < 0 ? "" : text.slice(jobsStart + "\njobs:\n".length);
    const lines = section.split("\n");
    const jobs = new Map<string, string>();
    let currentId: string | null = null;
    let buffer: string[] = [];

    for (const line of lines) {
      const header = line.match(/^ {2}([a-zA-Z0-9_-]+):\s*$/);
      if (header) {
        if (currentId !== null) jobs.set(currentId, buffer.join("\n"));
        currentId = header[1];
        buffer = [];
      } else if (currentId !== null) {
        buffer.push(line);
      }
    }
    if (currentId !== null) jobs.set(currentId, buffer.join("\n"));
    return jobs;
  };

  const jobs = jobsOf(buildApps);
  const callers = [...jobs.entries()].filter(([, body]) =>
    /uses:\s*\.\/\.github\/workflows\/_native-variant\.yml\b/.test(body),
  );

  const callerByVariant = new Map<string, { id: string; body: string }[]>();
  for (const [id, body] of callers) {
    const match = body.match(/^\s*variant:\s*(\S+)\s*$/m);
    const variantId = match?.[1];
    if (!variantId) continue;
    const list = callerByVariant.get(variantId) ?? [];
    list.push({ id, body });
    callerByVariant.set(variantId, list);
  }

  test("groups full builds by OS and gives every variant a single build step", () => {
    expect(jobsOf(group).size).toBe(1);
    expect([...jobs.keys()].filter((id) => id.startsWith("build-"))).toEqual([
      "build-android",
      "build-ios",
    ]);
    for (const variant of VARIANTS) {
      expect(callerByVariant.get(variant.id)?.length ?? 0).toBe(
        variant.mode === "repack" ? 1 : 0,
      );
      expect(
        group.match(new RegExp(`^\\s*variant: ${variant.id}$`, "gm")),
      ).toHaveLength(1);
    }
  });

  test("the four gate names exist exactly once and nothing else uses those names", () => {
    const expectedGates: Record<string, string> = {
      "🍎 Build iOS IPA (Phone)": "ios-phone-release-device-signed",
      "🤖 Build Android APK (Phone)": "android-phone-release-device-debugkey",
      "🤖 Build Android APK (TV)": "android-tv-release-device-debugkey",
      "🍎 Build tvOS IPA (Unsigned)": "ios-tv-release-device-unsigned",
    };

    for (const [gateName, expectedCallerVariant] of Object.entries(
      expectedGates,
    )) {
      const escaped = escapeRegExp(gateName);
      const exactLine = new RegExp(
        `^\\s*(?:name|build-name|repack-name):\\s*${escaped}\\s*$`,
        "gm",
      );
      const matchesInBuildApps = [...buildApps.matchAll(exactLine)];
      const matchesInNativeVariant = [...nativeVariant.matchAll(exactLine)];

      expect(matchesInBuildApps).toHaveLength(1);
      expect(matchesInNativeVariant).toHaveLength(0);

      const gateEntry = [...jobs.entries()].find(([, body]) =>
        new RegExp(`^\\s*name:\\s*${escaped}\\s*$`, "m").test(body),
      );
      expect(gateEntry).toBeDefined();
      const [, gateBody] = gateEntry!;
      const callerId = callerByVariant.get(expectedCallerVariant)![0].id;
      const needsLine = gateBody.match(/^\s*needs:\s*(.+)$/m)?.[1] ?? "";
      expect(needsLine).toContain(callerId);
      const buildOs = expectedCallerVariant.startsWith("ios-")
        ? "ios"
        : "android";
      expect(needsLine).toContain(`build-${buildOs}`);
      expect(gateBody).toContain(
        `needs.build-${buildOs}.outputs.${expectedCallerVariant}`,
      );
      expect(group).toContain(
        `${expectedCallerVariant}: \${{ steps.${expectedCallerVariant}.outcome }}`,
      );
    }
  });

  test("the ensure step carries the merge_group and fork skip condition", () => {
    const ensureVariants = VARIANTS.filter((v) => v.mode === "ensure");
    expect(ensureVariants.length).toBe(8);

    const fingerprint = jobs.get("fingerprint")!;
    const ensureStep = fingerprint.slice(fingerprint.indexOf("id: ensure"));
    const ifLine = ensureStep.match(/^\s*if: (.+)$/m)?.[1] ?? "";
    expect(ifLine).toContain("github.event_name != 'merge_group'");
    expect(ifLine).toContain(
      "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository",
    );
  });

  // A flaky fingerprint must never block a merge: the required variants build
  // in full and upload under a name no lookup will reuse.
  const ifOf = (body: string) => body.match(/^\s*if:\s*(.+)$/m)?.[1] ?? "";

  test("never repacks without a successful fingerprint and a trusted source", () => {
    for (const [, caller] of callers) {
      expect(ifOf(caller)).toContain("needs.fingerprint.result == 'success'");
      expect(ifOf(caller)).toMatch(
        /needs\.fingerprint\.outputs\.\w+_source != ''/,
      );
    }

    const [{ body: signed }] = callerByVariant.get(
      "ios-phone-release-device-signed",
    )!;
    expect(ifOf(signed)).toContain(
      "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository",
    );
  });

  test("checks signing credentials before fingerprint work and skips only on known absence", () => {
    const fingerprint = jobs.get("fingerprint")!;
    const [{ body: signed }] = callerByVariant.get(
      "ios-phone-release-device-signed",
    )!;
    const gate = jobs.get("gate-ios-phone")!;
    const preflight = fingerprint.indexOf(
      "- name: Check signed iOS credentials",
    );
    expect(preflight).toBeGreaterThan(0);
    expect(preflight).toBeLessThan(
      fingerprint.indexOf("- name: 📥 Checkout code"),
    );
    expect(fingerprint).toContain(
      "can_sign: ${{ steps.signing.outputs.can_sign }}",
    );
    expect(fingerprint).toContain("CAN_SIGN: ${{ secrets.EXPO_TOKEN != '' }}");
    expect(ifOf(signed)).toContain(
      "needs.fingerprint.outputs.can_sign != 'false'",
    );
    expect(gate).toContain(
      "needs: [fingerprint, ios-phone-release-device-signed, build-ios]",
    );
    expect(gate).toContain(
      "CAN_SIGN: ${{ needs.fingerprint.outputs.can_sign }}",
    );
    expect(gate).toContain("IS_FORK_REPO: ${{ github.event.repository.fork }}");
  });

  test.each([
    ["false", "true", 0, "Skipping signed iOS build"],
    ["false", "false", 1, "EXPO_TOKEN is not configured"],
    ["", "true", 1, "Build did not succeed"],
  ])(
    "checks a skipped signed build (can sign: %s; fork: %s)",
    (canSign, isFork, status, message) => {
      const script = runOf(
        jobs.get("gate-ios-phone")!,
        "✅ Verify build result",
      );
      const result = spawnSync("bash", ["-eo", "pipefail", "-c", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          RESULT: "skipped",
          BUILD_RESULT: "",
          SKIP_CI: "false",
          IS_FORK_PR: "false",
          CAN_SIGN: canSign,
          IS_FORK_REPO: isFork,
        },
      });
      expect(result.status).toBe(status);
      expect(result.stdout).toContain(message);
    },
  );

  test("a successful fallback upload passes its gate after a repack failure", () => {
    const result = spawnSync(
      "bash",
      [
        "-eo",
        "pipefail",
        "-c",
        runOf(jobs.get("gate-android-phone")!, "✅ Verify build result"),
      ],
      {
        env: {
          ...process.env,
          RESULT: "failure",
          BUILD_RESULT: "success",
          SKIP_CI: "false",
        },
      },
    );
    expect(result.status).toBe(0);
  });

  describe("the build job's artifact name", () => {
    const step = "Resolve artifact names";
    const script = runOf(groupRaw, step);

    test("is resolved before prebuild and used for the binary and its upload", () => {
      const resolveAt = group.indexOf(`- name: ${step}`);
      expect(resolveAt).toBeGreaterThan(0);
      expect(resolveAt).toBeLessThan(group.indexOf("- name: Prebuild phone"));
      expect(resolveAt).toBeLessThan(group.indexOf("- name: Prebuild tv"));
      expect(group).toMatch(/^\s*PLAN: \$\{\{ inputs\.plan \}\}$/m);
      expect(group).toMatch(/^\s*RUN_ID: \$\{\{ github\.run_id \}\}$/m);
      expect(group).toMatch(
        /^\s*RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}$/m,
      );
      for (const variant of VARIANTS) {
        expect(group).toContain(
          `artifact-name: \${{ fromJSON(steps.artifacts.outputs.plan).variants['${variant.id}'].name }}`,
        );
      }
      // The group resolves every name once; the action consumes it verbatim.
      expect(buildAction.match(/inputs\.artifact-name/g)).toHaveLength(2);
      expect(buildAction).toMatch(
        /^\s*ARTIFACT_NAME: \$\{\{ inputs\.artifact-name \}\}$/m,
      );
      expect(buildAction).toMatch(
        /^\s*name: \$\{\{ inputs\.artifact-name \}\}$/m,
      );
    });

    // The step as GitHub runs it, with bun standing in for the CLI: `name`
    // exits with HASH_EXIT, and every call is written to a log.
    const resolve = (given: string, hashExit: number) => {
      const dir = mkdtempSync(join(tmpdir(), "resolve-name-"));
      try {
        mkdirSync(join(dir, "bin"));
        writeFileSync(
          join(dir, "bin/bun"),
          [
            "#!/bin/sh",
            'echo "$*" >> "$LOG"',
            'case "$2" in',
            '  name) [ "$HASH_EXIT" = 0 ] && echo "hashed-$3"; exit "$HASH_EXIT" ;;',
            '  fallback-name) echo "fallback-$3-$4-$5" ;;',
            "  *) exit 64 ;;",
            "esac",
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
        const log = join(dir, "log");
        const output = join(dir, "output");
        const result = spawnSync("bash", ["-eo", "pipefail", "-c", script], {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${join(dir, "bin")}:${process.env.PATH}`,
            LOG: log,
            HASH_EXIT: String(hashExit),
            GITHUB_OUTPUT: output,
            PLAN: JSON.stringify({
              phone: true,
              variants: {
                "android-phone-release-device-debugkey": { name: given },
              },
            }),
            RUN_ID: "123",
            RUN_ATTEMPT: "2",
          },
        });
        const read = (path: string) =>
          existsSync(path) ? readFileSync(path, "utf8").trim() : "";
        return {
          code: result.status,
          stdout: result.stdout,
          output: JSON.parse(read(output).slice("plan=".length)).variants[
            "android-phone-release-device-debugkey"
          ].name,
          calls: read(log).split("\n").filter(Boolean),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    test("keeps the name the fingerprint job gave", () => {
      const result = resolve("given-name", 0);
      expect(result.code).toBe(0);
      expect(result.output).toBe("given-name");
      expect(result.calls).toEqual([]);
      expect(result.stdout).not.toContain("::warning::");
    });

    test("hashes once with cli.ts name when the name is empty", () => {
      const result = resolve("", 0);
      expect(result.code).toBe(0);
      expect(result.output).toBe(
        "hashed-android-phone-release-device-debugkey",
      );
      expect(result.calls).toEqual([
        "scripts/build-cache/cli.ts name android-phone-release-device-debugkey",
      ]);
      expect(result.stdout).toContain("::warning::");
    });

    test("falls back to cli.ts fallback-name and warns when hashing fails too", () => {
      const result = resolve("", 2);
      expect(result.code).toBe(0);
      expect(result.output).toBe(
        "fallback-android-phone-release-device-debugkey-123-2",
      );
      expect(result.calls).toEqual([
        "scripts/build-cache/cli.ts name android-phone-release-device-debugkey",
        "scripts/build-cache/cli.ts fallback-name android-phone-release-device-debugkey 123 2",
      ]);
      expect(result.stdout).toMatch(
        /::warning::.*built without a fingerprint and will not be reused/,
      );
    });
  });

  test("no artifact name is hand-written in either workflow outside comments", () => {
    expect(buildApps).not.toContain("streamyfin-");
    expect(nativeVariant).not.toContain("streamyfin-");
    expect(group).not.toContain("streamyfin-");
    expect(buildAction).not.toContain("streamyfin-");
  });

  test("uploads carry each variant's retention days", () => {
    const uploadSteps = nativeVariant
      .split(/\n(?=[ \t]*- name: )/)
      .filter((step) => step.includes("actions/upload-artifact@"));
    expect(uploadSteps).toHaveLength(1);
    for (const step of uploadSteps) {
      expect(step).toMatch(
        /^\s*retention-days:\s*\$\{\{\s*inputs\.retention-days\s*\}\}\s*$/m,
      );
    }
    expect(buildAction).toContain(
      "retention-days: ${{ inputs.retention-days }}",
    );

    for (const variant of VARIANTS) {
      const stepStart = group.indexOf(`variant: ${variant.id}`);
      const stepEnd = group.indexOf("- name: ", stepStart);
      expect(
        group.slice(stepStart, stepEnd < 0 ? undefined : stepEnd),
      ).toContain(`retention-days: ${variant.retentionDays}`);
    }

    for (const variant of VARIANTS.filter((v) => v.mode === "repack")) {
      const [{ body }] = callerByVariant.get(variant.id)!;
      const retention = body.match(/^\s*retention-days:\s*(\d+)\s*$/m)?.[1];
      expect(Number(retention)).toBe(variant.retentionDays);
    }
  });

  test(".app variants build simulator bundles and upload a tar", () => {
    const appVariants = VARIANTS.filter((v) => v.kind === "app");
    expect(appVariants.length).toBe(4);
    for (const variant of appVariants) {
      expect(variant.target).toBe("simulator");
      expect(variantById(variant.id)?.kind).toBe("app");
    }

    expect(buildScript).toMatch(
      /COPYFILE_DISABLE=1 tar -cf "\$tar_path" -C "\$products" "\$app_name"/,
    );
    expect(buildScript).toMatch(/tar_path="\$artifact_dir\/.*\.tar"/);
    expect(buildScript).toContain(
      'echo "artifact_path=$tar_path" >> "$GITHUB_OUTPUT"',
    );
  });

  test("repack artifact names stay distinct in artifact-comment.yml", () => {
    const commentWorkflow = readWorkflow("artifact-comment.yml");
    for (const variant of VARIANTS.filter((v) => v.mode === "repack")) {
      const name = artifactName(variant, "abc123");
      const patternLiteral = `^streamyfin-${variant.id}-r\\d+-fp-`;
      expect(commentWorkflow).toContain(patternLiteral);
      expect(new RegExp(`^streamyfin-${variant.id}-r\\d+-fp-`).test(name)).toBe(
        true,
      );
    }
    const universal = artifactName(
      variantById("android-phone-release-device-debugkey-universal")!,
      "abc123",
    );
    expect(
      /^streamyfin-android-phone-release-device-debugkey-r\d+-fp-/.test(
        universal,
      ),
    ).toBe(false);
  });

  const PERMISSION_LEVEL: Record<string, number> = {
    none: 0,
    read: 1,
    write: 2,
  };

  /** Parses the `permissions:` mapping of a single workflow job block. */
  const permissionsOf = (body: string): Record<string, string> | null => {
    const lines = body.split("\n");
    const start = lines.findIndex((line) => /^ {4}permissions:\s*$/.test(line));
    if (start < 0) return null;
    const perms: Record<string, string> = {};
    for (const line of lines.slice(start + 1)) {
      if (!line.trim()) continue;
      if (line.search(/\S/) <= 4) break;
      const match = line.match(/^\s*([a-z-]+):\s*(read|write|none)\s*$/);
      if (match) perms[match[1]] = match[2];
    }
    return perms;
  };

  /** Extracts every `run:` script body (block or inline) from a workflow. */
  const runBlocksOf = (text: string): string[] => {
    const lines = text.split("\n");
    const blocks: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const blockStart = line.match(/^(\s*)run:\s*[|>][-+]?\s*$/);
      if (blockStart) {
        const indent = blockStart[1].length;
        const body: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j];
          if (next.trim() && next.search(/\S/) <= indent) break;
          body.push(next.slice(indent + 2));
          i = j;
        }
        blocks.push(body.join("\n"));
        continue;
      }
      const inline = line.match(/^\s*run:\s*(.+)$/);
      if (inline) blocks.push(inline[1]);
    }
    return blocks;
  };

  test("every caller job grants at least the permissions requested by _native-variant.yml", () => {
    const calleeJobs = jobsOf(nativeVariant);
    expect(calleeJobs.size).toBeGreaterThan(0);

    const required = new Map<string, string>();
    for (const [, body] of calleeJobs) {
      const perms = permissionsOf(body);
      expect(perms).not.toBeNull();
      for (const [scope, level] of Object.entries(perms!)) {
        const current = required.get(scope);
        if (!current || PERMISSION_LEVEL[level] > PERMISSION_LEVEL[current]) {
          required.set(scope, level);
        }
      }
    }
    expect(required.size).toBeGreaterThan(0);

    for (const [, callerBody] of callers) {
      const callerPerms = permissionsOf(callerBody);
      expect(callerPerms).not.toBeNull();
      for (const [scope, level] of required) {
        expect(
          PERMISSION_LEVEL[callerPerms![scope]] ?? -1,
        ).toBeGreaterThanOrEqual(PERMISSION_LEVEL[level]);
      }
    }
  });

  test("the variant lookup step guards the command substitution", () => {
    const script = withoutComments(buildScript);
    expect(script).not.toMatch(/\beval\s+"\$\(bun\b/);
    expect(script).toMatch(
      /vars=\$\(bun -e '[\s\S]*?' "\$VARIANT"\)\s*\|\|\s*\{\s*echo "::error::[^"]+";\s*exit 1;\s*\}/,
    );
    expect(script).toMatch(/eval "\$vars"/);
    expect(script).toMatch(
      /\[ -n "\$v_os" \]\s*\|\|\s*\{\s*echo "::error::[^"]+";\s*exit 1;\s*\}/,
    );
  });

  test("the build recipe chain covers every os/config/target and ends in an erroring else", () => {
    const script = withoutComments(buildScript);
    const combinations = new Set(
      VARIANTS.map((v) => `${v.os}:${v.config}:${v.target}`),
    );
    for (const combo of combinations) {
      const [os, config, target] = combo.split(":");
      expect(script).toMatch(
        new RegExp(
          `^(?:if|elif)\\s+\\[ "\\$v_os" = "${os}" \\] && \\[ "\\$v_config" = "${config}" \\] && \\[ "\\$v_target" = "${target}" \\]; then$`,
          "m",
        ),
      );
    }
    expect(script.trimEnd()).toMatch(
      /\nelse\n\s+echo "::error::No build recipe for \$VARIANT"\n\s+exit 1\nfi$/,
    );
  });

  test("no run block interpolates inputs directly", () => {
    for (const workflow of [nativeVariant, buildApps, group, buildAction]) {
      const blocks = runBlocksOf(workflow);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block).not.toMatch(/\$\{\{\s*inputs\./);
      }
    }
  });
});
