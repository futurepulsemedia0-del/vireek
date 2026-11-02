# Release health, staged rollout and in-app updates

Target: **crash-free sessions ≥ 99.8 %** and **crash-free users ≥ 99.5 %** per release (Sentry → Releases → Health).
`@sentry/capacitor` already runs with `enableAutoSessionTracking`, so release health data exists as soon as a build ships. Do NOT set a custom `release` in `sentryNative.ts`: the Capacitor SDK derives `bundleId@version+build` itself, and that exact string is what dSYM / ProGuard-mapping uploads must match.

## Rollout ladder (both stores)
| Step | Android (Play) | iOS (App Store Connect) | Gate to continue |
| --- | --- | --- | --- |
| 1 | Internal testing (`Play rollout` workflow, track `internal`) | TestFlight internal | Maestro flow passes, manual device checklist done |
| 2 | Production **5 %** (workflow, track `production`, `user_fraction 0.05`) | Release with **Phased Release for Automatic Updates** ON (7-day, Apple-controlled) | 24 h: crash-free sessions ≥ 99.8 %, no new top issue |
| 3 | Raise to 20 % → 50 % → 100 % in Play Console, ≥ 24 h apart | Phased release continues; "Release to all" only if healthy | Same gate before every increase |
| Stop | Halt rollout in Play Console | Pause phased release | Any gate failed or a regression with data loss |

## Sentry alerts to create (Alerts → Create → Metric)
1. Crash-free session rate for release < 99.8 % over 1 h → notify mobile channel.
2. New issue in `environment:production` with `os.name:iOS|Android` affecting > 10 users in 1 h → page on-call.
3. ANR / app-hang rate regression after a release (Android vitals + Sentry) → notify.

## In-app update prompt
- Policy source: table `app_release_policy` (RPC `get_app_release_policy`, cached) → `UpdateGate`. `min_version` forces, `latest_version` nudges once per version.
- To force users off a bad build: raise `min_version`, ship the fix, then raise `latest_version`. An unreachable server never blocks field work.
- Play "in-app update priority" (workflow input `update_priority`) only affects Play's own flexible/immediate update API; it does not replace the table above.
