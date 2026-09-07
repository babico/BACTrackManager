# Store Release Checklist (mobile native shells — Mac builds required)

Status: NOT STARTED (native shells don't exist yet; core is tested and
bridge sources are in `apps/mobile/ios/`).

## Identifiers (reserve now, cheap)

- iOS bundle ID: `com.bactrack.manager` (Team ID needed for Xcode signing).
- Android applicationId: `com.bactrack.manager`.
- Name: "BACTrack Manager". SKU consistent across stores.

## iOS (Xcode 16+, physical iPhone for BLE)

- [ ] `npx react-native init` integration of `apps/mobile` core (package exists standalone today).
- [ ] `pod install` with `pod 'BreathalyzerSDK'` (needs BACtrack developer key first).
- [ ] Codegen run validates `NativeBACtrackSpec.ts` ↔ `BACtrackBridge.mm`.
- [ ] `NSBluetoothAlwaysUsageDescription`: "BACtrack C6 ile ölçüm için Bluetooth gerekli."
- [ ] `NSLocationWhenInUseUsageDescription`: only if GPS tagging enabled (else omit the key entirely).
- [ ] Privacy manifest (`PrivacyInfo.xcprivacy`): no tracking domains; list collected data (BAC readings = health data → disclose).
- [ ] Background modes: NONE initially (foreground-only capture; background BLE is a separate review).
- [ ] TestFlight internal → external (100 seats) → App Review (health-data disclosures ready) → phased release 1%.

## Android (JDK 17, AGP 8)

- [ ] `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT` (never `ACCESS_FINE_LOCATION` unless GPS tagging on — declare separately).
- [ ] Play Console: health-data declaration, data-safety form (BAC = health info, encrypted at rest, no ads SDKs).
- [ ] Internal track → closed → production staged rollout.

## Kill-switch (before any public build)

- [ ] API flag to disable captures remotely (`GET /health` includes `captures_enabled`; clients refuse new sessions when false). NOT IMPLEMENTED — P10 follow-up.

## Rollout order

1. Internal team (TestFlight/internal track), fake adapter OFF, real C6 matrix.
2. External beta with consent + data-deletion path (`DELETE /auth/bactrack` exists; add full account delete — P10 follow-up).
3. Production staged.
