import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManifestStore, type RunManifest } from "../src/manifest.ts";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "argus-manifest-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function newManifest(run_id: string): RunManifest {
  return {
    run_id,
    started_at: "2026-05-03T12:00:00.000Z",
    state: "running",
    crash_count: 0,
    ralph_iterations: {},
    tmux_restart_attempted: [],
    provider_mode: "max20",
    provider_outage_started_at: null,
  };
}

describe("ManifestStore.read", () => {
  test("returns null when manifest is missing", () => {
    const store = new ManifestStore(stateDir);
    expect(store.read("run-missing")).toBeNull();
  });

  test("round-trips through schema validation", () => {
    const store = new ManifestStore(stateDir);
    const m = newManifest("run-1");
    store.write("run-1", m);
    const loaded = store.read("run-1");
    expect(loaded).not.toBeNull();
    expect(loaded?.run_id).toBe("run-1");
    expect(loaded?.crash_count).toBe(0);
    expect(loaded?.provider_mode).toBe("max20");
  });

  test("read of an invalid manifest throws (so we surface corruption rather than silently default)", () => {
    const store = new ManifestStore(stateDir);
    // Hand-craft an invalid manifest: missing required fields.
    const path = join(stateDir, "runs", "run-bad", "manifest.json");
    const dir = join(stateDir, "runs", "run-bad");
    require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ not_a_run: true }), "utf8");
    expect(() => store.read("run-bad")).toThrow();
  });

  test("supports passthrough of unknown keys (forward-compat)", () => {
    const store = new ManifestStore(stateDir);
    const path = join(stateDir, "runs", "run-fwd", "manifest.json");
    const dir = join(stateDir, "runs", "run-fwd");
    require("node:fs").mkdirSync(dir, { recursive: true });
    const m = { ...newManifest("run-fwd"), future_field: "from-newer-build" };
    writeFileSync(path, JSON.stringify(m), "utf8");
    const loaded = store.read("run-fwd");
    expect(loaded).not.toBeNull();
    expect((loaded as unknown as { future_field?: string }).future_field).toBe("from-newer-build");
  });
});

describe("ManifestStore.write", () => {
  test("writes file with mode 0600 and no .tmp.<pid> artifact", () => {
    const store = new ManifestStore(stateDir);
    const m = newManifest("run-2");
    store.write("run-2", m);
    const filePath = join(stateDir, "runs", "run-2", "manifest.json");
    const st = statSync(filePath);
    // Mask permission bits; on macOS umask may add extra bits but owner-only is enforced.
    expect(st.mode & 0o777 & 0o077).toBe(0);
    const dir = join(stateDir, "runs", "run-2");
    const entries = readdirSync(dir);
    const tmpFiles = entries.filter((e) => e.includes(".tmp."));
    expect(tmpFiles).toEqual([]);
  });

  test("create the runs/<run_id>/ directory when missing", () => {
    const store = new ManifestStore(stateDir);
    const m = newManifest("run-3");
    store.write("run-3", m);
    const filePath = join(stateDir, "runs", "run-3", "manifest.json");
    expect(statSync(filePath).isFile()).toBe(true);
  });
});

describe("ManifestStore.update", () => {
  test("read-modify-write helper bumps a counter atomically", () => {
    const store = new ManifestStore(stateDir);
    store.write("run-4", newManifest("run-4"));
    const after = store.update("run-4", (m) => ({ ...m, crash_count: m.crash_count + 1 }));
    expect(after.crash_count).toBe(1);
    const reread = store.read("run-4");
    expect(reread?.crash_count).toBe(1);
  });

  test("update on a missing manifest throws (caller must seed)", () => {
    const store = new ManifestStore(stateDir);
    expect(() => store.update("run-no-such", (m) => m)).toThrow();
  });

  test("concurrent updates do not lose increments", async () => {
    const store = new ManifestStore(stateDir);
    store.write("run-5", newManifest("run-5"));
    const promises = Array.from({ length: 5 }, () =>
      Promise.resolve().then(() =>
        store.update("run-5", (m) => ({ ...m, crash_count: m.crash_count + 1 })),
      ),
    );
    await Promise.all(promises);
    const final = store.read("run-5");
    expect(final?.crash_count).toBe(5);
  });

  test("lock file is removed even if the update callback throws", () => {
    const store = new ManifestStore(stateDir);
    store.write("run-6", newManifest("run-6"));
    expect(() =>
      store.update("run-6", () => {
        throw new Error("kaboom");
      }),
    ).toThrow("kaboom");
    const lockPath = join(stateDir, "runs", "run-6", "manifest.lock");
    expect(() => statSync(lockPath)).toThrow();
  });
});
