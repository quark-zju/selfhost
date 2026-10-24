import { test } from "node:test";
import assert from "node:assert/strict";
import { paginateCanvases } from "./canvasList.ts";

const canvases = Array.from({ length: 43 }, (_, i) => ({
  id: String(i).padStart(2, "0"),
  name: `画布 ${i}`,
  updated: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
}));
test("recent ordering is global, pages hold 20 entries and the fetched list is unchanged", () => {
  const original = structuredClone(canvases);
  const pages = [1, 2, 3].map((page) => paginateCanvases(canvases, "", page));
  assert.deepEqual(
    pages.map((page) => page.items.length),
    [20, 20, 3],
  );
  assert.equal(pages[0].items[0].id, "42");
  assert.equal(pages[1].items[0].id, "22");
  assert.equal(pages[2].items[2].id, "00");
  assert.equal(
    new Set(pages.flatMap((page) => page.items.map((item) => item.id))).size,
    43,
  );
  assert.deepEqual(canvases, original);
});
test("search spans all pages, handles Unicode and empty results, and clamps stale page numbers", () => {
  const result = paginateCanvases(canvases, "画布 0", 9);
  assert.equal(result.total, 1);
  assert.equal(result.page, 1);
  assert.equal(result.items[0].id, "00");
  assert.equal(
    paginateCanvases(
      [{ id: "a", name: "My Canvas", updated: "2026-01-01" }],
      " CANVAS ",
      1,
    ).total,
    1,
  );
  assert.deepEqual(paginateCanvases(canvases, "不存在", 9), {
    items: [],
    total: 0,
    page: 1,
    pages: 1,
  });
  assert.equal(paginateCanvases(canvases, "", 99).page, 3);
  assert.equal(paginateCanvases(canvases, "", -1).page, 1);
});
test("equal update instants have deterministic ID ordering across time zones", () => {
  const result = paginateCanvases(
    [
      { id: "b", name: "b", updated: "2026-01-01T01:00:00+01:00" },
      { id: "a", name: "a", updated: "2026-01-01T00:00:00Z" },
    ],
    "",
    1,
  );
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["a", "b"],
  );
});
