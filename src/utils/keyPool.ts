import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "./logger.js";

export type SelectionStrategy = "fill-first" | "round-robin";
export type KeyFailureKind = "cooldown" | "exhausted" | "disabled";
export type KeyHealthStatus = "available" | KeyFailureKind;

export interface PoolLease {
  key: string;
  fingerprint: string;
}

export type PinResolution =
  | { status: "found"; lease: PoolLease }
  | { status: "missing_key"; fingerprint: string }
  | { status: "not_pinned" };

export interface ClassifiedExaFailure {
  kind: KeyFailureKind;
}

interface StoredKeyState {
  status: KeyFailureKind;
  until?: number;
}

interface StoredPin {
  fingerprint: string;
  expiresAt: number;
}

interface PersistedStateFile {
  version: 1;
  keys: Record<string, StoredKeyState>;
  pins: Record<string, StoredPin>;
}

interface FileStatSignature {
  mtimeMs: number;
  size: number;
}

export interface KeyPoolOptions {
  inlineKeys?: string[];
  keysFile?: string;
  stateFile?: string;
  strategy?: SelectionStrategy;
  cooldownMs?: number;
  pinTtlMs?: number;
  maxPins?: number;
  now?: () => number;
  onWarn?: (message: string) => void;
}

export const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_PIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_PINS = 200;
const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_ATTEMPTS = 20;
const LOCK_RETRY_DELAY_MS = 10;
const RENAME_RETRY_ATTEMPTS = 5;
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

const FAILURE_SEVERITY: Record<KeyFailureKind, number> = {
  cooldown: 1,
  exhausted: 2,
  disabled: 3,
};

export class AllPoolKeysUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllPoolKeysUnavailableError";
  }
}

export function defaultKeysFilePath(homeDir: string = homedir()): string {
  return join(homeDir, ".config", "exa-mcp", "keys.txt");
}

export function defaultStateFilePath(keysFile?: string, homeDir: string = homedir()): string {
  return keysFile
    ? join(dirname(keysFile), "keys-state.json")
    : join(homeDir, ".config", "exa-mcp", "keys-state.json");
}

export function expandHomePath(filePath: string, homeDir: string = homedir()): string {
  if (filePath === "~") return homeDir;
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return join(homeDir, filePath.slice(2));
  }
  return filePath;
}

export function parseSelectionStrategy(value: string | undefined): SelectionStrategy | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "fill-first" || normalized === "round-robin") {
    return normalized;
  }
  return undefined;
}

export function parseInlineKeys(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

export function parseKeyFileContent(content: string): string[] {
  const keys: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
      continue;
    }
    const stripped = trimmed.replace(/\s+#.*$/, "").trim();
    if (stripped.length > 0) {
      keys.push(stripped);
    }
  }
  return keys;
}

export function dedupeKeys(keys: Iterable<string>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of keys) {
    const key = raw.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
  }
  return unique;
}

export function fingerprintKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function startOfNextUtcMonthMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const err = error as {
    statusCode?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  const candidate = err.statusCode ?? err.status ?? err.response?.status;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error ?? "");
}

export function classifyExaFailure(error: unknown): ClassifiedExaFailure | null {
  const status = getStatusCode(error);
  if (status === undefined) return null;

  const message = getErrorMessage(error);

  if (status === 402) {
    if (/x402_payment_required|carried no api key/i.test(message)) {
      return null;
    }
    return { kind: "exhausted" };
  }

  if (status === 429) {
    return { kind: "cooldown" };
  }

  if (status === 401) {
    return { kind: "disabled" };
  }

  if (status === 403) {
    if (
      /prohibited|content.?filter|safety.?policy|moderation|feature.?disabled|not enabled for your plan/i.test(
        message,
      )
    ) {
      return null;
    }
    if (
      /team.?blocked|revoked|suspended|banned|api access.*disabled|not permitted/i.test(message)
    ) {
      return { kind: "disabled" };
    }
    return null;
  }

  return null;
}

function mergeKeyState(
  existing: StoredKeyState | undefined,
  incoming: StoredKeyState,
): StoredKeyState {
  if (!existing) return incoming;
  const existingRank = FAILURE_SEVERITY[existing.status];
  const incomingRank = FAILURE_SEVERITY[incoming.status];
  if (existingRank > incomingRank) return existing;
  if (incomingRank > existingRank) return incoming;
  if (existing.until !== undefined && incoming.until !== undefined) {
    return existing.until >= incoming.until ? existing : incoming;
  }
  return incoming;
}

function trimPinEntries(
  pins: Iterable<[string, StoredPin]>,
  maxPins: number,
): Array<[string, StoredPin]> {
  return Array.from(pins)
    .sort((a, b) => b[1].expiresAt - a[1].expiresAt)
    .slice(0, maxPins);
}

function statSignature(filePath: string): FileStatSignature | null {
  try {
    const stat = statSync(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function sameStat(a: FileStatSignature | null, b: FileStatSignature | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

function withFileLock<T>(lockPath: string, fn: () => T): T {
  let fd: number | undefined;
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw error;
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Lock disappeared between checks; retry immediately.
      }
      sleepSync(LOCK_RETRY_DELAY_MS);
    }
  }

  if (fd === undefined) {
    throw new Error(`Timed out acquiring state lock: ${lockPath}`);
  }

  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

function atomicWriteJson(targetPath: string, content: string): void {
  const tempPath = `${targetPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tempPath, content, "utf8");
    for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt += 1) {
      try {
        renameSync(tempPath, targetPath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if ((code === "EPERM" || code === "EBUSY") && attempt + 1 < RENAME_RETRY_ATTEMPTS) {
          sleepSync(LOCK_RETRY_DELAY_MS);
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore
    }
    throw error;
  }
}

export class KeyPool {
  readonly strategy: SelectionStrategy;
  readonly keysFile?: string;
  readonly stateFile?: string;

  private readonly inlineKeys: string[];
  private readonly cooldownMs: number;
  private readonly pinTtlMs: number;
  private readonly maxPins: number;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;

  private entries: PoolLease[] = [];
  private entryByFingerprint = new Map<string, PoolLease>();
  private states = new Map<string, StoredKeyState>();
  private pins = new Map<string, StoredPin>();
  private cursor = 0;
  private lastKeysStat: FileStatSignature | null = null;
  private lastStateStat: FileStatSignature | null = null;
  private missingKeysFileWarned = false;

  constructor(options: KeyPoolOptions = {}) {
    this.inlineKeys = dedupeKeys(options.inlineKeys ?? []);
    this.keysFile = options.keysFile;
    this.stateFile = options.stateFile;
    this.strategy = options.strategy ?? "fill-first";
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.pinTtlMs = options.pinTtlMs ?? DEFAULT_PIN_TTL_MS;
    this.maxPins = options.maxPins ?? DEFAULT_MAX_PINS;
    this.now = options.now ?? Date.now;
    this.warn = options.onWarn ?? ((message) => log(message));

    this.reload(true);
  }

  get size(): number {
    this.reload(false);
    return this.entries.length;
  }

  get hasKeys(): boolean {
    return this.size > 0;
  }

  acquire(excludeFingerprints?: ReadonlySet<string>): PoolLease | null {
    this.reload(false);
    if (this.entries.length === 0) return null;

    const currentNow = this.now();
    this.pruneExpired(currentNow);

    const total = this.entries.length;
    const start = this.strategy === "round-robin" ? this.cursor % total : 0;

    for (let offset = 0; offset < total; offset += 1) {
      const idx = (start + offset) % total;
      const entry = this.entries[idx];
      if (excludeFingerprints?.has(entry.fingerprint)) {
        continue;
      }
      if (!this.isAvailable(entry.fingerprint, currentNow)) {
        continue;
      }
      if (this.strategy === "round-robin") {
        this.cursor = (idx + 1) % total;
      }
      return entry;
    }

    return null;
  }

  resolvePin(pinId: string): PinResolution {
    this.reload(false);
    const currentNow = this.now();
    this.pruneExpired(currentNow);

    const pin = this.pins.get(pinId);
    if (!pin) {
      return { status: "not_pinned" };
    }

    const entry = this.entryByFingerprint.get(pin.fingerprint);
    if (!entry) {
      return { status: "missing_key", fingerprint: pin.fingerprint };
    }

    const state = this.states.get(pin.fingerprint);
    if (state?.status === "disabled") {
      return { status: "missing_key", fingerprint: pin.fingerprint };
    }

    return { status: "found", lease: entry };
  }

  pinRun(pinId: string, fingerprint: string): void {
    if (!pinId || !fingerprint) return;
    this.reload(false);
    const currentNow = this.now();
    this.pins.set(pinId, { fingerprint, expiresAt: currentNow + this.pinTtlMs });
    this.pins = new Map(trimPinEntries(this.pins, this.maxPins));
    this.persistState(currentNow);
  }

  reportFailure(fingerprint: string, failure: ClassifiedExaFailure): void {
    this.reload(false);
    const currentNow = this.now();

    let nextState: StoredKeyState;
    if (failure.kind === "exhausted") {
      nextState = { status: "exhausted", until: startOfNextUtcMonthMs(currentNow) };
    } else if (failure.kind === "cooldown") {
      nextState = { status: "cooldown", until: currentNow + this.cooldownMs };
    } else {
      nextState = { status: "disabled" };
    }

    const merged = mergeKeyState(this.states.get(fingerprint), nextState);
    this.states.set(fingerprint, merged);
    this.persistState(currentNow);
    this.warn(`[exa-pool] Key ${fingerprint} marked ${merged.status}.`);
  }

  buildUnavailableError(attemptedCount = 0): AllPoolKeysUnavailableError {
    this.reload(false);
    const currentNow = this.now();
    this.pruneExpired(currentNow);

    if (this.entries.length === 0) {
      return new AllPoolKeysUnavailableError(
        "No Exa API keys are configured in the pool. Add keys to your keys file or EXA_API_KEYS.",
      );
    }

    let exhausted = 0;
    let cooldown = 0;
    let disabled = 0;
    let minCooldownMs = Infinity;

    for (const entry of this.entries) {
      const state = this.states.get(entry.fingerprint);
      if (!state) continue;
      if (state.status === "exhausted") exhausted += 1;
      else if (state.status === "disabled") disabled += 1;
      else if (state.status === "cooldown") {
        cooldown += 1;
        if (state.until !== undefined) {
          minCooldownMs = Math.min(minCooldownMs, Math.max(0, state.until - currentNow));
        }
      }
    }

    const parts: string[] = [];
    if (exhausted > 0) parts.push(`${exhausted} exhausted`);
    if (cooldown > 0) {
      const waitSec = Number.isFinite(minCooldownMs)
        ? Math.max(1, Math.ceil(minCooldownMs / 1000))
        : 30;
      parts.push(`${cooldown} in cooldown (next ready in ~${waitSec}s)`);
    }
    if (disabled > 0) parts.push(`${disabled} disabled`);
    if (parts.length === 0 && attemptedCount > 0) {
      parts.push(`${attemptedCount} failed during this request`);
    }

    const summary = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    return new AllPoolKeysUnavailableError(
      `All ${this.entries.length} Exa pool key(s) are unavailable${summary}. Add new keys or wait for reset.`,
    );
  }

  private isAvailable(fingerprint: string, currentNow: number): boolean {
    const state = this.states.get(fingerprint);
    if (!state) return true;
    if (state.until !== undefined && currentNow >= state.until) {
      this.states.delete(fingerprint);
      return true;
    }
    return false;
  }

  private pruneExpired(currentNow: number): void {
    for (const [fingerprint, state] of this.states) {
      if (state.until !== undefined && currentNow >= state.until) {
        this.states.delete(fingerprint);
      }
    }
    for (const [pinId, pin] of this.pins) {
      if (currentNow >= pin.expiresAt) {
        this.pins.delete(pinId);
      }
    }
  }

  private reload(force: boolean): void {
    let keysChanged = force;

    if (this.keysFile) {
      const nextStat = statSignature(this.keysFile);
      if (nextStat === null) {
        if (force && !this.missingKeysFileWarned) {
          this.missingKeysFileWarned = true;
          this.warn(`[exa-pool] Keys file not found: ${this.keysFile}`);
        }
        if (this.lastKeysStat !== null) {
          keysChanged = true;
          this.lastKeysStat = null;
        }
      } else if (force || !sameStat(nextStat, this.lastKeysStat)) {
        keysChanged = true;
        this.lastKeysStat = nextStat;
        this.missingKeysFileWarned = false;
      }
    }

    const removedFingerprints: string[] = [];
    if (keysChanged) {
      const previousFingerprints = force ? [] : Array.from(this.entryByFingerprint.keys());
      const fileKeys = this.readKeysFile();
      const merged = dedupeKeys([...fileKeys, ...this.inlineKeys]);
      this.entries = merged.map((key) => ({ key, fingerprint: fingerprintKey(key) }));
      this.entryByFingerprint = new Map(this.entries.map((entry) => [entry.fingerprint, entry]));
      this.cursor = this.entries.length > 0 ? this.cursor % this.entries.length : 0;

      for (const fp of previousFingerprints) {
        if (!this.entryByFingerprint.has(fp)) {
          removedFingerprints.push(fp);
        }
      }
      for (const fingerprint of this.states.keys()) {
        if (!this.entryByFingerprint.has(fingerprint)) {
          this.states.delete(fingerprint);
        }
      }
    }

    if (this.stateFile) {
      const nextStateStat = statSignature(this.stateFile);
      if (nextStateStat && (force || !sameStat(nextStateStat, this.lastStateStat))) {
        this.loadStateFromDisk(nextStateStat);
      } else if (!nextStateStat && this.lastStateStat !== null) {
        this.states.clear();
        this.pins.clear();
        this.lastStateStat = null;
      }

      if (removedFingerprints.length > 0) {
        this.persistState(this.now(), removedFingerprints);
      }
    }
  }

  private readKeysFile(): string[] {
    if (!this.keysFile) return [];
    try {
      const raw = readFileSync(this.keysFile, "utf8");
      return parseKeyFileContent(raw);
    } catch {
      return [];
    }
  }

  private parseStateFile(
    raw: string,
    currentNow: number,
    filterToKnownEntries: boolean,
  ): PersistedStateFile | null {
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedStateFile>;
      if (!parsed || typeof parsed !== "object") return null;

      const keys: Record<string, StoredKeyState> = {};
      if (parsed.keys && typeof parsed.keys === "object") {
        for (const [fp, state] of Object.entries(parsed.keys)) {
          if (filterToKnownEntries && !this.entryByFingerprint.has(fp)) continue;
          if (!state || typeof state !== "object") continue;
          if (
            state.status !== "cooldown" &&
            state.status !== "exhausted" &&
            state.status !== "disabled"
          ) {
            continue;
          }
          if (typeof state.until === "number" && currentNow >= state.until) continue;
          keys[fp] =
            typeof state.until === "number"
              ? { status: state.status, until: state.until }
              : { status: state.status };
        }
      }

      const pins: Record<string, StoredPin> = {};
      if (parsed.pins && typeof parsed.pins === "object") {
        for (const [pinId, pin] of Object.entries(parsed.pins)) {
          if (!pin || typeof pin !== "object") continue;
          if (typeof pin.fingerprint !== "string" || typeof pin.expiresAt !== "number") continue;
          if (currentNow >= pin.expiresAt) continue;
          pins[pinId] = { fingerprint: pin.fingerprint, expiresAt: pin.expiresAt };
        }
      }

      return { version: 1, keys, pins };
    } catch {
      return null;
    }
  }

  private loadStateFromDisk(stat: FileStatSignature): void {
    if (!this.stateFile) return;
    try {
      const raw = readFileSync(this.stateFile, "utf8");
      const parsed = this.parseStateFile(raw, this.now(), true);
      this.lastStateStat = stat;
      if (!parsed) return;

      this.states = new Map(Object.entries(parsed.keys));
      this.pins = new Map(trimPinEntries(Object.entries(parsed.pins), this.maxPins));
    } catch {
      // Ignore transient read errors; state file is an optimization.
    }
  }

  private persistState(currentNow: number, removedFingerprints: string[] = []): void {
    if (!this.stateFile) return;
    const stateFile = this.stateFile;

    try {
      this.pruneExpired(currentNow);
      mkdirSync(dirname(stateFile), { recursive: true });

      withFileLock(`${stateFile}.lock`, () => {
        const mergedKeys: Record<string, StoredKeyState> = {};
        const mergedPins: Record<string, StoredPin> = {};

        if (existsSync(stateFile)) {
          const disk = this.parseStateFile(readFileSync(stateFile, "utf8"), currentNow, false);
          if (disk) {
            Object.assign(mergedKeys, disk.keys);
            Object.assign(mergedPins, disk.pins);
          }
        }

        for (const removedFp of removedFingerprints) {
          delete mergedKeys[removedFp];
        }

        for (const [fp, state] of this.states) {
          if (this.entryByFingerprint.has(fp)) {
            mergedKeys[fp] = mergeKeyState(mergedKeys[fp], state);
          }
        }
        for (const [pinId, pin] of this.pins) {
          mergedPins[pinId] = pin;
        }

        const payload: PersistedStateFile = {
          version: 1,
          keys: mergedKeys,
          pins: Object.fromEntries(trimPinEntries(Object.entries(mergedPins), this.maxPins)),
        };

        atomicWriteJson(stateFile, JSON.stringify(payload, null, 2));
        this.lastStateStat = statSignature(stateFile);
      });
    } catch (error) {
      this.warn(
        `[exa-pool] Failed to persist state file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export interface KeyPoolEnvOptions {
  checkDefaultKeysFile?: boolean;
  defaultPersistEnvState?: boolean;
  homeDir?: string;
}

function resolveKeysFileFromEnv(
  env: NodeJS.ProcessEnv,
  options: KeyPoolEnvOptions,
): string | undefined {
  const home = options.homeDir ?? homedir();
  const rawKeysFile = env.EXA_KEYS_FILE?.trim();
  const disableDefaultKeysFile =
    rawKeysFile?.toLowerCase() === "none" || rawKeysFile?.toLowerCase() === "false";

  if (rawKeysFile && !disableDefaultKeysFile) {
    return expandHomePath(rawKeysFile, home);
  }
  if (!disableDefaultKeysFile && options.checkDefaultKeysFile) {
    const candidate = defaultKeysFilePath(home);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function hasKeyPoolEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const rawKeysFile = env.EXA_KEYS_FILE?.trim();
  const hasKeysFile =
    Boolean(rawKeysFile) &&
    rawKeysFile?.toLowerCase() !== "none" &&
    rawKeysFile?.toLowerCase() !== "false";

  return (
    hasKeysFile ||
    Boolean(env.EXA_API_KEYS?.trim()) ||
    Boolean(parseSelectionStrategy(env.EXA_KEY_STRATEGY)) ||
    Boolean(env.EXA_API_KEY?.includes(","))
  );
}

export function createKeyPoolFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: KeyPoolEnvOptions = {},
): KeyPool | undefined {
  const home = options.homeDir ?? homedir();
  const keysFile = resolveKeysFileFromEnv(env, options);

  if (!keysFile && !hasKeyPoolEnv(env)) {
    return undefined;
  }

  const inlineKeys = dedupeKeys([
    ...parseInlineKeys(env.EXA_API_KEYS),
    ...parseInlineKeys(env.EXA_API_KEY),
  ]);
  const strategy = parseSelectionStrategy(env.EXA_KEY_STRATEGY);

  const rawStateFile = env.EXA_KEYS_STATE_FILE?.trim();
  const disableStateFile =
    rawStateFile?.toLowerCase() === "none" || rawStateFile?.toLowerCase() === "false";

  let stateFile: string | undefined;
  if (rawStateFile && !disableStateFile) {
    stateFile = expandHomePath(rawStateFile, home);
  } else if (!disableStateFile) {
    if (keysFile) {
      stateFile = defaultStateFilePath(keysFile, home);
    } else if (options.defaultPersistEnvState) {
      stateFile = defaultStateFilePath(undefined, home);
    }
  }

  return new KeyPool({
    inlineKeys,
    keysFile,
    stateFile,
    strategy,
  });
}
