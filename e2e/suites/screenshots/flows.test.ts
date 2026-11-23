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
