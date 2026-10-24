import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalAppStateStore } from "./localAppState.ts";

function tab() {
  const values = new Map();
  let writes = 0;
  return {
    sessionStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        writes++;
        values.set(key, value);
      },
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer),
    values,
    get writes() {
      return writes;
    },
  };
}
test("appState survives reload in one tab but stays independent across tabs and canvases", () => {
  const one = tab(),
    two = tab();
  const a = new LocalAppStateStore("canvas-a", one);
  a.save({ scrollX: 123, zoom: { value: 2 }, viewBackgroundColor: "#abc" });
  a.flush();
  assert.deepEqual(new LocalAppStateStore("canvas-a", one).load(), {
    scrollX: 123,
    zoom: { value: 2 },
    viewBackgroundColor: "#abc",
  });
  assert.deepEqual(new LocalAppStateStore("canvas-a", two).load(), {});
  assert.deepEqual(new LocalAppStateStore("canvas-b", one).load(), {});
  a.dispose();
});
test("rapid viewport changes coalesce locally and identical states do not rewrite storage", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const owner = tab();
  const store = new LocalAppStateStore("a", owner);
  t.after(() => store.dispose());
  store.save({ scrollY: 1 });
  t.mock.timers.tick(200);
  store.save({ scrollY: 2 });
  t.mock.timers.tick(299);
  assert.equal(owner.writes, 0);
  t.mock.timers.tick(1);
  assert.equal(owner.writes, 1);
  store.save({ scrollY: 2 });
  t.mock.timers.tick(500);
  assert.equal(owner.writes, 1);
});
test("dispose flushes the last local view immediately", () => {
  const owner = tab();
  const store = new LocalAppStateStore("a", owner);
  store.save({ scrollX: -42 });
  store.dispose();
  assert.deepEqual(new LocalAppStateStore("a", owner).load(), { scrollX: -42 });
});
test("broken or unavailable session storage falls back to editor defaults", () => {
  const owner = tab();
  owner.values.set("drawsrv:appState:a", "null");
  assert.deepEqual(new LocalAppStateStore("a", owner).load(), {});
  owner.values.set("drawsrv:appState:a", "not JSON");
  assert.deepEqual(new LocalAppStateStore("a", owner).load(), {});
  Object.defineProperty(owner, "sessionStorage", {
    get() {
      throw Error("storage blocked");
    },
  });
  assert.deepEqual(new LocalAppStateStore("a", owner).load(), {});
});
