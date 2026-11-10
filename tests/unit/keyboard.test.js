import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KEYBOARD_MARKUP,
  keyboardHasFoot,
  keyboardHeight,
  keyboardPlatform,
} from "../../src/panel/keyboard.js";

test("there is markup for every platform and layout", () => {
  for (const platform of ["ios", "android"]) {
    for (const layout of ["text", "numeric"]) {
      assert.ok(KEYBOARD_MARKUP[`${platform}-${layout}`].includes("key"), `${platform}-${layout}`);
    }
  }
});

test("tablets and home-button phones use the iOS style", () => {
  assert.equal(keyboardPlatform("android"), "android");
  for (const kind of ["ios", "ios-home", "tablet"]) assert.equal(keyboardPlatform(kind), "ios");
});

test("the keyboard never covers more than 60% of the screen", () => {
  assert.equal(keyboardHeight("ios", "text", false, 852), 336);
  assert.equal(keyboardHeight("ios", "text", true, 300), 180);
  assert.equal(keyboardHeight("unknown", "text", false, 852), 336);
});

test("only phones without a home button have an area under the keys", () => {
  assert.ok(keyboardHasFoot("ios", false));
  assert.ok(!keyboardHasFoot("ios", true));
  assert.ok(!keyboardHasFoot("ios-home", false));
});
