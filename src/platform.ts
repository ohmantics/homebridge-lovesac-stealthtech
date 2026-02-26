import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
} from 'homebridge';
import { PLUGIN_NAME, resolveDeviceConfig } from './settings';
import type { LovesacPlatformConfig } from './settings';
import { LovesacAccessory } from './accessory';
import { BleClient } from './ble/BleClient';
import { BleConnectionManager } from './ble/BleConnectionManager';
import { LovesacDevice } from './protocol/LovesacDevice';

export class LovesacPlatform implements DynamicPlatformPlugin {
  private readonly accessories: LovesacAccessory[] = [];
  private device: LovesacDevice | null = null;
  private connectionManager: BleConnectionManager | null = null;

  constructor(
    public readonly log: Logger,
    public readonly config: LovesacPlatformConfig,
    public readonly api: API,
  ) {
    this.log.info('Lovesac StealthTech platform initialized');

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      this.device?.stopPolling();
      this.connectionManager?.disconnect().catch(() => {});
    });
  }

  // Required by DynamicPlatformPlugin — we don't use cached accessories for external accessories
  configureAccessory(_accessory: PlatformAccessory): void {
    // External accessories are not cached, so this is a no-op
  }

  private discoverDevices(): void {
    let devices = this.config.devices ?? [];

    // If no devices configured at all, create a default entry for auto-discovery
    if (devices.length === 0) {
      this.log.info('No devices configured — will auto-discover via BLE.');
      devices = [{}];
    }

    if (devices.length > 1) {
      this.log.warn('Multiple devices configured — only the first device is supported in this version.');
    }

    const rawConfig = devices[0];
    const deviceConfig = resolveDeviceConfig(rawConfig);

    if (deviceConfig.address) {
      this.log.info('Setting up device: %s (%s)', deviceConfig.name, deviceConfig.address);
    } else {
      this.log.info('Setting up device: %s (auto-discovery)', deviceConfig.name);
    }

    // Generate a stable UUID from the BLE address + plugin name
    // _testSuffix in config allows generating a fresh identity for testing
    // For auto-discovery, use a fixed seed so the identity is stable
    const addressSeed = deviceConfig.address || 'auto';
    const uuidSeed = 'lovesac-st:' + addressSeed + ((rawConfig as Record<string, unknown>)._testSuffix ?? '');
    const uuid = this.api.hap.uuid.generate(uuidSeed);
    const accessory = new this.api.platformAccessory(deviceConfig.name, uuid);

    // Create BLE stack
    const bleClient = new BleClient(this.log);
    this.connectionManager = new BleConnectionManager(
      bleClient,
      deviceConfig.address,
      deviceConfig.idleTimeout,
      this.log,
    );
    this.device = new LovesacDevice(this.connectionManager, this.log);
    const device = this.device;

    // Create accessory handler
    const handler = new LovesacAccessory(this, accessory, deviceConfig, device);
    this.accessories.push(handler);

    // Audio receiver icon — closer to a soundbar than the TV icon
    accessory.category = this.api.hap.Categories.AUDIO_RECEIVER;

    this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
  }
}
