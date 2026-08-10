# Settings store

`08-settings` makes `agent/settings.config.json` the source of truth and uses
`agent/settings.json` only when source settings are unavailable. `createSettingsStore`
serializes updates, writes owner-only temporary files, runs the merge script, and
restores the exact source bytes if the merge fails. Paths and merge execution are
injectable for hermetic tests.

Extension-owned preferences are grouped by extension at the root of the settings
object (`permissions`, `handoff`, `subagents`, `browse`, and `health`). Pi core
settings such as models, extension paths, themes, and image-generation providers
remain top-level. Migrated readers accept legacy flat keys, but extension writers
update only nested fields and preserve sibling values.
