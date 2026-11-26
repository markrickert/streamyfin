import { ensureFixture } from "./fixture";
import { runComparison } from "./run";
import { execs, Fake, happyRoutes, ok, REPO, runCli, seed } from "./testing";

describe("ensureFixture", () => {
  // A traceback puts its exception at the end of stderr, so the excerpt the error
  // keeps is the tail, not the head.
  it("reports the stderr tail when a step fails", () => {
    const f = new Fake();
    const stderr = `setup chatter at the head\n${"noise\n".repeat(400)}RuntimeError: jellyfin busy`;
    f.routes.push(
      ["bun run e2e:setup", ok],
      ["bun run e2e:seed", { code: 1, stdout: "", stderr }],
    );
    let message = "";
    try {
      ensureFixture(f, REPO);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("…");
    expect(message).toContain("RuntimeError: jellyfin busy");
    expect(message).not.toContain("setup chatter at the head");
  });

  it("retries e2e:enrich once, logging the first failure's tail", () => {
    const f = new Fake();
    let attempts = 0;
    f.routes.push(
      ["bun run e2e:setup", ok],
      ["bun run e2e:seed", ok],
      [
        "bun run e2e:enrich",
        () => {
          attempts += 1;
          return attempts === 1
            ? { code: 1, stdout: "", stderr: "enrich boom" }
            : ok;
        },
      ],
      ["suites.syncplay import seerr", ok],
    );
    expect(() => ensureFixture(f, REPO)).not.toThrow();
    expect(execs(f, "e2e:enrich")).toHaveLength(2);
    expect(f.logs.some((line) => line.includes("enrich boom"))).toBe(true);
  });

  it("throws the retry's stderr tail when e2e:enrich fails twice", () => {
    const f = new Fake();
    let attempts = 0;
    f.routes.push(
      ["bun run e2e:setup", ok],
      ["bun run e2e:seed", ok],
      [
        "bun run e2e:enrich",
        () => {
          attempts += 1;
          return { code: 1, stdout: "", stderr: `boom-${attempts}` };
        },
      ],
    );
    let message = "";
    try {
      ensureFixture(f, REPO);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(execs(f, "e2e:enrich")).toHaveLength(2);
    expect(message).toContain("boom-2");
    expect(message).not.toContain("boom-1");
  });
});

describe("fixtureEnv port contract", () => {
  it("refuses a missing SYNCPLAY_SEERR_PORT instead of producing :undefined", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.files.set(`${REPO}/e2e/suites/syncplay/.env`, "SYNCPLAY_PORT=18096\n");
    await expect(runComparison(f, runCli, REPO)).rejects.toThrow(
      /SYNCPLAY_SEERR_PORT/,
    );
    expect(execs(f, "git switch")).toHaveLength(0);
  });
});
