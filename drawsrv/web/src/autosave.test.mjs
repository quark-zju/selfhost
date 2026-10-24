import { test } from "node:test";
import assert from "node:assert/strict";
import { Autosave, SaveError } from "./autosave.ts";

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test("serializes in-flight edits and uses the returned version", async () => {
  const first = deferred();
  const calls = [];
  const save = new Autosave(
    "initial",
    "v0",
    async (body, etag) => {
      calls.push([body, etag]);
      if (calls.length === 1) {
        await first.promise;
      }
      return { etag: `v${calls.length}` };
    },
    () => {},
  );
  save.queue("one");
  const pending = save.flush();
  save.queue("two");
  save.queue("three");
  first.resolve();
  assert.equal(await pending, true);
  assert.deepEqual(calls, [
    ["one", "v0"],
    ["three", "v1"],
  ]);
  assert.equal(save.dirty, false);
  save.dispose();
});
test("retains latest local changes on failure, supports explicit retry", async () => {
  let failed = false;
  const save = new Autosave(
    "initial",
    "v0",
    async () => {
      if (!failed) {
        failed = true;
        throw new Error("offline");
      }
      return { etag: "v1" };
    },
    () => {},
  );
  save.queue("edit");
  assert.equal(await save.flush(), false);
  assert.equal(save.dirty, true);
  assert.equal(await save.flush(), true);
  assert.equal(save.dirty, false);
  save.dispose();
});
test("a conflict stops all future uploads and leaves unsaved work dirty", async () => {
  let calls = 0;
  let state;
  const save = new Autosave(
    "initial",
    "v0",
    async () => {
      calls++;
      throw new SaveError("conflict", true);
    },
    (value) => {
      state = value;
    },
  );
  save.queue("edit");
  assert.equal(await save.flush(), false);
  save.queue("newer edit");
  assert.equal(await save.flush(), false);
  assert.equal(calls, 1);
  assert.equal(save.dirty, true);
  assert.equal(state.phase, "conflict");
  save.dispose();
});
test("reverting to the initial content during an in-flight write still persists", async () => {
  const first = deferred();
  const calls = [];
  const save = new Autosave(
    "initial",
    "v0",
    async (body) => {
      calls.push(body);
      if (calls.length === 1) {
        await first.promise;
      }
      return { etag: `v${calls.length}` };
    },
    () => {},
  );
  save.queue("edit");
  const pending = save.flush();
  save.queue("initial");
  first.resolve();
  assert.equal(await pending, true);
  assert.deepEqual(calls, ["edit", "initial"]);
  save.dispose();
});
test("unchanged content does not generate a request", async () => {
  const save = new Autosave(
    "initial",
    "v0",
    async () => {
      throw Error("must not send");
    },
    () => {},
  );
  save.queue("initial");
  assert.equal(await save.flush(), true);
  assert.equal(save.dirty, false);
  save.dispose();
});
