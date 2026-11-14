# Build environment for the Sofarr Android TV app: JDK + Android SDK + adb.
# Used by ./run.sh; nothing Android-related is installed on the host.
FROM eclipse-temurin:21-jdk-noble

ARG CMDLINE_TOOLS=16111833
ARG CMDLINE_TOOLS_SHA1=e025545c62a8e64c7559119566a569fb1dec5f60
ENV ANDROID_HOME=/opt/android-sdk

RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSLo /tmp/tools.zip "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip" \
 && echo "${CMDLINE_TOOLS_SHA1}  /tmp/tools.zip" | sha1sum -c - \
 && mkdir -p "$ANDROID_HOME/cmdline-tools" \
 && unzip -q /tmp/tools.zip -d "$ANDROID_HOME/cmdline-tools" \
 && mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" \
 && rm /tmp/tools.zip

ENV PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# Keep in step with compileSdk / AGP in the Gradle build.
RUN yes | sdkmanager --licenses > /dev/null \
 && sdkmanager --install "platform-tools" "platforms;android-37.0" "build-tools;37.0.0" > /dev/null \
 && chown -R 1000:1000 "$ANDROID_HOME"

# The run script mounts a cache volume here (Gradle downloads, debug signing key, adb pairing key).
ENV GRADLE_USER_HOME=/cache/gradle ANDROID_USER_HOME=/cache/.android HOME=/cache
RUN mkdir -p /cache && chown 1000:1000 /cache
USER 1000:1000
WORKDIR /src/android
