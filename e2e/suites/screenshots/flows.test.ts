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
  // unified TV Seerr flow hides the Android keyboard and focuses the 1931 card with
  // the D-pad on both TV platforms: Right while the focused card is leftOf the "1931"
  // year (the year text is inset in its own card), then one Left.
  it("seerr-tv.yml hides the Android keyboard and focuses the 1931 result by the D-pad", () => {
    const cmds = commandsOf("seerr-tv.yml");
    const hideKbd = cmds.find(
      (cmd) =>
        cmd.runFlow?.when?.true?.includes("!= '1'") &&
        cmd.runFlow.commands.includes("hideKeyboard"),
    );
    expect(hideKbd).toBeDefined();
    const shot = cmds.findIndex(
      (cmd) => cmd.takeScreenshot === "11-seerr-search",
    );
    expect(shot).toBeGreaterThanOrEqual(0);
    expect(cmds[shot + 1]).toEqual({ runFlow: "_focus-seerr-1931.yml" });
    const picks = commandsOf("_focus-seerr-1931.yml");
    expect(
      picks.find((c) => c.repeat?.while?.visible)?.repeat.while.visible,
    ).toEqual({
      focused: true,
      below: "Request movies",
      leftOf: "1931",
    });
    expect(picks.slice(-1)).toEqual([{ pressKey: "Remote Dpad Center" }]);
    expect(JSON.stringify(picks)).not.toContain("tapOn");
  });

  // The two branches are separate checks, run one after the other. With the testID
  // branch first, its tap opens the detail page, where the poster is gone, so the
  // fallback ran there too and failed to find the movies row.
  it("seerr-mobile.yml runs the title fallback before the testID branch, so only one of them taps", () => {
    const cmds = commandsOf("seerr-mobile.yml");
    const fallback = cmds.findIndex(
      (cmd) => cmd.runFlow?.when?.notVisible?.id === poster.id,
    );
    const byTestId = cmds.findIndex(
      (cmd) => cmd.runFlow?.when?.visible?.id === poster.id,
    );
    expect(fallback).toBeGreaterThanOrEqual(0);
    expect(byTestId).toBeGreaterThanOrEqual(0);
    expect(fallback).toBeLessThan(byTestId);
  });

  it("seerr-tv.yml uses the guarded 1931 card path on both TV platforms", () => {
    const tv = commandsOf("seerr-tv.yml");
    const shot = tv.findIndex(
      (cmd) => cmd.takeScreenshot === "11-seerr-search",
    );
    expect(shot).toBeGreaterThanOrEqual(0);
    expect(tv[shot + 1]).toEqual({ runFlow: "_focus-seerr-1931.yml" });
    const pick = commandsOf("_focus-seerr-1931.yml");
    const firstCard = {
      focused: true,
      below: "Request movies",
      above: "1931",
    };
    expect(pick[0].repeat.while.notVisible).toEqual(firstCard);
    expect(pick[1].assertVisible).toEqual(firstCard);
    expect(pick[2].repeat.while.visible).toEqual({
      focused: true,
      below: "Request movies",
      leftOf: "1931",
    });
    expect(pick[3].assertVisible).toEqual({ ...firstCard, rightOf: "1931" });
    expect(pick.slice(4)).toEqual([
      { pressKey: "Remote Dpad Left" },
      { assertVisible: { ...firstCard, leftOf: "1931" } },
      { pressKey: "Remote Dpad Center" },
    ]);
  });

  it("seerr-tv.yml proves the 1931 detail before capturing it", () => {
    const cmds = commandsOf("seerr-tv.yml");
    const shot = cmds.findIndex((c) => c.takeScreenshot === "12-seerr-detail");
    expect(shot).toBeGreaterThanOrEqual(0);
    expect(cmds.slice(shot - 3, shot)).toEqual([
      { extendedWaitUntil: { visible: "Request", timeout: 30000 } },
      { assertVisible: "1931" },
      {
        extendedWaitUntil: {
          visible: "__settle__",
          timeout: 6000,
          optional: true,
        },
      },
    ]);
  });
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

  // Relaunching on tvOS can resume a stale tab focus, so each tv.yml section
  // resets to the Home tab before its counted Right presses.
  it("tv.yml normalizes to the Home tab after every launchApp", () => {
    const cmds = commandsOf("tv.yml");
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

  // Hosted tvOS returned to Expo's server picker on a mid-flow relaunch; the
  // guarded helper reopens the dev-client link before Home is asserted.
  it.each(["tv.yml", "seerr-tv.yml", "bootstrap-seerr-tv.yml"])(
    "%s reconnects dev client on every launch before waiting for Home",
    (file) => {
      const cmds = commandsOf(file);
      const launches = cmds.flatMap((cmd, index) =>
        String(cmd) === "launchApp" ? [index] : [],
      );
      expect(launches.length).toBeGreaterThan(0);
      for (const launch of launches) {
        expect(cmds[launch + 1]).toEqual({
          runFlow: "_dismiss-dev-overlays.yml",
        });
        expect(cmds[launch + 2].extendedWaitUntil.timeout).toBe(60000);
        expect(cmds[launch + 2].extendedWaitUntil.visible).toContain(
          ".*Recently added.*",
        );
      }
    },
  );

  // A disabled Play all cannot hold tvOS focus while the movie grid loads, whereas
  // Android TV can focus Play all or Letters once loaded; walking Right until
  // Filters is focused handles both, and Center is only ever pressed on Filters.
  it("tv.yml walks the Movies toolbar to Filters before pressing Center", () => {
    const cmds = commandsOf("tv.yml");
    const shot = cmds.findIndex(
      (cmd) => cmd.takeScreenshot === "06-library-movies",
    );
    expect(shot).toBeGreaterThanOrEqual(0);
    expect(cmds[shot - 1].extendedWaitUntil).toEqual({
      visible: "The Blacksmith.*",
      timeout: 60000,
    });
    // Android TV leaves focus on the tab bar after Center opens the page, so Right
    // would walk the tabs: Down enters the toolbar first, and only when a tab holds
    // focus (tvOS draws no tv-nav-* item).
    expect(cmds[shot + 1].runFlow.when.visible).toEqual({
      id: "tv-nav-.*",
      focused: true,
    });
    expect(cmds[shot + 1].runFlow.commands[0]).toEqual({
      pressKey: "Remote Dpad Down",
    });
    expect(cmds[shot + 2].repeat.while.notVisible).toEqual({
      text: ".*Filters.*",
      focused: true,
    });
    expect(cmds[shot + 2].repeat.commands[0]).toEqual({
      pressKey: "Remote Dpad Right",
    });
    expect(cmds[shot + 3].assertVisible).toEqual({
      text: ".*Filters.*",
      focused: true,
    });
    expect(cmds[shot + 4]).toEqual({ pressKey: "Remote Dpad Center" });
  });

  // Hosted tvOS left focus on the Filters toolbar after the Rights, and the
  // poster card is unlabeled, so the geometric assert must also be below
  // Filters before the only Center may press a Show (docs/tv-focus-guide.md).
  it("tv.yml enters the Shows poster grid before selecting the seeded Show", () => {
    const cmds = commandsOf("tv.yml");
    const showRow = cmds.findIndex(
      (cmd) =>
        cmd.assertVisible?.text === ".*Shows.*" &&
        cmd.assertVisible?.focused === true,
    );
    expect(showRow).toBeGreaterThanOrEqual(0);
    expect(cmds[showRow + 1]).toEqual({ pressKey: "Remote Dpad Center" });
    expect(cmds[showRow + 2].extendedWaitUntil).toEqual({
      visible: ".*Filters.*",
      timeout: 15000,
    });
    expect(cmds[showRow + 3].extendedWaitUntil).toEqual({
      visible: "^(.*, )?Show(,.*)?$",
      timeout: 60000,
    });
    expect(cmds[showRow + 4]).toEqual({ pressKey: "Remote Dpad Down" });
    expect(cmds[showRow + 5].repeat.while.notVisible).toEqual({
      focused: true,
      above: "^(.*, )?Show(,.*)?$",
      rightOf: "Rocky Jones, Space Ranger",
      below: ".*Filters.*",
    });
    expect(cmds[showRow + 5].repeat.commands[0]).toEqual({
      pressKey: "Remote Dpad Right",
    });
    expect(cmds[showRow + 6].runFlow).toEqual({
      when: { visible: { text: ".*Filters.*", focused: true } },
      commands: [{ pressKey: "Remote Dpad Down" }],
    });
    expect(cmds[showRow + 7].assertVisible).toEqual({
      focused: true,
      above: "^(.*, )?Show(,.*)?$",
      rightOf: "Rocky Jones, Space Ranger",
      below: ".*Filters.*",
    });
    expect(cmds[showRow + 8]).toEqual({ pressKey: "Remote Dpad Center" });
  });

  // The focused Genres tile and Filters button still animate when the sheet
  // first appears; settling first keeps the capture identical across passes.
  it("tv.yml settles the focused filter sheet before capture", () => {
    const cmds = commandsOf("tv.yml");
    const shot = cmds.findIndex(
      (cmd) => cmd.takeScreenshot === "08-library-filters",
    );
    expect(shot).toBeGreaterThanOrEqual(0);
    expect(cmds[shot - 2].extendedWaitUntil).toEqual({
      visible: ".*Genres.*",
      timeout: 10000,
    });
    expect(cmds[shot - 1].extendedWaitUntil).toEqual({
      visible: "__settle__",
      timeout: 2000,
      optional: true,
    });
  });

  // The Discover Trending row can appear before the seeded Recently added
  // row; all three passes must wait for the fixed title so noise matches.
  it("seerr-tv.yml waits for seeded Discover content before capture", () => {
    const cmds = commandsOf("seerr-tv.yml");
    const shot = cmds.findIndex(
      (cmd) => cmd.takeScreenshot === "10-seerr-discover",
    );
    expect(shot).toBeGreaterThanOrEqual(0);
    expect(cmds[shot - 2].extendedWaitUntil).toEqual({
      visible: "Annie Oakley.*",
      timeout: 60000,
    });
    expect(cmds[shot - 1].extendedWaitUntil).toEqual({
      visible: "__settle__",
      timeout: 6000,
      optional: true,
    });
  });

  // The loaded first Library visit supplies Movies; Settings is captured later,
  // before its modal (docs/conventions/tv.md).
  it("tv.yml opens Movies from the first Library visit", () => {
    const cmds = commandsOf("tv.yml");
    const library = cmds.findIndex(
      (cmd) => cmd.takeScreenshot === "04-library",
    );
    const movies = cmds.findIndex(
      (cmd) => cmd.takeScreenshot === "06-library-movies",
    );
    const settings = cmds.findIndex(
      (cmd) => cmd.takeScreenshot === "05-settings",
    );
    expect(library).toBeGreaterThanOrEqual(0);
    expect(cmds[library + 1]).toEqual({ pressKey: "Remote Dpad Down" });
    expect(cmds[library + 2].assertVisible).toEqual({
      text: ".*Movies.*",
      focused: true,
    });
    expect(cmds[library + 3]).toEqual({ pressKey: "Remote Dpad Center" });
    expect(movies).toBeGreaterThan(library);
    expect(settings).toBeGreaterThan(movies);
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
    [
      "tv.yml",
      [
        "01-home",
        "02-search",
        "03-favorites",
        "04-library",
        "05-settings",
        "06-library-movies",
        "07-settings-modal",
        "08-library-filters",
        "09-series-details",
      ],
    ],
    [
      "seerr-tv.yml",
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

  it("mobile.yml and tv.yml select the seeded series even when its unplayed badge joins the label", () => {
    const mobileSelector = commandsOf("mobile.yml").find((command) =>
      command.scrollUntilVisible?.element?.includes("Show"),
    )?.scrollUntilVisible.element;
    const tvSelector = commandsOf("tv.yml").find((command) =>
      command.assertVisible?.above?.includes("Show"),
    )?.assertVisible.above;
    for (const selector of [mobileSelector, tvSelector]) {
      const card = new RegExp(selector);
      expect(card.test("Show")).toBe(true);
      expect(card.test("2, Show")).toBe(true);
      expect(card.test("Show, 2026")).toBe(true);
      expect(card.test("Shows")).toBe(false);
    }
  });

  // Two taps are allowed in the shared TV capture flows, both Android TV only: Google
  // TV's OS Shop prompt, and the Seerr search field, which D-pad Up cannot reach there
  // (it leaves focus on the tab bar). All other app navigation uses D-pad pressKey so
  // tvOS and Android TV share one flow set.
  it("shared TV flows drive the app by D-pad without tapOn except the Shop prompt and the Android search field", () => {
    expect(JSON.stringify(commandsOf("bootstrap-seerr-tv.yml"))).not.toContain(
      "tapOn",
    );
    const seerr = commandsOf("seerr-tv.yml");
    const android = seerr.find((cmd) =>
      cmd.runFlow?.commands?.some?.(
        (inner: Record<string, unknown>) => "tapOn" in inner,
      ),
    );
    expect(android?.runFlow.when).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Maestro resolves this flow variable
      true: "${MAESTRO_TVOS != '1'}",
    });
    expect(android?.runFlow.commands[0]).toEqual({
      tapOn: ".*Search\\.\\.\\..*",
    });
    expect(
      JSON.stringify(seerr.filter((cmd) => cmd !== android)),
    ).not.toContain("tapOn");
    const nonShopCmds = commandsOf("tv.yml").filter(
      (cmd) => cmd.runFlow?.when?.visible !== "Buy and rent movies on your TV",
    );
    expect(JSON.stringify(nonShopCmds)).not.toContain("tapOn");
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

  // Focus selects Search on tvOS NativeTabs; Android TV's JS TVNavBar also needs Center.
  it("bootstrap-seerr-tv focuses Search by D-pad and presses Center on Android TV", () => {
    const cmds = commandsOf("bootstrap-seerr-tv.yml");
    expect(cmds.some((cmd) => cmd.runFlow === "_focus-home-tab.yml")).toBe(
      true,
    );
    expect(cmds).toContainEqual({ pressKey: "Remote Dpad Right" });
    expect(cmds).toContainEqual({
      runFlow: {
        file: "_assert-tab-focused.yml",
        env: { TAB_LABEL: "Search", TAB_ID: "tv-nav-search" },
      },
    });
    const androidCenter = cmds.find((cmd) =>
      cmd.runFlow?.when?.true?.includes("!= '1'"),
    );
    expect(androidCenter?.runFlow.commands).toEqual([
      { pressKey: "Remote Dpad Center" },
    ]);
    expect(
      cmds.some((cmd) => cmd.extendedWaitUntil?.visible === "Discover"),
    ).toBe(true);
  });

  it("the parents take no screenshots themselves", () => {
    for (const file of ["pass-mobile.yml", "pass-tv.yml"])
      expect(screenshotNames(commandsOf(file))).toHaveLength(0);
  });

  it("tv.yml recovers from Google's Shop prompt at every relaunch", () => {
    const cmds = commandsOf("tv.yml");
    const launches = cmds.flatMap((cmd, index) =>
      String(cmd) === "launchApp" ? [index] : [],
    );
    expect(launches).toHaveLength(3);
    for (const relaunch of launches) expectShopGuard(cmds, relaunch);
  });

  function expectShopGuard(cmds: Record<string, any>[], relaunch: number) {
    expect(cmds[relaunch + 1]).toEqual({
      runFlow: "_dismiss-dev-overlays.yml",
    });
    expect(cmds[relaunch + 2].extendedWaitUntil).toEqual({
      visible: ".*Recently added.*|Buy and rent movies on your TV",
      timeout: 60000,
    });
    expect(cmds[relaunch + 3].runFlow).toEqual({
      when: {
        visible: "Buy and rent movies on your TV",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Maestro resolves this flow variable
        true: "${MAESTRO_TVOS != '1'}",
      },
      commands: [
        { tapOn: "Dismiss" },
        "launchApp",
        { runFlow: "_dismiss-dev-overlays.yml" },
      ],
    });
    expect(cmds[relaunch + 4].extendedWaitUntil).toEqual({
      visible: ".*Recently added.*",
      timeout: 60000,
    });
    expect(
      cmds
        .slice(relaunch + 5, relaunch + 7)
        .some((cmd) => cmd.runFlow === "_focus-home-tab.yml"),
    ).toBe(true);
  }

  it("tv.yml hands focus back to the tab bar after Center on Android TV, after the screenshot", () => {
    const cmds = commandsOf("tv.yml");
    for (const [shot, tabId] of [
      ["02-search", "tv-nav-search"],
      ["03-favorites", "tv-nav-tv-favorites"],
    ]) {
      const at = cmds.findIndex((cmd) => cmd.takeScreenshot === shot);
      expect(at).toBeGreaterThan(-1);
      expect(cmds[at + 1].runFlow).toEqual({
        when: {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Maestro resolves this flow variable
          true: "${MAESTRO_TVOS != '1'}",
        },
        commands: [
          { runFlow: { file: "_refocus-tab.yml", env: { TAB_ID: tabId } } },
        ],
      });
    }
  });

  it("TV tab focus is asserted per platform: tvOS by label, Android TV by testID", () => {
    const cmds = commandsOf("tv.yml");
    for (const cmd of cmds)
      expect(
        cmd.assertVisible?.focused &&
          cmd.assertVisible?.text?.match(
            /^(Search|Favorites|Library|Settings|Home)$/,
          ),
      ).toBeFalsy();
    const helper = commandsOf("_assert-tab-focused.yml");
    expect(JSON.stringify(helper)).toContain('"id":"${TAB_ID}"');
    expect(JSON.stringify(helper)).toContain('"text":"${TAB_LABEL}"');
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
      "Fetch development servers|Searching for development servers.*|DEVELOPMENT SERVERS|Enter URL manually",
    );
    const picker = new RegExp(cmds[1].runFlow.when.visible);
    expect(picker.test("Fetch development servers")).toBe(true);
    expect(picker.test("Searching for development servers...")).toBe(true);
    expect(picker.test("DEVELOPMENT SERVERS")).toBe(true);
    expect(picker.test("Enter URL manually")).toBe(true);
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

  it("bootstrap-login-tv focuses each Android TV credential field before typing", () => {
    const cmds = commandsOf("bootstrap-login-tv.yml");
    const username = cmds.findIndex(
      (cmd) => cmd.extendedWaitUntil?.visible === "Username",
    );
    expect(username).toBeGreaterThanOrEqual(0);
    const tvos = cmds[username + 1].runFlow;
    const android = cmds[username + 2].runFlow;
    expect(tvos.when.true).toContain("MAESTRO_TVOS == '1'");
    expect(
      tvos.commands.map(
        (cmd: Command) =>
          cmd.pressKey ?? (cmd.inputText ? "inputText" : undefined),
      ),
    ).toEqual([
      "Remote Dpad Center",
      "inputText",
      "Enter",
      "Remote Dpad Down",
      "Remote Dpad Center",
    ]);
    expect(android.when.true).toContain("MAESTRO_TVOS != '1'");
    const steps = android.commands as Command[];
    expect(steps[0]).toEqual({ tapOn: "Username" });
    expect(steps[1]).toEqual({
      assertVisible: { text: "Username", focused: true },
    });
    expect(steps[2].inputText).toBeTruthy();
    expect(steps[3]).toEqual({ pressKey: "Enter" });
    expect(steps[4]).toEqual({ assertVisible: steps[2].inputText });
    expect(steps[5]).toEqual({ tapOn: "Password" });
    expect(steps[6]).toEqual({
      assertVisible: { text: "Password", focused: true },
    });
    expect(cmds[username + 3].inputText).toContain("MAESTRO_JELLYFIN_PASS");
  });
});
