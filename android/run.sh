#!/usr/bin/env bash
# Build and install the Sofarr Android TV app using Docker only (nothing installed on the host).
#
#   ./run.sh image                    build the build-environment image (sofarr-android-build)
#   ./run.sh build                    build the debug APK -> app/build/outputs/apk/debug/app-debug.apk
#   ./run.sh pair HOST:PORT CODE      pair with the TV once (Developer options -> Wireless debugging ->
#                                     "Pair device with pairing code" shows HOST:PORT and CODE)
#   SOFARR_TV=HOST:PORT ./run.sh install
#                                     install the APK on the TV (HOST:PORT is the "IP address & Port"
#                                     on the Wireless debugging screen; the port changes when it's toggled)
#   SOFARR_TV=HOST:PORT ./run.sh adb ARGS...
#                                     any other adb command (logcat, shell, ...)
#
# Gradle downloads, the debug signing key and the adb pairing key live in the Docker volume
# sofarr-android-cache. Keep it: a new signing key means uninstalling the app before the next install.
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
  pair)
    [ $# -eq 3 ] || { echo "usage: $0 pair HOST:PORT CODE" >&2; exit 2; }
    run --network host "$image" adb pair "$2" "$3"
    ;;
  install)
    tv
    run --network host -e SOFARR_TV "$image" sh -c \
      'adb connect "$SOFARR_TV" && adb -s "$SOFARR_TV" install -r app/build/outputs/apk/debug/app-debug.apk'
    ;;
  adb)
    tv
    shift
    run --network host -e SOFARR_TV "$image" sh -c \
      'adb connect "$SOFARR_TV" > /dev/null && exec adb -s "$SOFARR_TV" "$@"' adb "$@"
    ;;
  *)
    sed -n '2,18p' "$0" >&2
    exit 2
    ;;
esac
