import { runComparison } from "./run";
import { Fake, happyRoutes, REPO, runCli, seed } from "./testing";

describe("tooling snapshot", () => {
  // The runner is loaded before the first git switch, so it never runs from the
  // snapshot. Its copied source only failed typecheck: shots.ts imports a module that
  // does not resolve from inside e2e/reports.
  it("copies what the passes run, and not the runner's own source", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    const { sessionDir } = await runComparison(f, runCli, REPO);
    const tooling = `${sessionDir}/tooling`;
    for (const file of [
      "compare.ts",
      "run.sh",
      "ios-disable-autofill.sh",
      "maestro.py",
      "masks-android-phone.json",
      "flows/mobile.yml",
    ])
      expect(f.files.has(`${tooling}/${file}`)).toBe(true);
    expect(f.files.has(`${tooling}/shots.ts`)).toBe(false);
    expect(f.files.has(`${tooling}/shots-lib.ts`)).toBe(false);
    expect(
      [...f.files.keys()].some((path) => path.startsWith(`${tooling}/lib/`)),
    ).toBe(false);
  });
});
