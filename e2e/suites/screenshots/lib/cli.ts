import { type Cli, PLATFORMS, type Platform, ShotError } from "./core";

export type ParsedCli = Cli | { command: "maestro-path" };

export function parseArgs(argv: string[]): ParsedCli {
  const [command, ...rest] = argv;
  if (command === "maestro-path") {
    if (rest.length > 0) throw new ShotError("usage: shots.ts maestro-path");
    return { command: "maestro-path" };
  }
  if (command !== "doctor" && command !== "run")
    throw new ShotError(
      "usage: shots.ts doctor [--fix] [--platform <p>] | run --platform <p> [--before <ref>] [--after <ref>] [--device <id>] [--out <dir>] [--port <port>] | maestro-path",
    );
  const flags: Record<string, string> = {};
  let fix = false;
  for (let i = 0; i < rest.length; i++) {
    if (command === "doctor" && rest[i] === "--fix") {
      fix = true;
      continue;
    }
    if (!rest[i].startsWith("--") || rest[i + 1] === undefined)
      throw new ShotError(`shots.ts: bad flag near '${rest[i]}'`);
    flags[rest[i].slice(2)] = rest[++i];
  }
  const cli: Cli = {
    command,
    fix,
    platform: flags.platform as Platform | undefined,
    before: flags.before,
    after: flags.after ?? "HEAD",
    device: flags.device,
    outDir: flags.out,
    port: flags.port ? Number(flags.port) : undefined,
  };
  if (
    cli.platform !== undefined &&
    !(PLATFORMS as readonly string[]).includes(cli.platform)
  )
    throw new ShotError(
      `shots.ts: --platform must be one of ${PLATFORMS.join(", ")}`,
    );
  if (command === "run") {
    if (!cli.platform)
      throw new ShotError("shots.ts run: --platform is required");
    if (
      cli.port !== undefined &&
      (!Number.isInteger(cli.port) || cli.port <= 0)
    )
      throw new ShotError("shots.ts run: --port must be a positive integer");
  }
  return cli;
}

export interface PlatformSpec {
  tv: boolean;
  fingerprintPlatform: "ios" | "android";
  /** Forwarded as `maestro --platform`: the pinned fork's tvOS driver. */
  maestroPlatform?: "tvos";
  masks: string;
}

export function platformSpec(platform: Platform): PlatformSpec {
  switch (platform) {
    case "ios":
    case "android":
      return {
        tv: false,
        fingerprintPlatform: platform,
        masks: `masks-${platform}-phone.json`,
      };
    case "android-tv":
      return {
        tv: true,
        fingerprintPlatform: "android",
        masks: "masks-android-tv.json",
      };
    case "apple-tv":
      return {
        tv: true,
        fingerprintPlatform: "ios",
        maestroPlatform: "tvos",
        masks: "masks-ios-tv.json",
      };
  }
}
