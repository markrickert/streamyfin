import { parseArgs, platformSpec } from "./cli";
import { ShotError } from "./core";

describe("parseArgs", () => {
  it("rejects a run without a platform", () => {
    expect(() => parseArgs(["run", "--before", "a"])).toThrow(ShotError);
  });
  it("leaves --before to resolveBaseRef and defaults --after to HEAD", () => {
    expect(parseArgs(["run", "--platform", "android"])).toMatchObject({
      before: undefined,
      after: "HEAD",
    });
  });
  it("accepts --fix as a valueless doctor flag", () => {
    expect(
      parseArgs(["doctor", "--fix", "--platform", "apple-tv"]),
    ).toMatchObject({ command: "doctor", fix: true, platform: "apple-tv" });
  });
  it("rejects --fix on run", () => {
    expect(() => parseArgs(["run", "--platform", "android", "--fix"])).toThrow(
      ShotError,
    );
  });
  it("accepts the documented run shape", () => {
    const cli = parseArgs([
      "run",
      "--platform",
      "apple-tv",
      "--before",
      "a",
      "--after",
      "b",
    ]);
    expect(cli).toMatchObject({
      command: "run",
      platform: "apple-tv",
      before: "a",
      after: "b",
    });
  });
  it("accepts maestro-path without extra arguments", () => {
    expect(parseArgs(["maestro-path"])).toEqual({ command: "maestro-path" });
  });
  it("rejects extra arguments on maestro-path", () => {
    expect(() => parseArgs(["maestro-path", "--fix"])).toThrow(ShotError);
  });
});

describe("platformSpec", () => {
  it("maps apple-tv to the tvOS driver and ios fingerprint", () => {
    expect(platformSpec("apple-tv")).toMatchObject({
      tv: true,
      fingerprintPlatform: "ios",
      maestroPlatform: "tvos",
      masks: "masks-ios-tv.json",
    });
  });
});
