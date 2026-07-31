# Settings store

`08-settings` makes `agent/settings.config.json` the source of truth and uses
`agent/settings.json` only when source settings are unavailable. `createSettingsStore`
serializes updates, writes owner-only temporary files, runs the merge script, and
restores the exact source bytes if the merge fails. Paths and merge execution are
injectable for hermetic tests.
