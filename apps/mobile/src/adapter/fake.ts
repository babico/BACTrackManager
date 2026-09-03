import type { AdapterEvent, BreathalyzerAdapter } from "./types.js";

export interface FakeScript {
  serial?: string;
  battery?: number | null;
  countdownSeconds?: number;
  blowSeconds?: number;
  bacPromille?: number;
  failAt?: "init" | "connect" | "test" | null;
}

export class FakeBreathalyzer implements BreathalyzerAdapter {
  readonly name = "fake";
  private listener: ((e: AdapterEvent) => void) | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  constructor(private readonly script: FakeScript = {}) {}

  async init(apiKey: string): Promise<void> {
    if (this.script.failAt === "init" || apiKey.length === 0) {
      throw new Error("sdk.declined: missing api key");
    }
  }

  async startScan(onEvent: (e: AdapterEvent) => void): Promise<void> {
    this.listener = onEvent;
    this.after(50, () =>
      onEvent({ kind: "scan.found", deviceId: "fake-c6-1", serial: this.script.serial ?? "03-FAKE-0-00001", rssi: -60 }),
    );
  }

  async stopScan(): Promise<void> {
    this.clear();
    this.listener = null;
  }

  async connect(deviceId: string): Promise<void> {
    if (this.script.failAt === "connect") throw new Error("connection.failed");
    const emit = this.requireListener();
    this.after(50, () =>
      emit({
        kind: "connection.ready",
        deviceId,
        serial: this.script.serial ?? "03-FAKE-0-00001",
        battery: this.script.battery ?? 87,
      }),
    );
  }

  async disconnect(): Promise<void> {
    this.clear();
  }

  async startTest(): Promise<void> {
    if (this.script.failAt === "test") throw new Error("test.failed");
    const emit = this.requireListener();
    const countdown = this.script.countdownSeconds ?? 3;
    const blow = this.script.blowSeconds ?? 2;
    for (let s = countdown; s >= 1; s--) {
      const left = s;
      this.after((countdown - s) * 100, () => emit({ kind: "test.countdown", secondsLeft: left }));
    }
    for (let s = blow; s >= 1; s--) {
      const left = s;
      this.after((countdown + (blow - s)) * 100, () => emit({ kind: "test.blow", secondsLeft: left }));
    }
    this.after((countdown + blow) * 100, () => emit({ kind: "test.analyzing" }));
    this.after((countdown + blow) * 100 + 50, () =>
      emit({
        kind: "test.result",
        bacPromille: this.script.bacPromille ?? 0.42,
        measuredAt: new Date().toISOString(),
      }),
    );
  }

  async battery(): Promise<number | null> {
    return this.script.battery ?? 87;
  }

  async serial(): Promise<string | null> {
    return this.script.serial ?? "03-FAKE-0-00001";
  }

  private requireListener(): (e: AdapterEvent) => void {
    if (!this.listener) throw new Error("scan not started");
    return this.listener;
  }

  private after(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms));
  }

  private clear(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
