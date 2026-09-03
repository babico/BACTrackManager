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
