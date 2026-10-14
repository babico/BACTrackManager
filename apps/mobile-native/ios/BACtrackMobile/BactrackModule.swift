import CoreBluetooth
import CoreLocation
import CryptoKit
import Foundation
import React
import Security
import SQLite3

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

@objc(BactrackModule)
final class BactrackModule: RCTEventEmitter, CBCentralManagerDelegate, CBPeripheralDelegate, CLLocationManagerDelegate {
  private let advertisedService = CBUUID(string: "D12EFFF0-1243-47A9-952C-F962382D49BB")
  private let breathService = CBUUID(string: "862BFFF0-7D59-4359-8B59-A96DB28BC679")
  private let breathCharacteristic = CBUUID(string: "862BFFF1-7D59-4359-8B59-A96DB28BC679")
  private let store = IOSLocalReadingStore()
  private let locationManager = CLLocationManager()
  private var central: CBCentralManager!
  private var peripheral: CBPeripheral?
  private var breath: CBCharacteristic?
  private var scanTimer: Timer?
  private var testActive = false
  private var pendingLocation: [String: Double]?
  private var connectedIdentity: String?
  private var deviceNames: [String: String] = [:]
  private var lastBatteryRequest = Date.distantPast
  private var pendingLocationResolve: RCTPromiseResolveBlock?
  private var locationTimeout: DispatchWorkItem?

  override init() {
    super.init()
    central = CBCentralManager(delegate: self, queue: .main)
    locationManager.delegate = self
  }

  override static func requiresMainQueueSetup() -> Bool { true }
  override func supportedEvents() -> [String]! {
    ["bactrack.localReadingSaved", "bactrack.localSaveError", "bactrack.localBleDevice", "bactrack.localBleState", "bactrack.localDeviceInfo", "bactrack.localBattery", "bactrack.localTestState"]
  }

  private func emit(_ event: String, _ body: [String: Any]) { sendEvent(withName: event, body: body) }
  private func state(_ value: String) { emit("bactrack.localBleState", ["value": value]) }

  @objc(startLocalScan:rejecter:)
  func startLocalScan(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard central.state == .poweredOn else { reject("BLE_UNAVAILABLE", "Turn on Bluetooth and allow Bluetooth access.", nil); return }
    stopScan()
    deviceNames.removeAll()
    state("scanning")
    central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    scanTimer = Timer.scheduledTimer(withTimeInterval: 12, repeats: false) { [weak self] _ in
      self?.stopScan()
      self?.state("scan complete")
    }
    resolve(true)
  }

  @objc(stopLocalScan)
  func stopLocalScan() { stopScan() }
  private func stopScan() { central?.stopScan(); scanTimer?.invalidate(); scanTimer = nil }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    if central.state == .poweredOn { state("Bluetooth ready") }
    else { state("Bluetooth unavailable (state \(central.state.rawValue))") }
  }

  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
    let name = peripheral.name ?? advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? "BACtrack"
    let serviceIds = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
    guard name.localizedCaseInsensitiveContains("BACtrack") || serviceIds.contains(advertisedService) else { return }
    let id = peripheral.identifier.uuidString
    deviceNames[id] = name
    emit("bactrack.localBleDevice", ["address": id, "name": name, "rssi": RSSI.intValue])
  }

  @objc(connectLocalDevice:resolver:rejecter:)
  func connectLocalDevice(_ identifier: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let id = UUID(uuidString: identifier), central.state == .poweredOn else { reject("BLE_UNAVAILABLE", "Bluetooth is unavailable.", nil); return }
    stopScan()
    if let found = central.retrievePeripherals(withIdentifiers: [id]).first {
      peripheral = found
      connectedIdentity = identifier
      found.delegate = self
      state("connecting to \(deviceNames[identifier] ?? found.name ?? "BACtrack")")
      central.connect(found)
      resolve(true)
    } else { reject("BLE_DEVICE_NOT_FOUND", "The selected breathalyzer is no longer available. Scan again.", nil) }
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    state("connected; discovering GATT services")
    peripheral.discoverServices(nil)
  }
  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    state("GATT connection error: \(error?.localizedDescription ?? "unknown")")
  }
  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    breath = nil; testActive = false; connectedIdentity = nil
    state("disconnected")
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard error == nil else { state("GATT service discovery failed"); return }
    peripheral.services?.forEach { peripheral.discoverCharacteristics(nil, for: $0) }
  }
  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    guard error == nil else { state("GATT characteristic discovery failed"); return }
    for characteristic in service.characteristics ?? [] {
      if service.uuid == breathService && characteristic.uuid == breathCharacteristic { breath = characteristic }
      if characteristic.properties.contains(.notify) || characteristic.properties.contains(.indicate) { peripheral.setNotifyValue(true, for: characteristic) }
      if characteristic.properties.contains(.read) { peripheral.readValue(for: characteristic) }
    }
  }
  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    guard error == nil, characteristic.uuid == breathCharacteristic else { return }
    if characteristic.isNotifying, let breath, breath.properties.contains(.writeWithoutResponse) {
      state("connected; local C6 test ready")
      requestBattery()
    }
  }
  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    guard error == nil, let bytes = characteristic.value, !bytes.isEmpty else { return }
    if characteristic.uuid == CBUUID(string: "2A24") || characteristic.uuid == CBUUID(string: "2A26") || characteristic.uuid == CBUUID(string: "2A27") || characteristic.uuid == CBUUID(string: "2A28") || characteristic.uuid == CBUUID(string: "2A29") {
      let fields = ["2A24": "model", "2A26": "firmware", "2A27": "hardwareRevision", "2A28": "softwareRevision", "2A29": "manufacturer"]
      if let field = fields[characteristic.uuid.uuidString], let value = String(data: bytes, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty { emit("bactrack.localDeviceInfo", ["field": field, "value": value]) }
    }
    guard characteristic.uuid == breathCharacteristic else { return }
    let packet = [UInt8](bytes)
    if packet[0] == 0x88, packet.count >= 3 {
      let voltage = Double((Int(packet[1]) << 8) | Int(packet[2])) / 1000
      let level = voltage < 1 ? 0 : voltage < 1.25 ? 1 : voltage < 1.5 ? 2 : voltage < 1.6 ? 3 : 4
      emit("bactrack.localBattery", ["voltage": voltage, "level": level]); return
    }
    guard testActive, packet[0] == 0x80, packet.count >= 2 else { return }
    switch packet[1] {
    case 1: emit("bactrack.localTestState", ["value": packet.count > 2 ? "Device countdown: \(packet[2])" : "Device countdown"])
    case 2: emit("bactrack.localTestState", ["value": "Blow steadily into the breathalyzer now."])
    case 3: emit("bactrack.localTestState", ["value": "Keep blowing steadily…"])
    case 4, 5: emit("bactrack.localTestState", ["value": "Analyzing breath sample…"])
    case 6:
      guard packet.count >= 5 else { emit("bactrack.localTestState", ["value": "Device returned an incomplete result packet."]); return }
      let bac = Double((Int(packet[3]) << 8) | Int(packet[4])) / 1000
      testActive = false
      do {
        let reading = try store.add(bac: bac, identity: connectedIdentity, location: pendingLocation)
        pendingLocation = nil
        emit("bactrack.localReadingSaved", reading)
        emit("bactrack.localTestState", ["value": "Result received: \(bac)% BAC; saving encrypted on this device."])
      } catch { emit("bactrack.localSaveError", ["value": error.localizedDescription]) }
    case 7, 8, 9, 10, 11, 12, 14, 15:
      testActive = false; pendingLocation = nil
      emit("bactrack.localTestState", ["value": "Breathalyzer stopped the test (device code \(packet[1]))."])
    default: emit("bactrack.localTestState", ["value": "Device test state \(packet[1])"])
    }
  }

  @objc(requestLocalBattery:rejecter:)
  func requestLocalBattery(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard requestBattery() else { reject("LOCAL_BATTERY_REQUEST_FAILED", "Could not request battery status.", nil); return }; resolve(true)
  }
  private func requestBattery() -> Bool {
    guard let peripheral, let breath, breath.properties.contains(.writeWithoutResponse) else { return false }
    peripheral.writeValue(Data([0x08]), for: breath, type: .withoutResponse)
    lastBatteryRequest = Date()
    return true
  }

  @objc(startLocalBreathTest:rejecter:)
  func startLocalBreathTest(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard !testActive, let peripheral, let breath, breath.properties.contains(.writeWithoutResponse) else { reject("LOCAL_TEST_NOT_READY", "Connect to a BACtrack C6 device before starting a local test.", nil); return }
    testActive = true
    peripheral.writeValue(Data([0x00, 0x01]), for: breath, type: .withoutResponse)
    emit("bactrack.localTestState", ["value": "Local test request sent; wait for the breathalyzer countdown."])
    resolve(true)
  }

  @objc(disconnectLocalDevice)
  func disconnectLocalDevice() { if let peripheral { central.cancelPeripheralConnection(peripheral) } }
  @objc(setPendingTestLocation:resolver:rejecter:)
  func setPendingTestLocation(_ location: NSDictionary?, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    pendingLocation = location as? [String: Double]; resolve(true)
  }
  @objc(getConnectedLocalDeviceIdentity:rejecter:)
  func getConnectedLocalDeviceIdentity(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) { resolve(connectedIdentity) }
  @objc(getLocalDeviceIdentity:resolver:rejecter:)
  func getLocalDeviceIdentity(_ identifier: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) { resolve(identifier) }

  @objc(getCurrentLocation:rejecter:)
  func getCurrentLocation(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard CLLocationManager.locationServicesEnabled() else { resolve(nil); return }
    pendingLocationResolve = resolve
    locationTimeout?.cancel()
    let timeout = DispatchWorkItem { [weak self] in self?.finishLocation(nil) }
    locationTimeout = timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: timeout)
    switch locationManager.authorizationStatus {
    case .notDetermined: locationManager.requestWhenInUseAuthorization()
    case .authorizedAlways, .authorizedWhenInUse: locationManager.requestLocation()
    default: finishLocation(nil)
    }
  }
  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    if manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorizedWhenInUse { manager.requestLocation() }
    else if manager.authorizationStatus != .notDetermined { finishLocation(nil) }
  }
  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let location = locations.last else { finishLocation(nil); return }
    finishLocation(["latitude": location.coordinate.latitude, "longitude": location.coordinate.longitude, "accuracy": location.horizontalAccuracy, "timestamp": location.timestamp.timeIntervalSince1970 * 1000])
  }
  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { finishLocation(nil) }
  private func finishLocation(_ value: [String: Double]?) {
    guard let resolve = pendingLocationResolve else { return }
    pendingLocationResolve = nil
    locationTimeout?.cancel(); locationTimeout = nil
    resolve(value)
  }

  @objc(getLocalReadings:rejecter:)
  func getLocalReadings(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) { promise(resolve, reject, operation: { try self.store.all() }) }
  @objc(getUnsyncedLocalReadings:rejecter:)
  func getUnsyncedLocalReadings(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) { promise(resolve, reject, operation: { try self.store.unsynced() }) }
  @objc(markLocalReadingsSynced:resolver:rejecter:)
  func markLocalReadingsSynced(_ ids: [String], resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) { promise(resolve, reject, operation: { try self.store.markSynced(ids); return true }) }
  @objc(importCloudReadings:resolver:rejecter:)
  func importCloudReadings(_ items: NSArray, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    promise(resolve, reject) {
      for item in items as? [[String: Any]] ?? [] {
        guard let id = item["id"] as? String, let value = item["bacPromille"] as? Double, let date = item["measuredAt"] as? String else { continue }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let measuredAt = formatter.date(from: date) ?? ISO8601DateFormatter().date(from: date)
        if let measuredAt { try self.store.addCloud(id: id, bac: value / 10, timestamp: measuredAt.timeIntervalSince1970 * 1000, identity: item["deviceSerial"] as? String) }
      }
      return true
    }
  }
  @objc(clearLocalReadings:rejecter:)
  func clearLocalReadings(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) { promise(resolve, reject, operation: { try self.store.clear(); return true }) }
  @objc(getSecureValue:resolver:rejecter:)
  func getSecureValue(_ key: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) { resolve(store.secureValue(key)) }
  @objc(setSecureValue:value:resolver:rejecter:)
  func setSecureValue(_ key: String, value: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) { store.setSecureValue(key, value); resolve(true) }
  @objc(clearSecureValue:resolver:rejecter:)
  func clearSecureValue(_ key: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) { store.setSecureValue(key, ""); resolve(true) }
  private func promise<T>(_ resolve: @escaping RCTPromiseResolveBlock, _ reject: @escaping RCTPromiseRejectBlock, operation: @escaping () throws -> T) {
    DispatchQueue.global(qos: .utility).async { do { resolve(try operation()) } catch { reject("LOCAL_STORAGE_FAILED", error.localizedDescription, error) } }
  }
  override func invalidate() { stopScan(); if let peripheral { central.cancelPeripheralConnection(peripheral) }; store.close(); super.invalidate() }
}

private final class IOSLocalReadingStore {
  private var db: OpaquePointer?
  private let keyAccount = "bactrack.local-readings.v1"
  init() {
    let path = NSSearchPathForDirectoriesInDomains(.applicationSupportDirectory, .userDomainMask, true)[0] + "/local_readings.sqlite"
    try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    guard sqlite3_open(path, &db) == SQLITE_OK else { return }
    sqlite3_exec(db, "CREATE TABLE IF NOT EXISTS readings (id TEXT PRIMARY KEY NOT NULL, payload BLOB NOT NULL); CREATE TABLE IF NOT EXISTS synced (id TEXT PRIMARY KEY NOT NULL); CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, payload BLOB NOT NULL);", nil, nil, nil)
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    var url = URL(fileURLWithPath: path); try? url.setResourceValues(values)
  }
  func close() { sqlite3_close(db); db = nil }
  private func key() -> SymmetricKey {
    if let existing = keychainData(), existing.count == 32 { return SymmetricKey(data: existing) }
    let data = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: keyAccount, kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
    SecItemAdd(query as CFDictionary, nil)
    return SymmetricKey(data: data)
  }
  private func keychainData() -> Data? {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: keyAccount, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
    return result as? Data
  }
  private func seal(_ data: Data) throws -> Data { try AES.GCM.seal(data, using: key()).combined! }
  private func open(_ data: Data) throws -> Data { try AES.GCM.SealedBox(combined: data).with { try AES.GCM.open($0, using: key()) } }
  private func execute(_ sql: String, _ values: [Any] = []) throws {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw NSError(domain: "LocalStore", code: 1) }
    defer { sqlite3_finalize(statement) }
    for (index, value) in values.enumerated() {
      let slot = Int32(index + 1)
      if let data = value as? Data { data.withUnsafeBytes { sqlite3_bind_blob(statement, slot, $0.baseAddress, Int32(data.count), SQLITE_TRANSIENT) } }
      else { (value as! String).withCString { sqlite3_bind_text(statement, slot, $0, -1, SQLITE_TRANSIENT) } }
    }
    guard sqlite3_step(statement) == SQLITE_DONE else { throw NSError(domain: "LocalStore", code: 2) }
  }
  private func rows(_ sql: String) throws -> [[String: Any]] {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw NSError(domain: "LocalStore", code: 3) }
    defer { sqlite3_finalize(statement) }
    var result: [[String: Any]] = []
    while sqlite3_step(statement) == SQLITE_ROW {
      let id = String(cString: sqlite3_column_text(statement, 0))
      let count = Int(sqlite3_column_bytes(statement, 1))
      guard let bytes = sqlite3_column_blob(statement, 1) else { continue }
      let payload = Data(bytes: bytes, count: count)
      if let json = try JSONSerialization.jsonObject(with: open(payload)) as? [String: Any] { result.append(["id": id, "payload": json]) }
    }
    return result
  }
  func add(bac: Double, identity: String?, location: [String: Double]?) throws -> [String: Any] {
    let id = UUID().uuidString.lowercased()
    var item: [String: Any] = ["id": id, "bacPercent": bac, "measuredAt": Date().timeIntervalSince1970 * 1000]
    if let identity { item["serial"] = identity }
    if let location { item.merge(location) { _, new in new }; item["locationCapturedAt"] = Date().timeIntervalSince1970 * 1000 }
    let data = try JSONSerialization.data(withJSONObject: item)
    try execute("INSERT INTO readings(id,payload) VALUES(?,?)", [id, seal(data)])
    return item
  }
  func all() throws -> [[String: Any]] {
    try rows("SELECT id,payload FROM readings").compactMap { row in
      guard var item = row["payload"] as? [String: Any], let id = row["id"] as? String else { return nil }
      item["synced"] = isSynced(id)
      return item
    }.sorted { ($0["measuredAt"] as? Double ?? 0) > ($1["measuredAt"] as? Double ?? 0) }
  }
  func unsynced() throws -> [[String: Any]] { try all().filter { !($0["cloud"] as? Bool ?? false) && !($0["synced"] as? Bool ?? false) } }
  func markSynced(_ ids: [String]) throws { for id in ids { try execute("INSERT OR IGNORE INTO synced(id) VALUES(?)", [id]) } }
  private func isSynced(_ id: String) -> Bool {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, "SELECT 1 FROM synced WHERE id=?", -1, &statement, nil) == SQLITE_OK else { return false }
    defer { sqlite3_finalize(statement) }
    id.withCString { sqlite3_bind_text(statement, 1, $0, -1, SQLITE_TRANSIENT) }
    return sqlite3_step(statement) == SQLITE_ROW
  }
  func addCloud(id: String, bac: Double, timestamp: Double, identity: String?) throws {
    var item: [String: Any] = ["id": id, "bacPercent": bac, "measuredAt": timestamp, "cloud": true, "synced": true]
    if let identity { item["serial"] = identity }
    try execute("INSERT OR IGNORE INTO readings(id,payload) VALUES(?,?)", [id, seal(try JSONSerialization.data(withJSONObject: item))])
    try markSynced([id])
  }
  func clear() throws { try execute("DELETE FROM readings"); try execute("DELETE FROM synced") }
  func secureValue(_ key: String) -> String? {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, "SELECT payload FROM settings WHERE key=?", -1, &statement, nil) == SQLITE_OK else { return nil }
    defer { sqlite3_finalize(statement) }
    key.withCString { sqlite3_bind_text(statement, 1, $0, -1, SQLITE_TRANSIENT) }
    guard sqlite3_step(statement) == SQLITE_ROW, let bytes = sqlite3_column_blob(statement, 0) else { return nil }
    let data = Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, 0)))
    return try? String(data: open(data), encoding: .utf8)
  }
  func setSecureValue(_ key: String, _ value: String) {
    guard let data = try? seal(Data(value.utf8)) else { return }
    try? execute("INSERT OR REPLACE INTO settings(key,payload) VALUES(?,?)", [key, data])
  }
}

private extension AES.GCM.SealedBox {
  func with<T>(_ body: (AES.GCM.SealedBox) throws -> T) rethrows -> T { try body(self) }
}
