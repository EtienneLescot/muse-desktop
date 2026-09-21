import { readFileSync } from "node:fs";

const source = readFileSync("node_modules/@muse-code/sdk/dist/src/msp.d.ts", "utf8");
const match = /export type MspMethod =([\s\S]*?);/.exec(source);
if (match === null) {
  console.log("  MspMethod introuvable");
  process.exit(0);
}
const methods = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
console.log(`  ${methods.length} methodes MSP declarees`);
const del = methods.filter((m) => /delete|remove|purge|destroy|forget|archive/i.test(m));
console.log(`  candidates a la suppression/archivage : ${del.length > 0 ? del.join(", ") : "AUCUNE"}`);
console.log(`  methodes session/* : ${methods.filter((m) => m.startsWith("session/")).join(", ")}`);
