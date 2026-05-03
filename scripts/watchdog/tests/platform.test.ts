import { describe, expect, test } from "bun:test";
import {
  LaunchdManager,
  type SpawnFn,
  SystemdManager,
  detectPlatform,
  makeServiceManager,
} from "../src/platform.ts";

describe("detectPlatform", () => {
  test("returns 'darwin' or 'linux' on supported hosts", () => {
    const p = detectPlatform();
    expect(p === "darwin" || p === "linux").toBe(true);
  });
});

describe("LaunchdManager", () => {
  test("restart calls launchctl kickstart -k gui/$UID/<label>", async () => {
    const calls: { cmd: string[] }[] = [];
    const spawn: SpawnFn = async (cmd) => {
      calls.push({ cmd });
      return { exitCode: 0, stderr: "" };
    };
    const mgr = new LaunchdManager({ spawn, uid: 501 });
    const r = await mgr.restart("com.argus.clawhip");
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const c = calls[0];
    if (!c) throw new Error("expected call");
    expect(c.cmd).toEqual(["launchctl", "kickstart", "-k", "gui/501/com.argus.clawhip"]);
  });

  test("restart returns ok:false on non-zero exit and surfaces stderr", async () => {
    const spawn: SpawnFn = async () => ({ exitCode: 1, stderr: "no such service" });
    const mgr = new LaunchdManager({ spawn, uid: 501 });
    const r = await mgr.restart("com.does.not.exist");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("no such service");
    expect(r.detail).toContain("exit=1");
  });

  test("restart returns ok:false when spawn throws", async () => {
    const spawn: SpawnFn = async () => {
      throw new Error("ENOENT launchctl");
    };
    const mgr = new LaunchdManager({ spawn, uid: 501 });
    const r = await mgr.restart("com.argus.clawhip");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("ENOENT launchctl");
  });
});

describe("SystemdManager", () => {
  test("restart calls systemctl --user restart <label>", async () => {
    const calls: { cmd: string[] }[] = [];
    const spawn: SpawnFn = async (cmd) => {
      calls.push({ cmd });
      return { exitCode: 0, stderr: "" };
    };
    const mgr = new SystemdManager({ spawn });
    const r = await mgr.restart("argus-clawhip");
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const c = calls[0];
    if (!c) throw new Error("expected call");
    expect(c.cmd).toEqual(["systemctl", "--user", "restart", "argus-clawhip"]);
  });

  test("restart returns ok:false on non-zero exit", async () => {
    const spawn: SpawnFn = async () => ({ exitCode: 5, stderr: "Failed to restart" });
    const mgr = new SystemdManager({ spawn });
    const r = await mgr.restart("argus-clawhip");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("Failed to restart");
  });
});

describe("makeServiceManager", () => {
  test("builds LaunchdManager on darwin", () => {
    const mgr = makeServiceManager("darwin");
    expect(mgr).toBeInstanceOf(LaunchdManager);
  });
  test("builds SystemdManager on linux", () => {
    const mgr = makeServiceManager("linux");
    expect(mgr).toBeInstanceOf(SystemdManager);
  });
});
