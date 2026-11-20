import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ensurePrivateDirectory, assertPrivateFile } from './private-storage.js';

export interface PublicDevice {
  id: string;
  name: string;
  platform: string;
  createdAt: string;
  revokedAt?: string;
}

export type DeviceRecord = PublicDevice;

export interface AuditRecord {
  id: string;
  deviceId: string;
  tool: string;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

interface StoredDevice extends PublicDevice {
  tokenHash: string;
}

interface RegistryState {
  version: 1;
  devices: StoredDevice[];
  audit: AuditRecord[];
}

interface RegistryOptions {
  now?: () => number;
}

const MAX_DEVICES = 256;
const MAX_PAIRINGS = 64;
const MAX_FINISHED_AUDIT = 200;
const PAIRING_LIFETIME_MS = 5 * 60 * 1000;
const MAX_STATE_BYTES = 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEVICE_TOKEN = /^jrc_device_[A-Za-z0-9_-]{43}$/;
const PAIRING_CODE = /^jrc_pair_[A-Za-z0-9_-]{32}$/;
const PLATFORMS = new Set(['darwin', 'win32', 'linux']);
const OUTCOMES = new Set(['running', 'completed', 'failed', 'unknown']);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validTime(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function allowedKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function publicDevice(device: StoredDevice): PublicDevice {
  const { tokenHash: _tokenHash, ...visible } = device;
  return visible;
}

/** Strict metadata allowlist: arguments, results and arbitrary extra fields never reach disk. */
function cleanAudit(value: unknown): AuditRecord {
  if (!object(value) || typeof value.id !== 'string' || !IDENTIFIER.test(value.id) ||
      typeof value.deviceId !== 'string' || !UUID.test(value.deviceId) ||
      typeof value.tool !== 'string' || !IDENTIFIER.test(value.tool) ||
      typeof value.status !== 'string' || !OUTCOMES.has(value.status) ||
      !validTime(value.startedAt) ||
      (value.finishedAt !== undefined && !validTime(value.finishedAt)) ||
      (value.durationMs !== undefined &&
        (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0))) {
    throw new Error('Invalid audit metadata');
  }
  return {
    id: value.id,
    deviceId: value.deviceId,
    tool: value.tool,
    status: value.status as AuditRecord['status'],
    startedAt: value.startedAt,
    ...(value.finishedAt !== undefined ? { finishedAt: value.finishedAt as string } : {}),
    ...(value.durationMs !== undefined ? { durationMs: value.durationMs as number } : {}),
  };
}

function decodeState(input: unknown): RegistryState {
  const corrupt = () => new Error('Invalid registry state; restore a trusted backup before starting');
  if (!object(input) || !allowedKeys(input, ['version', 'devices', 'audit']) || input.version !== 1 ||
      !Array.isArray(input.devices) || input.devices.length > MAX_DEVICES ||
      !Array.isArray(input.audit)) throw corrupt();

  const ids = new Set<string>();
  const hashes = new Set<string>();
  const devices: StoredDevice[] = input.devices.map(value => {
    if (!object(value) || !allowedKeys(value, ['id', 'name', 'platform', 'createdAt', 'revokedAt', 'tokenHash']) ||
        typeof value.id !== 'string' || !UUID.test(value.id) || ids.has(value.id) ||
        !validName(value.name) || typeof value.platform !== 'string' || !PLATFORMS.has(value.platform) ||
        !validTime(value.createdAt) || (value.revokedAt !== undefined && !validTime(value.revokedAt)) ||
        typeof value.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.tokenHash) || hashes.has(value.tokenHash)) {
      throw corrupt();
    }
    ids.add(value.id);
    hashes.add(value.tokenHash);
    return {
      id: value.id, name: value.name, platform: value.platform, createdAt: value.createdAt,
      tokenHash: value.tokenHash,
      ...(value.revokedAt !== undefined ? { revokedAt: value.revokedAt as string } : {}),
    };
  });
  const auditIds = new Set<string>();
  const audit = input.audit.map(value => {
    if (!object(value) || !allowedKeys(value, ['id', 'deviceId', 'tool', 'status', 'startedAt', 'finishedAt', 'durationMs'])) throw corrupt();
    let record: AuditRecord;
    try { record = cleanAudit(value); } catch { throw corrupt(); }
    if (auditIds.has(record.id)) throw corrupt();
    auditIds.add(record.id);
    return record;
  });
  // A v1 file may contain up to 200 legacy running records. The file-size
  // bound applies to all records; only finished history has a count limit.
  if (audit.filter(record => record.status !== 'running').length > MAX_FINISHED_AUDIT) throw corrupt();
  return { version: 1, devices, audit };
}

/** Single-process registry. The control server owns the exclusive data-directory lock. */
export class DeviceRegistry {
  private readonly pairings = new Map<string, number>();

  private constructor(
    private readonly file: string,
    private state: RegistryState,
    private readonly now: () => number,
  ) {}

  static open(dataDir: string, options: RegistryOptions = {}): DeviceRegistry {
    const directory = path.resolve(dataDir);
    ensurePrivateDirectory(directory);
    const directoryInfo = fs.lstatSync(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Registry directory must be a real directory');
    const file = path.join(directory, 'registry.json');
    let state: RegistryState = { version: 1, devices: [], audit: [] };
    if (fs.existsSync(file)) {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) throw new Error('Invalid registry state file');
      assertPrivateFile(file);
      let parsed: unknown;
      try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Invalid registry state JSON; restore a trusted backup before starting'); }
      state = decodeState(parsed);
    }
    return new DeviceRegistry(file, state, options.now ?? Date.now);
  }

  createPairing(): { code: string; expiresAt: string } {
    const now = this.now();
    for (const [hash, deadline] of this.pairings) if (deadline <= now) this.pairings.delete(hash);
    if (this.state.devices.length >= MAX_DEVICES) throw new Error('Device capacity reached');
    if (this.pairings.size >= MAX_PAIRINGS) throw new Error('Pending pairing capacity reached');
    const code = `jrc_pair_${randomBytes(24).toString('base64url')}`;
    const deadline = now + PAIRING_LIFETIME_MS;
    this.pairings.set(digest(code), deadline);
    return { code, expiresAt: new Date(deadline).toISOString() };
  }

  enroll(code: string, name: string, platform: string): { deviceId: string; token: string } {
    if (typeof code !== 'string' || !PAIRING_CODE.test(code)) throw new Error('Invalid or expired pairing code');
    const hash = digest(code);
    const deadline = this.pairings.get(hash);
    if (deadline === undefined || deadline <= this.now()) {
      this.pairings.delete(hash);
      throw new Error('Invalid or expired pairing code');
    }
    if (typeof name !== 'string' || !validName(name.trim())) throw new Error('Invalid device name');
    if (typeof platform !== 'string' || !PLATFORMS.has(platform)) throw new Error('Invalid device platform');
    if (this.state.devices.length >= MAX_DEVICES) throw new Error('Device capacity reached');
    const token = `jrc_device_${randomBytes(32).toString('base64url')}`;
    const device: StoredDevice = {
      id: randomUUID(), name: name.trim(), platform, createdAt: new Date(this.now()).toISOString(), tokenHash: digest(token),
    };
    this.persist({ ...this.state, devices: [...this.state.devices, device] });
    this.pairings.delete(hash);
    return { deviceId: device.id, token };
  }

  authenticate(token: string): DeviceRecord | undefined {
    if (typeof token !== 'string' || !DEVICE_TOKEN.test(token)) return undefined;
    const candidate = Buffer.from(digest(token), 'hex');
    const device = this.state.devices.find(value => timingSafeEqual(Buffer.from(value.tokenHash, 'hex'), candidate));
    return device && !device.revokedAt ? publicDevice(device) : undefined;
  }

  list(): PublicDevice[] {
    return this.state.devices.map(publicDevice);
  }

  revoke(id: string): boolean {
    const target = this.state.devices.find(device => device.id === id);
    if (!target) return false;
    if (target.revokedAt) return true;
    const revokedAt = new Date(this.now()).toISOString();
    this.persist({ ...this.state, devices: this.state.devices.map(device => device.id === id ? { ...device, revokedAt } : device) });
    return true;
  }

  audit(record: AuditRecord): void {
    const safe = cleanAudit(record);
    const records = this.state.audit.filter(value => value.id !== safe.id);
    records.push(safe);
    const finished = records.filter(value => value.status !== 'running');
    if (finished.length > MAX_FINISHED_AUDIT) records.splice(records.indexOf(finished[0]), 1);
    this.persist({ ...this.state, audit: records });
  }

  recentAudit(): AuditRecord[] {
    return this.state.audit.slice().reverse().map(record => ({ ...record }));
  }

  private persist(next: RegistryState): void {
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new Error('Registry state size limit reached');
    const temporary = `${this.file}.${randomBytes(12).toString('hex')}.tmp`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, serialized, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, this.file);
      // Commit in memory only after the replacement succeeds, so failed enrollment
      // cannot authorize an identity that was never durably recorded.
      this.state = next;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}
