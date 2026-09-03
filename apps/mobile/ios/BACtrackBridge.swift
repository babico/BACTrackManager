// BACtrackBridge.swift — TurboModule wrapping BreathalyzerSDK (CocoaPods).
// COMPILE ON MAC ONLY (Xcode 16, `pod install` with `pod 'BreathalyzerSDK'`).
// Event kinds MUST stay identical to apps/mobile/src/adapter/types.ts.
//
// SDK-callback → event-kind mapping (VERIFY-ON-MAC: confirm exact delegate
// method names against the installed BreathalyzerSDK version):
//   apiKey authorized        → sdk.authorized
//   apiKey declined          → sdk.declined {reason}
//   did discover peripheral  → scan.found {deviceId (UUID string), serial?, rssi}
//   did connect              → connection.ready {deviceId, serial, battery}
//   did disconnect           → connection.lost {deviceId}
//   countdown tick           → test.countdown {secondsLeft}
//   blow tick                → test.blow {secondsLeft}
//   analyzing started        → test.analyzing
//   result (BAC float)       → test.result {bacPromille, measuredAt (ISO-8601)}
//   any SDK error            → error {code, message}

import Foundation
// VERIFY-ON-MAC: module name exported by the BreathalyzerSDK pod.
// import BreathalyzerSDK

@objc(BACtrackBridge)
final class BACtrackBridge: RCTEventEmitter {
  private var hasListeners = false

  override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! {
    [
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
    ]
  }

  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  private func emit(_ kind: String, _ body: [String: Any] = [:]) {
    guard hasListeners else { return }
    var payload: [String: Any] = ["kind": kind]
    for (k, v) in body { payload[k] = v }
    sendEvent(withName: kind, body: payload)
  }

  // VERIFY-ON-MAC: replace bodies with real BreathalyzerSDK calls.
  // Shown shape: init(apiKey) → BACtrackAPI key + delegate assignment.

  @objc func `init`(
    _ apiKey: String,
    resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    guard !apiKey.isEmpty else {
      emit("sdk.declined", ["reason": "missing api key"])
      rejecter("E_NO_KEY", "missing api key", nil)
      return
    }
    // VERIFY-ON-MAC: BACtrackAPI.shared().apiKey = apiKey; delegate = self
    emit("sdk.authorized")
    resolver(true)
  }

  @objc func startScan() {
    // VERIFY-ON-MAC: BACtrackAPI.shared().connectToNearestBreathalyzer()
    // or startScanForBreathalyzers(); map discovery to scan.found.
  }

  @objc func stopScan() {
    // VERIFY-ON-MAC: cancel scan if the SDK exposes it.
  }

  @objc func connect(
    _ deviceId: String,
    resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    // VERIFY-ON-MAC: connect to cached peripheral by UUID string; on
    // success emit connection.ready {deviceId, serial, battery}.
    resolver(true)
  }

  @objc func disconnect(
    _ resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    // VERIFY-ON-MAC: BACtrackAPI.shared().disconnect()
    resolver(nil)
  }

  @objc func startTest(
    _ resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    // VERIFY-ON-MAC: BACtrackAPI.shared().startCountdown(); map the
    // five-step workflow (warmup/countdown/blow/analyze/result) to
    // test.countdown → test.blow → test.analyzing → test.result.
    resolver(true)
  }

  @objc func getBattery(
    _ resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    // VERIFY-ON-MAC: query device battery voltage/percent.
    resolver(87)
  }

  @objc func getSerial(
    _ resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    // VERIFY-ON-MAC: query device serial number.
    resolver("UNKNOWN")
  }
}
