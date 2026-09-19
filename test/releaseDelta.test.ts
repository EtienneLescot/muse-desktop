import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  applyReleaseDelta,
  applyReleaseDeltaFile,
  buildReleaseDelta,
  decodeReleaseDelta,
} from "../scripts/release-delta.mjs";

describe("release differential update", () => {
  it("builds a compressed path-free delta and reconstructs the target", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-release-delta-"));
    const sourcePath = join(root, "old.bin");
    const targetPath = join(root, "new.bin");
    const prefix = Buffer.alloc(64 * 1024, 0x41);
    const source = Buffer.concat([prefix, Buffer.from("old payload"), prefix]);
    const target = Buffer.concat([prefix, Buffer.from("new payload"), prefix]);
    await writeFile(sourcePath, source);
    await writeFile(targetPath, target);
    const built = await buildReleaseDelta({ sourcePath, targetPath, blockSize: 4096 });
    const patch = decodeReleaseDelta(built.bytes);
    assert.equal(patch.source.file, "old.bin");
    assert.equal(patch.target.file, "new.bin");
    assert.equal(patch.operations.some((operation) => operation.type === "copy"), true);
    assert.deepEqual(applyReleaseDelta({ sourceBytes: source, patch }), target);
    assert.equal(built.stats.useDelta, true);
  });

  it("rejects a changed source before writing output", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-release-delta-"));
    const sourcePath = join(root, "old.bin");
    const targetPath = join(root, "new.bin");
    const patchPath = join(root, "update.delta.gz");
    const outputPath = join(root, "out.bin");
    await writeFile(sourcePath, Buffer.from("old"));
    await writeFile(targetPath, Buffer.from("new"));
    const built = await buildReleaseDelta({ sourcePath, targetPath, blockSize: 4096 });
    await writeFile(patchPath, built.bytes);
    await writeFile(sourcePath, Buffer.from("tampered"));
    await assert.rejects(() => applyReleaseDeltaFile({ sourcePath, deltaPath: patchPath, outputPath }), /source does not match/);
    await assert.rejects(() => readFile(outputPath), /ENOENT/);
  });

  it("rejects malformed or tampered delta data", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-release-delta-"));
    const sourcePath = join(root, "old.bin");
    const targetPath = join(root, "new.bin");
    await writeFile(sourcePath, Buffer.from("old"));
    await writeFile(targetPath, Buffer.from("new"));
    const built = await buildReleaseDelta({ sourcePath, targetPath, blockSize: 4096 });
    const patch = decodeReleaseDelta(built.bytes);
    patch.operations[0].data = Buffer.from("bad").toString("base64");
    assert.throws(() => applyReleaseDelta({ sourceBytes: Buffer.from("old"), patch }), /target does not match|data length/);
    assert.throws(() => decodeReleaseDelta(Buffer.from("not gzip")), /cannot be decoded/);
  });
});
