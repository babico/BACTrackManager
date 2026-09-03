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
