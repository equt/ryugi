# Installing Ryugi in DeepSeek Harness

Ryugi ships a DeepSeek Harness bundle from this repository. The repo-root
`package.json` declares `dsh.bundle.patch`, so installing the repository as a
profile plugin is the whole install — no file copying, no `AGENTS.md` edit.

The integration adds:

- a skill provider over this package's `skills/` directory, so every Ryugi
  skill appears in the session skill catalog and loads through the native
  `skill` tool;
- the `using-ryugi` bootstrap as a durable user-role message at session start,
  re-injected after compaction, and skipped when the visible history already
  contains it;
- `skills/using-ryugi/references/dsh-tools.md` as the inline tool mapping, so
  the bootstrap already speaks DeepSeek Harness tool names.

## Desktop

1. Open **Plugins** in the sidebar.
2. Select **Add plugin**.
3. Enter `https://github.com/Innei/ryugi` (or `Innei/ryugi`) and install.
4. Enable **Ryugi** when the install finishes.

Ryugi appears under **Installed plugins**. A fresh session picks it up; with
configuration HMR the bundle can compose into the running profile, but an
already-created session does not retroactively receive the bootstrap.

## CLI

Install into the profile you boot (`web` below; substitute `headless` or your
own profile name):

```bash
dsh plugin --profile web add github:Innei/ryugi
dsh web
```

The first use initializes the profile if needed, links the package, and appends
the bundle to `dsh.profile.bundles`. To update, remove and reinstall:

```bash
dsh plugin --profile web remove ryugi
dsh plugin --profile web add github:Innei/ryugi
```

## Local development

From a checkout beside this one:

```bash
dsh plugin --profile web add ./ryugi
```

`pnpm` records a `link:` dependency; the profile resolves the plugin's relative
`./index.js` row from the linked checkout, so code changes only need a
recomposition (or a restart without HMR).

Verify the layer without booting:

```bash
dsh --profile web --dump-config | grep -A 2 'ryugi'
```

The dump should contain a `ryugi` row naming the installed package's
`.dsh/index.js`.

## Uninstall

Desktop: open **Plugins → Ryugi** and remove it.

CLI:

```bash
dsh plugin --profile web remove ryugi
```

## Troubleshooting

- **No Ryugi skills in the catalog.** Confirm the bundle is on in **Plugins**,
  then open a new session. `dsh --profile <name> --dump-config` should show the
  `ryugi` row; a missing row means the bundle was installed but not selected.
- **Skills appear but do not trigger.** The bootstrap is injected at session
  start only. Start a fresh session after installing. A session that was
  already open when the bundle was enabled has no bootstrap.
- **The bootstrap disappeared after a long session.** It is re-injected when a
  `compaction/end` event commits, unless a visible bootstrap message is still
  present.
- **A project's own skills win a name collision.** Bundled skills rank below
  project and custom roots (rank 600), which is the intended precedence.
- **Plugins shows an older Ryugi install without a bundle.** A release that
  predates the `dsh.bundle` declaration may already be present as a plain
  dependency. Remove it in **Plugins**, then install again; installing over an
  already-installed package is refused.
- **The install reports that the package is not a bundle.** The installed
  package is an older Ryugi release without the `dsh.bundle` declaration.
  Install from `main` (or a version that contains this file).
- **pnpm prints "Agent skills awaiting approval".** pnpm 12 detects the
  repository's `SKILL.md` bundles and asks separately before linking them into
  its own agent-skills directory. It does not block the DSH bundle, which reads
  `skills/` directly. Approve only if you also want pnpm's own skill links.

## Acceptance test

Open a clean session and send exactly:

> Let's make a react todo list

A working install auto-triggers the `brainstorming` skill before any code is
written. The same test is used for every harness in
[AGENTS.md](../AGENTS.md#harness-integrations).
