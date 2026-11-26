import { describeFailedStep, failedStep } from "./failure";
import { Fake, REPO } from "./testing";

const OUT = `${REPO}/e2e/reports/shots/session/before`;
const FLOW_DIR = `${OUT}/pass-mobile`;

/** A container command: runFlow or retry; `sourceDescription` is absent on an inline `runFlow: {when: ...}` and always on `retry`. */
const container = (
  name: string,
  seq: number,
  depth: number,
  sourceDescription?: string,
  status = "FAILED",
) => ({
  command: {
    [name]: {
      ...(sourceDescription === undefined ? {} : { sourceDescription }),
    },
  },
  metadata: { status, sequenceNumber: seq, depth },
});

/** A runFlowCommand entry; `sourceDescription` is absent on an inline `runFlow: {when: ...}`. */
const runFlow = (
  seq: number,
  depth: number,
  sourceDescription?: string,
  status = "FAILED",
) => container("runFlowCommand", seq, depth, sourceDescription, status);

const leaf = (
  name: string,
  seq: number,
  depth: number,
  {
    status = "FAILED",
    message,
    artifacts,
  }: {
    status?: string;
    message?: string;
    artifacts?: { type: string; path: string }[];
  } = {},
) => ({
  command: { [name]: { selector: { textRegex: ".*Settings.*" } } },
  metadata: {
    status,
    sequenceNumber: seq,
    depth,
    ...(message === undefined ? {} : { error: { message } }),
    ...(artifacts === undefined ? {} : { artifacts }),
  },
});

function commands(f: Fake, entries: unknown[], dir = FLOW_DIR) {
  f.dirs.add(OUT);
  f.dirs.add(dir);
  f.files.set(`${dir}/commands.json`, JSON.stringify(entries));
}

describe("failedStep", () => {
  it("names the file-runFlow chain of the deepest failed command, with absolute artifacts", () => {
    const f = new Fake();
    commands(f, [
      runFlow(10, 0, "mobile.yml"),
      runFlow(20, 1, "_tap-more.yml"),
      leaf("tapOnElement", 30, 2, {
        message: "Element not found: Text matching regex: .*Settings.*",
        artifacts: [
          {
            type: "SCREEN_HIERARCHY",
            path: "screen-hierarchy/step-030-tapOnElement-Settings.json",
          },
          {
            type: "SCREENSHOT",
            path: "screenshots/step-030-tapOnElement-Settings.png",
          },
        ],
      }),
      leaf("assertVisible", 40, 2, { status: "SKIPPED" }),
    ]);
    // Parent runFlow entries are FAILED too; the step is the failed non-runFlow leaf.
    expect(failedStep(f, OUT)).toEqual({
      flows: ["mobile.yml", "_tap-more.yml"],
      command: "tapOnElement",
      message: "Element not found: Text matching regex: .*Settings.*",
      screenshot: `${FLOW_DIR}/screenshots/step-030-tapOnElement-Settings.png`,
      hierarchy: `${FLOW_DIR}/screen-hierarchy/step-030-tapOnElement-Settings.json`,
    });
  });

  it("picks the last failed leaf and skips an inline runFlow in the chain", () => {
    const f = new Fake();
    commands(f, [
      runFlow(10, 0, "mobile.yml"),
      leaf("tapOnElement", 20, 1, { message: "first failure" }),
      // `runFlow: {when: ..., commands: ...}` carries no file name: its child still
      // belongs to mobile.yml, but nothing is added to the chain for it.
      runFlow(30, 1, undefined),
      leaf("assertVisible", 40, 2, { message: "inside the inline runFlow" }),
    ]);
    expect(failedStep(f, OUT)).toMatchObject({
      flows: ["mobile.yml"],
      command: "assertVisible",
      message: "inside the inline runFlow",
    });
  });

  it("treats retryCommand as a container: never the leaf, no chain entry", () => {
    const f = new Fake();
    commands(f, [
      runFlow(10, 0, "mobile.yml"),
      runFlow(20, 1, "_relaunch-home.yml"),
      // The retry wraps the commands that failed; it fails too but holds no name
      // and must not shadow the deeper leaf that came after it.
      container("retryCommand", 30, 2),
      leaf("assertConditionCommand", 40, 3, {
        message: "Assertion is false",
        artifacts: [
          {
            type: "SCREENSHOT",
            path: "screenshots/step-041-assert.png",
          },
        ],
      }),
    ]);
    expect(failedStep(f, OUT)).toMatchObject({
      flows: ["mobile.yml", "_relaunch-home.yml"],
      command: "assertConditionCommand",
      screenshot: `${FLOW_DIR}/screenshots/step-041-assert.png`,
    });
  });

  it("returns undefined when the pass left no commands.json", () => {
    const f = new Fake();
    expect(failedStep(f, OUT)).toBeUndefined();
  });

  it("returns undefined when no command failed", () => {
    const f = new Fake();
    commands(f, [
      runFlow(10, 0, "mobile.yml", "COMPLETED"),
      leaf("tapOnElement", 20, 1, { status: "COMPLETED" }),
    ]);
    expect(failedStep(f, OUT)).toBeUndefined();
  });

  it("returns undefined for an unparseable commands.json", () => {
    const f = new Fake();
    f.dirs.add(OUT);
    f.dirs.add(FLOW_DIR);
    f.files.set(`${FLOW_DIR}/commands.json`, "not json {");
    expect(failedStep(f, OUT)).toBeUndefined();
  });
});

describe("describeFailedStep", () => {
  it("renders chain, command, message and artifact paths relative to the session", () => {
    const sessionDir = `${REPO}/e2e/reports/shots/session`;
    expect(
      describeFailedStep(
        {
          flows: ["mobile.yml", "_tap-more.yml"],
          command: "tapOnElement",
          message: "Element not found: Text matching regex: .*Settings.*",
          screenshot: `${FLOW_DIR}/screenshots/step-030-tapOnElement-Settings.png`,
          hierarchy: `${FLOW_DIR}/screen-hierarchy/step-030-tapOnElement-Settings.json`,
        },
        sessionDir,
      ),
    ).toBe(
      "mobile.yml > _tap-more.yml: tapOnElement: Element not found: Text matching regex: .*Settings.* " +
        "(screenshot before/pass-mobile/screenshots/step-030-tapOnElement-Settings.png, " +
        "hierarchy before/pass-mobile/screen-hierarchy/step-030-tapOnElement-Settings.json)",
    );
  });

  it("omits the chain and artifact bracket when a step has neither", () => {
    expect(
      describeFailedStep(
        { flows: [], command: "launchApp", message: "app died" },
        OUT,
      ),
    ).toBe("launchApp: app died");
  });
});
