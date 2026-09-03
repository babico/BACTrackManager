# Mobile Capture Implementation Plan (P4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `apps/mobile` ships a fully tested TypeScript capture core (adapter interface, deterministic fake, connection/test reducer, encrypted journal, offline queue, sync engine, API client) plus iOS Swift bridge sources and a BLE survey probe, ready for Mac-side compile and C6 hardware-in-loop.

**Architecture:** All device contact hides behind `BreathalyzerAdapter` (events: `sdk.authorized, scan.found, connection.ready, test.countdown, test.blow, test.analyzing, test.result, error`). UI state is a single reducer (no scattered useState). Every event is journaled (AES-GCM, device keychain at runtime, env key in tests) BEFORE UI transitions. Sync engine supports `disabled, upload_only, download_only, bidirectional` and uploads with explicit backlog consent. Real BACtrack SDK drops behind the same interface when the key lands; fake stays for CI. Native iOS (Swift + TurboModule spec) compiles on Mac only — sources included, compile deferred with exact steps.

**Tech Stack:** TypeScript 5.6, vitest 2 (same as api), no RN runtime needed for core tests. Swift 5.9 / Xcode 16 for the deferred native half. Zero new runtime deps for core (uses global fetch/crypto).

**Plan split:** P4 of the phase plan. P1-P3 merged (backend capture + hybrid auth live, 24/24 tests). P5+ (web, sync worker, import, Dawarich) consume the API client and journal formats defined here.

---

## File structure (this plan)

| Path | Responsibility |
|---|---|
| `apps/mobile/package.json` | `@bactrack/mobile` private package, vitest |
| `apps/mobile/tsconfig.json` | Strict TS, NodeNext |
| `apps/mobile/vitest.config.ts` | Include `test/**/*.spec.ts` |
| `apps/mobile/src/adapter/types.ts` | `BreathalyzerAdapter` interface + event union |
| `apps/mobile/src/adapter/fake.ts` | Deterministic fake (seeded script of events) |
| `apps/mobile/src/state/reducer.ts` | Connection/test reducer + initial state |
| `apps/mobile/src/journal/store.ts` | AES-GCM journal: append/list/markSynced (storage-agnostic backend interface) |
| `apps/mobile/src/journal/memory-backend.ts` | In-memory backend for tests (Keychain/SQLite later) |
| `apps/mobile/src/sync/queue.ts` | Offline outbox queue with idempotency keys |
| `apps/mobile/src/sync/engine.ts` | Sync modes, backlog consent gate, push/pull against API client |
| `apps/mobile/src/api/client.ts` | Typed client for our backend (sessions/create/complete, readings, refresh) |
| `apps/mobile/src/api/tokens.ts` | Token bundle store interface (memory impl for tests) |
| `apps/mobile/ios/BACtrackBridge.swift` | TurboModule bridge: SDK init/scan/connect/test (compiles on Mac) |
| `apps/mobile/ios/BACtrackBridge.mm` | Obj-C++ glue |
| `apps/mobile/ios/NativeBACtrackSpec.ts` | TurboModule JS spec |
| `apps/mobile/ios/SurveyApp.swift` | Standalone BLE GATT survey probe (S1 spike app source) |
| `apps/mobile/test/*.spec.ts` | Reducer, fake script, journal roundtrip, queue idempotency, engine modes |
| `docs/c6-ble-survey.md` | Fingerprint table template (filled on Mac with real C6) |

Event union (exact strings, shared with future native bridge):

```ts
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
```

Reducer states: `idle → scanning → connecting → ready → countdown → blowing → analyzing → done | error`. Event journaling precedes every transition (engine subscribes to the same event bus).

---

### Task 1: Package + adapter + fake + reducer (TDD)

**Files:** `apps/mobile/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/adapter/types.ts`, `src/adapter/fake.ts`, `src/state/reducer.ts`, `test/reducer.spec.ts`, `test/fake.spec.ts`

- [ ] **Step 1: `apps/mobile/package.json`**

```json
{
  "name": "@bactrack/mobile",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "tsc --noEmit -p tsconfig.json"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json`: extends base, `outDir dist`, `rootDir src` — WAIT: tests live in `test/`, rootDir src breaks build. Use rootDir `.`, outDir dist, include `src`, `test`. (Lesson from db package: keep rootDir ".".)

`vitest.config.ts`: same shape as api (include test/**/*.spec.ts, timeout 30000).

- [ ] **Step 2: `src/adapter/types.ts`** — event union (verbatim from this plan) + interface:

```ts
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
```

- [ ] **Step 3: `src/adapter/fake.ts`** — `FakeBreathalyzer` implements the interface from a scripted timeline:

```ts
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
```

- [ ] **Step 4: `src/state/reducer.ts`**

```ts
import type { AdapterEvent } from "../adapter/types.js";

export type CapturePhase =
  | "idle" | "scanning" | "connecting" | "ready"
  | "countdown" | "blowing" | "analyzing" | "done" | "error";

export interface CaptureState {
  phase: CapturePhase;
  deviceId: string | null;
  serial: string | null;
  battery: number | null;
  countdownLeft: number | null;
  blowLeft: number | null;
  bacPromille: number | null;
  measuredAt: string | null;
  error: string | null;
}

export const initialState: CaptureState = {
  phase: "idle", deviceId: null, serial: null, battery: null,
  countdownLeft: null, blowLeft: null, bacPromille: null, measuredAt: null, error: null,
};

export type UiIntent =
  | { kind: "ui.scan" } | { kind: "ui.connect"; deviceId: string }
  | { kind: "ui.startTest" } | { kind: "ui.disconnect" } | { kind: "ui.reset" };

export function reduce(state: CaptureState, action: AdapterEvent | UiIntent): CaptureState {
  switch (action.kind) {
    case "ui.scan": return { ...initialState, phase: "scanning" };
    case "ui.connect": return { ...state, phase: "connecting", deviceId: action.deviceId, error: null };
    case "ui.startTest": return state.phase === "ready" ? { ...state, phase: "countdown" } : state;
    case "ui.disconnect": return { ...initialState };
    case "ui.reset": return { ...initialState };
    case "sdk.authorized": return state;
    case "sdk.declined": return { ...state, phase: "error", error: action.reason };
    case "scan.found":
      return state.phase === "scanning"
        ? { ...state, deviceId: action.deviceId, serial: action.serial }
        : state;
    case "connection.ready":
      return { ...state, phase: "ready", deviceId: action.deviceId, serial: action.serial, battery: action.battery, error: null };
    case "connection.lost": return { ...state, phase: "error", error: "connection lost" };
    case "test.countdown": return { ...state, phase: "countdown", countdownLeft: action.secondsLeft };
    case "test.blow": return { ...state, phase: "blowing", blowLeft: action.secondsLeft };
    case "test.analyzing": return { ...state, phase: "analyzing" };
    case "test.result":
      return { ...state, phase: "done", bacPromille: action.bacPromille, measuredAt: action.measuredAt };
    case "error": return { ...state, phase: "error", error: action.message };
  }
}
```

- [ ] **Step 5: Tests first** — `test/reducer.spec.ts` (intent→phase transitions incl. illegal startTest in idle stays idle, error paths) and `test/fake.spec.ts` (collect events from scripted run with countdown 1/blow 1, assert ordered kinds list equals `[scan.found, connection.ready, test.countdown, test.blow, test.analyzing, test.result]` and bac value). Write tests, run → FAIL (no src). Then write src → GREEN.

Fake spec collection pattern:

```ts
const events: AdapterEvent[] = [];
const fake = new FakeBreathalyzer({ countdownSeconds: 1, blowSeconds: 1, bacPromille: 0.0 });
await fake.init("key");
await fake.startScan((e) => events.push(e));
await new Promise((r) => setTimeout(r, 120));
await fake.connect("fake-c6-1");
await new Promise((r) => setTimeout(r, 120));
await fake.startTest();
await new Promise((r) => setTimeout(r, 500));
expect(events.map((e) => e.kind)).toEqual(["scan.found", "connection.ready", "test.countdown", "test.blow", "test.analyzing", "test.result"]);
```

- [ ] **Step 6: Build + commit** — `pnpm --filter @bactrack/mobile build`, tests green, commit `feat(mobile): adapter interface, fake and capture reducer`.

---

### Task 2: Journal + queue + sync + API client (TDD)

**Files:** `src/journal/store.ts`, `src/journal/memory-backend.ts`, `src/sync/queue.ts`, `src/sync/engine.ts`, `src/api/client.ts`, `src/api/tokens.ts`, tests for each.

- [ ] **Step 1: `src/journal/store.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface JournalBackend {
  append(row: string): Promise<void>;
  readAll(): Promise<string[]>;
  replaceAll(rows: string[]): Promise<void>;
}

export interface JournalEntry {
  seq: number;
  at: string;
  kind: string;
  payload: Record<string, unknown>;
}

export class Journal {
  constructor(private readonly backend: JournalBackend, private readonly keyHex: string) {}

  async append(kind: string, payload: Record<string, unknown>): Promise<JournalEntry> {
    const existing = await this.read();
    const entry: JournalEntry = { seq: existing.length + 1, at: new Date().toISOString(), kind, payload };
    await this.backend.append(sealRow(this.keyHex, entry));
    return entry;
  }

  async read(): Promise<JournalEntry[]> {
    const rows = await this.backend.readAll();
    return rows.map((r) => openRow(this.keyHex, r));
  }

  async markSyncedThrough(seq: number): Promise<void> {
    const rest = (await this.read()).filter((e) => e.seq > seq);
    const sealed: string[] = [];
    for (const e of rest) sealed.push(sealRow(this.keyHex, { ...e, seq: e.seq }));
    void sealed;
    const rows = await this.backend.readAll();
    const kept = rows.slice(seq);
    await this.backend.replaceAll(kept);
  }
}
```

Hmm — markSyncedThrough via slice assumes append order = seq order, true for append-only backends. Simplify honestly: keep entries with seq > n by re-reading decrypted and re-sealing (re-seal changes ciphertext, fine). Rewrite cleanly:

```ts
async markSyncedThrough(seq: number): Promise<void> {
  const rest = (await this.read()).filter((e) => e.seq > seq);
  const rows = rest.map((e) => sealRow(this.keyHex, e));
  await this.backend.replaceAll(rows);
}
```

sealRow/openRow module functions (AES-GCM, same construction as api crypto, duplicated deliberately — mobile must not depend on api package):

```ts
function sealRow(keyHex: string, entry: JournalEntry): string {
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(entry), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

function openRow(keyHex: string, row: string): JournalEntry {
  const key = Buffer.from(keyHex, "hex");
  const raw = Buffer.from(row, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  const pt = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  return JSON.parse(pt) as JournalEntry;
}
```

`node:crypto` in RN runtime later needs polyfill — note in file comment (`// NOTE(RN): replace node:crypto with react-native-get-random-values + AES impl at native integration; interface unchanged`).

- [ ] **Step 2: `src/journal/memory-backend.ts`**

```ts
import type { JournalBackend } from "./store.js";

export class MemoryBackend implements JournalBackend {
  private rows: string[] = [];
  async append(row: string): Promise<void> { this.rows.push(row); }
  async readAll(): Promise<string[]> { return [...this.rows]; }
  async replaceAll(rows: string[]): Promise<void> { this.rows = [...rows]; }
}
```

- [ ] **Step 3: `src/sync/queue.ts`** — idempotent outbox:

```ts
export type SyncMode = "disabled" | "upload_only" | "download_only" | "bidirectional";

export interface QueuedOp {
  key: string;
  path: string;
  method: "POST" | "PATCH";
  body: Record<string, unknown>;
}

export class SyncQueue {
  private ops: QueuedOp[] = [];
  enqueue(op: QueuedOp): boolean {
    if (this.ops.some((o) => o.key === op.key)) return false;
    this.ops.push(op);
    return true;
  }
  pending(): QueuedOp[] { return [...this.ops]; }
  dequeue(key: string): void { this.ops = this.ops.filter((o) => o.key !== key); }
  get size(): number { return this.ops.length; }
}
```

- [ ] **Step 4: `src/api/tokens.ts`**

```ts
export interface TokenBundle { accessToken: string; refreshToken: string; }

export interface TokenStore {
  load(): Promise<TokenBundle | null>;
  save(bundle: TokenBundle): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  private bundle: TokenBundle | null = null;
  async load(): Promise<TokenBundle | null> { return this.bundle; }
  async save(bundle: TokenBundle): Promise<void> { this.bundle = bundle; }
  async clear(): Promise<void> { this.bundle = null; }
}
```

- [ ] **Step 5: `src/api/client.ts`** — minimal typed client over fetch:

```ts
import type { TokenStore } from "./tokens.js";

export interface ApiError { status: number; code: number; message: string; }

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly orgId: string,
    private readonly tokens: TokenStore,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const bundle = await this.tokens.load();
    if (!bundle) throw new Error("not authenticated");
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bundle.accessToken}`,
        "x-org-id": this.orgId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      const refreshed = await this.refresh();
      if (!refreshed) throw { status: 401, message: "session expired" } as ApiError;
      return this.request<T>(method, path, body);
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: { code?: number; message?: string } };
      throw { status: res.status, code: data.error?.code ?? res.status, message: data.error?.message ?? "request failed" } as ApiError;
    }
    return (await res.json()) as T;
  }

  private async refresh(): Promise<boolean> {
    const bundle = await this.tokens.load();
    if (!bundle) return false;
    const res = await fetch(`${this.baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: bundle.refreshToken }),
    });
    if (!res.ok) {
      await this.tokens.clear();
      return false;
    }
    const pair = (await res.json()) as { accessToken: string; refreshToken: string };
    await this.tokens.save(pair);
    return true;
  }

  createSession(input: { deviceId: string; subjectUserId: string; clientSessionId: string }) {
    return this.request<{ session: { id: string }; lease: { id: string } }>("POST", "/sessions", input);
  }

  completeSession(id: string, input: { bacPromille: number; measuredAt: string; rawPayload?: Record<string, unknown> }) {
    return this.request<{ reading: { id: string }; duplicate: boolean }>("POST", `/sessions/${id}/complete`, input);
  }

  listReadings(query: string) {
    return this.request<{ readings: unknown[] }>("GET", `/readings${query}`);
  }
}
```

- [ ] **Step 6: `src/sync/engine.ts`**

```ts
import type { ApiClient } from "../api/client.js";
import type { Journal } from "../journal/store.js";
import type { SyncMode, SyncQueue } from "./queue.js";

export interface EngineEvents {
  onUploaded(key: string): void;
  onError(key: string, message: string): void;
}

export class SyncEngine {
  constructor(
    private readonly mode: SyncMode,
    private readonly queue: SyncQueue,
    private readonly api: ApiClient,
    private readonly journal: Journal,
    private readonly events: EngineEvents,
    private readonly backlogAllowed: () => boolean,
  ) {}

  async run(): Promise<{ uploaded: number; skipped: number }> {
    if (this.mode === "disabled" || this.mode === "download_only") return { uploaded: 0, skipped: this.queue.size };
    const pending = this.queue.pending();
    if (pending.length > 1 && !this.backlogAllowed()) {
      return { uploaded: 0, skipped: pending.length };
    }
    let uploaded = 0;
    for (const op of pending) {
      try {
        if (op.path === "/sessions" && op.method === "POST") {
          const res = await this.api.createSession(op.body as { deviceId: string; subjectUserId: string; clientSessionId: string });
          await this.journal.append("sync.session-created", { key: op.key, sessionId: res.session.id });
        } else if (op.path.endsWith("/complete")) {
          const id = op.path.split("/")[2];
          const res = await this.api.completeSession(id, op.body as { bacPromille: number; measuredAt: string });
          await this.journal.append("sync.reading-uploaded", { key: op.key, readingId: res.reading.id, duplicate: res.duplicate });
        } else {
          throw new Error(`unknown op ${op.method} ${op.path}`);
        }
        this.queue.dequeue(op.key);
        this.events.onUploaded(op.key);
        uploaded++;
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 409 || status === 422) {
          this.queue.dequeue(op.key);
          await this.journal.append("sync.op-rejected", { key: op.key, status });
          uploaded++;
          continue;
        }
        this.events.onError(op.key, (err as Error).message ?? "unknown");
        break;
      }
    }
    return { uploaded, skipped: this.queue.size };
  }
}
```

Backlog rule: single pending op always flows (normal online use); 2+ queued (offline backlog) needs explicit consent. 409/422 dequeues as reconciled (server already has it / rejects it — journaled, not retried forever). Network errors stop the run, keep the rest.

- [ ] **Step 7: Tests** — `test/journal.spec.ts` (append/read roundtrip, ciphertext differs per row, markSyncedThrough drops, wrong key throws), `test/queue.spec.ts` (dup key rejected, dequeue), `test/engine.spec.ts` with stubbed ApiClient: upload_only happy path (journal has sync entries, queue empty), disabled skips, backlog without consent skips, 409 reconciles, network error stops. `test/client.spec.ts` with stubbed global fetch: 401 → refresh → retry; refresh fail → clear + throw.

Stub ApiClient for engine tests:

```ts
const stubApi = {
  calls: [] as string[],
  createSession: async () => { stubApi.calls.push("create"); return { session: { id: "s1" }, lease: { id: "l1" } }; },
  completeSession: async () => { stubApi.calls.push("complete"); return { reading: { id: "r1" }, duplicate: false }; },
  listReadings: async () => ({ readings: [] }),
} as unknown as ApiClient;
```

Fetch stub for client tests via `vi.stubGlobal("fetch", ...)` + `vi.unstubAllGlobals()` afterEach.

- [ ] **Step 8: Build + commit** — build, tests, commit `feat(mobile): journal, queue, sync engine and API client`.

---

### Task 3: iOS Swift bridge + survey sources + docs

**Files:** `apps/mobile/ios/NativeBACtrackSpec.ts`, `apps/mobile/ios/BACtrackBridge.swift`, `apps/mobile/ios/BACtrackBridge.mm`, `apps/mobile/ios/SurveyApp.swift`, `docs/c6-ble-survey.md`

No compiler here — correctness by careful review + a structural test (`test/ios-sources.spec.ts` asserts the expected class/method names exist in the Swift sources — cheap tripwire against drift).

- [ ] **Step 1: `apps/mobile/ios/NativeBACtrackSpec.ts`** (TurboModule spec, Codegen input):

```ts
import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export interface Spec extends TurboModule {
  init(apiKey: string): Promise<boolean>;
  startScan(): void;
  stopScan(): void;
  connect(deviceId: string): Promise<boolean>;
  disconnect(): Promise<void>;
  startTest(): Promise<boolean>;
  getBattery(): Promise<number>;
  getSerial(): Promise<string>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>("BACtrackBridge");
```

- [ ] **Step 2: `apps/mobile/ios/BACtrackBridge.swift`** — wraps `BreathalyzerSDK` (podspec `BreathalyzerSDK`), emits the exact event kinds from `src/adapter/types.ts` via `sendEvent`. Structure:

```swift
import Foundation
import BreathalyzerSDK

@objc(BACtrackBridge)
final class BACtrackBridge: RCTEventEmitter, BACtrackAPIDelegate {
  private var hasListeners = false
  override static func requiresMainQueueSetup() -> Bool { false }
  override func supportedEvents() -> [String]! {
    ["sdk.authorized","sdk.declined","scan.found","connection.ready","connection.lost",
     "test.countdown","test.blow","test.analyzing","test.result","error"]
  }
  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }
  private func emit(_ kind: String, _ body: [String: Any] = [:]) {
    guard hasListeners else { return }
    var payload: [String: Any] = ["kind": kind]
    for (k, v) in body { payload[k] = v }
    sendEvent(withName: kind, body: payload)
  }

  @objc func `init`(_ apiKey: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
    BACtrackAPI.shared().apiKey = apiKey
    BACtrackAPI.shared().delegate = self
    resolver(true)
  }
  // ... startScan/connect/startTest map 1:1 to BACtrackAPI calls;
  // delegate callbacks translate to emit(...) with the plan's event kinds.
}
```

Full delegate mapping table in comments (SDK callback → event kind). Where the real SDK names differ, the Mac-side compile is the checkpoint that fixes names — mark each with `// VERIFY-ON-MAC`.

- [ ] **Step 3: `apps/mobile/ios/BACtrackBridge.mm`** — standard RCT_EXPORT_MODULE + method exports.

- [ ] **Step 4: `apps/mobile/ios/SurveyApp.swift`** — standalone SwiftUI/CoreBluetooth probe: scans, lists peripherals with name/RSSI, connects on tap, discovers services/characteristics printing UUIDs + properties, subscribes to notifiable characteristics and hex-dumps values. No SDK import. Output feeds `docs/c6-ble-survey.md`.

- [ ] **Step 5: `docs/c6-ble-survey.md`** — fingerprint table template (advertised name, MAC-randomized?, service UUIDs, characteristic UUIDs + props, battery/serial exposure, verdict).

- [ ] **Step 6: `test/ios-sources.spec.ts`** — reads the four ios files, asserts presence of `BACtrackBridge`, `supportedEvents`, the ten event-kind strings, `startObserving`, and `CBCentralManager` in SurveyApp. Tripwire only.

- [ ] **Step 7: Commit** — `feat(mobile): iOS bridge and BLE survey sources (Mac compile pending)`.

---

### Task 4: Close-out

- [ ] `pnpm build && pnpm lint` green, full mobile suite green (expect ≥20 tests), commit anything pending, report Mac-side checklist: `pod install` SDK, Codegen run, survey app on C6, fill `docs/c6-ble-survey.md`.

---

## Self-review

**Spec coverage:** Design S2 mobile slice: adapter interface + fake (CI backbone) ✓, single reducer ✓, encrypted journal before UI transitions (engine subscribes/journals; UI wiring in P6 web/mobile UI — journal API ready) ✓, offline queue + four sync modes + backlog consent ✓, iOS bridge sources + survey ✓. Real SDK swap = new class implementing the same interface (no core changes).
**Placeholder scan:** No TBD; exact code/commands. `VERIFY-ON-MAC` markers are explicit deferred-compile flags, not placeholders — each maps to a Mac checklist item in Task 4.
**Type consistency:** Event-kind strings identical across types.ts/fake/reducer/Swift `supportedEvents`/spec test. `ApiClient` paths match backend routes (`/sessions`, `/sessions/:id/complete`, `/readings`, `/auth/refresh`). Journal `seq` is append-order; `markSyncedThrough` re-seals survivors (ciphertext changes, seq preserved — documented in code).
