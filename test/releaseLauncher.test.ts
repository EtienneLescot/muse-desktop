import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInstallerInvocation,
  runInstallerHandoff,
  runReleaseLauncher,
  stopAndWaitForProcess,
  waitForProcessExit,
} from "../scripts/release-launcher.mjs";

test("buildInstallerInvocation keeps NSIS arguments shell-free", () => {
  assert.deepEqual(
    buildInstallerInvocation("C:/releases/Muse-Desktop-1.1.0.exe", ["/D=TARGET=C:/Muse"], "win32"),
    { executable: "C:\\releases\\Muse-Desktop-1.1.0.exe", args: ["/D=TARGET=C:/Muse"] },
  );
});

test("buildInstallerInvocation delegates MSI to Windows Installer", () => {
  assert.deepEqual(
    buildInstallerInvocation("C:/releases/Muse-Desktop-1.1.0.msi", ["/passive"], "win32"),
    { executable: "msiexec.exe", args: ["/i", "C:\\releases\\Muse-Desktop-1.1.0.msi", "/passive"] },
  );
  assert.throws(() => buildInstallerInvocation("Muse.msi", [], "linux"), /require Windows/);
});

test("buildInstallerInvocation rejects unsupported installer formats", () => {
  assert.throws(() => buildInstallerInvocation("C:/releases/Muse.zip", [], "win32"), /NSIS .exe or Windows .msi/);
});

test("waitForProcessExit polls until the process disappears", async () => {
  let calls = 0;
  const result = await waitForProcessExit(4242, {
    pollMs: 1,
    timeoutMs: 100,
    isAlive: async () => {
      calls += 1;
      return calls < 3;
    },
  });
  assert.deepEqual(result, { pid: 4242, exited: true });
  assert.equal(calls, 3);
});

test("stopAndWaitForProcess requests a graceful exit before polling", async () => {
  const events: string[] = [];
  let alive = true;
  const result = await stopAndWaitForProcess(4243, {
    pollMs: 1,
    timeoutMs: 100,
    isAlive: async () => alive,
    requestStop: async (pid) => {
      events.push(`stop:${pid}`);
      alive = false;
    },
  });
  assert.deepEqual(result, { pid: 4243, alreadyExited: false });
  assert.deepEqual(events, ["stop:4243"]);
});

test("runReleaseLauncher swaps, starts and returns the release result", async () => {
  const events: string[] = [];
  const result = await runReleaseLauncher({
    pid: 4244,
    stagedPath: "candidate",
    slotsRoot: "slots",
    executable: "Muse-Desktop.exe",
    args: ["--updated"],
    isAlive: async () => false,
    apply: async (options) => {
      events.push(`apply:${options.stagedPath}`);
      return { currentVersion: "1.1.0", previousVersion: "1.0.0", currentPath: "slots/current" };
    },
    launch: async (options) => {
      events.push(`launch:${options.args.join(",")}`);
      return { executable: options.executable, pid: 99 };
    },
  });
  assert.equal(result.schema, "muse-desktop.release-launch.v1");
  assert.equal(result.release.currentVersion, "1.1.0");
  assert.deepEqual(events, ["apply:candidate", "launch:--updated"]);
  assert.equal(result.rollback, null);
});

test("runReleaseLauncher rolls back when the restarted app cannot launch", async () => {
  let rollbacks = 0;
  await assert.rejects(
    runReleaseLauncher({
      stagedPath: "candidate",
      slotsRoot: "slots",
      executable: "Muse-Desktop.exe",
      apply: async () => ({ currentVersion: "1.1.0", previousVersion: "1.0.0" }),
      launch: async () => { throw new Error("start failed"); },
      rollback: async () => { rollbacks += 1; },
    }),
    /start failed/,
  );
  assert.equal(rollbacks, 1);
});

test("runInstallerHandoff stops Muse before launching the installer", async () => {
  const events: string[] = [];
  let alive = true;
  const result = await runInstallerHandoff({
    pid: 4245,
    installerPath: "C:/releases/Muse-Desktop-1.1.0.exe",
    isAlive: async () => alive,
    requestStop: async (pid) => {
      events.push(`stop:${pid}`);
      alive = false;
    },
    launch: async (options) => {
      events.push(`launch:${options.installerPath}`);
      return { installerPath: options.installerPath, executable: options.installerPath, args: [], pid: 4246 };
    },
  });
  assert.equal(result.schema, "muse-desktop.release-installer.v1");
  assert.deepEqual(events, ["stop:4245", "launch:C:/releases/Muse-Desktop-1.1.0.exe"]);
  assert.equal(result.installer.pid, 4246);
});
