import assert from "node:assert/strict";
import test from "node:test";
import { selectLabeledOption } from "../ui.ts";

test("labeled selection passes strings to Pi and returns the matching value", async () => {
  const value = { alias: "work" };
  let received: { title: string; options: string[] } | undefined;
  const selected = await selectLabeledOption(
    {
      ui: {
        async select(title, options) {
          received = { title, options };
          return "Work server";
        },
      },
    },
    "SSH host",
    [
      { label: "Home server", value: { alias: "home" } },
      { label: "Work server", value },
    ],
  );

  assert.deepEqual(received, {
    title: "SSH host",
    options: ["Home server", "Work server"],
  });
  assert.equal(selected, value);
});

test("labeled selection handles cancellation, unknown responses, and empty options", async (t) => {
  const items = [{ label: "Work server", value: "work" }];

  await t.test("cancellation", async () => {
    const selected = await selectLabeledOption(
      { ui: { select: async () => undefined } },
      "SSH host",
      items,
    );
    assert.equal(selected, undefined);
  });

  await t.test("unknown response", async () => {
    const selected = await selectLabeledOption(
      { ui: { select: async () => "Unknown server" } },
      "SSH host",
      items,
    );
    assert.equal(selected, undefined);
  });

  await t.test("empty options", async () => {
    let called = false;
    const selected = await selectLabeledOption(
      { ui: { select: async () => { called = true; return undefined; } } },
      "SSH host",
      [],
    );
    assert.equal(selected, undefined);
    assert.equal(called, false);
  });
});

test("labeled selection disambiguates duplicate labels", async () => {
  let received: string[] = [];
  const selected = await selectLabeledOption(
    {
      ui: {
        async select(_title, options) {
          received = options;
          return "Server (2)";
        },
      },
    },
    "SSH host",
    [
      { label: "Server", value: "first" },
      { label: "Server", value: "second" },
    ],
  );

  assert.deepEqual(received, ["Server", "Server (2)"]);
  assert.equal(selected, "second");
});
