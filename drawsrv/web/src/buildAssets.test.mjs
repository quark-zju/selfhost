import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripFirebaseConfig,
  assertNoFirebaseConfig,
} from "../build/excalidrawMetadata.ts";

const config = JSON.stringify({
  apiKey: "test-only-key",
  authDomain: "example.firebaseapp.com",
  databaseURL: "https://example.firebaseio.com",
  projectId: "test-project",
  storageBucket: "test-project.appspot.com",
  messagingSenderId: "123",
  appId: "test-app",
});

test("removes the complete upstream Firebase property without changing neighboring settings", () => {
  for (const key of [
    "VITE_APP_FIREBASE_CONFIG",
    '"VITE_APP_FIREBASE_CONFIG"',
    "'VITE_APP_FIREBASE_CONFIG'",
  ]) {
    const property = `${key}:${JSON.stringify(config)}`;
    for (const properties of [
      property,
      `${property},before:1`,
      `before:1,${property}`,
      `before:1,${property},after:2`,
    ]) {
      const stripped = stripFirebaseConfig(`({${properties}})`);
      const result = Function(`return ${stripped}`)();
      assert.equal("VITE_APP_FIREBASE_CONFIG" in result, false);
      if (properties.includes("before")) assert.equal(result.before, 1);
      if (properties.includes("after")) assert.equal(result.after, 2);
      for (const [name, value] of Object.entries(JSON.parse(config))) {
        assert.equal(stripped.includes(name), false);
        assert.equal(stripped.includes(value), false);
      }
      assertNoFirebaseConfig(stripped, "test.js");
    }
  }
  assert.equal(
    stripFirebaseConfig("const ordinary = 42;"),
    "const ordinary = 42;",
  );
});

test("handles single-quoted configuration and fails closed on changed upstream syntax", () => {
  assert.equal(
    stripFirebaseConfig(
      'const env = {VITE_APP_FIREBASE_CONFIG:\'{"apiKey":"test"}\',other:true};',
    ),
    "const env = {other:true};",
  );
  assert.throws(
    () =>
      stripFirebaseConfig(
        "const env = {VITE_APP_FIREBASE_CONFIG:loadConfig()};",
      ),
    /Unsupported/,
  );
});

test("rejects Firebase remnants in generated code without exposing their values", () => {
  for (const code of [
    config,
    "VITE_APP_FIREBASE_CONFIG",
    "https://example.firebaseapp.com",
    "https://example.firebaseio.com",
  ]) {
    assert.throws(
      () => assertNoFirebaseConfig(code, "asset.js"),
      (error) => {
        assert.equal(
          error.message,
          "Unexpected upstream Firebase configuration in asset.js",
        );
        return true;
      },
    );
  }
  assertNoFirebaseConfig("const ownStorage = '/api/canvases';", "clean.js");
});
