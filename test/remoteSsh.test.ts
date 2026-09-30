import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SSH_EXEC_TIMEOUT_MAX,
  SSH_EXEC_TIMEOUT_MIN,
  buildSshArgv,
  describeSshResult,
  describeSshTarget,
  validateSshTarget,
  type RemoteSshTarget,
} from "../src/lib/remoteSsh.ts";

const SSH = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";

function target(overrides: Partial<RemoteSshTarget> = {}): RemoteSshTarget {
  return { id: "ssh-a1", label: "build box", host: "192.168.1.40", port: 22, user: "", identityFile: "", ...overrides };
}

describe("remote ssh transport (M4-07)", () => {
  it("validates targets from untrusted input", () => {
    assert.ok(validateSshTarget(target()));
    assert.equal(validateSshTarget(target({ host: "bad host" })), null, "a space is not a host character");
    assert.equal(validateSshTarget(target({ host: "-evil" })), null, "an option-shaped host is refused");
    assert.equal(validateSshTarget(target({ user: "bad user" })), null);
    assert.equal(validateSshTarget(target({ port: 0 })), null);
    assert.equal(validateSshTarget(target({ port: 65536 })), null);
    assert.equal(validateSshTarget(null), null);
    // Defaults fill in honestly rather than guessing.
    const bare = validateSshTarget({ id: "ssh-b2", label: "x", host: "box.local", port: undefined, user: "", identityFile: "" });
    assert.ok(bare);
    assert.equal(bare.port, 22);
  });

  it("builds the canonical argv with the command after a literal --", () => {
    assert.deepEqual(buildSshArgv(SSH, target(), "uptime"), [
      SSH,
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "192.168.1.40",
      "--",
      "uptime",
    ]);
    const withOptions = buildSshArgv(SSH, target({ port: 2222, user: "ops", identityFile: "C:\\keys\\id" }), "-oProxyCommand=evil");
    assert.ok(withOptions);
    assert.equal(withOptions[1], "-p");
    assert.equal(withOptions[2], "2222");
    assert.equal(withOptions[3], "-i");
    assert.equal(withOptions[withOptions.length - 2], "--", "a dash-leading remote command stays a positional");
    assert.equal(withOptions[withOptions.length - 1], "-oProxyCommand=evil");
    assert.equal(withOptions.find((arg) => arg === "ops@192.168.1.40"), "ops@192.168.1.40");
  });

  it("refuses to build argv from an empty or oversized command", () => {
    assert.equal(buildSshArgv(SSH, target(), ""), null);
    assert.equal(buildSshArgv(SSH, target(), "   "), null);
    assert.equal(buildSshArgv(SSH, target(), "x".repeat(8_001)), null);
    assert.equal(buildSshArgv("", target(), "uptime"), null);
  });

  it("displays the target without leaking the identity path", () => {
    const shown = describeSshTarget(target({ user: "ops", identityFile: "C:\\Users\\ops\\keys\\id_ed25519" }));
    assert.match(shown, /ops@192\.168\.1\.40:22 \(key id_ed25519\)/);
    assert.doesNotMatch(shown, /Users/);
  });

  it("describes a finished exec in one bounded line", () => {
    assert.match(describeSshResult(0, false, " 14:00 up 3 days\n", ""), /succeeded/);
    assert.match(describeSshResult(255, false, "", "Connection refused\n"), /exited 255[\s\S]*Connection refused/);
    assert.match(describeSshResult(null, true, "", ""), /did not answer within the timeout/);
    assert.ok(SSH_EXEC_TIMEOUT_MIN < SSH_EXEC_TIMEOUT_MAX);
  });
});
