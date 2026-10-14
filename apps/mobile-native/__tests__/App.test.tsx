/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App, { batteryLabel, connectedDeviceModel, displayDeviceModel, normalizeCloudReadings, startNativeBreathTest } from '../App';
import { ManagerClient } from '../src/manager-client';
import { formatBac, isBacUnit } from '../src/bac-units';

jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
    SafeAreaView: View,
  };
});

test('keeps analysis and history primary and puts Manager connection in Settings', async () => {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<App />);
    await Promise.resolve();
  });

  expect(renderer.root.findByProps({ children: '01  ANALYSIS' })).toBeTruthy();
  expect(renderer.root.findByProps({ children: '02  HISTORY' })).toBeTruthy();
  expect(renderer.root.findByProps({ children: 'Breath analysis.' })).toBeTruthy();
  expect(renderer.root.findByProps({ children: 'Find my BACtrack' })).toBeTruthy();
  expect(renderer.root.findAllByProps({ children: 'Start breath test' })).toHaveLength(0);
  expect(renderer.root.findByProps({ children: 'BATTERY' })).toBeTruthy();
  expect(renderer.root.findByProps({ children: 'No device connected' })).toBeTruthy();
  expect(renderer.root.findAllByProps({ children: 'Disconnect device' })).toHaveLength(0);
  expect(renderer.root.findAllByProps({ children: 'BACtrack Android SDK' })).toHaveLength(0);
  expect(renderer.root.findAllByProps({ children: 'RAW BLE NOTIFICATIONS' })).toHaveLength(0);
  expect(renderer.root.findAllByProps({ children: 'GATT SERVICES / DEVICE CAPABILITIES' })).toHaveLength(0);

  await ReactTestRenderer.act(async () => {
    renderer.root.findByProps({ testID: 'history-tab' }).props.onPress();
  });
  expect(renderer.root.findByProps({ children: 'Your history.' })).toBeTruthy();
  expect(renderer.root.findByProps({ children: 'No saved breath tests yet.' })).toBeTruthy();

  await ReactTestRenderer.act(async () => {
    renderer.root.findByProps({ testID: 'settings-button' }).props.onPress();
  });
  expect(renderer.root.findByProps({ children: 'Settings.' })).toBeTruthy();
  expect(renderer.root.findByProps({ testID: 'settings-button' }).props.accessibilityState.selected).toBe(true);
  expect(renderer.root.findByProps({ children: 'BACtrack MANAGER SERVER' })).toBeTruthy();
  expect(renderer.root.findByProps({ children: 'Send sign-in link' })).toBeTruthy();
  expect(renderer.root.findByProps({ children: 'Auto-connect to saved BACtrack: ON' })).toBeTruthy();
  expect(renderer.root.findByProps({ testID: 'bac-unit-percent' }).props.accessibilityState.checked).toBe(true);
  expect(renderer.root.findByProps({ children: 'mg/L' })).toBeTruthy();
});

test('formats every display unit without changing the canonical percent value', () => {
  const percent = 0.08;
  expect(formatBac(percent, 'percent')).toBe('0.080 % BAC');
  expect(formatBac(percent, 'mg_l')).toBe('0.38 mg/L');
  expect(formatBac(percent, 'permille')).toBe('0.80 ‰');
  expect(formatBac(percent, 'g_l')).toBe('0.80 g/L');
  expect(formatBac(percent, 'mg_100ml')).toBe('80.0 mg/100mL');
  expect(percent).toBe(0.08);
  expect(isBacUnit('mg_l')).toBe(true);
  expect(isBacUnit('invalid')).toBe(false);
});

test('starts the native breath test without arguments on old and new Android bridges', async () => {
  const startLocalBreathTest = jest.fn().mockResolvedValue(true);
  const setPendingTestLocation = jest.fn().mockResolvedValue(true);
  const native = { startLocalBreathTest, setPendingTestLocation } as unknown as Parameters<typeof startNativeBreathTest>[0];
  const location = { latitude: 1, longitude: 2, accuracy: 3, timestamp: 4 };
  await startNativeBreathTest(native, location);
  expect(setPendingTestLocation).toHaveBeenCalledWith(location);
  expect(startLocalBreathTest).toHaveBeenCalledWith();

  await startNativeBreathTest({ startLocalBreathTest } as unknown as Parameters<typeof startNativeBreathTest>[0], null);
  expect(startLocalBreathTest).toHaveBeenCalledTimes(2);
  expect(startLocalBreathTest).toHaveBeenLastCalledWith();
});

test('converts Manager BAC decimals to bridge-compatible numbers', () => {
  const reading = { id: 'r1', bacPromille: '0.25', measuredAt: '2026-10-14T00:00:00Z', deviceSerial: 'C6' };
  expect(normalizeCloudReadings([reading])[0].bacPromille).toBe(0.25);
  expect(() => normalizeCloudReadings([{ ...reading, bacPromille: 'not-a-number' }])).toThrow('invalid BAC');
});

test('uses BACtrack model names reported by device identity fields', () => {
  expect(displayDeviceModel('BACtrack C6')).toBe('BACtrack C6');
  expect(displayDeviceModel('Unknown BLE device', 'Model K10')).toBe('BACtrack K10');
  expect(connectedDeviceModel(true, 'Model K10')).toBe('BACtrack C6');
  expect(connectedDeviceModel(false, 'Model K10')).toBe('BACtrack K10');
});

test('keeps battery text short enough for the fixed dashboard column', () => {
  expect(batteryLabel('Battery status unavailable', true)).toBe('N/A');
  expect(batteryLabel('Checking battery…', true)).toBe('…');
  expect(batteryLabel('Full', true)).toBe('Full');
  expect(batteryLabel('Not connected', false)).toBe('—');
});

test('normalizes a Manager server URL and rejects embedded credentials', () => {
  expect(ManagerClient.normalizeBaseUrl('http://192.168.21.2:3001/')).toBe('http://192.168.21.2:3001');
  expect(() => ManagerClient.normalizeBaseUrl('http://user:pass@example.com')).toThrow();
});

test('retains Manager credentials when refresh fails because the server is offline', async () => {
  const storage = {
    getSecureValue: jest.fn().mockResolvedValue(JSON.stringify({ accessToken: 'old', refreshToken: 'refresh' })),
    setSecureValue: jest.fn(),
    clearSecureValue: jest.fn(),
  };
  const previousFetch = globalThis.fetch;
  const fetchMock = jest.fn()
    .mockResolvedValueOnce({ status: 401 })
    .mockRejectedValueOnce(new Error('Network unavailable'));
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    await expect(new ManagerClient('http://manager.test', '', storage).me()).rejects.toThrow('Network unavailable');
    expect(storage.clearSecureValue).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = previousFetch;
  }
});
