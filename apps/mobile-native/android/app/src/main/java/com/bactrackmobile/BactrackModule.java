package com.bactrackmobile;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import org.json.JSONObject;

import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class BactrackModule extends ReactContextBaseJavaModule {
    private static final java.util.UUID C6_BREATH_SERVICE = java.util.UUID.fromString("862bfff0-7d59-4359-8b59-a96db28bc679");
    private static final java.util.UUID C6_BREATH_CHARACTERISTIC = java.util.UUID.fromString("862bfff1-7d59-4359-8b59-a96db28bc679");
    private final ReactApplicationContext context;
    private final LocalReadingStore readingStore;
    private final ExecutorService storageExecutor = Executors.newSingleThreadExecutor();
    private BluetoothLeScanner localScanner;
    private BluetoothGatt localGatt;
    private boolean localScanRunning;
    private final Map<String, ScanUpdate> lastLocalScanUpdates = new HashMap<>();
    private final Queue<BluetoothGattDescriptor> pendingNotificationDescriptors = new ArrayDeque<>();
    private final Queue<BluetoothGattCharacteristic> pendingDeviceInfoReads = new ArrayDeque<>();
    private int localNotificationCount;
    private boolean localC6ProtocolReady;
    private boolean localTestActive;
    private JSONObject pendingTestLocation;
    private volatile String localDeviceSerial;
    private long localBlowStartedAt;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Runnable stopScanTimeout = this::stopLocalScanInternal;
    private final Runnable localBlowProgress = new Runnable() {
        @Override
        public void run() {
            if (!localTestActive) return;
            long elapsed = System.currentTimeMillis() - localBlowStartedAt;
            if (elapsed >= 4_000) {
                emit("bactrack.localTestState", "Analyzing breath sample…");
                return;
            }
            mainHandler.postDelayed(this, 100);
        }
    };

    BactrackModule(ReactApplicationContext context) {
        super(context);
        this.context = context;
        this.readingStore = new LocalReadingStore(context);
    }

    @Override
    public String getName() {
        return "BactrackModule";
    }

    private void emit(String name, String value) {
        WritableMap payload = Arguments.createMap();
        payload.putString("value", value);
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit(name, payload);
    }

    private synchronized void emitLocalDevice(ScanResult result) {
        BluetoothDevice device = result.getDevice();
        String address = device.getAddress();
        int rssi = result.getRssi();
        String name = safeDeviceName(device);
        boolean isBactrack = "BACtrack".equalsIgnoreCase(name);
        if (!isBactrack && result.getScanRecord() != null && result.getScanRecord().getServiceUuids() != null) {
            isBactrack = result.getScanRecord().getServiceUuids().stream()
                    .anyMatch(uuid -> "d12efff0-1243-47a9-952c-f962382d49bb".equalsIgnoreCase(uuid.toString()));
        }
        if (!isBactrack) return;
        long now = android.os.SystemClock.elapsedRealtime();
        ScanUpdate previous = lastLocalScanUpdates.get(address);
        if (previous != null && (now - previous.at < 1_000 || Math.abs(rssi - previous.rssi) < 5)) return;
        lastLocalScanUpdates.put(address, new ScanUpdate(now, rssi));
        WritableMap payload = Arguments.createMap();
        payload.putString("address", address);
        payload.putString("name", name);
        payload.putInt("rssi", rssi);
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit("bactrack.localBleDevice", payload);
    }

    private String safeDeviceName(BluetoothDevice device) {
        try {
            String name = device.getName();
            return name == null ? "Unnamed BLE device" : name;
        } catch (SecurityException error) {
            return "Name permission required";
        }
    }

    private final ScanCallback localScanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            emitLocalDevice(result);
        }

        @Override
        public void onBatchScanResults(List<ScanResult> results) {
            for (ScanResult result : results) emitLocalDevice(result);
        }

        @Override
        public void onScanFailed(int errorCode) {
            localScanRunning = false;
            mainHandler.removeCallbacks(stopScanTimeout);
            emit("bactrack.localBleState", "scan failed (" + errorCode + ")");
        }
    };

    private final BluetoothGattCallback localGattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                localC6ProtocolReady = false;
                localTestActive = false;
                mainHandler.removeCallbacks(localBlowProgress);
                emit("bactrack.localBleState", "GATT connection error " + status);
                gatt.close();
                if (localGatt == gatt) localGatt = null;
                return;
            }
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                emit("bactrack.localBleState", "connected; discovering GATT services");
                gatt.discoverServices();
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                emit("bactrack.localBleState", "disconnected");
                pendingNotificationDescriptors.clear();
                pendingDeviceInfoReads.clear();
                localNotificationCount = 0;
                localC6ProtocolReady = false;
                localTestActive = false;
                mainHandler.removeCallbacks(localBlowProgress);
                gatt.close();
                if (localGatt == gatt) localGatt = null;
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                emit("bactrack.localBleState", "GATT service discovery failed (" + status + ")");
                return;
            }
            BluetoothGattService breathService = gatt.getService(C6_BREATH_SERVICE);
            BluetoothGattCharacteristic breathCharacteristic = breathService == null
                    ? null : breathService.getCharacteristic(C6_BREATH_CHARACTERISTIC);
            int breathProperties = breathCharacteristic == null ? 0 : breathCharacteristic.getProperties();
            localC6ProtocolReady = breathCharacteristic != null
                    && (breathProperties & (BluetoothGattCharacteristic.PROPERTY_WRITE
                    | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE)) != 0
                    && (breathProperties & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0;
            pendingNotificationDescriptors.clear();
            pendingDeviceInfoReads.clear();
            for (BluetoothGattService service : gatt.getServices()) {
                for (BluetoothGattCharacteristic characteristic : service.getCharacteristics()) {
                    if (isSafeDeviceInfoCharacteristic(characteristic)) {
                        pendingDeviceInfoReads.add(characteristic);
                    }
                    int properties = characteristic.getProperties();
                    if ((properties & (BluetoothGattCharacteristic.PROPERTY_NOTIFY |
                            BluetoothGattCharacteristic.PROPERTY_INDICATE)) != 0) {
                        try {
                            if (gatt.setCharacteristicNotification(characteristic, true)) {
                                BluetoothGattDescriptor cccd = characteristic.getDescriptor(
                                        java.util.UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"));
                                if (cccd != null) {
                                    boolean indicate = (properties & BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0
                                            && (properties & BluetoothGattCharacteristic.PROPERTY_NOTIFY) == 0;
                                    cccd.setValue(indicate
                                            ? BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                                            : BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                                    pendingNotificationDescriptors.add(cccd);
                                }
                            }
                        } catch (SecurityException error) {
                            emit("bactrack.localBleState", "Bluetooth permission revoked while subscribing");
                            return;
                        }
                    }
                }
            }
            localNotificationCount = pendingNotificationDescriptors.size();
            if (localNotificationCount == 0) {
                emit("bactrack.localBleState", "connected; GATT discovery complete; no notification characteristics");
                readNextDeviceInfoCharacteristic(gatt);
            } else {
                emit("bactrack.localBleState", "connected; enabling " + localNotificationCount + " GATT notifications");
                writeNextNotificationDescriptor(gatt);
            }
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                emit("bactrack.localBleState", "GATT notification subscription failed (" + status + ")");
            }
            writeNextNotificationDescriptor(gatt);
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            appendDeviceInfoRead(characteristic, characteristic.getValue(), status);
            readNextDeviceInfoCharacteristic(gatt);
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value, int status) {
            appendDeviceInfoRead(characteristic, value, status);
            readNextDeviceInfoCharacteristic(gatt);
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            handleLocalC6Packet(characteristic, characteristic.getValue());
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value) {
            handleLocalC6Packet(characteristic, value);
        }
    };

    private void writeNextNotificationDescriptor(BluetoothGatt gatt) {
        BluetoothGattDescriptor descriptor = pendingNotificationDescriptors.poll();
        if (descriptor == null) {
            emit("bactrack.localBleState", "connected; subscribed to " + localNotificationCount + " GATT notifications");
            readNextDeviceInfoCharacteristic(gatt);
            return;
        }
        try {
            if (!gatt.writeDescriptor(descriptor)) writeNextNotificationDescriptor(gatt);
        } catch (SecurityException error) {
            pendingNotificationDescriptors.clear();
            emit("bactrack.localBleState", "Bluetooth permission revoked while subscribing");
        }
    }

    private boolean isSafeDeviceInfoCharacteristic(BluetoothGattCharacteristic characteristic) {
        if ((characteristic.getProperties() & BluetoothGattCharacteristic.PROPERTY_READ) == 0) return false;
        String uuid = characteristic.getUuid().toString();
        return uuid.equals("00002a24-0000-1000-8000-00805f9b34fb")
                || uuid.equals("00002a26-0000-1000-8000-00805f9b34fb")
                || uuid.equals("00002a27-0000-1000-8000-00805f9b34fb")
                || uuid.equals("00002a28-0000-1000-8000-00805f9b34fb")
                || uuid.equals("00002a29-0000-1000-8000-00805f9b34fb");
    }

    private void readNextDeviceInfoCharacteristic(BluetoothGatt gatt) {
        BluetoothGattCharacteristic characteristic = pendingDeviceInfoReads.poll();
        if (characteristic == null) {
            if (localC6ProtocolReady) {
                requestLocalBatteryInternal(gatt);
                emit("bactrack.localBleState", "connected; local C6 test ready");
            }
            return;
        }
        try {
            if (!gatt.readCharacteristic(characteristic)) {
                appendDeviceInfoRead(characteristic, null, BluetoothGatt.GATT_FAILURE);
                readNextDeviceInfoCharacteristic(gatt);
            }
        } catch (SecurityException error) {
            pendingDeviceInfoReads.clear();
            emit("bactrack.localBleState", "Bluetooth permission revoked while reading device info");
        }
    }

    private void appendDeviceInfoRead(BluetoothGattCharacteristic characteristic, byte[] value, int status) {
        String field;
        switch (characteristic.getUuid().toString()) {
            case "00002a24-0000-1000-8000-00805f9b34fb": field = "model"; break;
            case "00002a26-0000-1000-8000-00805f9b34fb": field = "firmware"; break;
            case "00002a27-0000-1000-8000-00805f9b34fb": field = "hardwareRevision"; break;
            case "00002a28-0000-1000-8000-00805f9b34fb": field = "softwareRevision"; break;
            case "00002a29-0000-1000-8000-00805f9b34fb": field = "manufacturer"; break;
            default: return;
        }
        String text = value == null ? "" : new String(value, java.nio.charset.StandardCharsets.UTF_8).trim();
        if (status == BluetoothGatt.GATT_SUCCESS && !text.isEmpty()) emitDeviceInfo(field, text);
    }

    private void emitDeviceInfo(String field, String value) {
        WritableMap payload = Arguments.createMap();
        payload.putString("field", field);
        payload.putString("value", value);
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit("bactrack.localDeviceInfo", payload);
    }

    private void handleLocalC6Packet(BluetoothGattCharacteristic characteristic, byte[] value) {
        if (value == null || value.length < 2
                || !C6_BREATH_CHARACTERISTIC.equals(characteristic.getUuid())) return;
        int message = value[0] & 0xff;
        if (message == 0x88 && value.length >= 3) {
            localBatteryRequestPending = false;
            int millivolts = ((value[1] & 0xff) << 8) | (value[2] & 0xff);
            float voltage = millivolts / 1000f;
            int level = voltage < 1f ? 0 : voltage < 1.25f ? 1 : voltage < 1.5f ? 2 : voltage < 1.6f ? 3 : 4;
            WritableMap payload = Arguments.createMap();
            payload.putDouble("voltage", voltage);
            payload.putInt("level", level);
            context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit("bactrack.localBattery", payload);
            return;
        }
        if (!localTestActive) return;
        int state = value[1] & 0xff;
        if (message != 0x80) return;
        switch (state) {
            case 1:
                if (value.length >= 3) {
                    emit("bactrack.localTestState", "Device countdown: " + (value[2] & 0xff));
                }
                break;
            case 2:
                emit("bactrack.localTestState", "Blow steadily into the breathalyzer now.");
                break;
            case 3:
                mainHandler.removeCallbacks(localBlowProgress);
                localBlowStartedAt = System.currentTimeMillis();
                emit("bactrack.localTestState", "Keep blowing steadily…");
                mainHandler.post(localBlowProgress);
                break;
            case 4:
            case 5:
                mainHandler.removeCallbacks(localBlowProgress);
                emit("bactrack.localTestState", "Analyzing breath sample…");
                break;
            case 6:
                if (value.length >= 5) {
                    int thousandths = ((value[3] & 0xff) << 8) | (value[4] & 0xff);
                    float bacPercent = thousandths / 1000f;
                    localTestActive = false;
                    mainHandler.removeCallbacks(localBlowProgress);
                    saveLocalResult(bacPercent, pendingTestLocation);
                    pendingTestLocation = null;
                    emit("bactrack.localTestState", "Result received: " + bacPercent + "% BAC; saving encrypted on this device.");
                } else {
                    emit("bactrack.localTestState", "Device returned an incomplete result packet.");
                }
                break;
            case 7: case 8: case 9: case 10: case 11: case 12: case 14: case 15:
                localTestActive = false;
                pendingTestLocation = null;
                mainHandler.removeCallbacks(localBlowProgress);
                emit("bactrack.localTestState", "Breathalyzer stopped the test (device code " + state + ").");
                break;
            default:
                emit("bactrack.localTestState", "Device test state " + state);
        }
    }

    private void saveLocalResult(float bacPercent, JSONObject location) {
        final long measuredAt = System.currentTimeMillis();
        final String deviceSerial = localDeviceSerial;
        storageExecutor.execute(() -> {
            try {
                JSONObject reading = readingStore.add(bacPercent, measuredAt, deviceSerial, location);
                WritableMap payload = Arguments.createMap();
                payload.putString("id", reading.getString("id"));
                payload.putDouble("bacPercent", reading.getDouble("bacPercent"));
                payload.putDouble("measuredAt", reading.getLong("measuredAt"));
                context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                        .emit("bactrack.localReadingSaved", payload);
            } catch (Exception error) {
                emit("bactrack.localSaveError", error.getMessage() == null ? "Could not save reading locally" : error.getMessage());
            }
        });
    }

    @ReactMethod
    public void startLocalScan(Promise promise) {
        try {
            BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
            if (adapter == null || !adapter.isEnabled()) {
                promise.reject("LOCAL_BLE_UNAVAILABLE", "Bluetooth is unavailable or disabled");
                return;
            }
            localScanner = adapter.getBluetoothLeScanner();
            if (localScanner == null) {
                promise.reject("LOCAL_BLE_UNAVAILABLE", "BLE scanning is unavailable");
                return;
            }
            stopLocalScanInternal();
            synchronized (this) {
                lastLocalScanUpdates.clear();
            }
            localScanner.startScan(null, new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                    .build(), localScanCallback);
            localScanRunning = true;
            mainHandler.removeCallbacks(stopScanTimeout);
            mainHandler.postDelayed(stopScanTimeout, 20_000);
            emit("bactrack.localBleState", "scanning nearby devices (20 seconds)");
            promise.resolve(true);
        } catch (SecurityException error) {
            promise.reject("LOCAL_BLE_PERMISSION", "Bluetooth scan permission was not granted", error);
        } catch (RuntimeException error) {
            promise.reject("LOCAL_BLE_SCAN_FAILED", error.getMessage(), error);
        }
    }

    @ReactMethod
    public void stopLocalScan() {
        stopLocalScanInternal();
    }

    private void stopLocalScanInternal() {
        mainHandler.removeCallbacks(stopScanTimeout);
        if (!localScanRunning || localScanner == null) return;
        try {
            localScanner.stopScan(localScanCallback);
        } catch (SecurityException error) {
            localScanRunning = false;
            emit("bactrack.localBleState", "scan stopped; Bluetooth permission was revoked");
            return;
        }
        localScanRunning = false;
        emit("bactrack.localBleState", "scan complete");
    }

    private static final class ScanUpdate {
        final long at;
        final int rssi;

        ScanUpdate(long at, int rssi) {
            this.at = at;
            this.rssi = rssi;
        }
    }

    @ReactMethod
    public void connectLocalDevice(String address, Promise promise) {
        if (address == null || !address.matches("(?i)[0-9a-f]{2}(:[0-9a-f]{2}){5}")) {
            promise.reject("LOCAL_BLE_INVALID_ADDRESS", "Invalid BLE device address");
            return;
        }
        try {
            String identityKey = "device.identity." + UUID.nameUUIDFromBytes(
                    address.toUpperCase(Locale.ROOT).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            String existingIdentity = readingStore.getSecureValue(identityKey);
            if (existingIdentity == null || existingIdentity.isEmpty()) {
                existingIdentity = "ANDROID-" + UUID.randomUUID();
                readingStore.setSecureValue(identityKey, existingIdentity);
            }
            localDeviceSerial = existingIdentity;
            BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
            if (adapter == null || !adapter.isEnabled()) {
                promise.reject("LOCAL_BLE_UNAVAILABLE", "Bluetooth is unavailable or disabled");
                return;
            }
            if (localGatt != null) {
                localGatt.disconnect();
                localGatt.close();
            }
            stopLocalScanInternal();
            BluetoothDevice device = adapter.getRemoteDevice(address.toUpperCase(Locale.ROOT));
            localGatt = device.connectGatt(context, false, localGattCallback, BluetoothDevice.TRANSPORT_LE);
            if (localGatt == null) {
                promise.reject("LOCAL_BLE_CONNECT_FAILED", "Android could not start a GATT connection");
                return;
            }
            emit("bactrack.localBleState", "connecting to " + safeDeviceName(device));
            promise.resolve(true);
        } catch (SecurityException error) {
            promise.reject("LOCAL_BLE_PERMISSION", "Bluetooth connect permission was not granted", error);
        } catch (RuntimeException error) {
            promise.reject("LOCAL_BLE_CONNECT_FAILED", error.getMessage(), error);
        } catch (Exception error) {
            promise.reject("LOCAL_DEVICE_ID_FAILED", "Could not create a local device identity", error);
        }
    }

    @ReactMethod
    public void getConnectedLocalDeviceIdentity(Promise promise) {
        promise.resolve(localDeviceSerial);
    }

    @ReactMethod
    public void getLocalDeviceIdentity(String address, Promise promise) {
        if (address == null || !address.matches("(?i)[0-9a-f]{2}(:[0-9a-f]{2}){5}")) {
            promise.reject("LOCAL_BLE_INVALID_ADDRESS", "Invalid BLE device address");
            return;
        }
        storageExecutor.execute(() -> {
            try {
                String identityKey = "device.identity." + UUID.nameUUIDFromBytes(
                        address.toUpperCase(Locale.ROOT).getBytes(java.nio.charset.StandardCharsets.UTF_8));
                promise.resolve(readingStore.getSecureValue(identityKey));
            } catch (Exception error) {
                promise.reject("LOCAL_DEVICE_ID_FAILED", "Could not read local device identity", error);
            }
        });
    }

    @ReactMethod
    public void getCurrentLocation(Promise promise) {
        if (context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED
                && context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            promise.resolve(null);
            return;
        }
        LocationManager manager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) { promise.resolve(null); return; }
        Location recent = null;
        try {
            for (String provider : manager.getProviders(true)) {
                Location candidate = manager.getLastKnownLocation(provider);
                if (candidate != null && System.currentTimeMillis() - candidate.getTime() <= 120_000
                        && (recent == null || candidate.getTime() > recent.getTime())) recent = candidate;
            }
            if (recent != null) { promise.resolve(locationMap(recent)); return; }
            String provider = manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
                    ? LocationManager.GPS_PROVIDER : LocationManager.NETWORK_PROVIDER;
            final LocationManager locationManager = manager;
            final LocationListener[] listenerRef = new LocationListener[1];
            final boolean[] settled = {false};
            Runnable timeout = () -> {
                if (settled[0]) return;
                settled[0] = true;
                try { locationManager.removeUpdates(listenerRef[0]); } catch (SecurityException ignored) { }
                promise.resolve(null);
            };
            listenerRef[0] = location -> {
                if (settled[0]) return;
                settled[0] = true;
                mainHandler.removeCallbacks(timeout);
                try { locationManager.removeUpdates(listenerRef[0]); } catch (SecurityException ignored) { }
                promise.resolve(locationMap(location));
            };
            manager.requestSingleUpdate(provider, listenerRef[0], Looper.getMainLooper());
            mainHandler.postDelayed(timeout, 8_000);
        } catch (Exception error) {
            promise.resolve(null);
        }
    }

    private WritableMap locationMap(Location location) {
        WritableMap result = Arguments.createMap();
        result.putDouble("latitude", location.getLatitude());
        result.putDouble("longitude", location.getLongitude());
        result.putDouble("accuracy", location.hasAccuracy() ? location.getAccuracy() : 0);
        result.putDouble("timestamp", location.getTime());
        return result;
    }

    @ReactMethod
    public void setPendingTestLocation(ReadableMap location, Promise promise) {
        try {
            pendingTestLocation = null;
            if (location != null) {
                JSONObject sample = new JSONObject();
                sample.put("latitude", location.getDouble("latitude"));
                sample.put("longitude", location.getDouble("longitude"));
                sample.put("accuracy", location.getDouble("accuracy"));
                sample.put("capturedAt", location.getDouble("timestamp"));
                pendingTestLocation = sample;
            }
            promise.resolve(true);
        } catch (org.json.JSONException | RuntimeException error) {
            pendingTestLocation = null;
            promise.reject("LOCAL_TEST_LOCATION_INVALID", "Could not attach the test location", error);
        }
    }

    @ReactMethod
    public void startLocalBreathTest(Promise promise) {
        if (localGatt == null || !localC6ProtocolReady) {
            pendingTestLocation = null;
            promise.reject("LOCAL_TEST_NOT_READY", "Connect to a BACtrack C6 device before starting a local test");
            return;
        }
        if (localTestActive) {
            pendingTestLocation = null;
            promise.reject("LOCAL_TEST_IN_PROGRESS", "A local breath test is already in progress");
            return;
        }
        try {
            BluetoothGattService service = localGatt.getService(C6_BREATH_SERVICE);
            BluetoothGattCharacteristic characteristic = service == null
                    ? null : service.getCharacteristic(C6_BREATH_CHARACTERISTIC);
            if (characteristic == null) {
                pendingTestLocation = null;
                promise.reject("LOCAL_TEST_NOT_READY", "BACtrack C6 breath characteristic is unavailable");
                return;
            }
            byte[] startCountdown = new byte[]{0x00, 0x01};
            localTestActive = true;
            boolean accepted;
            if (Build.VERSION.SDK_INT >= 33) {
                accepted = localGatt.writeCharacteristic(characteristic, startCountdown,
                        BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE) == 0;
            } else {
                characteristic.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
                characteristic.setValue(startCountdown);
                accepted = localGatt.writeCharacteristic(characteristic);
            }
            if (!accepted) {
                localTestActive = false;
                pendingTestLocation = null;
                promise.reject("LOCAL_TEST_START_FAILED", "Android could not send the local test request");
                return;
            }
            emit("bactrack.localTestState", "Local test request sent; wait for the breathalyzer countdown.");
            promise.resolve(true);
        } catch (SecurityException error) {
            localTestActive = false;
            pendingTestLocation = null;
            promise.reject("LOCAL_BLE_PERMISSION", "Bluetooth connect permission was not granted", error);
        } catch (RuntimeException error) {
            localTestActive = false;
            pendingTestLocation = null;
            promise.reject("LOCAL_TEST_START_FAILED", error.getMessage(), error);
        }
    }

    @ReactMethod
    public void requestLocalBattery(Promise promise) {
        if (localGatt == null || !localC6ProtocolReady) {
            promise.reject("LOCAL_BLE_NOT_READY", "Connect to the BACtrack device first");
            return;
        }
        try {
            boolean accepted = requestLocalBatteryInternal(localGatt);
            if (!accepted) {
                promise.reject("LOCAL_BATTERY_REQUEST_FAILED", "Could not request battery status");
                return;
            }
            promise.resolve(true);
        } catch (SecurityException error) {
            promise.reject("LOCAL_BLE_PERMISSION", "Bluetooth connect permission was not granted", error);
        } catch (RuntimeException error) {
            promise.reject("LOCAL_BATTERY_REQUEST_FAILED", error.getMessage(), error);
        }
    }

    private boolean localBatteryRequestPending;

    private boolean requestLocalBatteryInternal(BluetoothGatt gatt) {
        try {
            BluetoothGattCharacteristic characteristic = gatt.getService(C6_BREATH_SERVICE)
                    .getCharacteristic(C6_BREATH_CHARACTERISTIC);
            byte[] command = new byte[]{0x08};
            boolean accepted;
            if (Build.VERSION.SDK_INT >= 33) {
                accepted = gatt.writeCharacteristic(characteristic, command,
                        BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE) == 0;
            } else {
                characteristic.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
                characteristic.setValue(command);
                accepted = gatt.writeCharacteristic(characteristic);
            }
            localBatteryRequestPending = accepted;
            return accepted;
        } catch (RuntimeException error) {
            return false;
        }
    }

    @ReactMethod
    public void disconnectLocalDevice() {
        if (localGatt == null) return;
        try {
            localTestActive = false;
            mainHandler.removeCallbacks(localBlowProgress);
            localGatt.disconnect();
        } catch (SecurityException error) {
            localGatt.close();
            localGatt = null;
        }
    }

    @ReactMethod
    public void getLocalReadings(Promise promise) {
        storageExecutor.execute(() -> {
            try {
                WritableArray result = Arguments.createArray();
                List<JSONObject> readings = readingStore.getAll();
                for (JSONObject reading : readings) {
                    WritableMap item = Arguments.createMap();
                    item.putString("id", reading.getString("id"));
                    item.putDouble("bacPercent", reading.getDouble("bacPercent"));
                    item.putDouble("measuredAt", reading.getLong("measuredAt"));
                    if (reading.has("serial")) item.putString("serial", reading.getString("serial"));
                    putReadingLocation(item, reading);
                    item.putBoolean("cloud", reading.optBoolean("cloud", false));
                    item.putBoolean("synced", readingStore.isSynced(reading.getString("id")));
                    result.pushMap(item);
                }
                promise.resolve(result);
            } catch (Exception error) {
                promise.reject("LOCAL_READINGS_FAILED", error.getMessage(), error);
            }
        });
    }

    @ReactMethod
    public void getUnsyncedLocalReadings(Promise promise) {
        storageExecutor.execute(() -> {
            try {
                WritableArray result = Arguments.createArray();
                for (JSONObject reading : readingStore.getUnsynced()) {
                    WritableMap item = Arguments.createMap();
                    item.putString("id", reading.getString("id"));
                    item.putDouble("bacPercent", reading.getDouble("bacPercent"));
                    item.putDouble("measuredAt", reading.getLong("measuredAt"));
                    if (reading.has("serial")) item.putString("serial", reading.getString("serial"));
                    putReadingLocation(item, reading);
                    result.pushMap(item);
                }
                promise.resolve(result);
            } catch (Exception error) {
                promise.reject("LOCAL_SYNC_READ_FAILED", error.getMessage(), error);
            }
        });
    }

    private void putReadingLocation(WritableMap item, JSONObject reading) {
        if (reading.has("latitude") && reading.has("longitude")) {
            item.putDouble("latitude", reading.optDouble("latitude"));
            item.putDouble("longitude", reading.optDouble("longitude"));
            if (reading.has("accuracy")) item.putDouble("accuracy", reading.optDouble("accuracy"));
        }
    }

    @ReactMethod
    public void markLocalReadingsSynced(ReadableArray ids, Promise promise) {
        storageExecutor.execute(() -> {
            try {
                List<String> values = new java.util.ArrayList<>();
                for (int i = 0; i < ids.size(); i++) {
                    String id = ids.getString(i);
                    if (id != null) values.add(id);
                }
                readingStore.markSynced(values);
                promise.resolve(true);
            } catch (Exception error) {
                promise.reject("LOCAL_SYNC_MARK_FAILED", error.getMessage(), error);
            }
        });
    }

    @ReactMethod
    public void importCloudReadings(ReadableArray items, Promise promise) {
        storageExecutor.execute(() -> {
            try {
                for (int i = 0; i < items.size(); i++) {
                    ReadableMap item = items.getMap(i);
                    if (item == null || !item.hasKey("id") || !item.hasKey("bacPromille") || !item.hasKey("measuredAt")) continue;
                    String id = item.getString("id");
                    String measuredAt = item.getString("measuredAt");
                    if (id == null || measuredAt == null) continue;
                    long at = java.time.Instant.parse(measuredAt).toEpochMilli();
                    String serial = item.hasKey("deviceSerial") && !item.isNull("deviceSerial")
                            ? item.getString("deviceSerial") : null;
                    readingStore.addCloudReading(id, item.getDouble("bacPromille") / 10d, at, serial);
                }
                promise.resolve(true);
            } catch (Exception error) {
                promise.reject("CLOUD_READINGS_IMPORT_FAILED", error.getMessage(), error);
            }
        });
    }

    @ReactMethod
    public void getSecureValue(String key, Promise promise) {
        storageExecutor.execute(() -> {
            try {
                promise.resolve(readingStore.getSecureValue(key));
            } catch (Exception error) {
                promise.reject("SECURE_VALUE_READ_FAILED", error.getMessage(), error);
            }
        });
    }

    @ReactMethod
    public void setSecureValue(String key, String value, Promise promise) {
        storageExecutor.execute(() -> {
            try {
                readingStore.setSecureValue(key, value);
                promise.resolve(true);
            } catch (Exception error) {
                promise.reject("SECURE_VALUE_WRITE_FAILED", error.getMessage(), error);
            }
        });
    }

    @ReactMethod
    public void clearSecureValue(String key, Promise promise) {
        storageExecutor.execute(() -> {
            try {
                readingStore.setSecureValue(key, "");
                promise.resolve(true);
            } catch (Exception error) {
                promise.reject("SECURE_VALUE_CLEAR_FAILED", error.getMessage(), error);
            }
        });
    }

    @ReactMethod
    public void clearLocalReadings(Promise promise) {
        storageExecutor.execute(() -> {
            try {
                readingStore.clear();
                promise.resolve(true);
            } catch (Exception error) {
                promise.reject("LOCAL_CLEAR_FAILED", error.getMessage(), error);
            }
        });
    }

    @ReactMethod
    public void addListener(String eventName) {}

    @ReactMethod
    public void removeListeners(double count) {}

    @Override
    public void onCatalystInstanceDestroy() {
        stopLocalScanInternal();
        if (localGatt != null) {
            try {
                localGatt.disconnect();
                localGatt.close();
            } catch (SecurityException ignored) {
                localGatt.close();
            }
            localGatt = null;
        }
        storageExecutor.shutdown();
        readingStore.close();
        super.onCatalystInstanceDestroy();
    }
}
