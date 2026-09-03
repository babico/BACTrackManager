import { describe, expect, it } from "vitest";
import { FakeBreathalyzer } from "../src/adapter/fake.js";
import type { AdapterEvent } from "../src/adapter/types.js";
import { initialState, reduce } from "../src/state/reducer.js";

describe("capture reducer", () => {
  it("walks idle → scanning → ready → countdown → done", () => {
    let s = reduce(initialState, { kind: "ui.scan" });
    expect(s.phase).toBe("scanning");
    s = reduce(s, { kind: "scan.found", deviceId: "d1", serial: "SN-1", rssi: -60 });
    expect(s.deviceId).toBe("d1");
    s = reduce(s, { kind: "ui.connect", deviceId: "d1" });
    expect(s.phase).toBe("connecting");
    s = reduce(s, { kind: "connection.ready", deviceId: "d1", serial: "SN-1", battery: 90 });
    expect(s.phase).toBe("ready");
    expect(s.battery).toBe(90);
    s = reduce(s, { kind: "ui.startTest" });
    s = reduce(s, { kind: "test.countdown", secondsLeft: 2 });
    expect(s.countdownLeft).toBe(2);
    s = reduce(s, { kind: "test.blow", secondsLeft: 1 });
    expect(s.phase).toBe("blowing");
    s = reduce(s, { kind: "test.analyzing" });
    s = reduce(s, { kind: "test.result", bacPromille: 0.0, measuredAt: "2026-09-03T00:00:00.000Z" });
    expect(s.phase).toBe("done");
    expect(s.bacPromille).toBe(0.0);
  });

  it("ignores startTest outside ready", () => {
    expect(reduce(initialState, { kind: "ui.startTest" }).phase).toBe("idle");
  });

  it("surfaces sdk decline and connection loss as error", () => {
    const a = reduce(initialState, { kind: "sdk.declined", reason: "no key" });
    expect(a.phase).toBe("error");
    const b = reduce({ ...initialState, phase: "ready" }, { kind: "connection.lost", deviceId: "d" });
    expect(b.phase).toBe("error");
  });

  it("reset returns to idle", () => {
    const s = reduce({ ...initialState, phase: "done", bacPromille: 1 }, { kind: "ui.reset" });
    expect(s).toEqual(initialState);
  });
});

describe("fake adapter", () => {
  it("emits ordered script", async () => {
    const events: AdapterEvent[] = [];
    const fake = new FakeBreathalyzer({ countdownSeconds: 1, blowSeconds: 1, bacPromille: 0.0 });
    await fake.init("key");
    await fake.startScan((e) => events.push(e));
    await new Promise((r) => setTimeout(r, 120));
    await fake.connect("fake-c6-1");
    await new Promise((r) => setTimeout(r, 120));
    await fake.startTest();
    await new Promise((r) => setTimeout(r, 500));
    expect(events.map((e) => e.kind)).toEqual([
      "scan.found",
      "connection.ready",
      "test.countdown",
      "test.blow",
      "test.analyzing",
      "test.result",
    ]);
    const last = events[events.length - 1];
    expect(last.kind).toBe("test.result");
    if (last.kind === "test.result") expect(last.bacPromille).toBe(0.0);
  });

  it("declines empty api key", async () => {
    const fake = new FakeBreathalyzer();
    await expect(fake.init("")).rejects.toThrow();
  });
});
