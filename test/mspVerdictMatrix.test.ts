/**
 * Pure helpers of `scripts/msp-verdict-matrix.mjs`: the path scrubber that
 * keeps the evidence report path-free, and the cell classification the M0-06
 * comparison relies on. Importing the script spawns nothing (its entry point
 * only runs when it is executed directly).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyOutcome, networkStages, sandboxBlocked, scrub, shellErrors } from "../scripts/msp-verdict-matrix.mjs";

describe("verdict matrix path scrubbing", () => {
  const places: [string, string][] = [
    ["C:\\Users\\me\\AppData\\Local\\Temp", "<temp>"],
    ["C:\\Users\\me\\AppData\\Local\\Temp\\muse-matrix-root-1", "<root>"],
  ];

  it("labels the most specific place first, in any case and slash style", () => {
    assert.equal(
      scrub("wrote c:\\users\\me\\appdata\\local\\temp\\muse-matrix-root-1\\a.txt", places),
      "wrote <root>\\a.txt",
    );
    assert.equal(scrub("C:/Users/me/AppData/Local/Temp/x.txt", places), "<temp>/x.txt");
  });

  it("replaces any leftover drive path but keeps URLs", () => {
    assert.equal(scrub("D:\\elsewhere\\file.txt and https://example.com", places), "<path> and https://example.com");
  });

  it("drops non-strings", () => {
    assert.equal(scrub(undefined, places), undefined);
  });
});

describe("verdict matrix cell classification", () => {
  const call = (status: string, output = "") => ({ status, output });

  it("trusts an observed side effect over anything the host reports", () => {
    assert.equal(classifyOutcome({ sideEffect: true, toolCalls: [call("failed")], decisions: ["abort"], timedOut: true }), "completed");
  });

  it("separates a turn that never called the tool from one that hung", () => {
    assert.equal(classifyOutcome({ sideEffect: false, toolCalls: [], decisions: [], timedOut: false }), "noTool");
    assert.equal(classifyOutcome({ sideEffect: false, toolCalls: [], decisions: [], timedOut: true }), "hung");
  });

  it("reports an aborted approval or a refusing status as denied", () => {
    assert.equal(classifyOutcome({ sideEffect: false, toolCalls: [], decisions: ["abort"], timedOut: false }), "denied");
    assert.equal(classifyOutcome({ sideEffect: false, toolCalls: [call("failed")], decisions: ["allow_once", "abort"], timedOut: false }), "denied");
    assert.equal(classifyOutcome({ sideEffect: false, toolCalls: [call("denied")], decisions: [], timedOut: false }), "denied");
  });

  it("reports a failed status or an error in the output as failed", () => {
    assert.equal(classifyOutcome({ sideEffect: false, toolCalls: [call("failed")], decisions: [], timedOut: false }), "failed");
    assert.equal(classifyOutcome({ sideEffect: false, toolCalls: [call("completed", "Access is denied")], decisions: [], timedOut: false }), "failed");
  });

  it("flags a clean run whose effect is missing, and a running call at timeout as hung", () => {
    assert.equal(classifyOutcome({ sideEffect: false, toolCalls: [call("completed")], decisions: [], timedOut: false }), "noEffect");
    assert.equal(classifyOutcome({ sideEffect: false, toolCalls: [call("inProgress")], decisions: [], timedOut: true }), "hung");
  });
});

describe("verdict matrix network stages", () => {
  // Shaped on the 1.4.2 sandboxed output (restricted): DNS answers, connects are refused.
  const restricted = [
    "probe account muse-sbx-r1",
    "probe dns ok 172.66.147.243",
    "probe iwr http://example.com fail webStatus=ConnectFailure WebException: x <- SocketException[AccessDenied]: y",
    "probe iwr https://example.com fail webStatus=ReceiveFailure WebException: x <- IOException: y",
    "probe tcp 80 fail socket=AccessDenied MethodInvocationException: x",
    "probe tcp 443 ok",
    "probe tnc 443 dns=True tcp=False ping=True",
    "probe curl http://example.com exit=6",
    "probe curl| * getaddrinfo() thread failed to start",
    "probe curl| * Could not resolve host: example.com",
    "probe curl https://example.com exit=35",
    "probe curl| * Connected to example.com (172.66.147.243) port 443",
    "probe done",
  ].join("\n");

  it("names the first stage that failed for each check", () => {
    const { stages } = networkStages(restricted);
    assert.equal(stages.account, "muse-sbx-r1");
    assert.equal(stages.dns, "ok");
    assert.equal(stages.iwr_http, "connect");
    assert.equal(stages.iwr_https, "receive");
    assert.equal(stages.tcp_80, "connect:AccessDenied");
    assert.equal(stages.tcp_443, "ok");
    assert.equal(stages.tnc_443, "connect");
    assert.equal(stages.curl_http, "resolver");
    assert.equal(stages.curl_https, "tls");
  });

  it("reads an SSPI error under an HTTPS receive failure as the TLS stage", () => {
    // Shaped on 1.4.2 under --sandbox-network enabled: Schannel has no credentials.
    const { stages } = networkStages("probe iwr https://example.com fail webStatus=ReceiveFailure WebException: x <- Win32Exception: y\nprobe curl https://example.com exit=6\nprobe curl| * Could not resolve host: example.com");
    assert.equal(stages.iwr_https, "tls");
    assert.equal(stages.curl_https, "dns");
  });

  it("reads curl's verbose lines of its own run only", () => {
    const { stages } = networkStages(restricted);
    assert.equal(stages.curl_http_connected, false);
    assert.equal(stages.curl_http_detail, "* getaddrinfo() thread failed to start");
    assert.equal(stages.curl_https_connected, true);
  });

  it("unwraps a JSON tool output and reports missing checks", () => {
    const { stages } = networkStages(JSON.stringify({ exit_code: 0, output: "probe dns fail SocketException: x\nprobe done" }));
    assert.equal(stages.dns, "dns");
    assert.equal(stages.iwr_https, "missing");
  });
});

describe("verdict matrix shell errors", () => {
  it("keeps each Set-Content error's category and path, apostrophes in the message aside", () => {
    const output = "Set-Content : L'accès au chemin d'accès 'G:\\p\\root\\link\\ps-1.txt' est refusé. + CategoryInfo : PermissionDenied: (x)\n" +
      "Set-Content : L'accès au chemin d'accès 'G:\\p\\out\\direct-1.txt' est refusé. + CategoryInfo : PermissionDenied: (y)";
    assert.deepEqual(shellErrors(output), ["PermissionDenied G:\\p\\root\\link\\ps-1.txt", "PermissionDenied G:\\p\\out\\direct-1.txt"]);
  });
});

describe("verdict matrix sandbox fallback", () => {
  it("fires only when every allowed cell hung or failed, ignoring the refusal", () => {
    const refused = { decision: "abort", outcome: "denied" };
    assert.equal(sandboxBlocked([{ decision: "allow_once", outcome: "failed" }, { decision: "none", outcome: "hung" }, refused]), true);
    assert.equal(sandboxBlocked([{ decision: "none", outcome: "completed" }, { decision: "none", outcome: "hung" }]), false);
    assert.equal(sandboxBlocked([refused]), false);
  });
});
