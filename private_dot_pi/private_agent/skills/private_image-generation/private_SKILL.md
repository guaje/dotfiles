---
name: image-generation
description: Generate images with available image generation models configured in agent/models.json and pi settings. Use when the user asks to create, generate, render, draw, or make an image, illustration, logo, icon, poster, mockup, or visual asset from a prompt using healthy configured provider models.
---

# Image Generation

Use this skill when the user wants a new image or visual asset generated from text or an input image. The image models must come from pi configuration and must be marked healthy before use; do not assume a provider or model ID.

## Required Availability Check

Before generating any image:

1. Read `agent/model-health-cache.json`.
2. Only use cached results where:
   - `service` is `imageGeneration`
   - `status` is `ok`
3. If there are no healthy image generation results, do **not** call an image generation endpoint. Tell the user that no image generation models are currently available and suggest running `/model-health` to refresh the cache.
4. If the cache file is missing, invalid, or stale according to `MODEL_HEALTH_CACHE_TTL_MS` in `model-health-check.ts`, do **not** assume availability. Tell the user the health cache needs to be refreshed with `/model-health` before image generation.

The health extension gets configured image models from `imageGenerationProviders` in `agent/settings.config.json` or `agent/settings.json`, and provider connection details from `agent/models.json`. Follow that same source-of-truth.

## Workflow

1. Perform the required availability check above.
2. Read `agent/settings.config.json` and `agent/models.json`.
3. Match each healthy cache result such as `provider/model-id` to:
   - `agent/settings.config.json` → `imageGenerationProviders[provider].models[]`
   - `agent/models.json` → `providers[provider]` for `baseUrl`, `apiKey`, and API compatibility.
4. If more than one healthy image model exists, choose the best fit from metadata and user constraints, or ask the user which model to use.
5. Build a complete generation prompt:
   - Subject and action
   - Style or medium
   - Composition/framing
   - Lighting/color palette
   - Aspect ratio or output size
   - Text to include or avoid
   - Negative constraints, if supported
6. Call the selected provider's OpenAI-compatible image generation endpoint and save the result to a file.
7. Display the saved image for the user:
   - In supported non-Termux terminals, use pi's inline terminal image rendering. From extension/tool rendering code, return an `Image` component from `@mariozechner/pi-tui` when `context.showImages` is true, using the saved file's base64 data and MIME type.
   - In Termux, do not rely on inline terminal image rendering. Schedule a delayed, background image opener so pi can finish rendering its response before Android switches apps: first `am start -a android.intent.action.VIEW -d file://<realSavedImagePath> -t image/png`; if that fails, try `termux-open --chooser --content-type image/png <savedImagePath>`; if image opening still fails, open the generated image directory with `termux-open --chooser <generatedImageDirectory>`.
8. Trigger a generated-image notification by calling `notifyGeneratedImage(savedImagePath, ctx)` from `agent/extensions/native-notify.ts` when you are operating from extension code that has a Pi extension context. If you generated the image from a script or shell workflow without an extension context, ask Pi/the user to call that function with the saved path rather than reimplementing notification logic.
9. Return the saved path, model, provider, display method, and a short note about any assumptions.

## Listing Healthy Image Models

From the repository root or `~/.pi`, list currently healthy image generation models from the cache with:

```bash
jq -r '
  .results[]?
  | select(.service == "imageGeneration" and .status == "ok")
  | [.id, (.name // (.id | split("/")[-1]))]
  | @tsv
' agent/model-health-cache.json
```

If this prints nothing, do not invent a model and do not call the image endpoint.

To inspect configured image generation models, use:

```bash
jq -r '
  .imageGenerationProviders
  | to_entries[]?
  | .key as $provider
  | (.value.models // [])[]
  | [$provider, .id, (.name // .id)]
  | @tsv
' agent/settings.config.json
```

A configured model is not enough; it must also be healthy in `agent/model-health-cache.json`.

## Endpoint

Use the selected provider's `baseUrl` from `agent/models.json` and append `/images/generations` after trimming a trailing slash:

```text
POST ${baseUrl}/images/generations
Authorization: Bearer ${apiKey}
Content-Type: application/json
```

Typical body:

```json
{
  "model": "<selected-image-model-id>",
  "prompt": "<final prompt>",
  "n": 1,
  "size": "1024x1024",
  "response_format": "b64_json"
}
```

Only include optional fields such as `quality`, `style`, `background`, `moderation`, `negative_prompt`, `image`, or `mask` when the selected model/provider metadata or API docs indicate support, or when the user explicitly requests them and the provider accepts them.

## Displaying Generated Images

After a file is written, show it immediately when practical:

- **Pi inline rendering:** In extension code or a custom image generation tool, render the most recently generated image with pi's TUI `Image` component from `@mariozechner/pi-tui` when `context.showImages` is true. Read the saved file, convert it to base64, pass the MIME type such as `image/png`, and cap the preview with the current terminal image settings (for example `terminal.imageWidthCells`). This works only in terminals with inline image support such as Kitty, iTerm2, Ghostty, or WezTerm.
- **Termux:** Detect Termux with environment/runtime signals such as `TERMUX_VERSION`, a Termux `PREFIX`, or the availability of `termux-open`. In Termux, schedule image opening in a delayed background shell so pi can finish writing its final response before Android foregrounds another app. Use Android's activity manager first, `am start -a android.intent.action.VIEW -d file://<realSavedImagePath> -t image/png`, because some gallery apps display shared-storage files correctly through this path when `termux-open` does not. If `am start` fails, try `termux-open --chooser --content-type image/png <savedImagePath>`; if that also fails, fall back to `termux-open --chooser <generatedImageDirectory>` so the user can select the image from a file/gallery picker. Avoid unsupported short options; use the long Termux:API CLI flags shown here. Allow `IMAGE_OPEN_DELAY_SECONDS` to tune the delay, with a safe default.
- **Fallback:** If inline rendering is unavailable and this is not Termux, return the path and tell the user how to open it locally.

Minimal extension renderer pattern:

```typescript
import { readFileSync } from 'node:fs';
import { Image, Text } from '@mariozechner/pi-tui';

renderResult(result, options, theme, context) {
  const imagePath = result.details?.path;
  if (!imagePath || !context.showImages) {
    return new Text(`Generated image: ${imagePath || 'unknown path'}`, 0, 0);
  }

  const base64Data = readFileSync(imagePath).toString('base64');
  return new Image(base64Data, 'image/png', theme, {
    maxWidthCells: 80,
    maxHeightCells: 24,
  });
}
```

## Safe API Key Handling

Resolve `apiKey` without printing it:

- Literal values are used as-is in an environment variable.
- Values like `$ENV_VAR` are resolved from the environment.
- Values beginning with `!` are shell commands; run the command and capture stdout.

Never include the key in final answers, logs, filenames, or generated artifacts.

## Output Directory

By default, save generated images under the OS Pictures directory in a `generated` subdirectory:

- Termux with storage set up: `$HOME/storage/pictures/generated`
- XDG desktops: `$(xdg-user-dir PICTURES)/generated`
- Fallback: `$HOME/Pictures/generated`

Allow users to override this with `IMAGE_OUT_DIR`.

## Generation Script

Use `agent/skills/image-generation/scripts/generate-image.mjs` for robust JSON handling and base64/URL outputs. The script reads the health cache first, refuses to generate when no healthy image models are available, reads pi configuration, selects a healthy model, calls the endpoint, writes a PNG, and returns JSON with `path`, `provider`, `model`, `size`, and `display`.

Run it from the repository root or `~/.pi` after setting a complete prompt:

```bash
IMAGE_PROMPT='<final prompt>' \
IMAGE_SIZE='1024x1024' \
node agent/skills/image-generation/scripts/generate-image.mjs
```

Useful environment overrides:

- `IMAGE_MODEL` or `IMAGE_PROVIDER` to select a healthy configured model/provider.
- `IMAGE_SIZE` to request a supported size, defaulting to `1024x1024`.
- `IMAGE_OUT_DIR` to override the default Pictures/generated output directory.
- `IMAGE_OPEN_DELAY_SECONDS` to tune delayed Termux image opening.
- `IMAGE_AGENT_DIR` for tests or unusual layouts; defaults to the script's containing `agent` directory.

## User Interaction Rules

- Ask a clarifying question if the request lacks a subject or desired visual output.
- If the user does not specify size, use `1024x1024` unless the model metadata indicates a better default.
- If the user asks for a logo, icon, poster, or UI mockup, ask whether exact text must be rendered; image models often render text imperfectly.
- Do not claim an image was generated unless the health cache had an `ok` image generation model, the API call succeeded, and a file was written.
- If no healthy image generation model is available, say so and suggest `/model-health`; do not attempt generation.
- If generation fails, report the provider/model, HTTP status, and actionable next step without exposing secrets.
