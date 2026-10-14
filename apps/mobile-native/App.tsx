import { useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  Alert,
  ActivityIndicator,
  AppState,
  Linking,
  NativeEventEmitter,
  NativeModules,
  Pressable,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  type Permission,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ManagerClient, type ManagerDevice, type ManagerOrg, type ManagerReading } from './src/manager-client';
import { BAC_UNITS, formatBac, isBacUnit, type BacUnit } from './src/bac-units';

type BactrackEvent = { value?: string };
type LocalReading = { id: string; bacPercent: number; measuredAt: number; serial?: string; cloud?: boolean; synced?: boolean; latitude?: number; longitude?: number; accuracy?: number };
type LocalBleDevice = { address: string; name: string; rssi: number };
type KnownBleDevice = { address: string; name: string };
type LocalLocation = { latitude: number; longitude: number; accuracy: number; timestamp: number };
type LocalDeviceInfo = { model?: string; firmware?: string; hardwareRevision?: string; softwareRevision?: string; manufacturer?: string };
type SyncMode = 'disabled' | 'upload_only' | 'download_only' | 'bidirectional';
type ManagerSettings = { baseUrl: string; organizationId: string; syncMode: SyncMode };
type BactrackNativeModule = {
  getLocalReadings(): Promise<LocalReading[]>;
  clearLocalReadings(): Promise<boolean>;
  startLocalScan(): Promise<boolean>;
  stopLocalScan(): void;
  connectLocalDevice(address: string): Promise<boolean>;
  requestLocalBattery(): Promise<boolean>;
  getCurrentLocation(): Promise<LocalLocation | null>;
  setPendingTestLocation?(location: LocalLocation | null): Promise<boolean>;
  startLocalBreathTest(): Promise<boolean>;
  disconnectLocalDevice(): void;
  getUnsyncedLocalReadings(): Promise<LocalReading[]>;
  markLocalReadingsSynced(ids: string[]): Promise<boolean>;
  importCloudReadings(readings: ManagerReading[]): Promise<boolean>;
  getSecureValue(key: string): Promise<string | null>;
  getConnectedLocalDeviceIdentity(): Promise<string | null>;
  getLocalDeviceIdentity?(address: string): Promise<string | null>;
  setSecureValue(key: string, value: string): Promise<boolean>;
  clearSecureValue(key: string): Promise<boolean>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

const DEFAULT_MANAGER_URL = 'http://192.168.21.2:3001';
const SYNC_MODES: { value: SyncMode; label: string }[] = [
  { value: 'disabled', label: 'Off' },
  { value: 'upload_only', label: 'Phone to Manager' },
  { value: 'download_only', label: 'Manager to phone' },
  { value: 'bidirectional', label: 'Both ways' },
];

export function displayDeviceModel(...values: Array<string | undefined>) {
  const source = values.filter((value) => value?.trim()).join(' ');
  const model = source.match(/\b(C6|K10)\b/i)?.[1]?.toUpperCase();
  return model ? `BACtrack ${model}` : source.trim() || 'BACtrack';
}

export function connectedDeviceModel(protocolReady: boolean, ...values: Array<string | undefined>) {
  return protocolReady ? 'BACtrack C6' : displayDeviceModel(...values);
}

export function batteryLabel(status: string, connected: boolean) {
  if (!connected) return '—';
  if (['Low', 'Medium', 'High', 'Full'].includes(status)) return status;
  return status === 'Unavailable' || status === 'Battery status unavailable' ? 'N/A' : '…';
}

function managerModelCode(...values: Array<string | undefined>) {
  return values.join(' ').match(/\b(C6|K10)\b/i)?.[1]?.toUpperCase() ?? 'C6';
}

function managerClient(baseUrl: string, organizationId = '') {
  const native = NativeModules.BactrackModule as BactrackNativeModule | undefined;
  if (!native) throw new Error('Secure local storage is unavailable.');
  return new ManagerClient(baseUrl, organizationId, native);
}

export async function startNativeBreathTest(native: BactrackNativeModule, location: LocalLocation | null) {
  if (native.setPendingTestLocation) {
    await native.setPendingTestLocation(location).catch(() => undefined);
  }
  await native.startLocalBreathTest();
}

export function normalizeCloudReadings(readings: ManagerReading[]): ManagerReading[] {
  return readings.map((reading) => {
    const bacPromille = Number(reading.bacPromille);
    if (!Number.isFinite(bacPromille) || bacPromille < 0) {
      throw new Error('Manager returned an invalid BAC value.');
    }
    return { ...reading, bacPromille };
  });
}

async function requestBlePermissions(requireLocation = false) {
  if (Platform.OS === 'ios') return true;
  const modernAndroid = Number(Platform.Version) >= 31;
  const permissions: Permission[] = [];
  if (!modernAndroid || requireLocation) {
    permissions.push(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  }
  if (modernAndroid) {
    permissions.push(
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    );
  }
  const results = await PermissionsAndroid.requestMultiple(permissions);
  return Object.values(results).every((result) => result === PermissionsAndroid.RESULTS.GRANTED);
}

function AppContent() {
  const [activeTab, setActiveTab] = useState<'analysis' | 'history' | 'settings'>('analysis');
  const [readings, setReadings] = useState<LocalReading[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [error, setError] = useState('');
  const [localBleDevices, setLocalBleDevices] = useState<LocalBleDevice[]>([]);
  const lastDeviceUiUpdate = useRef(new Map<string, { at: number; rssi: number }>());
  const knownDevicesRef = useRef<KnownBleDevice[]>([]);
  const autoConnectEnabledRef = useRef(true);
  const autoConnectAttempted = useRef(false);
  const batteryTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [knownDevices, setKnownDevices] = useState<KnownBleDevice[]>([]);
  const [knownDeviceIds, setKnownDeviceIds] = useState<Record<string, string>>({});
  const [knownDevicesLoaded, setKnownDevicesLoaded] = useState(false);
  const [autoConnectEnabled, setAutoConnectEnabled] = useState(true);
  const [autoConnectCandidate, setAutoConnectCandidate] = useState('');
  const [activeBleAddress, setActiveBleAddress] = useState('');
  const [activeBleName, setActiveBleName] = useState('');
  const [localBleStatus, setLocalBleStatus] = useState('Turn on your BACtrack and scan to connect.');
  const [deviceInfo, setDeviceInfo] = useState<LocalDeviceInfo>({});
  const [deviceBatteryLevel, setDeviceBatteryLevel] = useState<number | null>(null);
  const [localDeviceSerial, setLocalDeviceSerial] = useState<string | null>(null);
  const [batteryStatus, setBatteryStatus] = useState('Not connected');
  const [localProtocolReady, setLocalProtocolReady] = useState(false);
  const [locationCaptureEnabled, setLocationCaptureEnabled] = useState(true);
  const [bacUnit, setBacUnit] = useState<BacUnit>('percent');
  const [localBleBusy, setLocalBleBusy] = useState(false);
  const [localTestBusy, setLocalTestBusy] = useState(false);
  const [localTestStatus, setLocalTestStatus] = useState('');
  const [managerSettings, setManagerSettings] = useState<ManagerSettings>({
    baseUrl: DEFAULT_MANAGER_URL,
    organizationId: '',
    syncMode: 'disabled',
  });
  const [managerEmail, setManagerEmail] = useState('');
  const [managerUser, setManagerUser] = useState<{ id: string; email: string; displayName: string } | null>(null);
  const [managerOrgs, setManagerOrgs] = useState<ManagerOrg[]>([]);
  const [managerStatus, setManagerStatus] = useState('Sign in to connect this app to your Manager server.');
  const [managerBusy, setManagerBusy] = useState(false);
  const [magicToken, setMagicToken] = useState('');
  const [mfaTicket, setMfaTicket] = useState('');
  const [mfaCode, setMfaCode] = useState('');

  const updateManagerSettings = async (next: ManagerSettings) => {
    setManagerSettings(next);
    const native = NativeModules.BactrackModule as BactrackNativeModule | undefined;
    await native?.setSecureValue('manager.settings', JSON.stringify(next));
  };

  const loadManagerAccount = async (baseUrl: string, preferredOrgId = '') => {
    const normalizedUrl = ManagerClient.normalizeBaseUrl(baseUrl);
    const me = await managerClient(normalizedUrl).me();
    const selected = me.organizations.find((org) => org.id === preferredOrgId)
      ?? me.organizations.find((org) => org.type === 'personal')
      ?? me.organizations[0];
    setManagerUser(me.user);
    setManagerOrgs(me.organizations);
    if (selected) {
      await updateManagerSettings({ ...managerSettings, baseUrl: normalizedUrl, organizationId: selected.id });
    }
    setManagerStatus(`Connected as ${me.user.email}.`);
  };

  const consumeManagerLink = async (value: string) => {
    let token = value.trim();
    try {
      token = new URL(token).searchParams.get('token') ?? token;
    } catch {
      // A pasted raw one-time token is also accepted.
    }
    if (!token) return;
    setManagerBusy(true);
    try {
      const result = await managerClient(managerSettings.baseUrl).consumeMagicToken(token);
      if (result.mfaTicket) {
        setMfaTicket(result.mfaTicket);
        setManagerStatus('Enter your authenticator code to finish signing in.');
      } else {
        setMagicToken('');
        await loadManagerAccount(managerSettings.baseUrl, managerSettings.organizationId);
      }
    } catch (cause) {
      setManagerStatus(cause instanceof Error ? cause.message : 'Could not use that sign-in link.');
    } finally {
      setManagerBusy(false);
    }
  };
  const onManagerLink = useEffectEvent((url: string) => consumeManagerLink(url));

  const refreshReadings = async () => {
    const nativeModule = NativeModules.BactrackModule as BactrackNativeModule | undefined;
    if (!nativeModule) {
      setHistoryLoading(false);
      return;
    }
    try {
      setReadings(await nativeModule.getLocalReadings());
      setError('');
    } catch {
      setError('Could not decrypt local history. Data was not sent anywhere.');
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => { refreshReadings(); }, []);

  useEffect(() => {
    const native = NativeModules.BactrackModule as BactrackNativeModule | undefined;
    if (!native) return;
    let active = true;
    Promise.all([
      native.getSecureValue('ble.known-devices'),
      native.getSecureValue('ble.auto-connect'),
      native.getSecureValue('location.capture'),
      native.getSecureValue('display.bac-unit'),
    ]).then(([savedDevices, savedAutoConnect, savedLocationCapture, savedBacUnit]) => {
      if (!active) return;
      try {
        const parsed = savedDevices ? JSON.parse(savedDevices) as KnownBleDevice[] : [];
        knownDevicesRef.current = Array.isArray(parsed) ? parsed.filter((item) => item.address && item.name) : [];
      } catch {
        knownDevicesRef.current = [];
      }
      const enabled = savedAutoConnect !== 'false';
      autoConnectEnabledRef.current = enabled;
      setKnownDevices(knownDevicesRef.current);
      setAutoConnectEnabled(enabled);
      setLocationCaptureEnabled(savedLocationCapture !== 'false');
      if (isBacUnit(savedBacUnit)) setBacUnit(savedBacUnit);
      setKnownDevicesLoaded(true);
    }).catch(() => { if (active) setKnownDevicesLoaded(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const native = NativeModules.BactrackModule as BactrackNativeModule | undefined;
    if (!native?.getLocalDeviceIdentity || knownDevices.length === 0) {
      setKnownDeviceIds({});
      return;
    }
    let active = true;
    Promise.all(knownDevices.map(async (device) => ({
      address: device.address,
      id: await native.getLocalDeviceIdentity!(device.address).catch(() => null),
    }))).then((identities) => {
      if (active) setKnownDeviceIds(Object.fromEntries(identities.filter((entry) => entry.id).map((entry) => [entry.address, entry.id!])));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [knownDevices]);

  useEffect(() => {
    let active = true;
    const native = NativeModules.BactrackModule as BactrackNativeModule | undefined;
    if (!native) return;
    (async () => {
      try {
        const saved = await native.getSecureValue('manager.settings');
        if (!active) return;
        if (saved) {
          const parsed = JSON.parse(saved) as Partial<ManagerSettings>;
          const restored: ManagerSettings = {
            baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : DEFAULT_MANAGER_URL,
            organizationId: typeof parsed.organizationId === 'string' ? parsed.organizationId : '',
            syncMode: SYNC_MODES.some((mode) => mode.value === parsed.syncMode)
              ? parsed.syncMode as SyncMode : 'disabled',
          };
          setManagerSettings(restored);
          const tokenBundle = await native.getSecureValue('manager.tokens');
          if (tokenBundle) {
            const me = await managerClient(restored.baseUrl).me();
            if (!active) return;
            setManagerUser(me.user);
            setManagerOrgs(me.organizations);
            const selected = me.organizations.find((org) => org.id === restored.organizationId)
              ?? me.organizations.find((org) => org.type === 'personal')
              ?? me.organizations[0];
            if (selected) {
              const next = { ...restored, organizationId: selected.id };
              setManagerSettings(next);
              await native.setSecureValue('manager.settings', JSON.stringify(next));
            }
            setManagerStatus(`Connected as ${me.user.email}.`);
          }
        }
      } catch {
        if (active) setManagerStatus('Manager server is not reachable. Check the server URL and network.');
      }
    })().catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    Linking.getInitialURL().then((url) => { if (url) onManagerLink(url); }).catch(() => undefined);
    const subscription = Linking.addEventListener('url', ({ url }) => onManagerLink(url));
    return () => subscription.remove();
  }, []);

  const showSavedResult = useEffectEvent((percent: number) => {
    setLocalTestStatus(`Result saved on this device: ${formatBac(percent, bacUnit)}`);
  });

  useEffect(() => {
    if (!NativeModules.BactrackModule) return;
    const emitter = new NativeEventEmitter(NativeModules.BactrackModule);
    const subscriptions = [
      emitter.addListener('bactrack.localReadingSaved', (rawEvent: unknown) => {
        const reading = rawEvent as { bacPercent?: number };
        refreshReadings();
        showSavedResult(reading.bacPercent ?? 0);
        setLocalTestBusy(false);
      }),
      emitter.addListener('bactrack.localSaveError', (rawEvent: unknown) => {
        const message = `Local save failed: ${(rawEvent as BactrackEvent).value ?? 'unknown error'}`;
        setError(message);
        setLocalTestStatus(message);
        setLocalTestBusy(false);
      }),
      emitter.addListener('bactrack.localBleDevice', (rawEvent: unknown) => {
        const device = rawEvent as LocalBleDevice;
        if (autoConnectEnabledRef.current && !autoConnectAttempted.current
          && knownDevicesRef.current.some((known) => known.address === device.address)) {
          autoConnectAttempted.current = true;
          setAutoConnectCandidate(device.address);
        }
        const now = Date.now();
        const previous = lastDeviceUiUpdate.current.get(device.address);
        if (!previous) {
          lastDeviceUiUpdate.current.set(device.address, { at: now, rssi: device.rssi });
          setLocalBleDevices((current) => [...current, device]);
          return;
        }
        if (now - previous.at < 1000 || Math.abs(device.rssi - previous.rssi) < 5) return;
        lastDeviceUiUpdate.current.set(device.address, { at: now, rssi: device.rssi });
        setLocalBleDevices((current) => current.map((item) => item.address === device.address
          ? { ...item, ...device }
          : item));
      }),
      emitter.addListener('bactrack.localBleState', (rawEvent: unknown) => {
        const value = (rawEvent as BactrackEvent).value ?? 'Local BLE state changed.';
        if (value.includes('local C6 test ready')) {
          setLocalBleStatus('Connected and ready to test.');
          setLocalProtocolReady(true);
          setBatteryStatus('Reading…');
          batteryTimeout.current = setTimeout(() => {
            setBatteryStatus((current) => current === 'Reading…' ? 'Unavailable' : current);
          }, 5000);
        } else if (value.startsWith('connecting to ')) {
          setLocalProtocolReady(false);
          setLocalBleStatus('Connecting to BACtrack…');
        } else if (value === 'disconnected') {
          setLocalProtocolReady(false);
          setLocalBleStatus('Disconnected');
          setBatteryStatus('Not connected');
          setDeviceBatteryLevel(null);
          setLocalDeviceSerial(null);
          setActiveBleAddress('');
          setActiveBleName('');
        } else if (value.startsWith('scanning')) {
          setLocalBleStatus('Searching for BACtrack devices…');
        } else if (value === 'scan complete') {
          setLocalBleStatus(lastDeviceUiUpdate.current.size ? 'Select your BACtrack to connect.' : 'No BACtrack found. Turn it on and scan again.');
        } else if (value.includes('failed') || value.includes('error')) {
          setLocalProtocolReady(false);
          setLocalBleStatus('Could not communicate with the breathalyzer. Disconnect and try again.');
          setLocalDeviceSerial(null);
          setActiveBleAddress('');
          setActiveBleName('');
        }
        setLocalBleBusy(false);
      }),
      emitter.addListener('bactrack.localDeviceInfo', (rawEvent: unknown) => {
        const { field, value } = rawEvent as { field: keyof LocalDeviceInfo; value: string };
        setDeviceInfo((current) => ({ ...current, [field]: value }));
      }),
      emitter.addListener('bactrack.localBattery', (rawEvent: unknown) => {
        if (batteryTimeout.current) clearTimeout(batteryTimeout.current);
        const { level } = rawEvent as { voltage: number; level: number };
        setDeviceBatteryLevel(level);
        const label = ['Low', 'Medium', 'High', 'Full', 'Full'][level] ?? 'Unknown';
        setBatteryStatus(label);
      }),
      emitter.addListener('bactrack.localTestState', (rawEvent: unknown) => {
        const value = (rawEvent as BactrackEvent).value ?? 'Local test state changed.';
        setLocalTestStatus(value);
        if (value.startsWith('Breathalyzer stopped') || value.includes('failed')) {
          setLocalTestBusy(false);
        }
      }),
    ];
    return () => {
      if (batteryTimeout.current) clearTimeout(batteryTimeout.current);
      subscriptions.forEach((subscription) => subscription.remove());
    };
  }, []);

  useEffect(() => {
    if (localBleStatus !== 'Connected and ready to test.' || !activeBleAddress) return;
    const native = NativeModules.BactrackModule as BactrackNativeModule | undefined;
    if (!native) return;
    const remembered = [{ address: activeBleAddress, name: activeBleName || 'BACtrack' },
      ...knownDevicesRef.current.filter((device) => device.address !== activeBleAddress)].slice(0, 20);
    knownDevicesRef.current = remembered;
    setKnownDevices(remembered);
    native.setSecureValue('ble.known-devices', JSON.stringify(remembered)).catch(() => undefined);
  }, [activeBleAddress, activeBleName, localBleStatus]);

  const confirmClearHistory = () => {
    Alert.alert('Delete local history?', 'This permanently deletes all readings stored on this device. Nothing is changed on any other device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete history', style: 'destructive', onPress: async () => {
        const nativeModule = NativeModules.BactrackModule as BactrackNativeModule | undefined;
        if (!nativeModule) return;
        setHistoryBusy(true);
        try {
          await nativeModule.clearLocalReadings();
          setReadings([]);
          setError('');
        } catch {
          setError('Could not delete local history.');
        } finally {
          setHistoryBusy(false);
        }
      } },
    ]);
  };

  const startManagerLogin = async () => {
    setManagerBusy(true);
    try {
      const baseUrl = ManagerClient.normalizeBaseUrl(managerSettings.baseUrl);
      await updateManagerSettings({ ...managerSettings, baseUrl });
      const result = await managerClient(baseUrl).startLogin(managerEmail.trim());
      if (result.devToken) {
        await consumeManagerLink(result.devToken);
      } else if (result.sent) {
        setManagerStatus('Check your email, then open the BACtrack Manager app link.');
      } else {
        setManagerStatus('Email delivery is not configured on the Manager server.');
      }
    } catch (cause) {
      setManagerStatus(cause instanceof Error ? cause.message : 'Could not start Manager sign-in.');
    } finally {
      setManagerBusy(false);
    }
  };

  const completeManagerMfa = async () => {
    setManagerBusy(true);
    try {
      await managerClient(managerSettings.baseUrl).completeMfa(mfaTicket, mfaCode.trim());
      setMfaTicket('');
      setMfaCode('');
      await loadManagerAccount(managerSettings.baseUrl, managerSettings.organizationId);
    } catch (cause) {
      setManagerStatus(cause instanceof Error ? cause.message : 'Could not verify authenticator code.');
    } finally {
      setManagerBusy(false);
    }
  };

  const syncWithManager = async () => {
    const native = NativeModules.BactrackModule as BactrackNativeModule | undefined;
    if (!native || !managerUser || !managerSettings.organizationId) return;
    if (managerSettings.syncMode === 'disabled') {
      setManagerStatus('Sync is off. Choose a direction to connect phone history with Manager.');
      return;
    }
    setManagerBusy(true);
    setManagerStatus('Syncing with Manager…');
    try {
      const client = managerClient(managerSettings.baseUrl, managerSettings.organizationId);
      let uploaded = 0;
      let downloaded = 0;
      if (managerSettings.syncMode === 'upload_only' || managerSettings.syncMode === 'bidirectional') {
        const pending = await native.getUnsyncedLocalReadings();
        const deviceSerials = [...new Set(pending.map((reading) => reading.serial).filter((serial): serial is string => Boolean(serial)))];
        for (const serialNumber of deviceSerials) {
          const metadata: ManagerDevice = {
            serialNumber,
            model: managerModelCode(localProtocolReady && serialNumber === localDeviceSerial ? 'C6' : deviceInfo.model, activeBleName),
          };
          if (serialNumber === localDeviceSerial) {
            if (deviceInfo.firmware) metadata.firmwareVersion = deviceInfo.firmware;
            if (deviceInfo.hardwareRevision) metadata.hardwareRevision = deviceInfo.hardwareRevision;
            if (deviceInfo.softwareRevision) metadata.softwareRevision = deviceInfo.softwareRevision;
            if (deviceBatteryLevel !== null) metadata.batteryLevel = deviceBatteryLevel;
          }
          await client.claimDevice(metadata);
        }
        for (let start = 0; start < pending.length; start += 100) {
          const batch = pending.slice(start, start + 100);
          const result = await client.uploadReadings(batch.map((reading) => ({
            localId: reading.id,
            bacPercent: reading.bacPercent,
            measuredAt: new Date(reading.measuredAt).toISOString(),
            ...(reading.serial ? { deviceSerial: reading.serial } : {}),
            ...(reading.latitude !== undefined && reading.longitude !== undefined
              ? { latitude: reading.latitude, longitude: reading.longitude, ...(reading.accuracy !== undefined ? { accuracy: reading.accuracy } : {}) }
              : {}),
          })));
          await native.markLocalReadingsSynced(result.syncedLocalIds);
          uploaded += result.created;
        }
      }
      if (managerSettings.syncMode === 'download_only' || managerSettings.syncMode === 'bidirectional') {
        for (let page = 0; page < 500; page++) {
          const result = await client.listReadings(page * 1000);
          await native.importCloudReadings(normalizeCloudReadings(result.readings));
          downloaded += result.readings.length;
          if (result.readings.length < 1000) break;
          if (page === 499) throw new Error('Manager history is larger than the supported sync page limit.');
        }
      }
      await refreshReadings();
      setManagerStatus(`Sync complete: ${uploaded} new upload${uploaded === 1 ? '' : 's'}, ${downloaded} Manager records checked.`);
    } catch (cause) {
      setManagerStatus(cause instanceof Error ? cause.message : 'Sync failed. Check the connection and try again.');
    } finally {
      setManagerBusy(false);
    }
  };

  const disconnectManager = async () => {
    setManagerBusy(true);
    try {
      await managerClient(managerSettings.baseUrl).logout();
      setManagerUser(null);
      setManagerOrgs([]);
      await updateManagerSettings({ ...managerSettings, organizationId: '', syncMode: 'disabled' });
      setManagerStatus('Signed out. Local history remains on this phone.');
    } catch (cause) {
      setManagerStatus(cause instanceof Error ? cause.message : 'Could not sign out.');
    } finally {
      setManagerBusy(false);
    }
  };

  const scanLocally = async () => {
    const nativeModule = NativeModules.BactrackModule as BactrackNativeModule | undefined;
    if (!nativeModule) {
      setLocalBleStatus('Local Bluetooth is unavailable on this device.');
      return;
    }
    setLocalBleBusy(true);
    lastDeviceUiUpdate.current.clear();
    autoConnectAttempted.current = false;
    setAutoConnectCandidate('');
    setLocalBleDevices([]);
    setDeviceInfo({});
    setBatteryStatus('Checking when connected');
    try {
      if (!(await requestBlePermissions())) {
        setLocalBleStatus('Nearby-device permission was not granted.');
        setLocalBleBusy(false);
        return;
      }
      const [savedDevices, savedAutoConnect] = await Promise.all([
        nativeModule.getSecureValue('ble.known-devices'),
        nativeModule.getSecureValue('ble.auto-connect'),
      ]);
      const parsed = savedDevices ? JSON.parse(savedDevices) as KnownBleDevice[] : [];
      knownDevicesRef.current = Array.isArray(parsed) ? parsed.filter((item) => item.address && item.name) : [];
      const shouldAutoConnect = savedAutoConnect !== 'false';
      autoConnectEnabledRef.current = shouldAutoConnect;
      setKnownDevices(knownDevicesRef.current);
      setAutoConnectEnabled(shouldAutoConnect);
      await nativeModule.startLocalScan();
    } catch (cause) {
      setLocalBleBusy(false);
      setLocalBleStatus(`Local scan failed: ${cause instanceof Error ? cause.message : 'unknown error'}`);
    }
  };

  const connectLocal = async (address: string, name = 'BACtrack') => {
    const nativeModule = NativeModules.BactrackModule as BactrackNativeModule | undefined;
    if (!nativeModule) return;
    setLocalBleBusy(true);
    setDeviceInfo({});
    setLocalProtocolReady(false);
    setActiveBleAddress(address);
    setActiveBleName(name);
    setBatteryStatus('Checking battery…');
    try {
      await nativeModule.connectLocalDevice(address);
      setLocalDeviceSerial(await nativeModule.getConnectedLocalDeviceIdentity());
    } catch (cause) {
      setLocalBleBusy(false);
      setActiveBleAddress('');
      setActiveBleName('');
      setLocalBleStatus(`Could not connect: ${cause instanceof Error ? cause.message : 'unknown error'}`);
    }
  };

  const connectAutoDetected = useEffectEvent((address: string) => {
    const device = localBleDevices.find((item) => item.address === address);
    connectLocal(address, device?.name ?? 'BACtrack').catch(() => undefined);
  });

  useEffect(() => {
    if (!autoConnectCandidate) return;
    connectAutoDetected(autoConnectCandidate);
  }, [autoConnectCandidate]);

  const scanKnownDevices = useEffectEvent(() => {
    if (AppState.currentState === 'background' || !autoConnectEnabledRef.current
      || knownDevicesRef.current.length === 0 || activeBleAddress || localBleBusy || localProtocolReady) return;
    scanLocally().catch(() => undefined);
  });

  useEffect(() => {
    if (!knownDevicesLoaded) return;
    scanKnownDevices();
    const interval = setInterval(scanKnownDevices, 45_000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') scanKnownDevices();
    });
    return () => { clearInterval(interval); subscription.remove(); };
  }, [knownDevicesLoaded]);

  const startLocalBreathTest = async () => {
    const nativeModule = NativeModules.BactrackModule as BactrackNativeModule | undefined;
    if (!nativeModule) return;
    setLocalTestBusy(true);
    setLocalTestStatus('Starting local breath test…');
    try {
      let location: LocalLocation | null = null;
      if (locationCaptureEnabled) {
        const granted = await requestBlePermissions(true);
        if (granted) {
          try { location = await nativeModule.getCurrentLocation(); } catch { location = null; }
        }
      }
      await startNativeBreathTest(nativeModule, location);
    } catch (cause) {
      setLocalTestBusy(false);
      setLocalTestStatus(`Could not start local test: ${cause instanceof Error ? cause.message : 'unknown error'}`);
    }
  };

  const registerConnectedDevice = async () => {
    if (!localDeviceSerial || !managerUser || !managerSettings.organizationId) return;
    setManagerBusy(true);
    setManagerStatus('Registering this BACtrack with the selected account/team…');
    try {
      const metadata: ManagerDevice = {
        serialNumber: localDeviceSerial,
        model: managerModelCode(localProtocolReady ? 'C6' : deviceInfo.model, activeBleName),
        ...(deviceInfo.firmware ? { firmwareVersion: deviceInfo.firmware } : {}),
        ...(deviceInfo.hardwareRevision ? { hardwareRevision: deviceInfo.hardwareRevision } : {}),
        ...(deviceInfo.softwareRevision ? { softwareRevision: deviceInfo.softwareRevision } : {}),
        ...(deviceBatteryLevel !== null ? { batteryLevel: deviceBatteryLevel } : {}),
      };
      await managerClient(managerSettings.baseUrl, managerSettings.organizationId).claimDevice(metadata);
      setManagerStatus('Device registered to the selected account/team. Readings remain local unless sync is enabled.');
    } catch (cause) {
      setManagerStatus(cause instanceof Error ? cause.message : 'Could not register device with Manager.');
    } finally {
      setManagerBusy(false);
    }
  };

  const setBleAutoConnect = async (enabled: boolean) => {
    const native = NativeModules.BactrackModule as BactrackNativeModule | undefined;
    if (!native) return;
    autoConnectEnabledRef.current = enabled;
    setAutoConnectEnabled(enabled);
    await native.setSecureValue('ble.auto-connect', String(enabled));
    if (enabled && knownDevicesRef.current.length > 0 && !activeBleAddress) scanLocally().catch(() => undefined);
  };

  const setLocationCapture = async (enabled: boolean) => {
    const native = NativeModules.BactrackModule as BactrackNativeModule | undefined;
    if (!native) return;
    setLocationCaptureEnabled(enabled);
    await native.setSecureValue('location.capture', String(enabled));
  };

  const setDisplayUnit = async (unit: BacUnit) => {
    const native = NativeModules.BactrackModule as BactrackNativeModule | undefined;
    if (!native) return;
    try {
      await native.setSecureValue('display.bac-unit', unit);
      setBacUnit(unit);
    } catch {
      setError('Could not save the display unit on this phone.');
    }
  };

  const forgetKnownDevice = async (address: string) => {
    const native = NativeModules.BactrackModule as BactrackNativeModule | undefined;
    if (!native) return;
    const next = knownDevicesRef.current.filter((device) => device.address !== address);
    knownDevicesRef.current = next;
    setKnownDevices(next);
    await native.setSecureValue('ble.known-devices', JSON.stringify(next));
  };

  const localDeviceReady = localBleStatus === 'Connected and ready to test.';
  const connectedModel = connectedDeviceModel(localProtocolReady, deviceInfo.model, activeBleName);
  const canRunBreathTest = localProtocolReady;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.eyebrowRow}>
          <View style={styles.mark}><Text style={styles.markText}>B</Text></View>
          <Text style={styles.eyebrow}>BAC TRACK / MANAGER</Text>
          <Pressable testID="settings-button" accessibilityRole="tab" accessibilityState={{ selected: activeTab === 'settings' }}
            onPress={() => setActiveTab('settings')} style={[styles.settingsButton, activeTab === 'settings' && styles.settingsButtonActive]}>
            <Text style={[styles.settingsButtonText, activeTab === 'settings' && styles.settingsButtonTextActive]}>SETTINGS</Text>
          </Pressable>
        </View>
        <View style={styles.tabBar}>
            <Pressable onPress={() => setActiveTab('analysis')} style={[styles.tab, activeTab === 'analysis' && styles.tabActive]}>
            <Text style={[styles.tabText, activeTab === 'analysis' && styles.tabTextActive]}>01  ANALYSIS</Text>
          </Pressable>
          <Pressable testID="history-tab" onPress={() => setActiveTab('history')} style={[styles.tab, activeTab === 'history' && styles.tabActive]}>
            <Text style={[styles.tabText, activeTab === 'history' && styles.tabTextActive]}>02  HISTORY</Text>
          </Pressable>
        </View>

        {activeTab === 'analysis' ? <>
          <Text style={styles.title}>Breath analysis.</Text>
          <Text style={styles.intro}>Connect to your BACtrack. Results stay encrypted on this phone; Manager sync is optional in Settings.</Text>
          <View style={styles.homeDeviceSummary}>
            <View style={styles.homeDeviceIdentity}>
              <Text style={styles.homeSummaryHeading}>DEVICE</Text>
              <Text numberOfLines={1} ellipsizeMode="tail" style={styles.homeDeviceModel}>{activeBleAddress ? connectedModel : 'No device connected'}</Text>
            </View>
            <View style={styles.homeBattery}>
              <Text style={styles.homeSummaryHeading}>BATTERY</Text>
              <Text numberOfLines={1} style={styles.homeBatteryValue}>{batteryLabel(batteryStatus, !!activeBleAddress)}</Text>
            </View>
          </View>
          <View style={styles.localBleCard}>
            <Text style={styles.sectionKicker}>BACtrack / BLUETOOTH</Text>
            {!localDeviceReady ? <Text accessibilityLiveRegion="polite" style={styles.deviceStatus}>{localBleStatus}</Text> : null}
            {localTestStatus ? <Text accessibilityLiveRegion="polite" style={styles.deviceStatus}>{localTestStatus}</Text> : null}
            {!localDeviceReady ? <Pressable onPress={scanLocally} disabled={localBleBusy} style={styles.actionButton}>
              {localBleBusy ? <ActivityIndicator color="#fffaf1" /> : <Text style={styles.actionButtonText}>Find my BACtrack</Text>}
            </Pressable> : null}
            {localDeviceReady ? <Pressable onPress={startLocalBreathTest} disabled={!canRunBreathTest || localBleBusy || localTestBusy}
              style={[styles.actionButton, styles.actionButtonSecondary, (!canRunBreathTest || localBleBusy || localTestBusy) && styles.actionButtonDisabled]}>
              <Text style={[styles.actionButtonText, styles.actionButtonSecondaryText]}>
                {localTestBusy ? 'Breath test in progress…' : 'Start breath test'}
              </Text>
            </Pressable> : null}
            {localDeviceReady ? <Text style={styles.readingDate}>Start only when ready to blow and follow the device prompts. A reading is not a safe-driving determination.</Text> : null}
            {!localDeviceReady ? localBleDevices.map((device) => (
              <Pressable key={device.address} onPress={() => connectLocal(device.address, device.name)} disabled={localBleBusy} style={styles.bleDeviceRow}>
                <Text style={styles.bleDeviceName}>{displayDeviceModel(device.name)}</Text>
                <Text style={styles.localTag}>{knownDevices.some((known) => known.address === device.address) ? 'SAVED' : 'CONNECT'}</Text>
              </Pressable>
            )) : null}
            {activeBleAddress ? <Pressable onPress={() => (NativeModules.BactrackModule as BactrackNativeModule | undefined)?.disconnectLocalDevice()} style={styles.clearButton}>
              <Text style={styles.clearButtonText}>Disconnect device</Text>
            </Pressable> : null}
          </View>
        </> : activeTab === 'history' ? <>
          <Text style={styles.title}>Your history.</Text>
          <Text style={styles.intro}>Your breath-test history is encrypted on this phone. Manager copies appear only when you choose to sync.</Text>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionKicker}>BREATH TESTS</Text>
            {historyLoading ? <ActivityIndicator color="#d14e2b" /> : null}
          </View>
          <View style={styles.privacyNote}>
            <Text style={styles.privacyLabel}>ON-DEVICE ENCRYPTION</Text>
            <Text style={styles.privacyText}>Reading values and timestamps are encrypted with AES-GCM. The key is held by Android Keystore. Cloud downloads are also encrypted before being cached on this phone.</Text>
          </View>
          <View style={styles.historyList}>
            {readings.length === 0 && !historyLoading ? <Text style={styles.emptyHistory}>No saved breath tests yet.</Text> : null}
            {readings.map((reading) => (
              <View key={reading.id} style={styles.readingRow}>
                <View>
                  <Text style={styles.readingValue}>{formatBac(reading.bacPercent, bacUnit)}</Text>
                  <Text style={styles.readingDate}>{new Date(reading.measuredAt).toLocaleString()}</Text>
                  {reading.serial ? <Text style={styles.readingDate}>Device {reading.serial}</Text> : null}
                  {reading.latitude !== undefined && reading.longitude !== undefined
                    ? <Text style={styles.readingDate}>Location {reading.latitude.toFixed(4)}, {reading.longitude.toFixed(4)}</Text>
                    : null}
                </View>
                <Text style={styles.localTag}>{reading.cloud ? 'MANAGER COPY' : reading.synced ? 'SYNCED' : 'ON THIS PHONE'}</Text>
              </View>
            ))}
            {readings.length > 0 ? <Pressable onPress={confirmClearHistory} disabled={historyBusy} style={styles.clearButton}>
              {historyBusy ? <ActivityIndicator color="#a22d20" /> : <Text style={styles.clearButtonText}>Clear phone history</Text>}
            </Pressable> : null}
          </View>
        </> : <>
          <Text style={styles.title}>Settings.</Text>
          <Text style={styles.intro}>Your device, display, and privacy preferences. Manager is optional; local breath tests work without an account.</Text>
          <View style={styles.settingsCard}>
            <Text style={styles.settingsKicker}>MEASUREMENT UNIT</Text>
            <Text style={styles.settingsBody}>Choose how results appear in this app. Saved values and Manager sync remain in % BAC.</Text>
            {BAC_UNITS.map((unit) => <Pressable key={unit.value} testID={`bac-unit-${unit.value}`} accessibilityRole="radio" accessibilityState={{ checked: bacUnit === unit.value }}
              onPress={() => setDisplayUnit(unit.value)} style={[styles.unitOption, bacUnit === unit.value && styles.unitOptionActive]}>
              <View style={styles.unitCopy}>
                <Text style={[styles.unitLabel, bacUnit === unit.value && styles.unitTextActive]}>{unit.label}</Text>
                <Text style={[styles.unitDescription, bacUnit === unit.value && styles.unitDescriptionActive]}>{unit.description}</Text>
              </View>
              <View style={[styles.unitRadio, bacUnit === unit.value && styles.unitRadioActive]} />
            </Pressable>)}
            <Text style={styles.settingsNotice}>mg/L is an estimate using a 2100:1 blood-to-breath ratio. This changes the app display, not the device setting. If your C6 uses another device unit, verify its result before relying on converted values.</Text>
          </View>
          <View style={styles.settingsCard}>
            <Text style={styles.settingsKicker}>BLUETOOTH / SAVED DEVICES</Text>
            <Text style={styles.settingsBody}>Only devices you have connected are saved here. Auto-connect never picks an unknown nearby device.</Text>
            <Pressable accessibilityRole="switch" accessibilityState={{ checked: autoConnectEnabled }} onPress={() => setBleAutoConnect(!autoConnectEnabled)} style={[styles.modeOption, autoConnectEnabled && styles.modeOptionActive]}>
              <Text style={[styles.modeText, autoConnectEnabled && styles.modeTextActive]}>{autoConnectEnabled ? 'Auto-connect to saved BACtrack: ON' : 'Auto-connect to saved BACtrack: OFF'}</Text>
            </Pressable>
            {knownDevices.length ? knownDevices.map((device) => <View key={device.address} style={styles.knownDeviceRow}>
              <View style={styles.bleDeviceCopy}>
                <Text style={styles.bleDeviceName}>{displayDeviceModel(device.name)}</Text>
                <Text selectable style={styles.knownDeviceId}>BLE address  ·  {device.address}</Text>
                <Text selectable style={styles.knownDeviceId}>Local ID  ·  {activeBleAddress === device.address && localDeviceSerial ? localDeviceSerial : knownDeviceIds[device.address] ?? 'Unavailable'}</Text>
              </View>
              <Pressable accessibilityRole="button" onPress={() => forgetKnownDevice(device.address)}><Text style={styles.forgetDeviceText}>Forget</Text></Pressable>
            </View>) : <Text style={styles.settingsEmpty}>No saved devices yet. Connect a BACtrack from Analysis to remember it.</Text>}
            <Text style={styles.settingsNotice}>The local ID is generated by this app, not the hardware serial number. Bluetooth addresses stay on this phone.</Text>
          </View>
          <View style={styles.settingsCard}>
            <Text style={styles.settingsKicker}>TEST LOCATION</Text>
            <Text style={styles.settingsBody}>When enabled, the phone records a one-time location with each test. The point stays encrypted locally unless you choose to sync with Manager.</Text>
            <Pressable accessibilityRole="switch" accessibilityState={{ checked: locationCaptureEnabled }} onPress={() => setLocationCapture(!locationCaptureEnabled)} style={[styles.modeOption, locationCaptureEnabled && styles.modeOptionActive]}>
              <Text style={[styles.modeText, locationCaptureEnabled && styles.modeTextActive]}>{locationCaptureEnabled ? 'Save test location: ON' : 'Save test location: OFF'}</Text>
            </Pressable>
            <Text style={styles.settingsNotice}>When Manager sync and Dawarich are connected, synced test points may appear in your Dawarich map.</Text>
          </View>
          <View style={styles.managerCard}>
            <Text style={styles.settingsKicker}>BACtrack MANAGER SERVER</Text>
            <Text style={styles.settingsBody}>Optional home-lab connection for accounts, teams, and sync. Turning sync off does not affect local tests.</Text>
            <TextInput value={managerSettings.baseUrl} onChangeText={(baseUrl) => setManagerSettings((current) => ({ ...current, baseUrl }))}
              onEndEditing={async () => updateManagerSettings({ ...managerSettings, baseUrl: managerSettings.baseUrl.trim().replace(/\/$/, '') })}
              autoCapitalize="none" keyboardType="url" placeholder="https://manager.example.com" style={styles.input} />
            <Text accessibilityLiveRegion="polite" style={styles.deviceStatus}>{managerStatus}</Text>
            {!managerUser ? <>
              <TextInput value={managerEmail} onChangeText={setManagerEmail} autoCapitalize="none" keyboardType="email-address"
                placeholder="Email address" style={styles.input} />
              <Pressable onPress={startManagerLogin} disabled={managerBusy || !managerEmail.includes('@')} style={styles.actionButton}>
                {managerBusy ? <ActivityIndicator color="#fffaf1" /> : <Text style={styles.actionButtonText}>Send sign-in link</Text>}
              </Pressable>
              <TextInput value={magicToken} onChangeText={setMagicToken} autoCapitalize="none" placeholder="Paste sign-in link or token"
                style={styles.input} />
              <Pressable onPress={async () => consumeManagerLink(magicToken)} disabled={managerBusy || !magicToken.trim()} style={styles.outlineButton}>
                <Text style={styles.outlineButtonText}>Sign in with link</Text>
              </Pressable>
              {mfaTicket ? <>
                <TextInput value={mfaCode} onChangeText={setMfaCode} keyboardType="number-pad" placeholder="Authenticator code" style={styles.input} />
                <Pressable onPress={completeManagerMfa} disabled={managerBusy || !mfaCode.trim()} style={styles.actionButton}>
                  <Text style={styles.actionButtonText}>Verify code</Text>
                </Pressable>
              </> : null}
            </> : <>
              <Text style={styles.managerIdentity}>{managerUser.displayName}  ·  {managerUser.email}</Text>
              {managerOrgs.length > 1 ? <>
                <Text style={styles.deviceInfoHeading}>ACCOUNT / TEAM</Text>
                {managerOrgs.map((org) => <Pressable key={org.id} onPress={async () => {
                  await updateManagerSettings({ ...managerSettings, organizationId: org.id });
                }} style={[styles.modeOption, managerSettings.organizationId === org.id && styles.modeOptionActive]}>
                  <Text style={[styles.modeText, managerSettings.organizationId === org.id && styles.modeTextActive]}>{org.name} · {org.role}</Text>
                </Pressable>)}
              </> : null}
              <Text style={styles.deviceInfoHeading}>SYNC DIRECTION</Text>
              {SYNC_MODES.map((mode) => <Pressable key={mode.value} onPress={async () => {
                await updateManagerSettings({ ...managerSettings, syncMode: mode.value });
              }} style={[styles.modeOption, managerSettings.syncMode === mode.value && styles.modeOptionActive]}>
                <Text style={[styles.modeText, managerSettings.syncMode === mode.value && styles.modeTextActive]}>{mode.label}</Text>
              </Pressable>)}
              <Pressable onPress={syncWithManager} disabled={managerBusy || managerSettings.syncMode === 'disabled'} style={[styles.actionButton, managerSettings.syncMode === 'disabled' && styles.actionButtonDisabled]}>
                {managerBusy ? <ActivityIndicator color="#fffaf1" /> : <Text style={styles.actionButtonText}>Sync now</Text>}
              </Pressable>
              <Pressable onPress={registerConnectedDevice} disabled={managerBusy || !localDeviceReady || !localDeviceSerial} style={[styles.outlineButton, (!localDeviceReady || !localDeviceSerial) && styles.actionButtonDisabled]}>
                <Text style={styles.outlineButtonText}>Register connected BACtrack to account/team</Text>
              </Pressable>
              <Text style={styles.readingDate}>Manager uses a private app-generated device ID. The Bluetooth address and breath data are not sent when you register the device.</Text>
              <Pressable onPress={disconnectManager} disabled={managerBusy} style={styles.outlineButton}>
                <Text style={styles.outlineButtonText}>Disconnect Manager</Text>
              </Pressable>
            </>}
          </View>
        </>}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <Text style={styles.footer}>BAC TRACK MANAGER  /  LOCAL FIRST</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

export default function App() {
  return <SafeAreaProvider><AppContent /></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f4f2ec' },
  page: { paddingHorizontal: 24, paddingTop: 22, paddingBottom: 38, maxWidth: 620, width: '100%', alignSelf: 'center' },
  eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 34 },
  settingsButton: { marginLeft: 'auto', minHeight: 34, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 8, backgroundColor: '#e8e5dc' },
  settingsButtonActive: { backgroundColor: '#263a32' },
  settingsButtonText: { color: '#263a32', fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  settingsButtonTextActive: { color: '#fffaf1' },
  tabBar: { flexDirection: 'row', gap: 8, marginBottom: 25, padding: 4, borderRadius: 12, backgroundColor: '#e8e5dc' },
  tab: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 9 },
  tabActive: { backgroundColor: '#263a32' },
  tabText: { color: '#766f63', fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  tabTextActive: { color: '#fffaf1' },
  mark: { width: 31, height: 31, borderRadius: 16, backgroundColor: '#d14e2b', alignItems: 'center', justifyContent: 'center' },
  markText: { color: '#fffaf1', fontWeight: '900', fontSize: 17 },
  eyebrow: { color: '#766f63', fontSize: 11, fontWeight: '800', letterSpacing: 1.4 },
  title: { color: '#202b27', fontSize: 42, fontWeight: '800', letterSpacing: -1.5, lineHeight: 45 },
  intro: { color: '#686c62', fontSize: 15, lineHeight: 23, marginTop: 14, marginBottom: 30, maxWidth: 490 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sectionKicker: { color: '#92765e', fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  options: { gap: 9 },
  option: { paddingHorizontal: 16, paddingVertical: 15, borderColor: '#dedbd1', borderWidth: 1, borderRadius: 13, backgroundColor: '#fbfaf6' },
  optionSelected: { backgroundColor: '#263a32', borderColor: '#263a32' },
  optionTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  optionTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  optionNumber: { color: '#b1a99b', fontSize: 11, fontWeight: '800', letterSpacing: 0.7 },
  optionTitle: { color: '#29342e', fontSize: 16, fontWeight: '700' },
  optionDescription: { color: '#76766c', marginLeft: 34, marginTop: 6, fontSize: 12, lineHeight: 18 },
  selectedText: { color: '#fffaf1' },
  selectedDescription: { color: '#c9d1c8' },
  radio: { width: 19, height: 19, borderRadius: 10, borderWidth: 1.5, borderColor: '#bdb9ad', alignItems: 'center', justifyContent: 'center' },
  radioSelected: { borderColor: '#e9a17b' },
  radioDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#e9a17b' },
  privacyNote: { borderLeftWidth: 3, borderLeftColor: '#d14e2b', paddingLeft: 14, marginTop: 20, marginBottom: 29 },
  privacyLabel: { color: '#bd4a2d', fontSize: 9, fontWeight: '900', letterSpacing: 1.4, marginBottom: 5 },
  privacyText: { color: '#696c63', fontSize: 12, lineHeight: 18 },
  historyList: { gap: 9, marginBottom: 28 },
  emptyHistory: { padding: 18, borderRadius: 13, backgroundColor: '#fbfaf6', color: '#76766c', fontSize: 13 },
  readingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: 15, borderRadius: 13, backgroundColor: '#fbfaf6', borderWidth: 1, borderColor: '#dedbd1' },
  readingValue: { color: '#263a32', fontSize: 18, fontWeight: '800' },
  readingDate: { color: '#76766c', fontSize: 11, marginTop: 4 },
  localTag: { color: '#397b59', fontSize: 8, fontWeight: '900', letterSpacing: 0.7 },
  clearButton: { minHeight: 42, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#d7aaa0', borderRadius: 10, marginTop: 3 },
  clearButtonText: { color: '#a22d20', fontSize: 12, fontWeight: '800' },
  localBleCard: { backgroundColor: '#e8e5dc', borderRadius: 15, padding: 17, marginBottom: 16 },
  settingsCard: { backgroundColor: '#fbfaf6', borderWidth: 1, borderColor: '#dedbd1', borderRadius: 15, padding: 18, marginBottom: 14 },
  settingsKicker: { color: '#263a32', fontSize: 11, fontWeight: '900', letterSpacing: 1.3 },
  settingsBody: { color: '#59635b', fontSize: 13, lineHeight: 20, marginTop: 8, marginBottom: 8 },
  settingsNotice: { color: '#746d5f', fontSize: 11, lineHeight: 17, marginTop: 13, paddingLeft: 11, borderLeftWidth: 2, borderLeftColor: '#d8b47a' },
  settingsEmpty: { color: '#76766c', fontSize: 12, lineHeight: 18, marginTop: 14 },
  unitOption: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 57, paddingHorizontal: 13, paddingVertical: 9, borderRadius: 10, borderWidth: 1, borderColor: '#dedbd1', backgroundColor: '#f4f2ec', marginTop: 7 },
  unitOptionActive: { backgroundColor: '#263a32', borderColor: '#263a32' },
  unitCopy: { flex: 1, minWidth: 0 },
  unitLabel: { color: '#263a32', fontSize: 14, fontWeight: '800' },
  unitDescription: { color: '#76766c', fontSize: 11, lineHeight: 16, marginTop: 2 },
  unitTextActive: { color: '#fffaf1' },
  unitDescriptionActive: { color: '#c9d1c8' },
  unitRadio: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: '#aaa597' },
  unitRadioActive: { borderWidth: 5, borderColor: '#f5c878', backgroundColor: '#263a32' },
  managerCard: { backgroundColor: '#fbfaf6', borderWidth: 1, borderColor: '#dedbd1', borderRadius: 15, padding: 18, marginBottom: 16 },
  managerIdentity: { color: '#263a32', fontSize: 13, lineHeight: 20, marginVertical: 12 },
  input: { minHeight: 46, borderWidth: 1, borderColor: '#d2cec2', borderRadius: 9, backgroundColor: '#fbfaf6', paddingHorizontal: 12, color: '#263a32', fontSize: 13, marginTop: 9 },
  modeOption: { minHeight: 44, justifyContent: 'center', borderWidth: 1, borderColor: '#d2cec2', borderRadius: 9, backgroundColor: '#f4f2ec', paddingHorizontal: 12, paddingVertical: 8, marginTop: 7 },
  modeOptionActive: { backgroundColor: '#263a32', borderColor: '#263a32' },
  modeText: { color: '#263a32', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  modeTextActive: { color: '#fffaf1' },
  outlineButton: { minHeight: 43, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#bdb9ad', borderRadius: 9, paddingHorizontal: 12, marginTop: 9 },
  outlineButtonText: { color: '#263a32', fontSize: 12, fontWeight: '800' },
  bleDeviceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: 12, borderRadius: 10, backgroundColor: '#fbfaf6', marginTop: 8 },
  bleDeviceCopy: { flex: 1, minWidth: 0 },
  bleDeviceName: { color: '#263a32', fontSize: 13, fontWeight: '800' },
  deviceTitle: { color: '#263a32', fontSize: 18, fontWeight: '800', marginTop: 14 },
  deviceDescription: { color: '#696c63', fontSize: 12, lineHeight: 19, marginTop: 7 },
  deviceStatus: { color: '#263a32', fontSize: 12, lineHeight: 18, marginTop: 13 },
  homeDeviceSummary: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: '#263a32', padding: 17, borderRadius: 14, marginBottom: 18, height: 92 },
  homeDeviceIdentity: { flex: 1, minWidth: 0 },
  homeSummaryHeading: { color: '#c9d1c8', fontSize: 9, fontWeight: '900', letterSpacing: 1.1 },
  homeDeviceModel: { color: '#fffaf1', fontSize: 19, fontWeight: '800', marginTop: 4 },
  homeBattery: { width: 86, flexShrink: 0, alignItems: 'flex-end' },
  homeBatteryValue: { color: '#f5c878', fontSize: 18, fontWeight: '900', marginTop: 4 },
  knownDeviceRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: '#dedbd1', backgroundColor: '#f4f2ec', marginTop: 8 },
  knownDeviceId: { color: '#59635b', fontSize: 10, lineHeight: 16, marginTop: 4 },
  forgetDeviceText: { color: '#a22d20', fontSize: 11, fontWeight: '800', padding: 7 },
  deviceInfoHeading: { color: '#92765e', fontSize: 9, fontWeight: '900', letterSpacing: 1.1, marginBottom: 6 },
  batteryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  actionButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: '#263a32', borderRadius: 10, paddingHorizontal: 14, marginTop: 10 },
  actionButtonText: { color: '#fffaf1', fontSize: 12, fontWeight: '800' },
  actionButtonSecondary: { backgroundColor: '#dcd8ce' },
  actionButtonSecondaryText: { color: '#263a32' },
  actionButtonDisabled: { opacity: 0.55 },
  error: { color: '#a22d20', marginTop: 12, fontSize: 12 },
  footer: { color: '#aaa597', fontSize: 9, fontWeight: '800', letterSpacing: 1.1, marginTop: 32 },
});
