import type { Logger } from 'homebridge';
import type { IBleClient, NotificationHandler } from './BleClient';
import type { BleCommand } from '../protocol/commands';
import { errorMessage } from '../settings';

interface QueuedCommand {
  command: BleCommand;
  resolve: () => void;
  reject: (err: Error) => void;
}

export class BleConnectionManager {
  private queue: QueuedCommand[] = [];
  private processing = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private notificationHandler: NotificationHandler | null = null;
  private connectPromise: Promise<void> | null = null;
  private resolvedAddress: string;
  private onReconnectCallback: (() => void) | null = null;

  constructor(
    private readonly client: IBleClient,
    private readonly address: string,
    private readonly idleTimeout: number,
    private readonly log: Logger,
  ) {
    this.resolvedAddress = address;
  }

  getResolvedAddress(): string {
    return this.resolvedAddress;
  }

  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  onReconnect(callback: () => void): void {
    this.onReconnectCallback = callback;
  }

  async enqueue(command: BleCommand): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ command, resolve, reject });
      this.processQueue();
    });
  }

  async ensureConnected(): Promise<void> {
    if (this.connected && this.client.isConnected()) {
      this.resetIdleTimer();
      return;
    }

    // Reuse in-flight connection attempt
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async disconnect(): Promise<void> {
    this.clearIdleTimer();
    this.connected = false;
    await this.client.disconnect();
  }

  isConnected(): boolean {
    return this.connected && this.client.isConnected();
  }

  private async doConnect(): Promise<void> {
    const label = this.resolvedAddress || 'auto-discovery';
    this.log.info('Connecting to %s...', label);
    try {
      await this.client.connect(this.address || undefined);
      // After first connect, lock to the resolved address for reconnects
      if (!this.address && this.client.resolvedAddress) {
        this.resolvedAddress = this.client.resolvedAddress;
        this.log.info('Auto-discovered device: %s', this.resolvedAddress);
      }
      await this.client.subscribeNotifications((data) => {
        this.resetIdleTimer();
        if (this.notificationHandler) {
          this.notificationHandler(data);
        }
      });
      this.connected = true;
      this.resetIdleTimer();
      this.log.info('Connected to %s', this.resolvedAddress);
      if (this.onReconnectCallback) {
        this.onReconnectCallback();
      }
    } catch (err) {
      this.connected = false;
      throw err;
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          await this.ensureConnected();
          await this.client.write(item.command.characteristicUuid, item.command.data);
          this.resetIdleTimer();
          item.resolve();
        } catch (err) {
          // On write failure, disconnect and retry once
          this.log.warn('BLE write failed, reconnecting: %s', errorMessage(err));
          this.connected = false;
          try {
            await this.client.disconnect();
          } catch {
            // Ignore disconnect errors
          }
          try {
            await this.ensureConnected();
            await this.client.write(item.command.characteristicUuid, item.command.data);
            this.resetIdleTimer();
            item.resolve();
          } catch (retryErr) {
            item.reject(retryErr as Error);
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.log.info('Idle timeout, disconnecting from %s', this.resolvedAddress);
      this.disconnect().catch((err) => {
        this.log.warn('Error during idle disconnect: %s', errorMessage(err));
      });
    }, this.idleTimeout * 1000);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
