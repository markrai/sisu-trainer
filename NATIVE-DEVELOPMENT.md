# Capacitor native development

Sisu Trainer keeps two separate build paths. `npm run build` compiles the hosted browser/PWA application into its modular `dist/` tree. `npm run build:native` bundles the same TypeScript/DOM entry point with esbuild and stages packaged assets in generated `www/` output.

## Requirements

- Node.js 22 or newer
- Android Studio 2025.2.1 or newer
- Android API 24 minimum; the generated Capacitor 8 project currently compiles and targets API 36
- Android 17 / API 37 introduces the `ACCESS_LOCAL_NETWORK` runtime permission for apps targeting API 37+ that communicate with LAN hosts. Sisu Trainer currently targets API 36; this must be revisited when the target SDK is raised to 37.
- macOS for iOS development
- Xcode 26 or newer
- A physical iOS device for Bluetooth testing; iOS Simulator does not support BLE

The iOS project uses Swift Package Manager. CocoaPods is not required.

## Commands

```text
npm run check
npm run build
npm run build:native
npm run cap:sync
npm run cap:sync:android
npm run cap:sync:ios
npm run android
npm run ios
```

Build Android from the generated project on Windows with:

```text
android\gradlew.bat -p android assembleDebug
```

Run iOS sync and open/build commands on macOS with Xcode 26 or newer.

## Runtime boundaries

The hosted PWA continues to use Web Bluetooth, browser speech synthesis, Screen Wake Lock, browser `fetch`, and its service worker. Android and iOS use Capacitor BLE, native text-to-speech, native Keep Awake, and `CapacitorHttp` only for SISU `/health` and `/workout/ingest` traffic. The native app intentionally does not register the PWA service worker or show PWA installation UI.

Browser/PWA storage and installed native WebView storage are separate namespaces. Both continue to use IndexedDB, localStorage, and sessionStorage; data is not migrated between installations.

Use HTTPS for SISU, especially from native builds. The native app does not enable broad cleartext or mixed-content exceptions, so an `http` SISU endpoint reports a transport-security error. Native SISU traffic does not depend on browser CORS.

Native projects currently use Capacitor's generated placeholder store artwork. Produce final Play Store and App Store icon/splash variants from the existing Sisu Trainer branding before release.

## Device validation checklist

On a physical Android device and a physical iOS device, verify:

- The app launches from packaged assets, shows no Install tab or install prompt, and registers no service worker.
- The heart-rate chooser opens; a standards-based chest strap connects; live BPM and supported battery level update; disconnect clears the UI; and reconnect succeeds.
- A running workout keeps the screen awake, while pause/end/cancel releases Keep Awake and normal sleep resumes.
- Spoken workout instructions use the existing wording and stop/cancel when the workout lifecycle requests it.
- SISU HTTPS `/health` succeeds and a completed workout reaches `/workout/ingest` with the existing payload contract.

BLE behavior cannot be fully validated in an emulator or the iOS Simulator.
