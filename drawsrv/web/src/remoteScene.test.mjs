import { test } from "node:test";
import assert from "node:assert/strict";
import { reuseRemoteElements, hasChangedExistingFiles } from "./remoteScene.ts";

test("unchanged elements retain identity and remote deletes become undo-aware tombstones", () => {
  const unchanged = {
    id: "same",
    x: 10,
    boundElements: [],
    updated: 1,
    version: 1,
  };
  const changed = { id: "edit", x: 0, boundElements: [] };
  const removed = { id: "gone", x: 20, version: 2 };
  const tombstone = { id: "old deletion", isDeleted: true, version: 3 };
  const incoming = [
    { ...unchanged, updated: 100, version: 5 },
    { ...changed, x: 7 },
    { id: "new" },
  ];
  const result = reuseRemoteElements(
    [unchanged, changed, removed, tombstone],
    incoming,
  );
  assert.equal(result[0], unchanged);
  assert.equal(result[1], incoming[1]);
  assert.equal(result[2], incoming[2]);
  assert.deepEqual(result[3], { ...removed, isDeleted: true, version: 3 });
  assert.equal(result[4], tombstone);
  assert.equal(removed.isDeleted, undefined);
});
test("new image IDs can be added; same-ID content changes need a new file cache", () => {
  const current = {
    a: { id: "a", dataURL: "data:image/png;base64,one", created: 1 },
  };
  assert.equal(
    hasChangedExistingFiles(current, {
      a: { ...current.a, created: 100 },
      b: { id: "b", dataURL: "new" },
    }),
    false,
  );
  assert.equal(hasChangedExistingFiles(current, {}), false);
  assert.equal(
    hasChangedExistingFiles(current, {
      a: { ...current.a, dataURL: "different" },
    }),
    true,
  );
});

test("component-only undefined properties compare using JSON semantics", () => {
  const local = {
    id: "shape",
    x: 1,
    boundElements: [],
    optional: undefined,
    customData: { missing: undefined, nested: [undefined] },
  };
  const incoming = {
    id: "shape",
    x: 1,
    boundElements: [],
    customData: { nested: [null] },
  };
  assert.equal(reuseRemoteElements([local], [incoming])[0], local);
});
