import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildReleaseManifest } from "../scripts/release-manifest.mjs";
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


test("release-launcher CLI rollback flips the installed slots", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const run = (args: string[]) => {
    // "release:update ..." dispatches to release-update.mjs; anything else
    // (e.g. the launcher's own "rollback" subcommand) stays in the launcher
    if (args[0] === "release:update") {
      return execFileSync("node", ["scripts/release-update.mjs", ...args.slice(1)], { encoding: "utf8" });
    }
    return execFileSync("node", ["scripts/release-launcher.mjs", ...args], { encoding: "utf8" });
  };

  const base = await mkdtemp(join(tmpdir(), "muse-launcher-rollback-"));
  const slots = join(base, "slots");
  // build two versions with the update CLI: plan -> stage -> apply
  const buildVersion = (version: string, dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, `Muse-Desktop_${version}_x64-setup.exe`), `installer-v${version}`);
    fs.writeFileSync(join(dir, "muse-x86_64-pc-windows-msvc.exe"), `sidecar-v${version}`);
    // the manifest file must exist before plan/stage/apply
    fs.writeFileSync(
      join(dir, `release-${version}.manifest.json`),
      JSON.stringify(buildReleaseManifest({
        artifactPath: join(dir, `Muse-Desktop_${version}_x64-setup.exe`),
        sidecarPath: join(dir, "muse-x86_64-pc-windows-msvc.exe"),
        version,
        target: "x86_64-pc-windows-msvc",
      }), null, 2),
    );
    run(["release:update", "plan",
      "--manifest", join(dir, `release-${version}.manifest.json`),
      "--artifact", join(dir, `Muse-Desktop_${version}_x64-setup.exe`),
      "--sidecar", join(dir, "muse-x86_64-pc-windows-msvc.exe"),
      "--current-version", version === "1.1.0" ? "1.0.0" : "0.9.0",
      "--target", "x86_64-pc-windows-msvc",
      "--output", join(dir, `plan-${version}.json`)]);
    return { manifest: join(dir, `release-${version}.manifest.json`), artifact: join(dir, `Muse-Desktop_${version}_x64-setup.exe`), sidecar: join(dir, "muse-x86_64-pc-windows-msvc.exe"), plan: join(dir, `plan-${version}.json`) };
  };

  const stageAndApply = (v: { plan: string; artifact: string; sidecar: string }) => {
    const stageOutput = run(["release:update", "stage",
      "--plan", v.plan, "--artifact", v.artifact, "--sidecar", v.sidecar,
      "--staging-root", slots]);
    const stagedPath = JSON.parse(stageOutput).path;
    run(["release:update", "apply", "--staged", stagedPath, "--slots-root", slots]);
  };

  const v10 = buildVersion("1.0.0", join(base, "v10"));
  stageAndApply(v10);

  const v11 = buildVersion("1.1.0", join(base, "v11"));
  stageAndApply(v11);

  const planOf = (slot: string) =>
    JSON.parse(fs.readFileSync(join(slots, slot, "update-plan.json"), "utf8")).candidateVersion;
  const before = planOf("current");
  assert.equal(before, "1.1.0");

  // the CLI rollback subcommand flips current/previous without a launcher
  run(["rollback", "--slots-root", slots]);
  assert.equal(planOf("current"), "1.0.0");
  assert.equal(planOf("previous"), "1.1.0");
});
