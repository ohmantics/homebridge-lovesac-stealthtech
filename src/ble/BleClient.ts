import type { Logger } from 'homebridge';
import noble from '@stoprocent/noble';
import { SOFA_SERVICE_UUID_SHORT, CharUUID, BLE_SCAN_TIMEOUT } from '../settings';

export type NotificationHandler = (data: Buffer) => void;

export interface IBleClient {
  connect(address?: string): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  resolvedAddress: string;
  write(characteristicUuid: string, data: Buffer): Promise<void>;
  subscribeNotifications(handler: NotificationHandler): Promise<void>;
}

interface CharacteristicMap {
  [uuid: string]: noble.Characteristic;
}

export class BleClient implements IBleClient {
  private peripheral: noble.Peripheral | null = null;
  private characteristics: CharacteristicMap = {};
  private notificationHandler: NotificationHandler | null = null;
  private _connected = false;
  private _resolvedAddress = '';

  constructor(private readonly log: Logger) {}

  get resolvedAddress(): string {
    return this._resolvedAddress;
  }

  async connect(address?: string): Promise<void> {
    if (this._connected) {
      return;
    }

    let peripheral: noble.Peripheral | null;

    if (address) {
      this.log.debug('BLE: Starting scan for %s...', address);
      peripheral = await this.scanForDevice(address);
      if (!peripheral) {
        throw new Error(`Device ${address} not found`);
      }
    } else {
      this.log.debug('BLE: Starting auto-discovery scan...');
      peripheral = await this.scanForAnyDevice();
      if (!peripheral) {
        throw new Error('No Lovesac StealthTech device found');
      }
    }

    const resolvedId = peripheral.address !== '' && peripheral.address !== 'unknown'
      ? peripheral.address
      : peripheral.id ?? peripheral.uuid ?? 'unknown';
    this.log.debug('BLE: Connecting to %s...', resolvedId);
    this._resolvedAddress = resolvedId;
    // Register disconnect handler BEFORE connecting to avoid race (P0-2)
    peripheral.once('disconnect', () => {
      this.log.debug('BLE: Disconnected');
      this._connected = false;
      this.peripheral = null;
      this.characteristics = {};
    });

    await peripheral.connectAsync();
    this._connected = true;
    this.peripheral = peripheral;

    this.log.debug('BLE: Discovering services and characteristics...');
    const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [SOFA_SERVICE_UUID_SHORT],
      Object.values(CharUUID),
    );

    for (const char of characteristics) {
      this.characteristics[char.uuid] = char;
    }

    this.log.debug('BLE: Found %d characteristics', Object.keys(this.characteristics).length);
  }

  async disconnect(): Promise<void> {
    if (this.peripheral && this._connected) {
      try {
        await this.peripheral.disconnectAsync();
      } catch {
        // Already disconnected
      }
    }
    this._connected = false;
    this.peripheral = null;
    this.characteristics = {};
  }

  isConnected(): boolean {
    return this._connected;
  }

  async write(characteristicUuid: string, data: Buffer): Promise<void> {
    const char = this.characteristics[characteristicUuid];
    if (!char) {
      throw new Error(`Characteristic ${characteristicUuid} not found. Available: ${Object.keys(this.characteristics).join(', ')}`);
    }
    // Write without response (as per protocol spec)
    await char.writeAsync(data, true);
  }

  async subscribeNotifications(handler: NotificationHandler): Promise<void> {
    this.notificationHandler = handler;

    const upstream = this.characteristics[CharUUID.UpStream];
    if (!upstream) {
      throw new Error('UpStream characteristic not found');
    }

    // Remove previous listeners to prevent leak on reconnect (P0-1)
    upstream.removeAllListeners('data');

    upstream.on('data', (data: Buffer) => {
      if (this.notificationHandler) {
        try {
          this.notificationHandler(data);
        } catch (err) {
          this.log.error('BLE: Notification handler error: %s', err);
        }
      }
    });

    await upstream.subscribeAsync();
    this.log.debug('BLE: Subscribed to UpStream notifications');
  }

  private scanForAnyDevice(): Promise<noble.Peripheral | null> {
    return this.scan((_peripheral: noble.Peripheral) => {
      return true; // accept the first device with the right service UUID
    });
  }

  private scanForDevice(address: string): Promise<noble.Peripheral | null> {
    const normalized = address.toLowerCase().replace(/[:-]/g, '');
    return this.scan((peripheral: noble.Peripheral) => {
      const id = peripheral.id?.toLowerCase().replace(/[:-]/g, '') ?? '';
      const addr = peripheral.address?.toLowerCase().replace(/[:-]/g, '') ?? '';
      const uuid = peripheral.uuid?.toLowerCase().replace(/[:-]/g, '') ?? '';
      return id === normalized || addr === normalized || uuid === normalized;
    });
  }

  private scan(match: (peripheral: noble.Peripheral) => boolean): Promise<noble.Peripheral | null> {
    return new Promise((resolve, reject) => {
      const onDiscover = (peripheral: noble.Peripheral) => {
        if (!match(peripheral)) {
          return;
        }
        clearTimeout(timeout);
        cleanup();
        const name = peripheral.advertisement?.localName ?? '(unnamed)';
        this.log.info('BLE: Discovered device: %s', name);
        resolve(peripheral);
      };

      const cleanup = () => {
        noble.stopScanning();
        noble.removeListener('discover', onDiscover);
      };

      const timeout = setTimeout(() => {
        cleanup();
        resolve(null);
      }, BLE_SCAN_TIMEOUT);

      noble.on('discover', onDiscover);

      const startScan = () => {
        noble.startScanning([SOFA_SERVICE_UUID_SHORT], false, (err?: Error) => {
          if (err) {
            clearTimeout(timeout);
            cleanup();
            reject(err);
          }
        });
      };

      if (noble.state === 'poweredOn') {
        startScan();
      } else {
        noble.once('stateChange', (state: string) => {
          if (state === 'poweredOn') {
            startScan();
          } else {
            clearTimeout(timeout);
            cleanup();
            reject(new Error(`Bluetooth adapter state: ${state}`));
          }
        });
      }
    });
  }
}
