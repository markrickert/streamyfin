import { runComparison } from "./run";
import { execs, Fake, happyRoutes, REPO, runCli, seed } from "./testing";

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
