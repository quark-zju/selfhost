import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { diffCanvas, serializeCanvas, effectiveHash } from "./content.ts";
const hash = (value) => effectiveHash(value, webcrypto);
test("change lists omit server metadata, group fields, and carry only the relevant old values", () => {
  const scene = {
    name: "base",
    elements: [{ id: "a", x: 0, y: 0, version: 1, updated: 3 }],
    files: {},
    libraryItems: [],
  };
  const next = structuredClone(scene);
  Object.assign(next.elements[0], {
    x: 1,
    y: 2,
    version: 2,
    versionNonce: 12,
    updated: 100,
  });
  const operations = diffCanvas(JSON.stringify(scene), JSON.stringify(next));
  assert.equal(operations.length, 1);
  assert.deepEqual(operations[0].fields.map((field) => field.field).sort(), [
    "x",
    "y",
  ]);
  assert.deepEqual(operations[0].fields[0].before, { present: true, value: 0 });
  assert.equal(Object.hasOwn(operations[0].before, "value"), false);
  const metadataOnly = structuredClone(scene);
  metadataOnly.elements[0].updated = 999;
  assert.equal(
    diffCanvas(JSON.stringify(scene), JSON.stringify(metadataOnly)).length,
    0,
  );
});
test("concurrent additions do not create a global order precondition", () => {
  const before = {
    name: "base",
    elements: [{ id: "a" }],
    files: {},
    libraryItems: [],
  };
  const after = { ...before, elements: [...before.elements, { id: "b" }] };
  const operations = diffCanvas(JSON.stringify(before), JSON.stringify(after));
  assert.equal(operations.length, 1);
  assert.equal(operations[0].afterId, "a");
});
test("content hash matches the Go fixtures including Unicode and floating point values", async () => {
  const fixtures = JSON.parse(
    await readFile(
      new URL("../testdata/content-hash.json", import.meta.url),
      "utf8",
    ),
  );
  for (const fixture of fixtures)
    assert.equal(await hash(JSON.stringify(fixture.document)), fixture.hash);
});
