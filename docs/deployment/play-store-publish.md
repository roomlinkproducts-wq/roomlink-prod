# Publishing hotel-admin-mobile to Google Play Store

Covers `apps/hotel-admin-mobile` — a Capacitor shell (appId `in.roomlink.hoteladmin`) that
loads the deployed Next.js app (`https://hotel.roomlink.in`) at runtime rather than shipping
bundled web code. Whatever's live at that URL is what reviewers and users see.

## 1. Prep the Android project

- Confirm `apps/hotel-admin` is deployed and stable at the production URL.
- Sync against prod (not localhost — `cap sync`/`cap run` re-run every invocation, so the
  env var must be set each time):
  ```
  cd apps/hotel-admin-mobile
  npm run sync:prod
  npm run open:android
  ```
  This opens the `android/` project in Android Studio.

## 2. App identity & versioning

- `applicationId` is `in.roomlink.hoteladmin` (in `android/app/build.gradle`) — permanent
  once published, cannot change later.
- Bump before every release build:
  - `versionCode` — integer, must strictly increase each release (currently `1`)
  - `versionName` — user-facing string (currently `"1.0"`)

## 3. Signing

- Generate a release keystore once — losing it means you can never publish an update again:
  ```
  keytool -genkey -v -keystore roomlink-release.keystore -alias roomlink \
    -keyalg RSA -keysize 2048 -validity 10000
  ```
- Configure signing in `android/app/build.gradle` (or `key.properties`), or use Android
  Studio's Build → Generate Signed Bundle wizard.
- Store the keystore + passwords outside git (password manager / secrets vault).

## 4. Build the release artifact

Play Store requires an **Android App Bundle (.aab)**, not an APK.

- Android Studio: Build → Generate Signed Bundle/APK → Android App Bundle
- CLI: `./gradlew bundleRelease` (from `android/`)
- Output: `android/app/build/outputs/bundle/release/app-release.aab`

## 5. Google Play Console setup

- Developer account at [play.google.com/console](https://play.google.com/console) — $25
  one-time fee, if not already set up.
- Create the app and fill in:
  - App name, short/full description, category
  - Screenshots (phone required, tablet optional), feature graphic (1024×500), app icon (512×512)
  - Privacy policy URL (required — the app authenticates against a backend, so this needs
    to be hosted somewhere)
  - Content rating questionnaire
  - Target audience / data safety form (disclose account/login data at minimum)

## 6. Upload & rollout

- Release → Testing → Internal testing track first: upload the `.aab`, add testers, verify
  the app installs and works end-to-end against prod.
- Promote to Production, optionally as a staged rollout (e.g., 20% → 100%).
- First-submission review typically takes a few hours to a couple of days.

## Things specific to this app to double-check before submitting

- This is a **remote-URL Capacitor app** — Play policy allows it, but reviewers sometimes
  flag apps that read as a bare webview. Make sure native touches are functional and visible:
  push notifications (`@capacitor/push-notifications`) and the native user-agent gating in
  `is-native-client.ts` (`NATIVE_UA_MARKER`).
- `cleartext` is only enabled for `http://` URLs in `capacitor.config.ts` — confirm the
  build was synced with `sync:prod` (HTTPS), not the localhost default, before building the
  release bundle.
- Verify app icons/splash screens are set for Android, not placeholders — check
  `android/app/src/main/res/`.
