import type { CapacitorConfig } from '@capacitor/cli'

/**
 * hotel-admin ships no static build of its own here — Capacitor loads the
 * real Next.js app (server components, server actions, next-auth's
 * server-side session) from a remote URL, exactly the way a browser tab
 * would. `www/` is an intentionally-empty placeholder Capacitor requires to
 * exist on disk; nothing in it is ever shown.
 *
 * CAPACITOR_SERVER_URL must point at a running hotel-admin instance:
 *  - iOS Simulator: the default below (`http://localhost:3001`) works as-is
 *    — the simulator shares the host machine's network.
 *  - Android Emulator: set `http://10.0.2.2:3001` instead — the emulator's
 *    alias for the host machine's localhost.
 *  - A physical device: your machine's LAN IP, e.g. `http://192.168.1.23:3001`.
 *  - Production / store builds: the real deployed HTTPS URL —
 *    `https://hotel.roomlink.in`. Use the `:prod` scripts in this package
 *    (`sync:prod`, `run:android:prod`, `run:ios:prod`) rather than the plain
 *    ones — `cap run`/`cap open` each re-run `cap sync` themselves, so the
 *    env var has to be set on every invocation, not just once. No safe
 *    default is baked in here; leaving CAPACITOR_SERVER_URL unset keeps
 *    local dev pointed at localhost instead of silently shipping a prod
 *    build.
 */
const serverUrl = process.env.CAPACITOR_SERVER_URL ?? 'http://localhost:3001'

const config: CapacitorConfig = {
  appId: 'in.roomlink.hoteladmin',
  appName: 'RoomLink Hotel',
  webDir: 'www',
  server: {
    url: serverUrl,
    // Only relevant for the plain-http dev URLs above; a production HTTPS
    // URL doesn't need this.
    cleartext: serverUrl.startsWith('http://'),
  },
  ios: {
    // Read by apps/hotel-admin's src/server/is-native-client.ts
    // (NATIVE_UA_MARKER) to gate every native-only branch — see the
    // mobile-app plan's isolation mechanism. Never change this string
    // without updating that file too.
    appendUserAgent: 'RoomLinkNativeApp',
  },
  android: {
    appendUserAgent: 'RoomLinkNativeApp',
  },
}

export default config
