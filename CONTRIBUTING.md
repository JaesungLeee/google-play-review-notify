# Contributing

Thanks for helping make Google Play review notifications work for everyone. The most valuable
contributions, in order:

1. **Unrecognized Play emails.** Google changes wording and adds new notice types; each report
   becomes a fixture and a rule.
2. **Rule sets for other languages.** Play Console emails follow the console language. English
   and Korean ship today.
3. Bug reports with the `--verbose` log (secrets are redacted automatically).
4. New notifiers, state stores, or sources that follow the existing plugin interfaces.

## Development setup

Node 20 or newer.

```bash
git clone https://github.com/JaesungLeee/google-play-review-notify.git
cd google-play-review-notify
npm ci
npm run lint && npm run typecheck && npm test
npm run build            # dist/ (CLI, library) and dist/action/index.js
npm run cli -- --help    # run the CLI from source
```

CI runs the same checks on Node 20 and 22 and additionally verifies that
`dist/action/index.js` matches the sources. **Always run `npm run build` and commit the bundle**
when you change anything under `src/` or `rules/`.

## Reporting an unrecognized Play email

1. Enable `UNKNOWN_NOTICE` in your config so the email surfaces as an event, or find it in Gmail
   with `from:google.com "Google Play"`.
2. Open the email in Gmail → ⋮ → **Show original** → **Download original** to get the `.eml`.
3. Mask before sharing: replace the developer name, app names, package names, URLs to your
   servers, and the recipient address with placeholders such as `Sample Team`, `Sample App`,
   `com.example.sampleapp`, `developer@example.com`. **Keep the subject wording, the sentence
   structure, and the paragraph around the reason unchanged**: that is what the rules match.
4. Open a "Unrecognized Play email" issue with the masked subject and plain-text body, the date,
   the console language, and what the email actually meant (rejection of an update, warning about
   a live app, removal, ...).

## Adding or changing a rule set

Rule sets live in `rules/email/<locale>.json` and are embedded into the package at build time.

```json
{
  "locale": "de",
  "rules": [
    { "type": "REJECTED", "subject": ["..."], "body": ["App-Status: Abgelehnt"] },
    {
      "type": "POLICY_WARNING",
      "subject": ["..."],
      "body": ["Status: Weitere Maßnahmen erforderlich"]
    }
  ],
  "extract": {
    "packageName": ["regex:\\(([a-z][a-z0-9_]*(?:\\.[a-z0-9_]+)+)\\)"],
    "appName": ["regex:..."],
    "versionCode": ["regex:..."],
    "reason": ["section:Gefundenes Problem|Grund"]
  }
}
```

- Rules are evaluated top to bottom, first match wins, across all bundled rule sets (English
  first). Prefer **body** patterns for the event type: Google reuses the same subject for
  rejections and deadline warnings.
- `extract` patterns are `regex:<pattern>` (first capture group) or `section:<Heading|Alt>` (text
  after a heading line until a blank line).
- Register a new locale in `loadBuiltinRuleSets()` in `src/sources/email/rules.ts`.
- Add masked fixtures under `test/fixtures/email/<locale>/` using the existing
  `From:` / `Date:` / `Subject:` + blank line + body format, and add cases to
  `test/sources/email.test.ts`. Include at least one **unrelated** Play email (newsletter, terms
  update) to prove the rules do not over-match.
- Never commit real, unmasked emails. `test/fixtures/email/private/` is git-ignored for local
  originals.

Rule changes are released as patch versions.

## Adding a source, notifier, or state store

The interfaces are in `src/core/types.ts`:

- `SourceAdapter.poll(ctx, state)` returns normalized `ReviewEvent`s and the next state. Sources
  must never throw for a single app failure, must record only (no events) when `ctx.baseline` is
  true or when they see a package for the first time, and must use stable event ids.
- `Notifier.send(message, channel)` receives an already rendered message.
- `StateStore.load() / save(state)`; custom stores can be loaded from a local module via
  `stateStore.type: custom` without changes to this repository.

Wire new implementations in `src/sources/index.ts`, `src/notifiers/index.ts`, or
`src/state/index.ts`, extend the zod config schema in `src/core/config.ts`, and add tests that
inject fakes (see `test/sources/*.test.ts` for the pattern; no network in tests).

## Pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) in the title
  (`feat(email): ...`, `fix(store-listing): ...`, `docs: ...`). Changelog entries are derived
  from them.
- Keep the PR focused; documentation updates that describe the change belong in the same PR.
- Do not edit `CHANGELOG.md` or bump the version: both are generated from the commit titles
  by Release Please (see below).

## Releasing (maintainers)

Releases are automated:

1. Every push to `main` runs **Release Please**, which opens or updates a "chore(main): release
   x.y.z" PR. The version comes from the Conventional Commit titles since the last release
   (`fix` → patch, `feat` → minor while below 1.0, `!`/`BREAKING CHANGE` → minor as well).
   The PR also rewrites `CHANGELOG.md`, `package.json` and the manifest.
2. Merging that PR creates the GitHub Release and the `vX.Y.Z` tag.
3. The **Publish** workflow runs on the release: tests, build, a check that the tag, `package.json`
   and the built CLI agree, `npm publish --provenance` through npm trusted publishing, and
   finally moves the floating `v1` tag so GitHub Action users pick up the release.

One-time setup, repository settings:

- **Settings → Actions → General → Workflow permissions**: enable "Allow GitHub Actions to
  create and approve pull requests".
- Optional but recommended: a fine-grained PAT (contents + pull requests: write) saved as the
  `RELEASE_PLEASE_TOKEN` secret. Without it the release PR is created with the default token and
  CI does not run on it; you would merge it unchecked.
- **npmjs.com → package `play-review-notify` → Settings → Trusted Publisher**: add GitHub
  Actions with owner `JaesungLeee`, repository `google-play-review-notify`, workflow
  `publish.yml`. No npm token is stored anywhere.
- The first time, publish the Action to the GitHub Marketplace by editing the release and
  checking "Publish this Action to the GitHub Marketplace". Later releases update the listing.

Rule-set-only changes are `fix(email): ...` commits and therefore ship as patch releases.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind.
