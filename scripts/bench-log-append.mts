#!/usr/bin/env node

/**
 * Cost of appending to the persisted transcript log.
 *
 * `appendLog` reads the whole stored log, concatenates, slices to the cap and
 * serialises everything back. Streaming appends in small batches, so the total
 * cost of a long turn grows with the log length. This script measures that cost
 * at several sizes so the shape is visible rather than assumed.
 *
 * It exercises the real `appendLog`/`saveLog`/`loadLog` from `src/lib/persist.ts`
 * against an in-memory localStorage. That measures the **algorithm's** cost, not
 * WebView2's storage cost, which a node process cannot reproduce.
 *
 * Usage:
 *   node --experimental-strip-types scripts/bench-log-append.mts
 *   node --experimental-strip-types scripts/bench-log-append.mts --json
 */
import { saveLog, appendLog, loadLog } from "../src/lib/persist.ts";

const SIZES = [100, 500, 1000, 2000];
const APPENDS_PER_SIZE = 60;

function fakeStorage(): { stored: (key: string) => string } {
  const map = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string): string | null => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string): void => { map.set(k, String(v)); },
    removeItem: (k: string): void => { map.delete(k); },
  };
  return { stored: (key: string) => map.get(key) ?? "" };
}

const entry = (n: number) => ({
  id: `e-${n}`,
  role: "user" as const,
  text: `message number ${n} with some plausible body text of moderate length`,
  ts: 1_700_000_000_000 + n,
});

type Row = {
  logSize: number;
  seeded: number;
  appendMs: number;
  medianMs: number;
  maxMs: number;
  storedKb: number;
};

function main(): { rows: Row[]; appendsPerSize: number } {
  const rows: Row[] = [];

  for (const size of SIZES) {
    const storage = fakeStorage();
    const session = `bench-${size}`;

    // Seed through the public API so validation accepts every entry.
    saveLog(session, Array.from({ length: size }, (_, i) => entry(i)));
    const seeded = loadLog(session).length;

    // Warm up once at this size, then measure single-entry appends.
    appendLog(session, [entry(size)]);
    const samples: number[] = [];
    for (let i = 0; i < APPENDS_PER_SIZE; i += 1) {
      const t0 = process.hrtime.bigint();
      appendLog(session, [entry(size + 1 + i)]);
      const t1 = process.hrtime.bigint();
      samples.push(Number(t1 - t0) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const mean = samples.reduce((sum, v) => sum + v, 0) / samples.length;
    rows.push({
      logSize: size,
      seeded,
      appendMs: Number(mean.toFixed(3)),
      medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(3)),
      maxMs: Number(samples[samples.length - 1].toFixed(3)),
      storedKb: Math.round(storage.stored(`muse-desktop.log.v1.${session}`).length / 1024),
    });
  }

  return { rows, appendsPerSize: APPENDS_PER_SIZE };
}

const { rows, appendsPerSize } = main();

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ schema: "muse-desktop.bench-log-append.v1", appendsPerSize, rows }, null, 2)}\n`);
} else {
  const base = rows[0];
  process.stdout.write(`Coût d'un ajout d'une entrée, moyenne sur ${appendsPerSize} ajouts\n\n`);
  process.stdout.write("taille   moyenne(ms)  médiane(ms)  max(ms)  stockage(Ko)  ×base\n");
  for (const r of rows) {
    process.stdout.write(
      `${String(r.logSize).padStart(6)}  ${String(r.appendMs).padStart(11)}  ${String(r.medianMs).padStart(10)}  ${String(r.maxMs).padStart(7)}  ${String(r.storedKb).padStart(11)}  ${(r.appendMs / base.appendMs).toFixed(1).padStart(5)}\n`,
    );
  }
  const last = rows[rows.length - 1];
  process.stdout.write(
    `\nCroissance : ×${(last.appendMs / base.appendMs).toFixed(1)} sur le coût d'ajout quand le journal passe de ${base.logSize} à ${last.logSize} entrées (soit ×${(last.logSize / base.logSize).toFixed(0)} de taille).\n`,
  );
  const totalMs = rows.reduce((sum, r) => sum + r.appendMs, 0);
  process.stdout.write(`Somme des moyennes mesurées : ${totalMs.toFixed(2)} ms.\n`);
}
