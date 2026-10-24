import { test } from "node:test";
import assert from "node:assert/strict";
import { Autosave } from "./autosave.ts";
import { normalizeElements, normalizeLibraryItems } from "./normalize.ts";

test("a restored empty binding does not upload an unchanged scene", async () => {
  const stored = [{ id: "shape", boundElements: null }];
  const loaded = normalizeElements(stored);
  const sends = [];
  const save = new Autosave(
    JSON.stringify(loaded),
    "etag",
    async (body) => {
      sends.push(body);
      return { etag: "next", revision: "next", persisted: true };
    },
    () => {},
  );
  try {
    // Excalidraw restores null as [], even when the user made no changes.
    save.queue(JSON.stringify([{ id: "shape", boundElements: [] }]));
    assert.equal(await save.flush(), true);
    assert.equal(sends.length, 0);
    assert.equal(stored[0].boundElements, null);
  } finally {
    save.dispose();
  }
});

test("new and imported elements and library items keep real bindings while normalizing empty ones", () => {
  const bound = {
    id: "box",
    boundElements: [
      { id: "arrow", type: "arrow" },
      { id: "label", type: "text" },
    ],
  };
  const elements = [
    { id: "new", boundElements: null },
    { id: "legacy" },
    bound,
  ];
  const result = normalizeElements(elements);
  assert.deepEqual(result, [
    { id: "new", boundElements: [] },
    { id: "legacy", boundElements: [] },
    bound,
  ]);
  assert.equal(result[2], bound);
  assert.deepEqual(normalizeElements(result), result);
  const library = [{ id: "library", status: "published", elements }];
  assert.deepEqual(normalizeLibraryItems(library), [
    { id: "library", status: "published", elements: result },
  ]);
  assert.equal(library[0].elements[0].boundElements, null);
});
