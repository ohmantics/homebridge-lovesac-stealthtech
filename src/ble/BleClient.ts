import type { Logger } from 'homebridge';
import type { Peripheral, Characteristic } from '@stoprocent/noble';
import {
  SOFA_SERVICE_UUID_SHORT, CharUUID, BLE_SCAN_TIMEOUT,
  BLE_CONNECT_TIMEOUT, BLE_WRITE_TIMEOUT, BLE_DISCONNECT_TIMEOUT, BLE_DISCOVER_TIMEOUT,
  BLE_SCAN_RETRY_DELAY,
  withTimeout,
} from '../settings';

// Lazy-import noble to avoid opening an HCI socket in Homebridge's main
// process. The top-level import runs during plugin registration (main
// process), but BLE is only used in the child bridge. Deferring the
// require() ensures the HCI socket is only opened once, in the child.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const getNoble = (() => {
  let instance: typeof import('@stoprocent/noble').default | null = null;
  return () => {
    if (!instance) {
      instance = require('@stoprocent/noble') as typeof import('@stoprocent/noble').default;
    }
    return instance;
  };
})();


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
  [uuid: string]: Characteristic;
}

export class BleClient implements IBleClient {
  private peripheral: Peripheral | null = null;
  private characteristics: CharacteristicMap = {};
  private notificationHandler: NotificationHandler | null = null;
  private _connected = false;
  private _resolvedAddress = '';
  private connectGeneration = 0;

  constructor(private readonly log: Logger) {}

  get resolvedAddress(): string {
    return this._resolvedAddress;
  }

  async connect(address?: string): Promise<void> {
    if (this._connected) {
      return;
    }

    const gen = ++this.connectGeneration;

    // Fast path: reuse cached peripheral from a prior connection (skip scan)
    if (this.peripheral) {
      this.log.debug('BLE: Reconnecting to cached peripheral %s...', this._resolvedAddress);
      try {
        await this.connectPeripheral(this.peripheral, gen);
        return;
      } catch (err) {
        this.log.debug('BLE: Cached peripheral connect failed: %s — falling back to scan',
          (err as Error).message);
        this.peripheral = null;
      }
    }

    // Slow path: scan for the device (with one retry)
    const peripheral = await this.scanWithRetry(address, gen);

    const resolvedId = peripheral.address !== '' && peripheral.address !== 'unknown'
      ? peripheral.address
      : peripheral.id ?? peripheral.uuid ?? 'unknown';
    this._resolvedAddress = resolvedId;

    await this.connectPeripheral(peripheral, gen);
  }

  private async connectPeripheral(peripheral: Peripheral, gen: number): Promise<void> {
    // Register disconnect handler BEFORE connecting to avoid race (P0-2).
    // Capture the generation so a stale handler from a timed-out attempt does
    // not clear state that belongs to a newer connection.
    peripheral.once('disconnect', () => {
      this.log.debug('BLE: Disconnected');
      if (gen === this.connectGeneration) {
        this._connected = false;
        this.characteristics = {};
      }
    });

    try {
      await withTimeout(peripheral.connectAsync(), BLE_CONNECT_TIMEOUT, 'BLE connect');
    } catch (err) {
      // Cancel the pending HCI connection and reset the adapter so
      // subsequent scans still work (BlueZ gets stuck otherwise).
      if (peripheral.state === 'connecting') {
        try { peripheral.cancelConnect(); } catch { /* best effort */ }
      } else {
        peripheral.disconnectAsync().catch(() => {});
      }
      getNoble().reset();
      throw err;
    }
    this._connected = true;
    this.peripheral = peripheral;

    this.log.debug('BLE: Discovering services and characteristics...');
    let characteristics: Characteristic[];
    try {
      ({ characteristics } = await withTimeout(
        peripheral.discoverSomeServicesAndCharacteristicsAsync(
          [SOFA_SERVICE_UUID_SHORT],
          Object.values(CharUUID),
        ),
        BLE_DISCOVER_TIMEOUT,
        'BLE service discovery',
      ));
    } catch (err) {
      peripheral.disconnectAsync().catch(() => {});
      throw err;
    }

    for (const char of characteristics) {
      this.characteristics[char.uuid] = char;
    }

    this.log.debug('BLE: Found %d characteristics', Object.keys(this.characteristics).length);
  }

  private async scanWithRetry(address: string | undefined, gen: number): Promise<Peripheral> {
    const label = address ?? 'auto-discovery';
    const scanFn = address
      ? () => this.scanForDevice(address)
      : () => this.scanForAnyDevice();

    this.log.debug('BLE: Starting scan for %s...', label);
    let peripheral = await scanFn();
    if (peripheral) {
      return peripheral;
    }

    // First scan missed — retry once after a short delay
    if (gen !== this.connectGeneration) {
      throw new Error('Connection attempt superseded');
    }
    this.log.info('BLE: Scan found nothing, retrying in %ds...', BLE_SCAN_RETRY_DELAY / 1000);
    await new Promise(r => setTimeout(r, BLE_SCAN_RETRY_DELAY));

    if (gen !== this.connectGeneration) {
      throw new Error('Connection attempt superseded');
    }
    peripheral = await scanFn();
    if (peripheral) {
      return peripheral;
    }

    throw new Error(address
      ? `Device ${address} not found`
      : 'No Lovesac StealthTech device found');
  }

  async disconnect(): Promise<void> {
    if (this.peripheral && this._connected) {
      try {
        await withTimeout(this.peripheral.disconnectAsync(), BLE_DISCONNECT_TIMEOUT, 'BLE disconnect');
      } catch {
        // Already disconnected or timed out — clean up regardless
      }
    }
    this._connected = false;
    this.characteristics = {};
    // Keep this.peripheral cached for fast reconnect
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
    await withTimeout(char.writeAsync(data, true), BLE_WRITE_TIMEOUT, 'BLE write');
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

    await withTimeout(upstream.subscribeAsync(), BLE_DISCOVER_TIMEOUT, 'BLE subscribe');
    this.log.debug('BLE: Subscribed to UpStream notifications');
  }

  private scanForAnyDevice(): Promise<Peripheral | null> {
    return this.scan((_peripheral: Peripheral) => {
      return true; // accept the first device with the right service UUID
    });
  }

  private scanForDevice(address: string): Promise<Peripheral | null> {
    const normalized = address.toLowerCase().replace(/[:-]/g, '');
    return this.scan((peripheral: Peripheral) => {
      const id = peripheral.id?.toLowerCase().replace(/[:-]/g, '') ?? '';
      const addr = peripheral.address?.toLowerCase().replace(/[:-]/g, '') ?? '';
      const uuid = peripheral.uuid?.toLowerCase().replace(/[:-]/g, '') ?? '';
      return id === normalized || addr === normalized || uuid === normalized;
    });
  }

  private scan(match: (peripheral: Peripheral) => boolean): Promise<Peripheral | null> {
    return new Promise((resolve, reject) => {
      const onDiscover = (peripheral: Peripheral) => {
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
        getNoble().stopScanning();
        getNoble().removeListener('discover', onDiscover);
        getNoble().removeListener('stateChange', onStateChange);
      };

      const timeout = setTimeout(() => {
        cleanup();
        resolve(null);
      }, BLE_SCAN_TIMEOUT);

      getNoble().on('discover', onDiscover);

      const startScan = () => {
        getNoble().startScanning([SOFA_SERVICE_UUID_SHORT], false, (err?: Error) => {
          if (err) {
            clearTimeout(timeout);
            cleanup();
            reject(err);
          }
        });
      };

      const onStateChange = (state: string) => {
        if (state === 'poweredOn') {
          startScan();
        } else {
          clearTimeout(timeout);
          cleanup();
          reject(new Error(`Bluetooth adapter state: ${state}`));
        }
      };

      if (getNoble().state === 'poweredOn') {
        startScan();
      } else {
        getNoble().once('stateChange', onStateChange);
      }
    });
  }
}
