import assert from "node:assert/strict";
import test from "node:test";
import { POPOVER_ATTRIBUTE, popoverToDismiss } from "../src/lib/popovers.ts";

test("an outside click dismisses the open popover", () => {
  const out = popoverToDismiss([{ id: "model-control", containsTarget: false }]);
  assert.equal(out?.id, "model-control");
});

test("a click inside the popover does not dismiss it", () => {
  // The option's own handler closes the element; treating the click as
  // "outside" would close it twice and, worse, a stray capture-phase listener
  // could close it before the option's onClick ever ran.
  const out = popoverToDismiss([{ id: "model-control", containsTarget: true }]);
  assert.equal(out, null);
});

test("nothing open means nothing to dismiss", () => {
  assert.equal(popoverToDismiss([]), null);
});

test("a click inside one popover leaves another popover alone", () => {
  // Popovers are mutually exclusive in practice, but the rule must not depend on
  // that: an interaction inside any of them is not an outside interaction.
  const out = popoverToDismiss([
    { id: "model-control", containsTarget: true },
    { id: "reasoning-effort-control", containsTarget: false },
  ]);
  assert.equal(out, null);
});

test("the marker is a data attribute, not a class", () => {
  // Classes in this app describe appearance and get restyled freely; the marker
  // has to survive that, and it must not match a content disclosure by accident.
  assert.equal(POPOVER_ATTRIBUTE, "data-popover");
  assert.equal(POPOVER_ATTRIBUTE.startsWith("data-"), true);
});
