#!/usr/bin/env bash
# Build and install the Sofarr Android TV app using Docker only (nothing installed on the host).
#
#   ./run.sh image                    build the build-environment image (sofarr-android-build)
#   ./run.sh build                    build the debug APK -> app/build/outputs/apk/debug/app-debug.apk
#   ./run.sh release                  build the signed release APK -> app/build/outputs/apk/release/app-release.apk
#                                     (makes the release key on first use; it stays in the cache volume)
#   ./run.sh pair HOST:PORT CODE      pair with the TV once (Developer options -> Wireless debugging ->
#                                     "Pair device with pairing code" shows HOST:PORT and CODE)
#   SOFARR_TV=HOST:PORT ./run.sh install [release]
#                                     install the debug (or release) APK on the TV (HOST:PORT is the "IP address & Port"
#                                     on the Wireless debugging screen; the port changes when it's toggled)
#   SOFARR_TV=HOST:PORT ./run.sh adb ARGS...
#                                     any other adb command (logcat, shell, ...)
#
# Gradle downloads, the debug and release signing keys and the adb pairing key live in the Docker
# volume sofarr-android-cache. Keep it: a new signing key means uninstalling the app (and signing in
# again) before the next install. Debug and release builds are signed differently, so switching
# between them also means uninstalling first.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
image=sofarr-android-build
volume=sofarr-android-cache

run() {
  docker run --rm -i $([ -t 0 ] && echo -t) -v "$repo:/src" -v "$volume:/cache" --memory 2g "$@"
}

tv() {
  : "${SOFARR_TV:?set SOFARR_TV=HOST:PORT (Wireless debugging -> IP address & Port)}"
}

case "${1:-}" in
  image)
    docker build -t "$image" "$here"
    ;;
  build)
    run "$image" ./gradlew --no-daemon assembleDebug
    ls -l "$here/app/build/outputs/apk/debug/app-debug.apk"
    ;;
  release)
    run "$image" sh -c '
      set -e
      key=/cache/.android/sofarr-release.jks pw=/cache/.android/sofarr-release.password
      if [ ! -f "$key" ]; then
        head -c 24 /dev/urandom | base64 | tr -d "/+=" > "$pw" && chmod 600 "$pw"
        keytool -genkeypair -keystore "$key" -storepass "$(cat "$pw")" -keypass "$(cat "$pw")" -alias sofarr \
          -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=Sofarr" >/dev/null
      fi
      ./gradlew --no-daemon assembleRelease -Psofarr.keystore="$key" -Psofarr.keystorePassword="$(cat "$pw")"'
    ls -l "$here/app/build/outputs/apk/release/app-release.apk"
    ;;
  pair)
    [ $# -eq 3 ] || { echo "usage: $0 pair HOST:PORT CODE" >&2; exit 2; }
    run --network host "$image" adb pair "$2" "$3"
    ;;
  install)
    tv
    variant="${2:-debug}"
    run --network host -e SOFARR_TV "$image" sh -c \
      'adb connect "$SOFARR_TV" && adb -s "$SOFARR_TV" install -r "app/build/outputs/apk/$1/app-$1.apk"' sh "$variant"
    ;;
  adb)
    tv
    shift
    run --network host -e SOFARR_TV "$image" sh -c \
      'adb connect "$SOFARR_TV" > /dev/null && exec adb -s "$SOFARR_TV" "$@"' adb "$@"
    ;;
  *)
    sed -n "2,19p" "$0" >&2
    exit 2
    ;;
esac
