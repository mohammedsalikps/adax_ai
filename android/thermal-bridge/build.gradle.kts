// NOT COMPILED, NOT RUN on hardware. No Android SDK, JDK or Gradle was available when this was written; the plugin versions come from
// the root project the integrator creates (see android/README.md), and every value below must be checked when it is first built.
//
// The FLIR Atlas Android SDK is not in any public Maven repository. It is downloaded from FLIR after creating a free developer account
// and accepting FLIR's online licence, and it must not be committed to this repository. Put the SDK's .aar files in
// android/thermal-bridge/libs/ (git-ignored; see android/README.md).
//
// The bridge compiles against them (compileOnly) and the host app packages them (implementation): the Android Gradle plugin refuses to
// build a library AAR with direct local .aar dependencies, and the SDK's native libraries must end up in the app.

import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  id("com.android.library")
  // The Kotlin Android plugin, 2.x (its version is set in the root project). With Android Gradle plugin 9.0 or later, which builds
  // Kotlin itself ("built-in Kotlin", on by default), remove this line: AGP 9 refuses to apply it. The kotlin {} block below stays.
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "ai.adaxai.thermal"
  compileSdk = 34

  defaultConfig {
    // Check against the minSdkVersion in the FLIR SDK's own AAR manifest: the manifest merger fails if this is lower.
    minSdk = 26
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

// Kotlin compiles for Java 17 too. Not `android { kotlinOptions { jvmTarget = "17" } }`: Kotlin 2.2.0 "raises the deprecation level of
// the kotlinOptions{} block in Gradle to error"; this compilerOptions block is its replacement in Kotlin's migration guide.
kotlin {
  compilerOptions {
    jvmTarget.set(JvmTarget.JVM_17)
  }
}

dependencies {
  // The FLIR Atlas Android SDK (licence-gated download; file names as in the downloaded archive, not assumed here).
  compileOnly(fileTree(mapOf("dir" to "libs", "include" to listOf("*.aar"))))
}
