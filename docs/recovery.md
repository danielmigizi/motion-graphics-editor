# Saving and recovery

Explicit Save writes the saved ProjectFile to `projects/<id>.json` atomically.
Server autosave (`PUT /api/projects/:id?autosave=1`) writes a separate per-project
journal, leaving the explicit saved file intact. The journal keeps the most
recent 20 autosaved ProjectFiles. Both survive browser and server restarts.
Opening a saved project offers a newer journal revision (or a newer browser
recovery copy), with options to recover, open the saved revision, or download
both copies. Failed saves leave a persistent Retry / Download a copy banner
in both editor views; the next successful save clears it.

ProjectFiles preserve the latest 30 revision records, including snapshots.
The live editor keeps up to 100 revision records. Named checkpoints preserve
an independent ProjectFile until explicitly deleted, unaffected by the
journal's 20-entry cap. Restoring one appends one new revision, respects
current scene locks, and can be undone in the current session.

**Undo and redo stacks do not survive reopening.** They are session-only edit
operations and are deliberately omitted from ProjectFile serialization.
Saved revision snapshots still support rollback after reopening, while the
journal and checkpoints provide durable document recovery.

The browser also keeps one best-effort localStorage recovery slot. Clearing
browser storage removes that copy, but does not remove server files. Server
persistence requires a successful write to the local server; keep downloaded
JSON copies when the server is unavailable.
