jest.mock("expo-build-disk-cache", () => ({
  default: {
    resolveBuildCache: jest.fn(),
    uploadBuildCache: jest.fn(),
  },
}));

jest.mock("node:child_process", () => ({
  execFile: jest.fn(),
}));

type CacheArgs = {
  projectRoot: string;
  platform: "ios" | "android";
  fingerprintHash: string;
  runOptions?: Record<string, unknown>;
  buildPath?: string;
};

const provider = require("./build-cache-provider.js") as {
  resolveBuildCache: (args: CacheArgs, options?: unknown) => Promise<unknown>;
  uploadBuildCache: (args: CacheArgs, options?: unknown) => Promise<unknown>;
};

const execFileMock = jest.requireMock("node:child_process")
  .execFile as jest.Mock;
const diskCache = jest.requireMock("expo-build-disk-cache").default as {
  resolveBuildCache: jest.Mock;
  uploadBuildCache: jest.Mock;
};

type FakeDevice = {
  // The second column of `adb devices`: "device", "unauthorized", "offline"...
  state?: string;
  abiList?: string;
  abi?: string;
};

const mockAdb = (devices: Record<string, FakeDevice>) => {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _options: unknown,
      callback: (
        error: Error | null,
        result?: { stdout: string; stderr: string },
      ) => void,
    ) => {
      if (args[0] === "devices") {
        const lines = Object.entries(devices).map(
          ([serial, { state = "device" }]) => `${serial}\t${state}`,
        );
        callback(null, {
          stdout: `List of devices attached\n${lines.join("\n")}\n\n`,
          stderr: "",
        });
        return;
      }
      // `adb -s <serial> shell getprop <prop>`
      const [, serial, , , prop] = args;
      const device = devices[serial];
      if (!device) {
        callback(new Error(`adb: device '${serial}' not found`));
        return;
      }
      const stdout =
        prop === "ro.product.cpu.abilist"
          ? (device.abiList ?? "")
          : (device.abi ?? "");
      callback(null, { stdout, stderr: "" });
    },
  );
};

const mockAdbError = (error: Error) => {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null) => void,
    ) => callback(error),
  );
};

const args = (
  platform: CacheArgs["platform"],
  runOptions?: CacheArgs["runOptions"],
): CacheArgs => ({
  projectRoot: "/project",
  platform,
  fingerprintHash: "abc123",
  runOptions,
});

describe("build-cache-provider", () => {
  it("passes iOS args through to the disk cache without calling adb", async () => {
    const iosArgs = args("ios", { configuration: "Debug" });
    diskCache.resolveBuildCache.mockResolvedValue("/cache/app.app");

    const result = await provider.resolveBuildCache(iosArgs, {
      remoteOptions: true,
    });

    expect(result).toBe("/cache/app.app");
    expect(diskCache.resolveBuildCache).toHaveBeenCalledWith(iosArgs, {
      remoteOptions: true,
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it.each([
    ["release", { variant: "release" }],
    ["an all-arch build", { variant: "debug", allArch: true }],
  ])(
    "leaves the fingerprint of an Android %s build untouched",
    async (_name, runOptions) => {
      const androidArgs = args("android", runOptions);

      await provider.resolveBuildCache(androidArgs);
      await provider.uploadBuildCache(androidArgs);

      expect(diskCache.resolveBuildCache).toHaveBeenCalledWith(
        androidArgs,
        undefined,
      );
      expect(diskCache.uploadBuildCache).toHaveBeenCalledWith(
        androidArgs,
        undefined,
      );
      expect(execFileMock).not.toHaveBeenCalled();
    },
  );

  it("keys an Android debug build by the attached device's ABI list", async () => {
    mockAdb({
      "emulator-5554": { abiList: "arm64-v8a" },
    });
    const debugArgs = args("android", { variant: "debug" });

    await provider.resolveBuildCache(debugArgs, { remote: {} });
    await provider.uploadBuildCache({ ...debugArgs, buildPath: "/app.apk" });

    expect(diskCache.resolveBuildCache).toHaveBeenCalledWith(
      { ...debugArgs, fingerprintHash: "abc123.arm64-v8a" },
      { remote: {} },
    );
    expect(diskCache.uploadBuildCache).toHaveBeenCalledWith(
      expect.objectContaining({
        buildPath: "/app.apk",
        fingerprintHash: "abc123.arm64-v8a",
      }),
      undefined,
    );
    // The same key reads and writes: a resolved APK matches what a later
    // run stored, and the caller's args are never mutated.
    const [resolvedKey] = diskCache.resolveBuildCache.mock.calls[0];
    const [uploadedKey] = diskCache.uploadBuildCache.mock.calls[0];
    expect(resolvedKey.fingerprintHash).toBe(uploadedKey.fingerprintHash);
    expect(debugArgs.fingerprintHash).toBe("abc123");
  });

  it("encodes the whole ordered ABI list into a filename-safe key", async () => {
    mockAdb({
      "emulator-5554": { abiList: "arm64-v8a,armeabi-v7a,armeabi" },
    });

    await provider.resolveBuildCache(args("android", { variant: "debug" }));

    expect(diskCache.resolveBuildCache).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprintHash: "abc123.arm64-v8a%2Carmeabi-v7a%2Carmeabi",
      }),
      undefined,
    );
  });

  it("keys a flavored debugOptimized build the same way", async () => {
    mockAdb({ "emulator-5554": { abiList: "x86_64,x86" } });

    await provider.resolveBuildCache(
      args("android", { variant: "freeDebugOptimized" }),
    );

    expect(diskCache.resolveBuildCache).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprintHash: "abc123.x86_64%2Cx86" }),
      undefined,
    );
  });

  it("keys the build when every attached device reports the same ABI list", async () => {
    mockAdb({
      "emulator-5554": { abiList: "arm64-v8a,armeabi-v7a" },
      "0123456789ABCDEF": { abiList: "arm64-v8a, armeabi-v7a" },
    });

    await provider.resolveBuildCache(args("android", { variant: "debug" }));

    expect(diskCache.resolveBuildCache).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprintHash: "abc123.arm64-v8a%2Carmeabi-v7a",
      }),
      undefined,
    );
  });

  it("keys a device whose ABI list holds no usual build target", async () => {
    // "mips" is nothing Expo would pick first, but a conservative keyed
    // entry is still safe: an APK built under it only serves this device.
    mockAdb({ "emulator-5554": { abiList: "mips" } });

    await provider.resolveBuildCache(args("android", { variant: "debug" }));

    expect(diskCache.resolveBuildCache).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprintHash: "abc123.mips" }),
      undefined,
    );
  });

  it("ignores devices adb does not report as ready", async () => {
    // The unauthorized arm box never answers getprop; only the ready
    // emulator's ABI may end up in the key.
    mockAdb({
      "0123456789ABCDEF": { state: "unauthorized", abiList: "armeabi-v7a" },
      "emulator-5554": { abiList: "x86_64" },
    });

    await provider.resolveBuildCache(args("android", { variant: "debug" }));

    expect(diskCache.resolveBuildCache).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprintHash: "abc123.x86_64" }),
      undefined,
    );
    for (const [, adbArgs] of execFileMock.mock.calls) {
      expect(adbArgs).not.toContain("0123456789ABCDEF");
    }
  });

  it("falls back to ro.product.cpu.abi when abilist is blank", async () => {
    mockAdb({ "emulator-5554": { abiList: "", abi: "armeabi-v7a" } });

    await provider.resolveBuildCache(args("android", { variant: "debug" }));

    expect(diskCache.resolveBuildCache).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprintHash: "abc123.armeabi-v7a" }),
      undefined,
    );
  });

  it.each([
    ["no device is attached", {}],
    [
      "attached devices report different ABI lists",
      {
        "emulator-5554": { abiList: "x86_64" },
        "0123456789ABCDEF": { abiList: "arm64-v8a" },
      },
    ],
    [
      // Order is part of the key: Expo picks the first buildable entry, so
      // the same ABIs in a different order can still mean different APKs.
      "the ABI lists only differ in order",
      {
        "emulator-5554": { abiList: "arm64-v8a,armeabi-v7a" },
        "0123456789ABCDEF": { abiList: "armeabi-v7a,arm64-v8a" },
      },
    ],
    [
      "a device reports no ABI at all",
      { "emulator-5554": { abiList: "", abi: "" } },
    ],
  ])(
    "never reads or writes an unsuffixed cache key when %s",
    async (_name, devices) => {
      mockAdb(devices);
      const debugArgs = args("android", { variant: "debug" });

      expect(await provider.resolveBuildCache(debugArgs)).toBeNull();
      expect(await provider.uploadBuildCache(debugArgs)).toBeNull();
      expect(diskCache.resolveBuildCache).not.toHaveBeenCalled();
      expect(diskCache.uploadBuildCache).not.toHaveBeenCalled();
    },
  );

  it("skips the cache when adb fails", async () => {
    mockAdbError(new Error("adb: cannot connect to daemon"));

    expect(
      await provider.resolveBuildCache(args("android", { variant: "debug" })),
    ).toBeNull();
    expect(diskCache.resolveBuildCache).not.toHaveBeenCalled();
    expect(diskCache.uploadBuildCache).not.toHaveBeenCalled();
  });
});
