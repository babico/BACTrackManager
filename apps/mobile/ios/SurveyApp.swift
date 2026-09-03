// SurveyApp.swift — standalone BLE GATT survey probe (S1 spike, NO SDK).
// Build as a throwaway single-view app on Mac (Xcode 16, iOS 17+ target),
// run next to the powered-on C6, tap the device, copy the dump into
// docs/c6-ble-survey.md. No API key needed. Delete after fingerprinting.

import SwiftUI
import CoreBluetooth

final class SurveyCentral: NSObject, ObservableObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  @Published var lines: [String] = []
  @Published var devices: [CBPeripheral] = []
  private var central: CBCentralManager!
  private var seen: Set<UUID> = []

  override init() {
    super.init()
    central = CBCentralManager(delegate: self, queue: nil)
  }

  func log(_ s: String) {
    DispatchQueue.main.async { self.lines.append(s) }
    print(s)
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    log("central state: \(central.state.rawValue)")
    if central.state == .poweredOn { central.scanForPeripherals(withServices: nil) }
  }

  func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    guard !seen.contains(peripheral.identifier) else { return }
    seen.insert(peripheral.identifier)
    DispatchQueue.main.async { self.devices.append(peripheral) }
    log("FOUND name=\(peripheral.name ?? "?") id=\(peripheral.identifier) rssi=\(RSSI) adv=\(advertisementData)")
  }

  func inspect(_ peripheral: CBPeripheral) {
    central.stopScan()
    peripheral.delegate = self
    log("connecting \(peripheral.identifier)")
    central.connect(peripheral)
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    log("connected; discovering services")
    peripheral.discoverServices(nil)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    if let error { log("services error: \(error)"); return }
    for s in peripheral.services ?? [] {
      log("SERVICE \(s.uuid)")
      peripheral.discoverCharacteristics(nil, for: s)
    }
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didDiscoverCharacteristicsFor service: CBService,
    error: Error?
  ) {
    if let error { log("chars error: \(error)"); return }
    for c in service.characteristics ?? [] {
      var props: [String] = []
      if c.properties.contains(.read) { props.append("read") }
      if c.properties.contains(.write) { props.append("write") }
      if c.properties.contains(.writeWithoutResponse) { props.append("writeNR") }
      if c.properties.contains(.notify) { props.append("notify") }
      if c.properties.contains(.indicate) { props.append("indicate") }
      log("CHAR svc=\(service.uuid) uuid=\(c.uuid) props=\(props.joined(separator: ","))")
      if c.properties.contains(.read) { peripheral.readValue(for: c) }
      if c.properties.contains(.notify) { peripheral.setNotifyValue(true, for: c) }
    }
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    let hex = (characteristic.value ?? Data()).map { String(format: "%02x", $0) }.joined()
    log("VALUE uuid=\(characteristic.uuid) hex=\(hex)")
  }
}

struct SurveyView: View {
  @StateObject private var survey = SurveyCentral()
  var body: some View {
    NavigationView {
      List {
        Section("Devices (tap to inspect)") {
          ForEach(survey.devices, id: \.identifier) { d in
            Button(d.name ?? d.identifier.uuidString) { survey.inspect(d) }
          }
        }
        Section("Log") {
          ForEach(survey.lines.indices, id: \.self) { i in
            Text(survey.lines[i]).font(.system(size: 10, design: .monospaced))
          }
        }
      }
      .navigationTitle("C6 survey")
    }
  }
}
