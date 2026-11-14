import groovy.json.JsonSlurper

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// One version for the whole project: the app ships with the server's version.
val sofarrVersion = (JsonSlurper().parse(rootDir.resolve("../server/package.json")) as Map<*, *>)["version"] as String
val (major, minor, patch) = sofarrVersion.split(".").map { it.takeWhile(Char::isDigit).toInt() }

android {
    namespace = "io.github.chmodr.sofarr"
    compileSdk = 37

    defaultConfig {
        applicationId = "io.github.chmodr.sofarr"
        minSdk = 34 // Google TV Streamer (Android TV 14) is the only target.
        targetSdk = 36
        versionCode = major * 10_000 + minor * 100 + patch
        versionName = sofarrVersion
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.foundation)
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.tv.material)
    implementation(libs.activity.compose)
    implementation(libs.core.ktx)
    implementation(libs.okhttp)
    implementation(libs.serialization.json)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.exoplayer.hls)
    implementation(libs.media3.ui)
    implementation(libs.coil.compose)
    implementation(libs.coil.okhttp)
}
