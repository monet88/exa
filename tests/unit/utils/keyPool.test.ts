import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExaError } from "exa-js";
import { afterEach, describe, expect, it } from "vitest";
import {
  AllPoolKeysUnavailableError,
  classifyExaFailure,
  createKeyPoolFromEnv,
  dedupeKeys,
  fingerprintKey,
  KeyPool,
  parseKeyFileContent,
  startOfNextUtcMonthMs,
} from "../../../src/utils/keyPool.js";

describe("KeyPool", () => {
  const tempDirs: string[] = [];

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "exa-keypool-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses key files with comments, blank lines, and deduplicates preserving order", () => {
    const parsed = parseKeyFileContent(
      [
        "# primary team",
        "key-alpha",
        "  key-beta   # free account 2",
        "// ignored line",
        "",
        "key-alpha",
        "key-gamma",
      ].join("\n"),
    );

    expect(dedupeKeys(parsed)).toEqual(["key-alpha", "key-beta", "key-gamma"]);
  });

  it("supports fill-first default and round-robin selection strategies", () => {
    const fillFirst = new KeyPool({ inlineKeys: ["k1", "k2", "k3"] });
    expect(fillFirst.acquire()?.key).toBe("k1");
    expect(fillFirst.acquire()?.key).toBe("k1");
    expect(fillFirst.acquire(new Set([fingerprintKey("k1")]))?.key).toBe("k2");

    const roundRobin = new KeyPool({
      inlineKeys: ["k1", "k2", "k3"],
      strategy: "round-robin",
    });
    expect(roundRobin.acquire()?.key).toBe("k1");
    expect(roundRobin.acquire()?.key).toBe("k2");
    expect(roundRobin.acquire()?.key).toBe("k3");
    expect(roundRobin.acquire()?.key).toBe("k1");
  });

  it("hot-reloads unlimited keys from disk without restarting", () => {
    const dir = createTempDir();
    const keysFile = join(dir, "keys.txt");
    const initialKeys = Array.from({ length: 120 }, (_, i) => `free-key-${i + 1}`);
    writeFileSync(keysFile, initialKeys.join("\n"), "utf8");

    const pool = new KeyPool({
      keysFile,
      stateFile: join(dir, "keys-state.json"),
      onWarn: () => {},
    });
    expect(pool.size).toBe(120);
    expect(pool.acquire()?.key).toBe("free-key-1");

    pool.reportFailure(fingerprintKey("free-key-1"), { kind: "disabled" });
    expect(pool.acquire()?.key).toBe("free-key-2");

    const updatedKeys = ["free-key-new", ...initialKeys.slice(1), "free-key-121"];
    writeFileSync(keysFile, updatedKeys.join("\n"), "utf8");
    const future = new Date(Date.now() + 5_000);
    utimesSync(keysFile, future, future);

    expect(pool.size).toBe(121);
    expect(pool.acquire()?.key).toBe("free-key-new");
  });

  it("recovers exhausted 402 keys at the start of next UTC month and cooldown 429 keys after timeout", () => {
    let nowMs = Date.UTC(2026, 10, 18, 10, 0, 0);
    const pool = new KeyPool({
      inlineKeys: ["k1", "k2"],
      cooldownMs: 30_000,
      now: () => nowMs,
      onWarn: () => {},
    });

    pool.reportFailure(fingerprintKey("k1"), { kind: "exhausted" });
    expect(pool.acquire()?.key).toBe("k2");

    pool.reportFailure(fingerprintKey("k2"), { kind: "cooldown" });
    expect(pool.acquire()).toBeNull();
    const err = pool.buildUnavailableError();
    expect(err).toBeInstanceOf(AllPoolKeysUnavailableError);
    expect(err.message).toContain("1 exhausted");
    expect(err.message).toContain("1 in cooldown");

    // Advance past 30s cooldown: k2 recovers, k1 remains exhausted.
    nowMs += 31_000;
    expect(pool.acquire()?.key).toBe("k2");

    // Advance to 00:00:00Z of next UTC month: k1 resets and is chosen first under fill-first.
    nowMs = startOfNextUtcMonthMs(nowMs);
    expect(pool.acquire()?.key).toBe("k1");
  });

  it("classifies Exa 402, 429, 401, and 403 errors accurately without poisoning on content filters", () => {
    expect(classifyExaFailure(new ExaError("No more credits", 402))).toEqual({ kind: "exhausted" });
    expect(
      classifyExaFailure(
        new ExaError("The request carried no API key (X402_PAYMENT_REQUIRED)", 402),
      ),
    ).toBeNull();

    expect(classifyExaFailure(new ExaError("Rate limit exceeded", 429))).toEqual({
      kind: "cooldown",
    });

    expect(classifyExaFailure(new ExaError("Invalid API key", 401))).toEqual({ kind: "disabled" });
    expect(classifyExaFailure(new ExaError("The team's API access has been revoked", 403))).toEqual(
      { kind: "disabled" },
    );
    expect(
      classifyExaFailure(
        new ExaError("Content was rejected by a safety policy during processing", 403),
      ),
    ).toBeNull();
    expect(classifyExaFailure(new ExaError("Feature not enabled for your plan", 403))).toBeNull();
    expect(classifyExaFailure(new ExaError("Service overloaded", 503))).toBeNull();
  });

  it("persists key states and run pins by SHA-256 fingerprint across processes without writing raw keys", () => {
    const dir = createTempDir();
    const keysFile = join(dir, "keys.txt");
    const stateFile = join(dir, "keys-state.json");
    writeFileSync(keysFile, "secret-key-one\nsecret-key-two\n", "utf8");

    const poolA = new KeyPool({
      keysFile,
      stateFile,
      onWarn: () => {},
    });
    const first = poolA.acquire()!;
    expect(first.key).toBe("secret-key-one");
    poolA.pinRun("agent_run_abc", first.fingerprint);
    poolA.reportFailure(first.fingerprint, { kind: "exhausted" });

    const rawState = readFileSync(stateFile, "utf8");
    expect(rawState).not.toContain("secret-key-one");
    expect(rawState).not.toContain("secret-key-two");
    expect(rawState).toContain(first.fingerprint);

    // Second process instance picks up persisted exhaustion and pinned run ID.
    const poolB = new KeyPool({
      keysFile,
      stateFile,
      onWarn: () => {},
    });
    expect(poolB.acquire()?.key).toBe("secret-key-two");
    expect(poolB.resolvePin("agent_run_abc")).toEqual({
      status: "found",
      lease: { key: "secret-key-one", fingerprint: first.fingerprint },
    });

    // Disabled pinned key reports missing_key instead of silently switching teams.
    poolB.reportFailure(first.fingerprint, { kind: "disabled" });
    expect(poolB.resolvePin("agent_run_abc")).toEqual({
      status: "missing_key",
      fingerprint: first.fingerprint,
    });
  });

  it("creates KeyPool from env vars and expands home paths cleanly", () => {
    const dir = createTempDir();
    const subDir = join(dir, "sub");
    mkdirSync(subDir, { recursive: true });
    const keysFile = join(subDir, "keys.txt");
    writeFileSync(keysFile, "file-k1\n", "utf8");

    const pool = createKeyPoolFromEnv(
      {
        EXA_KEYS_FILE: "~/sub/keys.txt",
        EXA_API_KEYS: "env-k1, env-k2",
        EXA_KEY_STRATEGY: "round-robin",
        EXA_KEYS_STATE_FILE: "none",
      },
      { homeDir: dir },
    );

    expect(pool).toBeDefined();
    expect(pool?.keysFile).toBe(keysFile);
    expect(pool?.strategy).toBe("round-robin");
    expect(pool?.stateFile).toBeUndefined();
    expect(pool?.acquire()?.key).toBe("file-k1");
    expect(pool?.acquire()?.key).toBe("env-k1");
    expect(pool?.acquire()?.key).toBe("env-k2");

    expect(createKeyPoolFromEnv({ EXA_API_KEY: "single-key" })).toBeUndefined();
    expect(
      createKeyPoolFromEnv({ EXA_API_KEY: "single-key", EXA_KEYS_FILE: "none" }),
    ).toBeUndefined();
  });

  it("preserves stronger failure states, other pools' persisted keys, pin caps, and disk state deletion", () => {
    const dir = createTempDir();
    const stateFile = join(dir, "keys-state.json");
    let nowMs = 1_000_000;

    // Pool A uses inline keys ["poolA-1", "poolA-2"] and marks poolA-1 exhausted.
    const poolA = new KeyPool({
      inlineKeys: ["poolA-1", "poolA-2"],
      stateFile,
      maxPins: 2,
      pinTtlMs: 10_000,
      now: () => nowMs,
      onWarn: () => {},
    });
    poolA.reportFailure(fingerprintKey("poolA-1"), { kind: "exhausted" });
    // Concurrent cooldown report must NOT downgrade exhausted -> cooldown.
    poolA.reportFailure(fingerprintKey("poolA-1"), { kind: "cooldown" });

    // Pool B uses a disjoint key set sharing the same stateFile and saves its own failure.
    const poolB = new KeyPool({
      inlineKeys: ["poolB-1", "poolB-2"],
      stateFile,
      maxPins: 2,
      pinTtlMs: 10_000,
      now: () => nowMs,
      onWarn: () => {},
    });
    poolB.reportFailure(fingerprintKey("poolB-1"), { kind: "disabled" });

    // Pool A's exhausted record must still exist on disk and in a fresh Pool A instance.
    const poolAReloaded = new KeyPool({
      inlineKeys: ["poolA-1", "poolA-2"],
      stateFile,
      now: () => nowMs,
      onWarn: () => {},
    });
    expect(poolAReloaded.acquire()?.key).toBe("poolA-2");

    // Pin eviction: maxPins = 2 keeps only the 2 newest pins; older pins expire after pinTtlMs.
    poolA.pinRun("run_1", fingerprintKey("poolA-2"));
    nowMs += 100;
    poolA.pinRun("run_2", fingerprintKey("poolA-2"));
    nowMs += 100;
    poolA.pinRun("run_3", fingerprintKey("poolA-2"));
    expect(poolA.resolvePin("run_1")).toEqual({ status: "not_pinned" });
    expect(poolA.resolvePin("run_2").status).toBe("found");
    expect(poolA.resolvePin("run_3").status).toBe("found");

    nowMs += 11_000;
    expect(poolA.resolvePin("run_2")).toEqual({ status: "not_pinned" });
    expect(poolA.resolvePin("run_3")).toEqual({ status: "not_pinned" });

    // Deleting keys-state.json clears in-memory states and pins on next reload.
    poolA.pinRun("run_4", fingerprintKey("poolA-2"));
    expect(existsSync(stateFile)).toBe(true);
    rmSync(stateFile);
    expect(poolAReloaded.acquire()?.key).toBe("poolA-1");
    expect(poolA.resolvePin("run_4")).toEqual({ status: "not_pinned" });
  });

  it("skips disk persistence safely when state lock is held instead of writing unlocked", () => {
    const dir = createTempDir();
    const stateFile = join(dir, "keys-state.json");
    const warnings: string[] = [];
    const pool = new KeyPool({
      inlineKeys: ["lock-k1", "lock-k2"],
      stateFile,
      onWarn: (msg) => warnings.push(msg),
    });

    writeFileSync(`${stateFile}.lock`, "held", "utf8");
    pool.reportFailure(fingerprintKey("lock-k1"), { kind: "exhausted" });

    expect(existsSync(stateFile)).toBe(false);
    expect(warnings.some((w) => w.includes("Timed out acquiring state lock"))).toBe(true);
    expect(pool.acquire()?.key).toBe("lock-k2");
  });
});
