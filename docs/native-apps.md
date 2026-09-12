# Native apps

Desktop uses Tauri; Android uses Capacitor. Both load the web app build.
Set the sync server in **Settings → Sync server**. Use an HTTPS URL on Android.

## Desktop

Install Rust and the Tauri system dependencies for your platform.

```sh
npm run -w @carbon/desktop dev
npm run -w @carbon/desktop build
```

Bundles are written to `apps/desktop/src-tauri/target/release/bundle/`.
Regenerate app icons with `./gen-icons.sh` after updating the PWA icons.

### Quick-add (global hotkey + tray)

- **Ctrl/⌘ + Shift + A** opens quick-add. Inline tags, assignees, priorities and natural-language commands work here.
- The tray menu provides **Open Carbon**, **Quick Add** and **Quit**.
- Closing the main window hides it to the tray. Use **Quit** to exit.

## Android

Install JDK 21 and the Android SDK. Set `JAVA_HOME` and `ANDROID_HOME` to their
installation paths. SDK versions are defined in `apps/mobile/android/variables.gradle`.

```sh
npm run -w @carbon/mobile build:android
npm run -w @carbon/mobile open:android
```

The build command creates a debug APK; the second command opens Android Studio.
`apps/mobile/build-android.sh` also supports release and device-install modes.

### Push notifications

1. Register your Android app in Firebase and place its `google-services.json` in `apps/mobile/android/app/`.
2. Set `FCM_SERVICE_ACCOUNT_FILE` on the Carbon server to the service-account JSON path, or use `FCM_SERVICE_ACCOUNT_JSON`.

Keep the service-account key on the server. Android background push requires this
configuration; browser Web Push uses separate VAPID keys.

## CORS

Set `CORS_ORIGINS` to the app origins you allow, for example:

```ini
CORS_ORIGINS=tauri://localhost,http://tauri.localhost,https://localhost,https://carbon.example.com
```

Tauri uses `tauri://localhost` on Linux/macOS and `http://tauri.localhost` on Windows.
Capacitor Android uses `https://localhost`.
