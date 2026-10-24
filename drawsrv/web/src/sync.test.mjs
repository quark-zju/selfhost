import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { Autosave } from "./autosave.ts";
import { serializeCanvas, effectiveHash } from "./content.ts";

const body = (name = "base") =>
  serializeCanvas({ name, elements: [], files: {}, libraryItems: [] });
const hash = (value) => effectiveHash(value, webcrypto);
const state = async (value, sequence = 2, extras = {}) => ({
  etag: `etag-${sequence}`,
  revision: `epoch-${sequence}`,
  persisted: false,
  hash: await hash(value),
  ...extras,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function setup(t, send, options = {}) {
  const refreshes = [],
    logs = [];
  const save = new Autosave(body(), "etag-1", send, () => {}, 200, {
    hash: await hash(body()),
    revision: "epoch-1",
    persisted: true,
    hashBody: hash,
    loadSnapshot: async () => {
      const value = body("remote");
      return {
        ...(await state(value, 50)),
        body: value,
        apply: () => {
          refreshes.push(true);
        },
      };
    },
    log: (decision, details) => logs.push({ decision, details }),
    publish: async () => state(body(), 100, { persisted: true }),
    ...options,
  });
  t.after(() => save.dispose());
  return { save, refreshes, logs };
}
test("SSE with compatible effective content updates metadata without refreshing", async (t) => {
  const { save, refreshes } = await setup(t, () =>
    assert.fail("unexpected upload"),
  );
  await save.observeRemote(await state(body(), 2, { persisted: true }));
  assert.equal(save.version, "etag-2");
  assert.equal(refreshes.length, 0);
});
test("SSE with different content refreshes a clean client", async (t) => {
  const { save, refreshes } = await setup(t, () =>
    assert.fail("unexpected upload"),
  );
  await save.observeRemote(await state(body("remote")));
  assert.equal(refreshes.length, 1);
});
test("dirty SSE first applies local changes, then compares acknowledged content", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sends = [];
  const { save, refreshes } = await setup(t, async (value, etag, baseline) => {
    sends.push({ value, baseline });
    return state(value, 3, { applied: [0], dropped: [] });
  });
  save.queue(body("local"));
  await save.observeRemote(await state(body("remote"), 2));
  assert.equal(sends.length, 0);
  assert.equal(refreshes.length, 0);
  t.mock.timers.tick(200);
  await save.sync();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].baseline, body());
  assert.equal(save.dirty, false);
  assert.equal(refreshes.length, 0);
  // An older event cannot make this acknowledged state look stale.
  await save.observeRemote(await state(body("old remote"), 2));
  assert.equal(refreshes.length, 0);
});
test("a partial apply preserves local content and blocks uploads and automatic refresh", async (t) => {
  let uploads = 0;
  const { save, refreshes, logs } = await setup(t, async () => {
    uploads++;
    return state(body("server"), 3, {
      applied: [0],
      dropped: [{ index: 1, reason: "field precondition changed" }],
    });
  });
  save.queue(body("local"));
  assert.equal(await save.sync(), false);
  assert.equal(save.dirty, true);
  await save.observeRemote(await state(body("other"), 4));
  save.queue(body("more local"));
  assert.equal(await save.sync(), false);
  assert.equal(uploads, 1);
  assert.equal(refreshes.length, 0);
  assert.ok(
    logs.some(
      ({ decision, details }) =>
        decision === "保存结果" && details.dropped === 1,
    ),
  );
});
test("edits during an ACK are sent against the acknowledged baseline before a refresh", async (t) => {
  const first = deferred(),
    started = deferred();
  const sends = [];
  const { save, refreshes } = await setup(t, async (value, etag, baseline) => {
    sends.push({ value, baseline });
    if (sends.length === 1) {
      started.resolve();
      return first.promise;
    }
    return state(body("merged remote"), 4, { applied: [0], dropped: [] });
  });
  save.queue(body("first"));
  const running = save.sync();
  await started.promise;
  save.queue(body("second"));
  first.resolve(
    await state(body("merged remote"), 3, { applied: [0], dropped: [] }),
  );
  await running;
  assert.equal(sends.length, 2);
  assert.equal(sends[1].baseline, body("first"));
  assert.equal(sends[1].value, body("second"));
  assert.equal(refreshes.length, 1);
  assert.equal(save.dirty, false);
});
test("new edits during asynchronous hash comparison prevent an automatic refresh", async (t) => {
  const comparing = deferred(),
    release = deferred();
  let comparisons = 0;
  const { save, refreshes } = await setup(
    t,
    async (value) => state(value, 3, { applied: [0], dropped: [] }),
    {
      hashBody: async (value) => {
        comparisons++;
        if (comparisons === 1) {
          comparing.resolve();
          await release.promise;
        }
        return hash(value);
      },
    },
  );
  const event = save.observeRemote(await state(body("remote")));
  await comparing.promise;
  save.queue(body("new local"));
  release.resolve();
  await event;
  assert.equal(refreshes.length, 0);
  await save.sync();
  assert.equal(save.dirty, false);
});

test("hash calculation failure does not loop, upload or automatically refresh", async (t) => {
  let attempts = 0;
  const { save, refreshes } = await setup(
    t,
    () => assert.fail("unexpected upload"),
    {
      hashBody: async () => {
        attempts++;
        throw Error("hash unavailable");
      },
    },
  );
  await save.observeRemote(await state(body("remote")));
  assert.equal(attempts, 1);
  assert.equal(refreshes.length, 0);
});

test("snapshot fetch does not overwrite edits that arrive while it is in flight", async (t) => {
  const fetchStarted = deferred(),
    fetchDone = deferred();
  let applied = 0;
  const { save } = await setup(
    t,
    async (value) => state(value, 4, { applied: [0], dropped: [] }),
    {
      loadSnapshot: async () => {
        fetchStarted.resolve();
        return fetchDone.promise;
      },
    },
  );
  const pending = save.observeRemote(await state(body("remote"), 2));
  await fetchStarted.promise;
  save.queue(body("new local"));
  fetchDone.resolve({
    ...(await state(body("remote"), 3)),
    body: body("remote"),
    apply: () => {
      applied++;
    },
  });
  await pending;
  assert.equal(applied, 0);
  assert.equal(save.dirty, true);
  await save.sync();
  assert.equal(save.dirty, false);
});
test("adopted snapshot becomes the next conditional-save baseline", async (t) => {
  const baselines = [];
  const { save, refreshes } = await setup(t, async (value, etag, baseline) => {
    baselines.push(baseline);
    return state(value, 51, { applied: [0], dropped: [] });
  });
  await save.observeRemote(await state(body("remote"), 2));
  save.queue(body("local after remote"));
  await save.sync();
  assert.deepEqual(baselines, [body("remote")]);
  assert.equal(refreshes.length, 1);
});
test("a snapshot older than a newer SSE is discarded and fetched again", async (t) => {
  const fetchStarted = deferred(),
    fetchDone = deferred();
  let loads = 0;
  const adopted = [];
  const { save } = await setup(t, () => assert.fail("unexpected upload"), {
    loadSnapshot: async () => {
      loads++;
      if (loads === 1) {
        fetchStarted.resolve();
        return fetchDone.promise;
      }
      return {
        ...(await state(body("newest"), 4)),
        body: body("newest"),
        apply: () => {
          adopted.push("newest");
        },
      };
    },
  });
  const pending = save.observeRemote(await state(body("remote"), 2));
  await fetchStarted.promise;
  await save.observeRemote(await state(body("newest"), 4));
  fetchDone.resolve({
    ...(await state(body("remote"), 3)),
    body: body("remote"),
    apply: () => {
      adopted.push("stale");
    },
  });
  await pending;
  assert.equal(loads, 2);
  assert.deepEqual(adopted, ["newest"]);
});
test("active editing defers loading and resumes without polling", async (t) => {
  let busy = true;
  const { save, refreshes } = await setup(
    t,
    () => assert.fail("unexpected upload"),
    { canRefresh: () => !busy },
  );
  await save.observeRemote(await state(body("remote"), 2));
  assert.equal(refreshes.length, 0);
  busy = false;
  await save.resumeRemote();
  assert.equal(refreshes.length, 1);
});
test("disposing during snapshot fetch prevents an adoption", async (t) => {
  const started = deferred(),
    done = deferred();
  let applied = 0;
  const { save } = await setup(t, () => assert.fail("unexpected upload"), {
    loadSnapshot: async () => {
      started.resolve();
      return done.promise;
    },
  });
  const pending = save.observeRemote(await state(body("remote"), 2));
  await started.promise;
  save.dispose();
  done.resolve({
    ...(await state(body("remote"), 2)),
    body: body("remote"),
    apply: () => {
      applied++;
    },
  });
  await pending;
  assert.equal(applied, 0);
});

test("a gesture starting during snapshot fetch defers the adoption", async (t) => {
  const started = deferred(),
    done = deferred();
  let busy = false,
    applied = 0;
  const { save } = await setup(t, () => assert.fail("unexpected upload"), {
    canRefresh: () => !busy,
    loadSnapshot: async () => {
      started.resolve();
      return done.promise;
    },
  });
  const pending = save.observeRemote(await state(body("remote"), 2));
  await started.promise;
  busy = true;
  done.resolve({
    ...(await state(body("remote"), 2)),
    body: body("remote"),
    apply: () => {
      applied++;
    },
  });
  await pending;
  assert.equal(applied, 0);
  busy = false;
  await save.resumeRemote();
  assert.equal(applied, 1);
});
test("invalid snapshot hashes block adoption and keep subsequent local edits dirty", async (t) => {
  let applied = 0;
  const { save } = await setup(t, () => assert.fail("unexpected upload"), {
    loadSnapshot: async () => ({
      ...(await state(body("other"), 2)),
      body: body("remote"),
      apply: () => {
        applied++;
      },
    }),
  });
  await save.observeRemote(await state(body("remote"), 2));
  assert.equal(applied, 0);
  save.queue(body("local after failure"));
  assert.equal(save.dirty, true);
  assert.equal(await save.sync(), false);
});

test("edits arriving during an automatic hash comparison keep their throttle window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const comparing = deferred(),
    release = deferred(),
    calls = [];
  let comparisons = 0;
  const { save, refreshes } = await setup(
    t,
    async (value) => {
      calls.push(value);
      return state(value, 3, { applied: [0], dropped: [] });
    },
    {
      hashBody: async (value) => {
        if (++comparisons === 1) {
          comparing.resolve();
          await release.promise;
        }
        return hash(value);
      },
    },
  );
  const event = save.observeRemote(await state(body("remote"), 2));
  await comparing.promise;
  save.queue(body("local"));
  release.resolve();
  await event;
  assert.equal(calls.length, 0);
  assert.equal(refreshes.length, 0);
  t.mock.timers.tick(199);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1);
  await save.sync();
  assert.deepEqual(calls, [body("local")]);
});
