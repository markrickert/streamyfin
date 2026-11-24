import { readFileSync } from "node:fs";
import { join } from "node:path";

// Compare masks must cover the device chrome and volatile text without hiding the
// rest of a captured screen. Blank detection happens before masks are applied.
describe("phone capture masks", () => {
  it.each(["ios", "android"])(
    "%s hides search carets and shifted Settings version text",
    (platform) => {
      const masks = JSON.parse(
        readFileSync(join(__dirname, `masks-${platform}-phone.json`), "utf8"),
      );
      expect(masks["02-search"].length).toBeGreaterThan(0);
      expect(masks["11-seerr-search"].length).toBeGreaterThan(0);
      const settings = masks["05-settings"][0];
      expect(settings[3]).toBeGreaterThan(0.1);
    },
  );
  it("Android navigation bar cannot drift into a report", () => {
    const masks = JSON.parse(
      readFileSync(join(__dirname, "masks-android-phone.json"), "utf8"),
    );
    expect(masks["*"]).toContainEqual([0, 0.96, 1, 0.04]);
  });
});

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

  // Android TV's result cards carry no title label and TMDB orders them live, so the
  // flow focuses the 1931 card with the D-pad: Right while the focused card is leftOf
  // the "1931" year (the year text is inset in its own card), then one Left. The
  // keyboard must be closed first, or it hides the results.
  it("seerr-tv.yml focuses the 1931 result by the D-pad on Android TV only", () => {
    const cmds = commandsOf("seerr-tv.yml");
    const androidSearch = cmds.find(
      (cmd) =>
        cmd.runFlow?.when?.true?.includes("!= '1'") &&
        cmd.runFlow.commands.some((c: Command) => c.inputText),
    );
    expect(androidSearch?.runFlow.commands).toContainEqual("hideKeyboard");
    const androidPick = cmds.find(
      (cmd) =>
        cmd.runFlow?.when?.notVisible?.id === poster.id &&
        cmd.runFlow.when.true?.includes("!= '1'"),
    );
    const picks = androidPick?.runFlow.commands as Command[];
    expect(picks.find((c) => c.repeat)?.repeat.while.visible).toEqual({
      focused: true,
      leftOf: "1931",
    });
    expect(picks.slice(-1)).toEqual([{ pressKey: "Remote Dpad Center" }]);
    expect(JSON.stringify(picks)).not.toContain("tapOn");
    const appleFallback = cmds.find(
      (cmd) =>
        cmd.runFlow?.when?.notVisible?.id === poster.id &&
        cmd.runFlow.when.true?.includes("== '1'"),
    );
    expect(appleFallback?.runFlow.commands).toEqual([
      { tapOn: ".*Iron Man, 1931" },
    ]);
  });

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
  ])(
    "%s runs its flows in the order the capture state needs",
    (file, flows) => {
      const cmds = commandsOf(file);
      expect(cmds.map((cmd) => cmd.runFlow)).toEqual(flows);
    },
  );

  // tv.yml and seerr-tv.yml drive Android TV with taps, which XCTest silently drops
  // on tvOS, so the pass gates D-pad twins for Apple TV instead of making the
  // Android flows platform-aware.
  it("pass-tv.yml gates tv-apple and seerr-apple on tvOS", () => {
    const cmds = commandsOf("pass-tv.yml");
    expect(cmds[0].runFlow).toBe("bootstrap-login-tv.yml");
    expect(cmds[1].runFlow).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Maestro's own placeholder, read verbatim from the YAML
      when: { true: "${MAESTRO_TVOS == '1'}" },
      commands: [{ runFlow: "tv-apple.yml" }],
    });
    expect(cmds[2].runFlow).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Maestro's own placeholder, read verbatim from the YAML
      when: { true: "${MAESTRO_TVOS != '1'}" },
      commands: [{ runFlow: "tv.yml" }],
    });
    expect(cmds[3].runFlow).toBe("bootstrap-seerr-tv.yml");
    expect(cmds[4].runFlow).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Maestro's own placeholder, read verbatim from the YAML
      when: { true: "${MAESTRO_TVOS == '1'}" },
      commands: [{ runFlow: "seerr-apple.yml" }],
    });
    expect(cmds[5].runFlow).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Maestro's own placeholder, read verbatim from the YAML
      when: { true: "${MAESTRO_TVOS != '1'}" },
      commands: [{ runFlow: "seerr-tv.yml" }],
    });
    expect(cmds).toHaveLength(6);
  });

  // Relaunching on tvOS can resume a stale tab focus, so each tv-apple section
  // resets to the Home tab before its counted Right presses.
  it("tv-apple.yml normalizes to the Home tab after every launchApp", () => {
    const cmds = commandsOf("tv-apple.yml");
    const launches = cmds.flatMap((cmd, index) =>
      String(cmd) === "launchApp" ? [index] : [],
    );
    const normalizations = cmds.flatMap((cmd, index) =>
      cmd.runFlow === "_focus-home-tab.yml" ? [index] : [],
    );
    expect(launches).toHaveLength(3);
    expect(normalizations).toHaveLength(launches.length);
    for (const [i, launch] of launches.entries()) {
      const normalized = normalizations[i];
      const end = launches[i + 1] ?? cmds.length;
      const firstRight = cmds.findIndex(
        (cmd, index) =>
          index > launch && index < end && cmd.pressKey === "Remote Dpad Right",
      );
      expect(normalized).toBeGreaterThan(launch);
      expect(normalized).toBeLessThan(firstRight);
    }
  });

  // Hosted tvOS showed the Movies-row Center landing while focus had returned to
  // the Library tab, so the flow retries the row select only when that state is
  // observed — never blindly, since Center on a poster would start playback.
  it("tv-apple.yml retries the Movies row Center only when focus bounced to the Library tab", () => {
    const cmds = commandsOf("tv-apple.yml");
    const moviesRow = cmds.findIndex(
      (cmd) =>
        cmd.assertVisible?.text === ".*Movies.*" &&
        cmd.assertVisible?.focused === true,
    );
    expect(moviesRow).toBeGreaterThanOrEqual(0);
    expect(cmds[moviesRow + 1].pressKey).toBe("Remote Dpad Center");
    expect(cmds[moviesRow + 2].extendedWaitUntil).toEqual({
      visible: "__settle__",
      timeout: 1500,
      optional: true,
    });
    expect(cmds[moviesRow + 3].runFlow).toEqual({
      when: { visible: { text: "Library", focused: true } },
      commands: [
        { pressKey: "Remote Dpad Down" },
        { assertVisible: { text: ".*Movies.*", focused: true } },
        { pressKey: "Remote Dpad Center" },
      ],
    });
    expect(cmds[moviesRow + 4].extendedWaitUntil).toEqual({
      visible: ".*Filters.*",
      timeout: 15000,
    });
  });

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
    ["tv-apple.yml", ["08-library-filters", "09-series-details"]],
    [
      "seerr-apple.yml",
      ["10-seerr-discover", "11-seerr-search", "12-seerr-detail"],
    ],
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
        .find(
          (command) =>
            command.runFlow.when.platform === "Android" &&
            command.runFlow.commands.at(-1)?.extendedWaitUntil,
        )
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

  // On Android TV, TVPosterCard renders the title TextView outside its unlabeled
  // Pressable, so neither the title nor `above:` reaches the card (`above:` picked the
  // focused toolbar button). Focus the card with the D-pad, leaving Apple TV's tap.
  it("tv.yml focuses the Show card with the D-pad on Android TV without changing Apple TV", () => {
    const cmds = commandsOf("tv.yml");
    const branches = cmds.filter((cmd) =>
      String(cmd.runFlow?.when?.true ?? "").includes("MAESTRO_TVOS"),
    );
    expect(branches).toHaveLength(2);
    const androidTv = branches.find((cmd) =>
      cmd.runFlow.when.true.includes("!= '1'"),
    );
    const appleTv = branches.find((cmd) =>
      cmd.runFlow.when.true.includes("== '1'"),
    );
    const androidCmds = androidTv?.runFlow.commands as Command[];
    expect(androidCmds[0]).toEqual({ pressKey: "Remote Dpad Down" });
    const moveRight = androidCmds.find((cmd) => cmd.repeat)?.repeat;
    expect(moveRight.while.notVisible).toEqual({
      focused: true,
      above: "^(.*, )?Show(,.*)?$",
      rightOf: "Rocky Jones, Space Ranger",
    });
    expect(moveRight.commands[0]).toEqual({ pressKey: "Remote Dpad Right" });
    expect(androidCmds.at(-1)).toEqual({ pressKey: "Remote Dpad Center" });
    expect(JSON.stringify(androidCmds)).not.toContain("tapOn");
    expect(appleTv?.runFlow.commands).toEqual([
      { tapOn: "^(.*, )?Show(,.*)?$" },
    ]);
  });

  it("waits for rendered Home content after every relaunch in mobile.yml instead of the racy Home label", () => {
    const cmds = commandsOf("mobile.yml");
    const relaunches = cmds
      .map((cmd, index) => ({ cmd, index }))
      .filter(({ cmd }) => String(cmd) === "launchApp");
    expect(relaunches.length).toBeGreaterThan(1);
    for (const { index } of relaunches.slice(1)) {
      expect(cmds[index + 1].extendedWaitUntil?.visible).toBe(
        ".*Recently added.*",
      );
    }
  });

  // The bootstrap's Search tab is the same inert-tapOn case as the login's done
  // key: tvOS must focus it (which selects the tab), Android TV keeps tapOn.
  it("bootstrap-seerr-tv selects Search by D-pad on tvOS and tapOn on Android", () => {
    const cmds = commandsOf("bootstrap-seerr-tv.yml");
    const branches = cmds.filter((cmd) =>
      cmd.runFlow?.when?.true?.includes("MAESTRO_TVOS"),
    );
    const tvos = branches.find((cmd) =>
      cmd.runFlow.when.true.includes("== '1'"),
    );
    const android = branches.find((cmd) =>
      cmd.runFlow.when.true.includes("!= '1'"),
    );
    expect(tvos?.runFlow.commands).toEqual([
      { runFlow: "_focus-home-tab.yml" },
      { pressKey: "Remote Dpad Right" },
      { assertVisible: { text: "Search", focused: true } },
    ]);
    expect(android?.runFlow.commands).toEqual([{ tapOn: "Search" }]);
    expect(
      cmds.some((cmd) => cmd.extendedWaitUntil?.visible === "Discover"),
    ).toBe(true);
  });

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

  // The ANR step runs first so an Android system dialog never blocks the dev overlays,
  // then the picker step opens the runner's link, and the open-in alert branches on
  // tvOS (where PineBoard focuses Open and ignores tapOn).
  it("dismisses Android ANRs, reconnects from the server picker, accepts open-in per platform, then dismisses onboarding and dev menu", () => {
    const cmds = commandsOf("_dismiss-dev-overlays.yml");
    expect(cmds).toHaveLength(6);
    expect(cmds[0].runFlow.when.visible).toBe(".*isn't responding.*");
    expect(cmds[0].runFlow.commands).toEqual([
      { tapOn: "Wait" },
      "waitForAnimationToEnd",
    ]);
    expect(cmds[1].runFlow.when.visible).toBe(
      "Fetch development servers|Searching for development servers.*",
    );
    const picker = new RegExp(cmds[1].runFlow.when.visible);
    expect(picker.test("Fetch development servers")).toBe(true);
    expect(picker.test("Searching for development servers...")).toBe(true);
    expect(picker.test("Home")).toBe(false);
    expect(cmds[1].runFlow.commands).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Maestro's own placeholder, read verbatim from the YAML
      { openLink: "${MAESTRO_DEV_CLIENT_URL}" },
      "waitForAnimationToEnd",
    ]);
    expect(cmds[2].runFlow.when).toEqual({
      visible: "Open in .*",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Maestro's own placeholder, read verbatim from the YAML
      true: "${MAESTRO_TVOS != '1'}",
    });
    expect(cmds[2].runFlow.commands).toEqual([
      { tapOn: "Open" },
      "waitForAnimationToEnd",
    ]);
    expect(cmds[3].runFlow.when).toEqual({
      visible: "Open in .*",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Maestro's own placeholder, read verbatim from the YAML
      true: "${MAESTRO_TVOS == '1'}",
    });
    expect(cmds[3].runFlow.commands).toEqual([
      { pressKey: "Remote Dpad Center" },
      "waitForAnimationToEnd",
    ]);
    expect(cmds[4].runFlow.when.visible).toBe("Continue");
    expect(cmds[4].runFlow.commands).toEqual([
      { tapOn: "Continue" },
      "waitForAnimationToEnd",
    ]);
    expect(cmds[5].runFlow.when.visible).toBe("Go home");
    expect(cmds[5].runFlow.commands).toEqual([
      { extendedWaitUntil: { visible: "Close", timeout: 10000 } },
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

  it("bootstrap-login-tv finds the server button with or without its icon in the label", () => {
    // The tvOS hierarchy exposes the focused button as an icon glyph plus "Add server".
    const cmds = commandsOf("bootstrap-login-tv.yml");
    const selector = cmds[3].extendedWaitUntil.visible;
    expect(new RegExp(`^(?:${selector})$`).test("\uf103, Add server")).toBe(
      true,
    );
    expect(new RegExp(`^(?:${selector})$`).test("Add server")).toBe(true);
  });

  it("bootstrap-login-tv commits the tvOS password on its done key and presses Log in by D-pad", () => {
    // tvOS tapOn misreports success on the keyboard's done and on the Log in button,
    // so the flow walks the D-pad for both; keyed off the password input, not
    // hardcoded positions.
    const cmds = commandsOf("bootstrap-login-tv.yml");
    const password = cmds.findIndex(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Maestro's own placeholder, read verbatim from the YAML
      (cmd) => cmd.inputText === "${MAESTRO_JELLYFIN_PASS}",
    );
    expect(password).toBeGreaterThanOrEqual(0);
    const branches = cmds
      .slice(password + 1)
      .filter((cmd) => cmd.runFlow?.when?.true?.includes("MAESTRO_TVOS"));
    const tvos = branches.filter((cmd) =>
      cmd.runFlow.when.true.includes("== '1'"),
    );
    const android = branches.filter((cmd) =>
      cmd.runFlow.when.true.includes("!= '1'"),
    );
    expect(tvos[0]?.runFlow.commands).toEqual([
      { pressKey: "Remote Dpad Down" },
      { pressKey: "Remote Dpad Down" },
      { pressKey: "Remote Dpad Down" },
      { pressKey: "Remote Dpad Center" },
      { assertNotVisible: "Keyboard" },
    ]);
    expect(android[0]?.runFlow.commands).toEqual([{ pressKey: "Enter" }]);
    expect(tvos[1]?.runFlow.commands).toEqual([
      { pressKey: "Remote Dpad Down" },
      { pressKey: "Remote Dpad Down" },
      { pressKey: "Remote Dpad Center" },
    ]);
    expect(android[1]?.runFlow.commands).toEqual([{ tapOn: "Log in" }]);
  });
});
