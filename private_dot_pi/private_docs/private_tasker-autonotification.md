# Tasker + AutoNotification setup for Pi native notifications

Use this setup for the default Termux notification path in `agent/extensions/native-notify.ts`. On Termux, Pi sends notifications through Tasker/AutoNotification first so notifications can use the Pi icons; if that command fails, Pi falls back to Termux:API's `termux-notification`.

## Prerequisites

- Tasker installed
- AutoNotification installed and enabled
- Pi notification assets present:
  - `~/.pi/agent/extensions/assets/pi-logo.png`
  - `~/.pi/agent/extensions/assets/pi-logo-status.png`

## 1. Enable external access in Tasker

In Tasker:

1. Open **Tasker**.
2. Go to **Preferences**.
3. Open the **Misc** tab.
4. Enable **Allow External Access**.

## 2. Create the Tasker profile

Create a new profile:

1. Tap **Profiles**.
2. Tap **+**.
3. Choose **Event**.
4. Choose **System**.
5. Choose **Intent Received**.
6. Set **Action** to:

```text
works.earendil.pi.NOTIFY
```

Leave the other fields empty unless you intentionally want to restrict the intent.

## 3. Copy the Pi icons to shared storage

Tasker and AutoNotification cannot read files from Termux's private app directory, such as `~/.pi/...`. Copy the icons to shared storage first:

```sh
mkdir -p "$HOME/storage/shared/Pictures/pi"
cp "$HOME/.pi/agent/extensions/assets/pi-logo.png" "$HOME/storage/shared/Pictures/pi/"
cp "$HOME/.pi/agent/extensions/assets/pi-logo-status.png" "$HOME/storage/shared/Pictures/pi/"
```

If `$HOME/storage/shared` does not exist, run `termux-setup-storage` first and grant storage access.

Shared icon paths:

```text
/storage/emulated/0/Pictures/pi/pi-logo.png
/storage/emulated/0/Pictures/pi/pi-logo-status.png
```

## 4. Create the notification task

Attach a new task to the profile, then add an AutoNotification action:

```text
Plugin → AutoNotification → AutoNotification
```

Configure the notification fields from the broadcast extras.

Use one AutoNotification action for normal notifications:

```text
Title: %title
Text: %body
Subtext / Summary: %subtitle
Icon: %icon
Status Bar Icon Manual: %status_icon
Group Key: %group
Notification ID: %notification_id
```

Do **not** set `Picture` or `Icon Expanded` on the normal action. Some AutoNotification versions switch to an expanded image layout just because those fields are configured, even if `%picture` is empty or omitted.

Use a second AutoNotification action for generated-image notifications only. Configure it the same way, plus `Picture: %pi_picture`. `%pi_picture` is a notification-sized preview image; `%generated_image_path` is the full image for tap/open actions.

```text
Title: %title
Text: %body
Subtext / Summary: %subtitle
Icon: %icon
Status Bar Icon Manual: %status_icon
Picture: %pi_picture
Group Key: %group
Notification ID: %notification_id
```

Prefer `Picture` for generated images. `Icon Expanded` may not load file paths reliably on every device/AutoNotification version.

Add a Tasker **If** condition to the generated-image AutoNotification action so it runs only when `%pi_picture` is set. Add the opposite condition to the normal action, or put the generated-image action first and stop the task after it runs.

Example task structure:

```text
If %pi_picture Is Set
  AutoNotification action with Picture: %pi_picture
Else
  AutoNotification action with no Picture/Icon Expanded field
End If
```

Recommended icon paths:

```text
Icon: /storage/emulated/0/Pictures/pi/pi-logo.png
Status Bar Icon Manual: /storage/emulated/0/Pictures/pi/pi-logo-status.png
```

Use `Icon: %icon` for the normal collapsed notification icon/image. Do not set `Picture` or `Icon Expanded` in the normal branch. Use `Picture: %pi_picture` only in the generated-image branch.

Pi omits the generated-image extras for normal ready/approval notifications and sends `pi_picture`, `picture`, and `generated_image_path` only from `notifyGeneratedImage(...)`, which is the notification path used by the image-generation skill. Prefer `%pi_picture` for AutoNotification's expanded `Picture` field because it is a smaller preview stored under a `previews/` subdirectory next to generated images, such as `/storage/emulated/0/Pictures/generated/previews`. Use `%generated_image_path` for tap/open commands so tapping opens the full generated image.

Preview images are generated only for Termux/Tasker notifications. They are cleaned up opportunistically when a new preview is created: files named `*.pi-notify-preview.png` older than 7 days in the preview directory are deleted.

If AutoNotification does not accept a file path for the status bar icon, choose a built-in AutoNotification icon there and keep the Pi logo in `Icon`.

AutoNotification cannot replace Android's app/header identity icon with an arbitrary Pi image. The configurable parts are the notification content icon (`Icon`), the status bar icon (`Status Bar Icon Manual`), and generated-image expanded content (`Icon Expanded` or `Picture`).

### AutoNotification file access permission

On recent Android versions, AutoNotification may initially create an extra notification like:

```text
Can't Access File
Tap here to give AutoNotification permission to access /...
```

This means the broadcast reached Tasker, but AutoNotification cannot read the image file yet. Tap the **Can't Access File** notification and grant AutoNotification access to the requested image or, preferably, the whole folder that contains it.

For Pi notification icons, grant access to:

```text
/storage/emulated/0/Pictures/pi
```

For generated images and generated-image notification previews, also grant access to:

```text
/storage/emulated/0/Pictures/generated
```

In the Android file picker, choose the folder, then tap **Use this folder** or **Allow** when prompted. After granting access, rerun the test broadcast.

To intentionally trigger AutoNotification's file-access prompt for generated previews, send a test notification that uses a preview file in multiple image/icon fields. Replace the filenames with existing files if needed:

```sh
preview="/storage/emulated/0/Pictures/generated/previews/example.pi-notify-preview.png"
full="/storage/emulated/0/Pictures/generated/example.png"
am broadcast --user current \
  -a works.earendil.pi.NOTIFY \
  --es title "Pi Coding Agent" \
  --es subtitle "Generated Preview Access Prompt Test" \
  --es body "Grant access if AutoNotification asks" \
  --es content "Generated Preview Access Prompt Test Grant access if AutoNotification asks" \
  --es group "pi-native-notify" \
  --es notification_id "pi-native-notify-generated-preview-access-prompt-test" \
  --es icon "$preview" \
  --es status_icon "/storage/emulated/0/Pictures/pi/pi-logo-status.png" \
  --es large_icon "$preview" \
  --es image_path "$preview" \
  --es picture "$preview" \
  --es pi_picture "$preview" \
  --es generated_image_path "$full"
```

If AutoNotification shows **Can't Access File**, tap it and grant access to:

```text
/storage/emulated/0/Pictures/generated/previews
```

If the prompt keeps appearing:

1. Confirm the files exist in shared storage:

   ```sh
   ls -l /storage/emulated/0/Pictures/pi/pi-logo.png /storage/emulated/0/Pictures/pi/pi-logo-status.png
   ```

2. Check Android app permissions for **AutoNotification** and allow photos/media access if Android offers that permission.
3. Check Android app permissions for **Tasker** and allow photos/media access if Android offers that permission.
4. Reopen AutoNotification once, then rerun the test broadcast.
5. If the small/status icon path still fails, remove `%status_icon` from the AutoNotification small-icon field and use a built-in AutoNotification icon there. Keep `%large_icon` or `%image_path` for the Pi logo.

## 5. Test the Tasker bridge from Termux

Run this in Termux:

```sh
am broadcast --user current \
  -a works.earendil.pi.NOTIFY \
  --es title "Pi Coding Agent" \
  --es subtitle "Tasker Test" \
  --es body "Ready for input" \
  --es content "Tasker Test
Ready for input" \
  --es group "pi-native-notify" \
  --es notification_id "pi-native-notify" \
  --es icon "/storage/emulated/0/Pictures/pi/pi-logo.png" \
  --es large_icon "/storage/emulated/0/Pictures/pi/pi-logo.png" \
  --es status_icon "/storage/emulated/0/Pictures/pi/pi-logo-status.png" \
  --es image_path "/storage/emulated/0/Pictures/pi/pi-logo.png"
```

You should see a notification created by Tasker/AutoNotification.

## 6. Start Pi

Tasker/AutoNotification is the default Termux notification backend. If the icons exist in shared storage, `agent/extensions/native-notify.ts` automatically discovers them from:

```text
$HOME/storage/shared/Pictures/pi/pi-logo.png
$HOME/storage/shared/Pictures/pi/pi-logo-status.png
```

So the usual launch command is just:

```sh
pi
```

You can still override the discovered paths when needed:

```sh
PI_NATIVE_NOTIFY_ICON_PATH=/storage/emulated/0/Pictures/pi/pi-logo.png \
PI_NATIVE_NOTIFY_STATUS_ICON_PATH=/storage/emulated/0/Pictures/pi/pi-logo-status.png \
pi
```

If the Tasker broadcast command itself fails, `agent/extensions/native-notify.ts` falls back to `termux-notification`.

## Optional chezmoi setup script

For new Termux environments, keep the source icons tracked under `~/.pi` and copy them to Android shared storage after `termux-setup-storage` has been run. Do not manage `/storage/emulated/0/...` directly as chezmoi files.

A portable chezmoi run script can skip non-Termux systems:

```sh
#!/bin/sh
set -eu

case "${PREFIX:-}" in
  */com.termux/files/usr) ;;
  *) exit 0 ;;
esac

shared="$HOME/storage/shared"
if [ ! -d "$shared" ]; then
  echo "Skipping Pi notification icons: run termux-setup-storage first"
  exit 0
fi

src="$HOME/.pi/agent/extensions/assets"
dest="$shared/Pictures/pi"
mkdir -p "$dest"

cp -f "$src/pi-logo.png" "$dest/pi-logo.png"
cp -f "$src/pi-logo-status.png" "$dest/pi-logo-status.png"

echo "Installed Pi notification icons to $dest"
```

Put it in chezmoi as a run script, for example:

```text
run_after_install-pi-notification-icons.sh
```

The `PREFIX` guard means it runs only in Termux and exits without doing anything on macOS or other environments.

## Broadcast extras sent by Pi

The Tasker backend sends these extras:

```text
title             Notification title, usually "Pi Coding Agent"
subtitle          Session title, tmux session, session summary, or cwd-derived label
body              Main notification body
content           Combined subtitle + body text
group             Notification group key, usually "pi-native-notify"
notification_id   Stable notification id, usually "pi-native-notify"
status_icon       Path to the Pi status icon asset
large_icon        Path to the Pi large icon asset
image_path        Path to the Pi large icon asset
picture           Omitted for normal notifications; generated image path for generated-image notifications
pi_picture        Omitted for normal notifications; preferred preview image path for Tasker conditions/expanded Picture field
generated_image_path  Omitted for normal notifications; full generated image path for tap/open actions
```
