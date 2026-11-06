# Security

The editor runs on your computer. It spends real money (fal generation) and starts coding agents with shell access. No local app is hack-proof, so the goal is to fail safely:

- Nothing on the internet can read or change your work.
- The agents the editor starts can't change spending limits, swap the fal key, approve their own requests or start generation as you through the server. That rests on two things they don't have: the browser tab's secret and the key file. Codex and OpenCode are walled off from both (and from the browser profiles that store the tab's session). Claude Code and Cursor are only slowed down by text-matching rules (see 3), so treat their shell access as yours.
- If the computer itself is compromised, the loss is capped at the prepaid credit on your fal account.

## Who we defend against

| Attacker | Example | In scope |
|---|---|---|
| A website open in your browser | A page that calls `fetch('http://localhost:5318/api/projects')` | Yes |
| One of your own agents, prompt-injected | Claude Code or Codex reads a web page that tells it to `curl` the server, `cat` the key file, or open a URL in your browser | Yes |
| Another program running as you | Malware, a compromised npm package, a hostile editor extension | No: only the money cap applies (below) |
| Someone else on your network | | Yes: the server listens on 127.0.0.1 only |

## Controls

### 1. The server answers only the editor, the renderer and local tools

- The server listens on loopback (`127.0.0.1`) only, and it refuses any `Host` header other than `localhost`, `127.0.0.1` or `[::1]`. This blocks DNS rebinding.
- A request that carries an `Origin` header is answered only when that origin is the editor (`http://localhost:5317`), the server itself (`http://localhost:5318`, and the same ports on `127.0.0.1`), or the headless renderer's own page. Every other origin gets **403** on every route and every method, including reads. No response carries `Access-Control-Allow-Origin: *`.
- Under `/api`, a request the browser marks `Sec-Fetch-Site: cross-site` or `same-site` (another `localhost` port) is refused unless its origin is allowed. This stops a page from embedding API responses with `<script>` or `<img>` tags.
- Requests without an `Origin` (the CLI scripts, the MCP server, the renderer's server-side calls) keep working. A browser always sends `Origin` on cross-origin requests, so a website can't use this path.

- Files the server serves (uploads, renders), and every file the Vite dev server serves from `public/`, carry `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`, so an uploaded SVG or HTML file opened in the browser can't run script as the editor. The dev server refuses other spellings of private folders (`/public/assets/uploads/…`, percent-encoded paths, `/@fs/…`, `.mge`, `projects`, `chats`, `renders`, `brand-kits`, and `dist`, where a build copies `public/`); uploads and renders are reachable only through the server.
- The renderer's own page server (a random `127.0.0.1` port, used during exports) answers only its own host, refuses foreign origins, no longer allows any origin to read, and no longer copies `public/` (uploads included) into its bundle.

*Stops:* a website reading your projects, transcripts, generation log, renders or uploads.

### 2. Only the tab opened from the editor link counts as you

The `Origin` header proves nothing to the server: any local program can set it. So the server makes a random secret each time it starts and keeps it in memory only, never in a file or an environment variable.

1. `npm run dev` prints a one-time **editor link**: `http://localhost:5317/?session=…`.
2. Opening it exchanges the token for two things: a cookie (`HttpOnly`, `SameSite=Strict`) and a **tab secret** that the tab keeps in its own `sessionStorage`. The token then stops working. The editor removes it from the address bar.
3. A request counts as **you** only when it carries the cookie **and** the tab secret (in the `X-MGE-Tab` header; the event stream sends it as `?tab=`), and, if it has an `Origin`, that origin is the editor page's (port 5317), not the server's own. A request with the editor's `Origin` but neither is treated as an agent. API responses are sent with `Cache-Control: no-store`, so none of this lands in a browser cache.
4. Why both: a cookie for `localhost` goes to every port and every tab. An agent that opens `http://localhost:<its own port>` in your browser would receive it. The tab secret stays in the tab that opened the link: a tab an agent opens, or an uploaded file opened at the editor's address, starts without one. The browser does keep `sessionStorage` (and cookies) in its profile folder on disk for session restore; that folder is denied to agents (control 3), firmly for Codex and OpenCode and as a speed bump for Claude Code and Cursor.
5. When the server restarts, every session ends. Open the new link it prints.
6. **Settings › Open in another tab or browser:**
   - **Open a new unlocked tab** opens a tab that inherits this tab's secret (the browser copies `sessionStorage` into a tab a page opens), with no link at all.
   - **Copy a one-time link** is for another browser. It works once, for 5 minutes. Opening it shows a short pairing code (like `K7Q-2MX`) in that browser, and the unlocked tab shows a permission card with a code. Allow only when the two match. A program that copies the link off the clipboard gets its own, different code, so its card doesn't match what your other browser shows.
7. When the MCP server (or `scripts/dev-on.mjs`) starts the editor, it doesn't put the link in the server log. It writes the link to `editor-link-<port>` in the config directory (mode 0600), which editor-launched agents are denied, and opens your browser on it when it can. The locked notice names that file.
8. The cookie and the link file are named per server port, so editors running in parallel worktrees don't sign each other out.

Only you can:

- Change generation settings: the daily budget, the confirmation threshold, and skipping the card for your own clicks.
- Save, test or remove the fal key.
- Set model route overrides, or dismiss a route suggestion.
- Start a generation job as yourself. A job from anyone else is an agent job: it is checked against the budget, and the editor shows its permission card.
- Hold the editor's event stream, report the editor's state, and answer permission cards. Without this, an agent could connect as the editor and approve its own requests.
- Send, cancel or reset a chat with an agent, or change the chat's agent or model.
- Delete a checkpoint, or save or discard a pending proposal.
- Write History entries (`?autosave=1`), record take outcomes and deliveries (they feed the scoreboard and route suggestions), and cancel a job you started.

Agents keep everything they need through the MCP server: reading the project and editor state, sending commands to the editor, saving projects, rendering, exporting, uploading and importing, and cancelling their own jobs. Saving a project stays open to them, with History as the safety net:

- Every save, yours or an agent's, first copies the saved version into History, one project at a time, so two saves at once can't lose a version.
- The server remembers who wrote the saved file, and files each History copy by who wrote that content. Agents' content goes in its own ring of 20 and never pushes out your 20, and the newest copy of a version *you* wrote is always kept. When you open a project, only your own History entries are offered back as unsaved work.
- The person's own pasted patch or generated take keeps its saved copy until they discard it, and an agent's request to open another project never replaces edits made while it loads, nor discards unsaved changes whose History copy couldn't be written.
- A save an agent asks the editor to make (the bridge `save` command), or an autosave of changes an agent applied (Auto-apply), is filed as the agent's, unless you changed something since the last save, in which case it holds your edit and is yours.
- Opening another project (which an agent can do) doesn't throw away the pending proposal of the project you were reviewing: it comes back when you reopen that project.
- An agent can't replace a patch you pasted or a generated take waiting for review, and can't send a change under your own labels ("You", "You (generated take)").
- Recovered unsaved work you accept counts as yours.
- The MCP tool also asks you before it overwrites a saved project or discards unsaved changes. A caller that skips the MCP still can't lose your work silently: the server copies what an overwrite replaces, and before an agent's request makes the editor discard unsaved changes to a saved project, the editor writes them to History first. (A document that isn't saved on the server, such as the sample or an opened file, has no History; its browser autosave is the only copy.)

Local files an agent names (importing an asset, analyzing a reference video) are read by the server, not the MCP process, so the server's own idea of the config directory applies. The path is resolved first; one that leads, through symlinks or not (a file with more than one hard link is refused too), into the config directory, the browser profiles, the other denied places, or `/proc`, `/sys` or `/dev` (where a process's environment can be read) is refused. The file is then opened without following symlinks and checked to be the same regular file; on Linux the server also asks where the open file really is (`/proc/self/fd`), which catches a folder above it being swapped for a symlink mid-check. Uploads must also look like what they claim: images and audio are checked for their format's signature, and an SVG must start with an `<svg>` element, so a key, a link or a browser session file renamed `key.svg` or `key.mp3` is refused. Exports record take outcomes only when you start them.

*Stops:* an agent (or any local program) raising the budget, swapping the key, starting cardless jobs, or approving its own permission requests.

### 3. Agents the editor starts can't read the key file

Without a system keychain, the fal key is a file readable only by you (mode 0600) in `~/.config/motion-editor` (or `MGE_CONFIG_DIR`). The agents the editor launches are denied that directory, the `.mge` folder (dev server logs, including `scripts/dev-on.mjs`'s), the browser profiles present on the machine (Chrome and its beta, dev and canary channels, Chromium, Firefox, Brave, Edge, Vivaldi, Opera, Arc and Safari, including the Snap installs of Firefox, Chromium and Brave, the Flatpak installs of Firefox, Chrome, Chromium, Brave, Edge, Vivaldi and Opera, and `XDG_CONFIG_HOME`), which hold the editor's cookie and tab storage along with every other site's logins (their caches too), the session D-Bus socket, through which the Linux keyring hands out the key while it is unlocked, and the desktop and terminal sockets that exist (`/tmp/.X11-unix`, `~/.Xauthority`, Wayland, the AT-SPI accessibility bus, tmux and screen, including the tmux server this editor runs under and custom `TMUX_TMPDIR`/`SCREENDIR` folders), through which a program could read the clipboard, click in your browser or read the terminal that shows the editor link. Claude Code also runs with only your user-level settings, so a `.claude/settings.json` another agent writes into the shared workspace isn't loaded; before each Cursor turn the editor clears the workspace's `.cursor/` folder and writes only its own files, and Codex can't write `.cursor/`, `.claude/`, `.mcp.json`, `.git` (whose hooks git would run for Claude Code or Cursor) or the instruction files other agents read (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`) in the shared workspace at all. (To hold a path that doesn't exist yet, Codex leaves an empty read-only placeholder there; Claude Code and git treat those as absent.) These names are protected at the top of the workspace only: see Known limits. Codex can write only its own project's workspace and its own temp folder (its `TMPDIR`): the shared temp folder (where tsx caches the editor's own compiled code), the other projects' workspaces and the OpenCode run folder are read-only to it. The editor's MCP server is started with the repo's own `tsconfig.json` and no tsx cache, so nothing in a workspace can change what it runs:

| Agent | How | Strength |
|---|---|---|
| Codex | A Codex permission profile that keeps workspace writes and network, and marks those paths `none`. The editor stops the turn if Codex doesn't report the profile. | Enforced by Codex's sandbox. On Linux, bubblewrap masks the paths, which also blocks connecting to the sockets (checked on a Linux machine: reading the key and connecting to the session bus are both refused). If Codex falls back to Landlock alone (for example where unprivileged user namespaces are restricted), files stay denied but Landlock doesn't control connecting to sockets: see the pending check. A command Codex asks to run outside the sandbox shows you a permission card; with **Auto-apply** on, Codex's own reviewer decides. |
| Claude Code | `--settings` deny rules: `Read` and `Edit` on those paths, and `Bash` commands that name them, `secret-tool` or `find-generic-password`. Deny rules beat your allow rules. | Read/Edit rules are enforced. Bash rules match command text, so a reworded command (`cat ~/.config/m*/k*`) gets through. That is a speed bump, not a wall. |
| Cursor Agent | Workspace `.cursor/cli.json` deny rules: `Read` and `Write` on those paths, `Shell(secret-tool)`. | Same limits as Claude Code: they apply to Cursor's file tools, not to every shell command. |
| OpenCode | Its config already denies every shell and file tool; the editor adds explicit `Read`/`Edit` denies for those paths too. | Enforced by its own permission rules. |

Agent processes also never inherit `FAL_KEY`, `FAL_KEY_ID` or `FAL_KEY_SECRET`. If you export one of those before `npm run dev`, though, it stays in the server's own environment, which any program running as you can read from `/proc/<pid>/environ`. Codex runs in its own process namespace and can't see it; Claude Code and Cursor can. Save the key in **Settings › Generation** instead.

### 4. The key at rest

- **macOS:** the key is a Keychain item created with `/usr/bin/security`. The tool that creates an item is trusted to read it, so any program that runs `security find-generic-password -s motion-editor -a fal -w` probably gets the key without a prompt. This still has to be checked on a Mac (see below). Removing that trust would make the editor itself prompt every time it starts. A real fix needs a signed native helper, which is out of scope.
- **Linux:** with a Secret Service keyring (`secret-tool`), any program running as you can read the key while the keyring is unlocked. Codex's sandbox can't reach the session bus (its socket path is denied); a bus on an abstract socket (no path) can't be denied this way.
- **No keychain:** a 0600 file, readable by any program running as you.

In every case, a program running as you can read the key. That is why control 5 exists.

### 5. The money cap outside the app

Use a fal key just for this editor:

- Create it at [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys) with **API** scope.
- Put prepaid credit on the account and turn auto top-up off.
- If you think the key leaked, delete it on fal and paste a new one in **Settings › Generation**.

The prepaid balance is the most anyone can spend with that key, including malware running as you. It is the only control here that such a program can't change.

An API-scope key can't read fal's billing events. Spending is then tracked from the editor's own estimates, which were tested and err high. A key with billing scope adds reconciliation against fal's bill, but if it leaks it exposes more.

## Other safeguards

- The fal key never appears in project files, the generation log, chat transcripts, MCP output, server events or error messages (`server/generation/leak.test.ts`).
- fal URL overrides are accepted only for local stub addresses.
- URL imports check every redirect hop against private and loopback addresses.
- Agent jobs go through the budget ledger and the editor's permission card.

## Out of scope

- Malware or another program running as your user account. It can read the key and the projects, and drive the browser. The prepaid cap limits the money.
- A compromised operating system, browser or browser extension.
- npm supply-chain attacks on the editor's own dependencies.
- Other users on a shared computer who have root.

## Known limits

- Bash rules for Claude Code and Cursor match command text; they slow an agent down but don't stop a determined one.
- The reference analyzer hands ffmpeg the checked real path; a folder in that path swapped for a symlink between the check and ffmpeg's open could still point it elsewhere. Any agent can create such a symlink (it needn't read the target), but ffmpeg only extracts frames and audio from what it reads, so a key or session file yields nothing usable. Off Linux (no `/proc/self/fd`), the same race applies to asset imports, where the media signature checks are what stop a private file being published.
- Claude Code and Cursor (not sandboxed) could also write the shared temp folder, including tsx's cache that the dev server uses after a restart. That is part of "treat their shell access as yours".
- A page on another site can still *display* (not read) an upload or a render whose random file name it knows, because media tags send no `Origin`.
- X11 and D-Bus can also listen on abstract sockets, which have no path to deny.
- Claude Code still loads a workspace `.mcp.json` if your own settings enable project MCP servers automatically (`enableAllProjectMcpServers`); another agent could write one. Leave that setting off.
- Browser profiles in custom places (for example Chrome started with `--user-data-dir`) aren't known to the deny list. Unlock the editor in a browser profile kept in its usual place.
- Codex can still create `.git`, `AGENTS.md` or `.cursor/rules` inside a subfolder of the shared workspace. If Claude Code or Cursor later runs git in that subfolder, or Cursor picks up nested rules, they would act on what Codex planted. The editor's agents work at the workspace root.
- Agents keep your own MCP servers and their full toolset. A filesystem or browser-control MCP server you have enabled can reach what the agent's own shell can't. If you use one, treat that agent as having your access.
- When the MCP server opens your browser on the editor link, the link is briefly in the browser launcher's command line, which any program running as you could read before the browser spends it. This only happens when an agent started the editor.

## Pending manual checks

- **macOS Keychain:** on a Mac with a key saved, run `security find-generic-password -s motion-editor -a fal -w` from Terminal. If it prints the key with no prompt, the limit in control 4 applies as written. Record the result here.
- **Codex sockets on another machine (Mac, or Linux without bubblewrap):** in an editor chat with Codex, ask it to run `busctl --user list` and to read a file in the config directory. Both should be refused. On macOS, also ask it to run `security find-generic-password -s motion-editor -a fal -w`. Record what happens.

## Reporting a problem

Open an issue on the repository. Leave secrets and keys out of it.

## Dependency audit

Production `npm audit` is clear. The complete audit still reports a
development-only Stylelint dependency chain rooted in the unpatched `braces`
advisory GHSA-vfj7-8cjw-p6xm, which only affects patterns written by the
developer. Run `npm run audit`: it reports that chain explicitly and fails on
new findings, non-development occurrences or an unavailable audit. No forced
downgrade or broad advisory suppression is used.
