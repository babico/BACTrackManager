import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const iosDir = join(dirname(fileURLToPath(import.meta.url)), "..", "ios");
const read = (f: string) => readFileSync(join(iosDir, f), "utf8");

const EVENT_KINDS = [
  "sdk.authorized",
  "sdk.declined",
  "scan.found",
  "connection.ready",
  "connection.lost",
  "test.countdown",
  "test.blow",
  "test.analyzing",
  "test.result",
  "error",
];

describe("ios sources (drift tripwire)", () => {
  it("bridge exposes all event kinds", () => {
    const swift = read("BACtrackBridge.swift");
    expect(swift).toContain("BACtrackBridge");
    for (const kind of EVENT_KINDS) {
      expect(swift).toContain(`"${kind}"`);
    }
    expect(swift).toContain("startObserving");
  });

  it("spec and glue match bridge surface", () => {
    const spec = read("NativeBACtrackSpec.ts");
    for (const m of ["init", "startScan", "stopScan", "connect", "disconnect", "startTest", "getBattery", "getSerial"]) {
      expect(spec).toContain(m);
    }
    const mm = read("BACtrackBridge.mm");
    expect(mm).toContain("RCT_EXTERN_MODULE(BACtrackBridge");
  });

  it("survey app is SDK-free CoreBluetooth", () => {
    const survey = read("SurveyApp.swift");
    expect(survey).toContain("CBCentralManager");
    expect(survey).not.toContain("BreathalyzerSDK");
  });
});
