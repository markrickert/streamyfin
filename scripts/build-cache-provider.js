const { execFile } = require("node:child_process");
const { existsSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { promisify } = require("node:util");

const provider = require("expo-build-disk-cache").default;

const ADB_TIMEOUT_MS = 15000;

const execFileAsync = promisify(execFile);

const adbPath = () => {
  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (sdkRoot) return join(sdkRoot, "platform-tools", "adb");
  const macDefault = join(
    homedir(),
    "Library",
    "Android",
    "sdk",
    "platform-tools",
    "adb",
  );
  return existsSync(macDefault) ? macDefault : "adb";
};

const adb = async (args) => {
  const { stdout } = await execFileAsync(adbPath(), args, {
    timeout: ADB_TIMEOUT_MS,
  });
  return stdout;
};

const readySerials = (devicesOutput) =>
  devicesOutput
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === "device")
    .map(([serial]) => serial);

const normalizedAbiList = (raw) =>
  raw
    .trim()
    .split(",")
    .map((abi) => abi.trim())
    .filter(Boolean);

const deviceAbiList = async (serial) => {
  const getprop = (prop) => adb(["-s", serial, "shell", "getprop", prop]);
  const abiList = (await getprop("ro.product.cpu.abilist")).trim();
  return normalizedAbiList(abiList || (await getprop("ro.product.cpu.abi")));
};

// Expo CLI builds a debug APK for the attached device's ABI only (the variant
// parsing lives in resolveGradlePropsAsync), while the fingerprint the cache
// is keyed on is ABI-agnostic. Serving a cached APK to a device of another
// ABI fails adb install with INSTALL_FAILED_NO_MATCHING_ABIS, so the device's
// ordered ABI list has to be part of the key.
const isSingleAbiBuild = ({ variant, allArch } = {}) => {
  if (allArch) return false;
  const parts = String(variant ?? "debug").split(/(?=[A-Z])/);
  let buildType = parts.pop();
  if (parts.length > 0 && buildType === "Optimized") {
    buildType = `${parts.pop().toLowerCase()}${buildType}`;
  } else {
    buildType = buildType.toLowerCase();
  }
  return buildType === "debug" || buildType === "debugOptimized";
};

// The ABI list every ready device shares, encoded for a filename, or null when
// there is not exactly one. Two lists that differ only in order still disagree:
// Expo picks the first buildable entry, so only identical lists guarantee it
// builds the same ABI for every device.
const deviceAbiKey = async () => {
  try {
    const serials = readySerials(await adb(["devices"]));
    const lists = await Promise.all(serials.map(deviceAbiList));
    if (lists.length === 0 || lists.some((list) => list.length === 0)) {
      return null;
    }
    const [first, ...rest] = lists;
    if (rest.some((list) => list.join(",") !== first.join(","))) return null;
    return encodeURIComponent(first.join(","));
  } catch {
    return null;
  }
};

let skipLogged = false;

// null skips the cache entirely: a single-ABI build without one shared ABI
// list must never read or write the unsuffixed key.
const cacheArgs = async (args) => {
  if (args.platform !== "android" || !isSingleAbiBuild(args.runOptions)) {
    return args;
  }
  const abiKey = await deviceAbiKey();
  if (abiKey) {
    return { ...args, fingerprintHash: `${args.fingerprintHash}.${abiKey}` };
  }
  if (!skipLogged) {
    skipLogged = true;
    console.log(
      "Skipping the build cache: no single ordered ABI list across ready devices (attach the one target device)",
    );
  }
  return null;
};

const resolveBuildCache = async (args, options) => {
  const keyed = await cacheArgs(args);
  if (keyed === null) return null;
  return provider.resolveBuildCache(keyed, options);
};

const uploadBuildCache = async (args, options) => {
  const keyed = await cacheArgs(args);
  if (keyed === null) return null;
  return provider.uploadBuildCache(keyed, options);
};

module.exports = { resolveBuildCache, uploadBuildCache };
