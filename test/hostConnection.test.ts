/**
 * M4-07: Remote / Cloud host connection unit tests.
 *
 * Runs on node:test:
 *   npm test -- --test-name-pattern="host connection"
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HOST_CONNECTIONS_SCHEMA,
  HOST_CONNECTIONS_KEY,
  calculateReconnectBackoff,
  createConnectionRecord,
  createHostConnection,
  destroyHostEnvironment,
  evaluateHeartbeat,
  parseHostConnectionConfig,
  parseHostConnections,
  routeSessionToHost,
  sanitizeEndpoint,
  serializeHostConnections,
  transitionConnectionState,
  type HostConnectionConfig,
  type HostConnectionRecord,
} from "../src/lib/hostConnection.ts";

describe("host connection endpoints", () => {
  it("sanitizes local endpoint correctly", () => {
    assert.deepEqual(sanitizeEndpoint("", "local"), {
      valid: true,
      normalized: "local://sidecar",
    });
    assert.deepEqual(sanitizeEndpoint("   ", "local"), {
      valid: true,
      normalized: "local://sidecar",
    });
  });

  it("sanitizes remote SSH endpoints", () => {
    const valid1 = sanitizeEndpoint("ssh://dev@192.168.1.50:22", "remote-ssh");
    assert.equal(valid1.valid, true);
    assert.equal(valid1.normalized, "ssh://dev@192.168.1.50:22");

    const valid2 = sanitizeEndpoint("ubuntu@devbox.internal", "remote-ssh");
    assert.equal(valid2.valid, true);
    assert.equal(valid2.normalized, "ssh://ubuntu@devbox.internal");

    const invalid = sanitizeEndpoint("not a valid host @@@ ???", "remote-ssh");
    assert.equal(invalid.valid, false);
    assert.match(invalid.error || "", /Invalid SSH endpoint/i);
  });

  it("sanitizes cloud runner endpoints", () => {
    const valid = sanitizeEndpoint("https://runner.cloud.internal/agent/v1", "cloud-runner");
    assert.equal(valid.valid, true);
    assert.equal(valid.normalized, "https://runner.cloud.internal/agent/v1");

    const invalidProto = sanitizeEndpoint("ftp://runner.internal", "cloud-runner");
    assert.equal(invalidProto.valid, false);
    assert.match(invalidProto.error || "", /http:\/\/ or https:\/\//i);

    const empty = sanitizeEndpoint("", "cloud-runner");
    assert.equal(empty.valid, false);
  });
});

describe("host connection configuration and store", () => {
  it("uses the canonical schema and localStorage key", () => {
    assert.equal(HOST_CONNECTIONS_SCHEMA, "muse-desktop.host-connections.v1");
    assert.equal(HOST_CONNECTIONS_KEY, "muse-desktop.host-connections.v1");
  });

  it("creates a valid host connection config", () => {
    const result = createHostConnection({
      label: "Devbox GPU",
      type: "remote-ssh",
      endpoint: "ssh://ubuntu@gpu-cluster.internal:22",
      authType: "key",
      workspaceRoot: "/home/ubuntu/repo",
      hasCredential: true,
    });
    assert.equal(result.error, undefined);
    assert.ok(result.config);
    assert.equal(result.config.label, "Devbox GPU");
    assert.equal(result.config.type, "remote-ssh");
    assert.equal(result.config.authType, "key");
    assert.equal(result.config.hasCredential, true);
    assert.equal(result.config.workspaceRoot, "/home/ubuntu/repo");
  });

  it("parses and bounds stored connection list", () => {
    const raw = {
      schema: HOST_CONNECTIONS_SCHEMA,
      activeConnectionId: "host-1",
      connections: [
        {
          id: "host-1",
          label: "Primary Local",
          type: "local",
          endpoint: "local://sidecar",
          authType: "none",
        },
        {
          id: "host-2",
          label: "Remote Cloud",
          type: "cloud-runner",
          endpoint: "https://runner.company.net",
          authType: "token",
          hasCredential: true,
        },
        // Duplicate id should be dropped
        {
          id: "host-1",
          label: "Duplicate",
          type: "local",
          endpoint: "local://sidecar",
        },
      ],
    };

    const parsed = parseHostConnections(raw);
    assert.equal(parsed.connections.length, 2);
    assert.equal(parsed.activeConnectionId, "host-1");
    assert.equal(parsed.connections[0].id, "host-1");
    assert.equal(parsed.connections[1].id, "host-2");

    const serialized = serializeHostConnections(parsed);
    const roundTrip = parseHostConnections(JSON.parse(serialized));
    assert.deepEqual(roundTrip, parsed);
  });
});

describe("host connection lifecycle state machine", () => {
  it("transitions between connection states cleanly", () => {
    const config: HostConnectionConfig = {
      id: "remote-1",
      label: "Cloud Node",
      type: "cloud-runner",
      endpoint: "https://cloud-agent.internal",
      authType: "token",
      workspaceRoot: "/workspace",
      hasCredential: true,
      createdAt: "2026-09-19T00:00:00Z",
      updatedAt: "2026-09-19T00:00:00Z",
    };

    let record = createConnectionRecord(config);
    assert.equal(record.state, "disconnected");
    assert.equal(record.reconnectAttempts, 0);

    // Connecting
    record = transitionConnectionState(record, "connecting");
    assert.equal(record.state, "connecting");
    assert.equal(record.errorMessage, null);

    // Connected
    record = transitionConnectionState(record, "connected", { latencyMs: 42 });
    assert.equal(record.state, "connected");
    assert.equal(record.latencyMs, 42);
    assert.equal(record.reconnectAttempts, 0);
    assert.ok(record.lastHeartbeatAt);

    // Heartbeat failure -> reconnecting
    record = transitionConnectionState(record, "reconnecting", {
      errorMessage: "Host connection dropped",
    });
    assert.equal(record.state, "reconnecting");
    assert.equal(record.reconnectAttempts, 1);
    assert.equal(record.errorMessage, "Host connection dropped");

    // Second reconnect attempt
    record = transitionConnectionState(record, "reconnecting");
    assert.equal(record.reconnectAttempts, 2);

    // Final failure -> error
    record = transitionConnectionState(record, "error", {
      errorMessage: "Connection refused by host",
    });
    assert.equal(record.state, "error");
    assert.equal(record.errorMessage, "Connection refused by host");
  });

  it("calculates exponential backoff", () => {
    assert.equal(calculateReconnectBackoff(0, 1000, 30000), 1000);
    assert.equal(calculateReconnectBackoff(1, 1000, 30000), 2000);
    assert.equal(calculateReconnectBackoff(2, 1000, 30000), 4000);
    assert.equal(calculateReconnectBackoff(3, 1000, 30000), 8000);
    assert.equal(calculateReconnectBackoff(10, 1000, 15000), 15000); // Clamped by maxMs
  });

  it("detects missed heartbeats", () => {
    const config: HostConnectionConfig = {
      id: "remote-2",
      label: "Remote 2",
      type: "remote-ssh",
      endpoint: "ssh://user@host",
      authType: "none",
      workspaceRoot: "",
      hasCredential: false,
      createdAt: "",
      updatedAt: "",
    };

    const initial = createConnectionRecord(config);
    const connected = transitionConnectionState(initial, "connected", {
      heartbeatAt: new Date(1_000_000).toISOString(),
    });

    // Check at 1_005_000 (5s later, within 15s timeout)
    const fresh = evaluateHeartbeat(connected, 1_005_000, 15_000);
    assert.equal(fresh.alive, true);
    assert.equal(fresh.updatedRecord.state, "connected");

    // Check at 1_025_000 (25s later, exceeds 15s timeout)
    const expired = evaluateHeartbeat(connected, 1_025_000, 15_000);
    assert.equal(expired.alive, false);
    assert.equal(expired.updatedRecord.state, "reconnecting");
    assert.match(expired.updatedRecord.errorMessage || "", /Heartbeat missed/i);
  });
});

describe("session routing and environment destruction", () => {
  it("routes session to target host maintaining isolation", () => {
    const localConfig = createHostConnection({
      id: "local-host",
      label: "Local Sidecar",
      type: "local",
      endpoint: "local://sidecar",
    }).config!;

    const remoteConfig = createHostConnection({
      id: "remote-host",
      label: "Cloud Runner",
      type: "cloud-runner",
      endpoint: "https://runner.internal",
    }).config!;

    const localRecord = createConnectionRecord(localConfig);
    const remoteRecord = createConnectionRecord(remoteConfig);
    remoteRecord.activeSessionIds.push("session-cloud-123");

    const records = [localRecord, remoteRecord];

    // Session 1 is bound to remote
    const routedRemote = routeSessionToHost("session-cloud-123", records);
    assert.equal(routedRemote.targetRecord?.config.id, "remote-host");
    assert.equal(routedRemote.isolated, true);

    // Unbound session routes to local by default
    const routedDefault = routeSessionToHost("session-new-456", records);
    assert.equal(routedDefault.targetRecord?.config.id, "local-host");
    assert.equal(routedDefault.isolated, false);

    // Explicit request to remote host
    const explicitRemote = routeSessionToHost("session-new-456", records, "remote-host");
    assert.equal(explicitRemote.targetRecord?.config.id, "remote-host");
    assert.equal(explicitRemote.isolated, true);
  });

  it("destroys environment and signals terminated sessions", () => {
    const hostA = createConnectionRecord(
      createHostConnection({ id: "host-a", label: "A", type: "local", endpoint: "" }).config!,
    );
    const hostB = createConnectionRecord(
      createHostConnection({ id: "host-b", label: "B", type: "cloud-runner", endpoint: "https://b.internal" }).config!,
    );
    hostB.activeSessionIds = ["sess-1", "sess-2"];

    const records = [hostA, hostB];
    const { remaining, terminatedSessions, removedRecord } = destroyHostEnvironment("host-b", records);

    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].config.id, "host-a");
    assert.deepEqual(terminatedSessions, ["sess-1", "sess-2"]);
    assert.equal(removedRecord?.config.id, "host-b");
  });
});
