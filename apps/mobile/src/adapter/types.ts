export type AdapterEvent =
  | { kind: "sdk.authorized" }
  | { kind: "sdk.declined"; reason: string }
  | { kind: "scan.found"; deviceId: string; serial: string | null; rssi: number }
  | { kind: "connection.ready"; deviceId: string; serial: string; battery: number | null }
  | { kind: "connection.lost"; deviceId: string }
  | { kind: "test.countdown"; secondsLeft: number }
  | { kind: "test.blow"; secondsLeft: number }
  | { kind: "test.analyzing" }
  | { kind: "test.result"; bacPromille: number; measuredAt: string }
  | { kind: "error"; code: string; message: string };

export interface BreathalyzerAdapter {
  readonly name: string;
  init(apiKey: string): Promise<void>;
  startScan(onEvent: (e: AdapterEvent) => void): Promise<void>;
  stopScan(): Promise<void>;
  connect(deviceId: string): Promise<void>;
  disconnect(): Promise<void>;
  startTest(): Promise<void>;
  battery(): Promise<number | null>;
  serial(): Promise<string | null>;
}
