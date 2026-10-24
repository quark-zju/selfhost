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
      return {
        etag: `v${calls.length}`,
        revision: `v${calls.length}`,
        persisted: true,
      };
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
      return { etag: "v1", revision: "v1", persisted: true };
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
      return {
        etag: `v${calls.length}`,
        revision: `v${calls.length}`,
        persisted: true,
      };
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

test("a render triggered by an idle flush does not schedule another save", async () => {
  let save;
  save = new Autosave(
    "initial",
    "v0",
    async () => {
      throw Error("must not send");
    },
    (state) => {
      if (state.phase === "saved") {
        queueMicrotask(() => save.queue("initial"));
      }
    },
  );
  assert.equal(await save.flush(), true);
  assert.equal(save.dirty, false);
  save.dispose();
});

test("uploads coalesced changes every two seconds during continuous editing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const save = new Autosave(
    "initial",
    "v0",
    async (body) => {
      calls.push(body);
      return { etag: "v1", revision: "v1", persisted: true };
    },
    () => {},
  );
  t.after(() => save.dispose());
  save.queue("one");
  t.mock.timers.tick(1000);
  assert.deepEqual(calls, []);
  save.queue("two");
  t.mock.timers.tick(999);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, ["two"]);
});

test("unchanged notifications do not restart the idle countdown", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const save = new Autosave(
    "initial",
    "v0",
    async (body) => {
      calls.push(body);
      return { etag: "v1", revision: "v1", persisted: true };
    },
    () => {},
  );
  t.after(() => save.dispose());
  save.queue("edit");
  t.mock.timers.tick(1000);
  save.queue("edit");
  t.mock.timers.tick(1000);
  assert.deepEqual(calls, ["edit"]);
});

test("edits during an automatic save get their own two-second upload window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
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
      return {
        etag: `v${calls.length}`,
        revision: `v${calls.length}`,
        persisted: true,
      };
    },
    () => {},
  );
  t.after(() => save.dispose());
  save.queue("one");
  t.mock.timers.tick(2000);
  assert.deepEqual(calls, ["one"]);
  save.queue("two");
  first.resolve();
  // Drain the promise callbacks without forcing a manual save.
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
  assert.deepEqual(calls, ["one"]);
  assert.equal(save.dirty, true);
  t.mock.timers.tick(1999);
  assert.deepEqual(calls, ["one"]);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, ["one", "two"]);
});

test("manual flush still saves edits queued during an automatic request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
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
      return {
        etag: `v${calls.length}`,
        revision: `v${calls.length}`,
        persisted: true,
      };
    },
    () => {},
  );
  t.after(() => save.dispose());
  save.queue("one");
  t.mock.timers.tick(2000);
  save.queue("two");
  const flushed = save.flush();
  first.resolve();
  assert.equal(await flushed, true);
  assert.deepEqual(calls, ["one", "two"]);
  assert.equal(save.dirty, false);
});

test("sync acknowledges memory while explicit flush waits for durable storage", async () => {
  const events = [];
  let state;
  const save = new Autosave(
    "initial",
    "v0",
    async (body, etag) => {
      events.push(["upload", body, etag]);
      return { etag: "v1", revision: "v1", persisted: false };
    },
    (value) => {
      state = value;
    },
    2000,
    {
      persisted: true,
      publish: async (etag) => {
        events.push(["persist", etag]);
        return { etag, revision: etag, persisted: true };
      },
    },
  );
  save.queue("edit");
  assert.equal(await save.sync(), true);
  assert.equal(save.dirty, false);
  assert.equal(save.needsPersistence, true);
  assert.equal(state.phase, "synced");
  assert.deepEqual(events, [["upload", "edit", "v0"]]);
  assert.equal(await save.flush(), true);
  assert.equal(save.needsPersistence, false);
  assert.equal(state.phase, "saved");
  assert.deepEqual(events[1], ["persist", "v1"]);
  save.dispose();
});

test("failed disk flush retries persistence without uploading acknowledged data again", async () => {
  let uploads = 0;
  let publishes = 0;
  const save = new Autosave(
    "initial",
    "v0",
    async () => {
      uploads++;
      return { etag: "v1", revision: "v1", persisted: false };
    },
    () => {},
    2000,
    {
      persisted: true,
      publish: async (etag) => {
        publishes++;
        if (publishes === 1) {
          throw Error("disk full");
        }
        return { etag, revision: etag, persisted: true };
      },
    },
  );
  save.queue("edit");
  assert.equal(await save.flush(), false);
  assert.equal(save.dirty, false);
  assert.equal(save.needsPersistence, true);
  assert.equal(await save.flush(), true);
  assert.equal(uploads, 1);
  assert.equal(publishes, 2);
  save.dispose();
});

test("status events only mark the matching acknowledged version durable", async () => {
  let state;
  const save = new Autosave(
    "initial",
    "v0",
    async () => ({ etag: "v1", revision: "v1", persisted: false }),
    (value) => {
      state = value;
    },
  );
  save.queue("edit");
  assert.equal(await save.sync(), true);
  save.observePersistence("old-version", true);
  assert.equal(state.phase, "synced");
  save.observePersistence("v1", true);
  assert.equal(state.phase, "saved");
  assert.equal(save.needsPersistence, false);
  save.dispose();
});

test("manual disk flush serializes edits arriving while a commit is in flight", async () => {
  const disk = deferred();
  const events = [];
  let counter = 0;
  const save = new Autosave(
    "initial",
    "v0",
    async (body, etag) => {
      events.push(["upload", body, etag]);
      counter++;
      return { etag: `v${counter}`, revision: `v${counter}`, persisted: false };
    },
    () => {},
    2000,
    {
      persisted: true,
      publish: async (etag) => {
        events.push(["persist", etag]);
        if (etag === "v1") {
          await disk.promise;
        }
        return { etag, revision: etag, persisted: true };
      },
    },
  );
  save.queue("one");
  const flushed = save.flush();
  await new Promise(setImmediate);
  save.queue("two");
  disk.resolve();
  assert.equal(await flushed, true);
  assert.deepEqual(events, [
    ["upload", "one", "v0"],
    ["persist", "v1"],
    ["upload", "two", "v1"],
    ["persist", "v2"],
  ]);
  assert.equal(save.dirty, false);
  assert.equal(save.needsPersistence, false);
  save.dispose();
});

test("a stale timer after a manual save cannot disable future uploads", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
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
      return {
        etag: `v${calls.length}`,
        revision: `v${calls.length}`,
        persisted: true,
      };
    },
    () => {},
  );
  t.after(() => save.dispose());
  save.queue("one");
  const flushed = save.flush();
  save.queue("two");
  first.resolve();
  await flushed;
  t.mock.timers.tick(2000);
  await new Promise(setImmediate);
  save.queue("three");
  t.mock.timers.tick(2000);
  assert.deepEqual(calls, ["one", "two", "three"]);
});

test("manual flush includes edits queued by its completion notification", async () => {
  const calls = [];
  let queued = false;
  let save;
  save = new Autosave(
    "initial",
    "v0",
    async (body) => {
      calls.push(body);
      return {
        etag: `v${calls.length}`,
        revision: `v${calls.length}`,
        persisted: true,
      };
    },
    (state) => {
      if (state.phase === "saved" && !queued) {
        queued = true;
        queueMicrotask(() => save.queue("completion edit"));
      }
    },
  );
  save.queue("one");
  assert.equal(await save.flush(), true);
  assert.deepEqual(calls, ["one", "completion edit"]);
  assert.equal(save.dirty, false);
  save.dispose();
});

test("a durability event arriving before the upload ACK is not lost", async () => {
  const ack = deferred();
  let state;
  const save = new Autosave(
    "initial",
    "v0",
    async () => ack.promise,
    (value) => {
      state = value;
    },
  );
  save.queue("edit");
  const synced = save.sync();
  save.observePersistence("v1", true, "revision-1");
  ack.resolve({ etag: "v1", revision: "revision-1", persisted: false });
  assert.equal(await synced, true);
  assert.equal(save.needsPersistence, false);
  assert.equal(state.phase, "saved");
  save.dispose();
});

test("an old event for the same payload cannot confirm a new revision", async () => {
  const save = new Autosave(
    "body B",
    "etag-B",
    async () => ({ etag: "etag-A", revision: "new-A", persisted: false }),
    () => {},
  );
  save.observePersistence("etag-A", true, "old-A");
  save.queue("body A");
  assert.equal(await save.sync(), true);
  assert.equal(save.needsPersistence, true);
  save.observePersistence("etag-A", true, "new-A");
  assert.equal(save.needsPersistence, false);
  save.dispose();
});

test("a one-shot event during completion updates durability after the request settles", async () => {
  let save;
  let state;
  save = new Autosave(
    "initial",
    "v0",
    async () => ({ etag: "v1", revision: "revision-1", persisted: false }),
    (value) => {
      state = value;
      if (value.phase === "synced") {
        save.observePersistence("v1", true, "revision-1");
      }
    },
  );
  save.queue("edit");
  await save.sync();
  assert.equal(save.needsPersistence, false);
  assert.equal(state.phase, "saved");
  save.dispose();
});
