// Run with: npx -y tsx --test agent/extensions/tests/native-notify.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXTENSION_PATH = resolve("agent/extensions/native-notify.ts");

async function loadExtension() {
  const moduleUrl = `${pathToFileURL(EXTENSION_PATH).href}?t=${Date.now()}-${Math.random()}`;
  return import(moduleUrl) as Promise<typeof import("../native-notify.ts")>;
}

function createPiHarness() {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const harness = {
    sentUserMessages: [] as Array<{ content: string; options?: { deliverAs?: "steer" | "followUp" } }>,
    pi: {
      on(eventName: string, handler: (...args: any[]) => unknown) {
        const eventHandlers = handlers.get(eventName) ?? [];
        eventHandlers.push(handler);
        handlers.set(eventName, eventHandlers);
      },
      sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }) {
        harness.sentUserMessages.push({ content, options });
      },
    },
    async emit(eventName: string, ...args: any[]) {
      for (const handler of handlers.get(eventName) ?? []) {
        await handler(...args);
      }
    },
    handlerCount(eventName: string) {
      return handlers.get(eventName)?.length ?? 0;
    },
  };
  return harness;
}

test("detectNotificationTarget detects Termux from Termux-specific environment", async () => {
  const { detectNotificationTarget } = await loadExtension();

  assert.equal(detectNotificationTarget({ PREFIX: "/data/data/com.termux/files/usr" }, "linux"), "termux");
  assert.equal(detectNotificationTarget({ TERMUX_VERSION: "0.118.3" }, "linux"), "termux");
  assert.equal(
    detectNotificationTarget({ ANDROID_ROOT: "/system", ANDROID_DATA: "/data", PREFIX: "/data/data/com.termux/files/usr" }, "linux"),
    "termux",
  );
});

test("detectNotificationTarget detects macOS when not running under Termux", async () => {
  const { detectNotificationTarget } = await loadExtension();

  assert.equal(detectNotificationTarget({}, "darwin"), "macos");
});

test("detectNotificationTarget prefers Termux over macOS if both signals are present", async () => {
  const { detectNotificationTarget } = await loadExtension();

  assert.equal(detectNotificationTarget({ PREFIX: "/data/data/com.termux/files/usr" }, "darwin"), "termux");
});

test("getNotificationCommand builds the Android Termux notification command", async () => {
  const { getNotificationCommand } = await loadExtension();

  assert.deepEqual(getNotificationCommand("Pi", "Ready for input", "termux", ""), {
    command: "termux-notification",
    args: ["-t", "Pi", "-c", "Ready for input"],
  });
});

test("getNotificationCommand adds the Pi icon image to Android Termux notifications", async () => {
  const { getNotificationCommand } = await loadExtension();

  assert.deepEqual(getNotificationCommand("Pi", "Ready for input", "termux", "/tmp/pi-icon.png"), {
    command: "termux-notification",
    args: ["-t", "Pi", "-c", "Ready for input", "--image-path", "/tmp/pi-icon.png"],
  });
});

test("getNotificationCommand builds the macOS osascript notification command without an icon", async () => {
  const { getNotificationCommand } = await loadExtension();

  assert.deepEqual(getNotificationCommand('Pi "Agent"', "Ready\\done\nnext", "macos", ""), {
    command: "osascript",
    args: ["-e", 'display notification "Ready\\\\done next" with title "Pi \\"Agent\\"" subtitle "Pi"'],
  });
});

test("getNotificationCommand uses alerter with osascript fallback on macOS", async () => {
  const { getNotificationCommand } = await loadExtension();

  const command = getNotificationCommand("Pi", "Ready for input", "macos", "/tmp/pi-icon.png", "Pi", "Type a follow-up…");

  assert.equal(command?.command, "alerter");
  assert.deepEqual(command?.args.slice(0, 13), [
    "--title", "Pi",
    "--subtitle", "Pi",
    "--message", "Ready for input",
    "--reply", "Type a follow-up…",
    "--json",
    "--app-icon", "/tmp/pi-icon.png",
    "--group", command?.args[12],
  ]);
  assert.equal(command?.args[12], "pi-native-notify");
  assert.equal(command?.args[13], "--ignore-dnd");
  assert.deepEqual(command?.fallback, {
    command: "osascript",
    args: ["-e", 'display notification "Ready for input" with title "Pi" subtitle "Pi"'],
  });
});



test("sendNativeNotification stops after alerter succeeds", async () => {
  const { sendNativeNotification } = await loadExtension();
  const calls: Array<{ command: string; args: string[] }> = [];
  const execFile = ((command: string, args: string[], _options: unknown, callback: (error?: Error | null, stdout?: string) => void) => {
    calls.push({ command, args });
    callback(null, "");
  }) as any;

  await sendNativeNotification("Pi", "Ready for input", execFile, "macos", "/tmp/pi-icon.png");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "alerter");
  assert.equal(calls.some((call) => call.command === "osascript"), false);
});

test("sendNativeNotification falls back to osascript when alerter fails", async () => {
  const { sendNativeNotification } = await loadExtension();
  const calls: Array<{ command: string; args: string[] }> = [];
  const execFile = ((command: string, args: string[], _options: unknown, callback: (error?: Error | null) => void) => {
    calls.push({ command, args });
    callback(command === "alerter" ? new Error("missing") : null);
  }) as any;

  await sendNativeNotification("Pi", "Ready for input", execFile, "macos", "/tmp/pi-icon.png");

  assert.equal(calls[0]?.command, "alerter");
  assert.deepEqual(calls[1], {
    command: "osascript",
    args: ["-e", 'display notification "Ready for input" with title "Pi" subtitle "Pi"'],
  });
});

test("sendNativeNotification ignores unsupported platforms", async () => {
  const { sendNativeNotification } = await loadExtension();
  const calls: any[] = [];

  await sendNativeNotification("Pi", "Ready for input", ((...args: any[]) => {
    calls.push(args);
  }) as any, "unsupported");

  assert.deepEqual(calls, []);
});

test("notifyGeneratedImage uses alerter content-image for generated images", async () => {
  const { notifyGeneratedImage } = await loadExtension();
  const calls: Array<{ command: string; args: string[] }> = [];
  const execFile = ((command: string, args: string[], _options: unknown, callback: (error?: Error | null, stdout?: string) => void) => {
    calls.push({ command, args });
    callback(null, "");
  }) as any;

  await notifyGeneratedImage("/tmp/generated.png", undefined, {
    execFile,
    target: "macos",
    env: {},
    iconPath: "/tmp/pi-logo.svg",
    body: "Generated image ready",
  });

  assert.equal(calls[0]?.command, "alerter");
  assert.deepEqual(calls[0]?.args.slice(0, 11), [
    "--title", "Pi Coding Agent",
    "--subtitle", "Pi",
    "--message", "Generated image ready",
    "--content-image", "/tmp/generated.png",
    "--group", calls[0]!.args[9],
    "--ignore-dnd",
  ]);
  assert.equal(calls[0]?.args[9], "pi-native-notify");
  assert.deepEqual(calls[0]?.args.slice(11), ["--app-icon", "/tmp/pi-logo.svg"]);
});

test("notifyPiWaitingForUser forwards alerter replies as follow-up prompts", async () => {
  const { notifyPiWaitingForUser } = await loadExtension();
  const replies: string[] = [];
  const execFile = ((command: string, args: string[], _options: unknown, callback: (error?: Error | null, stdout?: string) => void) => {
    assert.equal(command, "alerter");
    assert.ok(args.includes("--reply"));
    assert.ok(args.includes("--json"));
    callback(null, JSON.stringify({ activationType: "replied", activationValue: "Continue from notification" }));
  }) as any;

  await notifyPiWaitingForUser(undefined, undefined, {
    execFile,
    target: "macos",
    env: {},
    iconPath: "",
    onReply: (reply) => replies.push(reply),
  });

  assert.deepEqual(replies, ["Continue from notification"]);
});

test("notifyPiWaitingForUser sends the standard waiting notification", async () => {
  const { notifyPiWaitingForUser } = await loadExtension();
  const calls: Array<{ command: string; args: string[] }> = [];
  const execFile = ((command: string, args: string[], _options: unknown, callback: () => void) => {
    calls.push({ command, args });
    callback();
  }) as any;

  await notifyPiWaitingForUser(undefined, undefined, { execFile, target: "macos", env: {}, iconPath: "" });

  assert.equal(calls[0]?.command, "alerter");
  assert.deepEqual(calls[0]?.args.slice(0, 11), [
    "--title", "Pi Coding Agent",
    "--subtitle", "Pi",
    "--message", "Ready for input",
    "--reply", "Type a follow-up…",
    "--json",
    "--group", calls[0]?.args[10],
  ]);
  assert.equal(calls[0]?.args[10], "pi-native-notify");
  assert.equal(calls[0]?.args[11], "--ignore-dnd");
});

test("getNotificationTitle uses the tmux session name when inside tmux", async () => {
  const { getNotificationTitle } = await loadExtension();
  const execFile = ((command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    assert.equal(command, "tmux");
    callback(null, "work-session\n");
  }) as any;

  assert.equal(await getNotificationTitle({ env: { TMUX: "/tmp/tmux-501/default,123,0" }, execFile }), "Work-session");
});

test("getNotificationTitle falls back to the session description for generic tmux session names", async () => {
  const { getNotificationTitle } = await loadExtension();
  const execFile = ((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    callback(null, "Pi\n");
  }) as any;
  const ctx = {
    sessionManager: {
      getEntries: () => [{
        type: "message",
        message: { role: "user", content: "Improve notification titles for approval prompts" },
      }],
    },
  };

  assert.equal(
    await getNotificationTitle({ ctx, env: { TMUX: "/tmp/tmux-501/default,123,0" }, execFile }),
    "Improve Notification Titles",
  );
});

test("getNotificationTitle summarizes the session outside tmux", async () => {
  const { getNotificationTitle } = await loadExtension();
  const ctx = {
    sessionManager: {
      getEntries: () => [
        {
          type: "message",
          message: { role: "user", content: "Add native notifications for macOS and Termux" },
        },
        {
          type: "message",
          message: { role: "assistant", content: "Implemented native notifications." },
        },
        {
          type: "message",
          message: { role: "user", content: "Use notification titles from a session summary" },
        },
      ],
    },
  };

  assert.equal(await getNotificationTitle({ ctx, env: {} }), "Notifications Titles Session");
});

test("getNotificationTitle uses a short session description outside tmux", async () => {
  const { getNotificationTitle } = await loadExtension();
  const ctx = {
    sessionManager: {
      getEntries: () => [{
        type: "message",
        message: { role: "user", content: "Please add native notifications for approval prompts and ready state" },
      }],
    },
  };

  assert.equal(await getNotificationTitle({ ctx, env: {} }), "Native Notifications Approval");
});

test("native-notify checks readiness at session start and sends a notification every time agent_end fires", async () => {
  const { createNativeNotifyExtension } = await loadExtension();
  const calls: Array<{ command: string; args: string[] }> = [];
  const execFile = ((command: string, args: string[], _options: unknown, callback: () => void) => {
    calls.push({ command, args });
    callback();
  }) as any;
  const harness = createPiHarness();

  createNativeNotifyExtension({ execFile, target: "termux", env: {}, iconPath: "" })(harness.pi as any);

  assert.equal(harness.handlerCount("session_start"), 1);
  assert.equal(harness.handlerCount("agent_end"), 1);
  await harness.emit("session_start", {}, { cwd: "/tmp/test-project" });
  await harness.emit("agent_end", {}, { cwd: "/tmp/test-project" });
  await harness.emit("agent_end", {}, { cwd: "/tmp/test-project" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, [
    { command: "termux-notification", args: ["-t", "Pi Coding Agent", "-c", "Ready for input"] },
    { command: "termux-notification", args: ["-t", "Pi Coding Agent", "-c", "Ready for input"] },
  ]);
});
