import { readFileSync } from "node:fs";
import { join } from "node:path";

// js-yaml ships no types; keep the require (typed) rather than adding @types/js-yaml
// for one test block.
const { loadAll: loadAllYaml } = require("js-yaml") as {
  loadAll: (src: string) => unknown[];
};

// The flows are data, not code: parse the real YAML so a future flow edit that drops
// the permission grant or reorders the overlay dismissal fails here, not on device.
describe("Seerr detail tap on refs with and without the poster testID", () => {
  type Command = Record<string, any>;
  const commandsOf = (file: string): Command[] =>
    loadAllYaml(
      readFileSync(join(__dirname, "flows", file), "utf8"),
    )[1] as Command[];
  const poster = { id: "seerr-poster-194310" };

  // The two branches are separate checks, run one after the other. With the testID
  // branch first, its tap opens the detail page, where the poster is gone, so the
  // fallback ran there too and failed to find the movies row.
  it.each(["seerr-mobile.yml", "seerr-tv.yml"])(
    "%s runs the title fallback before the testID branch, so only one of them taps",
    (file) => {
      const cmds = commandsOf(file);
      const fallback = cmds.findIndex(
        (cmd) => cmd.runFlow?.when?.notVisible?.id === poster.id,
      );
      const byTestId = cmds.findIndex(
        (cmd) => cmd.runFlow?.when?.visible?.id === poster.id,
      );
      expect(fallback).toBeGreaterThanOrEqual(0);
      expect(byTestId).toBeGreaterThanOrEqual(0);
      expect(fallback).toBeLessThan(byTestId);
    },
  );
});

describe("capture pass parents", () => {
  type Command = Record<string, any>;
  const commandsOf = (file: string): Command[] =>
    loadAllYaml(
      readFileSync(join(__dirname, "flows", file), "utf8"),
    )[1] as Command[];

  // runCapture invokes exactly one parent per pass, so the order below is the only
  // thing sequencing the flows — login first on the freshly-reset app, and the Seerr
  // flows last because their screens only exist once the bootstrap connected.
  it.each<[string, string[]]>([
    [
      "pass-mobile.yml",
      [
        "bootstrap-login-mobile.yml",
        "mobile.yml",
        "ensure-seerr-mobile.yml",
        "seerr-mobile.yml",
      ],
    ],
    [
      "pass-tv.yml",
      [
        "bootstrap-login-tv.yml",
        "tv.yml",
        "bootstrap-seerr-tv.yml",
        "seerr-tv.yml",
      ],
    ],
  ])(
    "%s runs its flows in the order the capture state needs",
    (file, flows) => {
      const cmds = commandsOf(file);
      expect(cmds.map((cmd) => cmd.runFlow)).toEqual(flows);
    },
  );

  // Names are the before/noise/after pairing key: a flow that captures one of the new
  // shots twice, or not at all, silently un-pairs a screen. Screenshots nested under
  // runFlow/repeat guards count too.
  const screenshotNames = (cmds: Command[]): string[] =>
    cmds.flatMap((cmd) => [
      ...(cmd.takeScreenshot ? [cmd.takeScreenshot] : []),
      ...screenshotNames(
        (cmd.runFlow?.commands ?? cmd.repeat?.commands ?? []) as Command[],
      ),
    ]);

  it.each<[string, string[]]>([
    ["bootstrap-login-mobile.yml", ["00-login-connected"]],
    ["ensure-seerr-mobile.yml", ["13-seerr-settings"]],
    ["mobile.yml", ["14-library-filter-sheet", "15-series-details"]],
    ["tv.yml", ["08-library-filters", "09-series-details"]],
  ])("%s captures each of %s exactly once", (file, names) => {
    const shots = screenshotNames(commandsOf(file));
    for (const name of names)
      expect(shots.filter((shot) => shot === name)).toHaveLength(1);
  });

  // The Seerr bootstrap runs only when Discover is missing, so a shot taken there is
  // absent from every pass where the plugin-pushed sign-in already connected.
  it("bootstrap-seerr-mobile.yml takes no screenshots: it only runs conditionally", () => {
    expect(
      screenshotNames(commandsOf("bootstrap-seerr-mobile.yml")),
    ).toHaveLength(0);
  });

  it("does not send Android Back after connecting on the login screen", () => {
    const commands = commandsOf("bootstrap-login-mobile.yml");
    const shot = commands.findIndex(
      (command) => command.takeScreenshot === "00-login-connected",
    );
    expect(commands[shot - 2].runFlow.when).toEqual({ platform: "iOS" });
    expect(commands[shot - 2].runFlow.commands).toEqual([
      { hideKeyboard: { optional: true } },
    ]);
  });

  it("waits for the iOS sheet container instead of its inaccessible option count", () => {
    const branches = commandsOf("mobile.yml").filter(
      (command) => command.runFlow?.when?.platform,
    );
    expect(
      branches
        .find((command) => command.runFlow.when.platform === "iOS")
        ?.runFlow.commands.at(-1)?.extendedWaitUntil?.visible,
    ).toBe("Bottom Sheet");
    expect(
      branches
        .find((command) => command.runFlow.when.platform === "Android")
        ?.runFlow.commands.at(-1)?.extendedWaitUntil?.visible,
    ).toBe(".* items");
  });

  it.each(["mobile.yml", "tv.yml"])(
    "%s selects the seeded series even when its unplayed badge joins the label",
    (file) => {
      const selector = commandsOf(file).find((command) =>
        command.scrollUntilVisible?.element?.includes("Show"),
      )?.scrollUntilVisible.element;
      const card = new RegExp(selector);
      expect(card.test("Show")).toBe(true);
      expect(card.test("2, Show")).toBe(true);
      expect(card.test("Show, 2026")).toBe(true);
      expect(card.test("Shows")).toBe(false);
    },
  );

  it("the parents take no screenshots themselves", () => {
    for (const file of ["pass-mobile.yml", "pass-tv.yml"])
      expect(screenshotNames(commandsOf(file))).toHaveLength(0);
  });
});

describe("bootstrap-login first-run overlays", () => {
  type Command = Record<string, any>;
  const commandsOf = (file: string): Command[] =>
    loadAllYaml(
      readFileSync(join(__dirname, "flows", file), "utf8"),
    )[1] as Command[];

  // The picker step comes first: the link it opens raises the iOS "Open in" prompt,
  // which the next step accepts.
  it("reconnects from the server picker, accepts the open-in prompt, then dismisses the onboarding sheet and dev menu in order", () => {
    const cmds = commandsOf("_dismiss-dev-overlays.yml");
    expect(cmds).toHaveLength(4);
    expect(cmds[0].runFlow.when.visible).toBe("Fetch development servers");
    expect(cmds[0].runFlow.commands).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Maestro's own placeholder, read verbatim from the YAML
      { openLink: "${MAESTRO_DEV_CLIENT_URL}" },
      "waitForAnimationToEnd",
    ]);
    expect(cmds[1].runFlow.when.visible).toBe("Open in .*");
    expect(cmds[1].runFlow.commands).toEqual([
      { tapOn: "Open" },
      "waitForAnimationToEnd",
    ]);
    expect(cmds[2].runFlow.when.visible).toBe("Continue");
    expect(cmds[2].runFlow.commands).toEqual([
      { tapOn: "Continue" },
      "waitForAnimationToEnd",
    ]);
    expect(cmds[3].runFlow.when.visible).toBe("Go home");
    expect(cmds[3].runFlow.commands).toEqual([
      { tapOn: "Close" },
      "waitForAnimationToEnd",
    ]);
  });

  it("bootstrap-login-mobile grants notifications and keeps dismissing overlays until the login field is reachable", () => {
    const cmds = commandsOf("bootstrap-login-mobile.yml");
    expect(cmds[0].launchApp).toEqual({
      stopApp: false,
      permissions: { notifications: "allow" },
    });
    expect(cmds[1].repeat.while).toEqual({
      notVisible: { id: "login-server-url" },
    });
    expect(cmds[1].repeat.commands[0].runFlow).toBe(
      "_dismiss-dev-overlays.yml",
    );
    expect(cmds[2].assertVisible).toEqual({ id: "login-server-url" });
  });

  it("bootstrap-login-tv grants notifications except on tvOS, then dismisses overlays", () => {
    const cmds = commandsOf("bootstrap-login-tv.yml");
    expect(cmds[0].runFlow.commands).toEqual([
      {
        launchApp: {
          stopApp: false,
          permissions: { notifications: "allow" },
        },
      },
    ]);
    expect(cmds[1].runFlow.commands).toEqual(["launchApp"]);
    expect(cmds[2].runFlow).toBe("_dismiss-dev-overlays.yml");
  });
});
