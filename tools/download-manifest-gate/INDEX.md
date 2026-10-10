# INDEX — tools/download-manifest-gate/

- [`gate.ts`](gate.ts) — decides whether a desktop deploy may replace the published `downloads/{channel}/{platform}.json` in the pages repo (#1000): only with the same or a newer version, by the `compareVersions` the app's update check uses ([`src/utils/versionCompare.ts`](../../src/utils/versionCompare.ts)). A missing manifest is written; a missing pages checkout or an unreadable or versionless manifest is an error.
- [`cli.ts`](cli.ts) — entry point for the [`download-manifest-gate`](../../.github/actions/download-manifest-gate/action.yml) action; sets the `publish` step output the three `deploy-*.yml` workflows condition their manifest write and push on.
- [`gate.test.ts`](gate.test.ts) — decision and CLI tests, run by `npm test`.

A tester build dispatched from a feature branch uses a version below everything published, such as `0.0.0-release-0.6.0-preview.1`: its installer is built and attached to a GitHub prerelease, and the public downloads page and update channel stay as they are.

The gate also refuses to move a manifest back on purpose. To point a channel at an earlier version again, edit that manifest in the pages repo by hand.
