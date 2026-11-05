# Tests

All of these use made-up data in a temporary folder. They never read or change
your real settings in `%APPDATA%\EQNag`, and the end-to-end tests contact no
trigger websites.

## Unit tests

```
npm test
```

These take a few seconds and need only `npm ci`. They cover saving and
recovering data, log backups, regex safety, the GINA search and share file
validation. Electron is replaced with a small stub, so they say nothing about
windows or overlays.

## End-to-end tests

These run a packaged build on Windows, on throwaway profiles. Build it, then
run the tests. It takes about 10 minutes, and windows will open while it runs:

```
npx ng build --configuration=production
npx electron-builder build --win dir --publish never
npm run test:e2e
```

To test another build, or to run only some groups:

```
node tests/e2e/overlay.test.cjs --exe "C:\path\to\EQ Nag.exe"
node tests/e2e/app.test.cjs --exe "C:\path\to\EQ Nag.exe" generators importFolders
```

| Group | Covers |
|---|---|
| `triggers` | Triggers firing, stored variables, hang protection (about 5 minutes) |
| `saving` | Moving the window, and quitting with a save pending |
| `settingsCleanup` | Removing the settings of removed features |
| `generators` | The DoT and buff generators and re-importing, with a fake spell |
| `damagedFile` | Restoring a damaged trigger file from its backup |
| `importFolders` | The import window's folder list |

`overlay.test.cjs` covers the overlay window: building overlays, showing timers,
and blocking script from shared triggers.

A run that stops early keeps its temporary `nag-e2e-*` folder and prints where it
is, because the app's logs are in there. You can delete it afterward.

Anything that depends on the main window's HTML is in `e2e/lib/ui.cjs`, so
upgrading Angular Material should mostly mean updating that one file.

## Check by hand

The tests check behavior, not appearance, and can't reach some things. Before
a release, and after upgrading Electron or Angular, check:

- **Overlays:** they look right and are transparent and click-through, including
  across multiple monitors and after a monitor turns off and on.
- **DPS meter:** live numbers on screen during real combat.
- **EQ Spell Resources:** one real DoT import and one real buff import,
  including a spell with an icon and a buff with an item effect.
- **GINA importer:** the window with GINA installed, and its "not found" message.
- **Sounds and speech:** alerts play out loud.
- **A long session:** triggers keep working during a real raid, including buff
  timers that use cast times.
- **Installer:** installing over the previous version keeps your settings, and
  the app updates itself.
