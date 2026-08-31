# Settings store

`08-settings` makes `agent/settings.config.json` the source of truth and uses
`agent/settings.json` only when source settings are unavailable. `createSettingsStore`
serializes updates, writes owner-only temporary files, runs the merge script, and
restores the exact source bytes if the merge fails. Paths and merge execution are
injectable for hermetic tests.

Pi's `/scoped-models` selector is the one intentional reverse-sync path: pressing
`Ctrl+S` writes Pi's selection to `agent/settings.json`; the extension mirrors only
`enabledModels` into `agent/settings.config.json`, preserves every sibling setting,
and runs the merge script. Selecting Pi's implicit “all models” state removes
`enabledModels` from the source. Generated and source files are watched by directory
so atomic replacements do not detach synchronization.

Extension-owned preferences are grouped by extension at the root of the settings
object (`permissions`, `handoff`, `subagents`, `browse`, and `health`). Pi core
settings such as models, extension paths, themes, and image-generation providers
remain top-level. Migrated readers accept legacy flat keys, but extension writers
update only nested fields and preserve sibling values.
