import { test } from "node:test";
import assert from "node:assert/strict";
import { HoldAction, HOLD_DURATION_MS } from "./holdAction.ts";

function fixture() {
  let time = 0,
    next = 0,
    fired = 0;
  const timers = new Map();
  const states = [];
  const clock = {
    setTimeout(fn, delay) {
      const id = ++next;
      timers.set(id, { fn, due: time + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const hold = new HoldAction(
    () => fired++,
    (active) => states.push(active),
    clock,
  );
  return {
    hold,
    states,
    get fired() {
      return fired;
    },
    advance(ms) {
      time += ms;
      for (const [id, timer] of timers)
        if (timer.due <= time) {
          timers.delete(id);
          timer.fn();
        }
    },
  };
}

test("a continuous one-second hold fires once, despite repeated starts", () => {
  const f = fixture();
  f.hold.start();
  f.advance(HOLD_DURATION_MS - 1);
  f.hold.start();
  assert.equal(f.fired, 0);
  f.advance(1);
  f.advance(HOLD_DURATION_MS);
  assert.equal(f.fired, 1);
  assert.deepEqual(f.states, [true, false]);
});

test("cancelled holds cannot delete later and a new hold starts from zero", () => {
  const f = fixture();
  f.hold.start();
  f.advance(HOLD_DURATION_MS - 1);
  f.hold.cancel();
  f.hold.cancel();
  f.advance(HOLD_DURATION_MS);
  assert.equal(f.fired, 0);
  f.hold.start();
  f.advance(HOLD_DURATION_MS - 1);
  assert.equal(f.fired, 0);
  f.advance(1);
  assert.equal(f.fired, 1);
  assert.deepEqual(f.states, [true, false, true, false]);
});
