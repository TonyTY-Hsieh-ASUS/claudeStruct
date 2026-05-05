// Project-level Gradle config for the claudeStruct JetBrains plugin
// (W7.2). Mirrors the W7.1 VS Code extension's "sideload-only first"
// posture — we don't publish to the JetBrains Marketplace yet; users
// build a .zip via `./gradlew buildPlugin` and install it via
// File > Settings > Plugins > ⚙ > "Install Plugin from Disk…".
//
// IntelliJ Platform Gradle Plugin 2.x (the modern one) targets the
// 2024.x platform line and pulls in everything else (kotlin-stdlib,
// the Platform SDK, JUnit harness) transitively. Keeping the build
// minimal so a Kotlin developer can read the file end-to-end without
// hunting through transitive plugin docs.

plugins {
    kotlin("jvm") version "1.9.25"
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = "dev.claudestruct"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        // 2024.2 is the floor we target — covers IntelliJ IDEA
        // 2024.2+, PyCharm 2024.2+, WebStorm 2024.2+, GoLand 2024.2+,
        // RubyMine 2024.2+, etc. Bumping the floor is a follow-up
        // when JetBrains drops 2024.2 support; the actions don't
        // touch any 2024.3+ APIs today.
        intellijIdeaCommunity("2024.2")
        // Plugin verifier ships with the platform plugin — no extra
        // dep needed for `./gradlew verifyPlugin`.
    }
    testImplementation("org.jetbrains.kotlin:kotlin-test")
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "242"  // 2024.2
            // No `untilBuild` so the plugin keeps loading on newer
            // platform versions until something genuinely breaks —
            // a hard upper bound is hostile to operators that pin
            // claudeStruct in their IDE.
            untilBuild = provider { null }
        }
    }
}

kotlin {
    // Use the JDK the build env provides. JDK 21 is the OpenJDK
    // LTS most distros ship today; the 2024.2 IntelliJ Platform
    // accepts 17+ so 21 stays compatible. If a contributor only
    // has 17, drop this to `jvmToolchain(17)`.
    jvmToolchain(21)
}

tasks {
    // Reproducible JAR — same input → byte-identical .zip across
    // builds. Helps when chasing "why did the install ZIP change"
    // without a code diff.
    jar {
        isPreserveFileTimestamps = false
        isReproducibleFileOrder = true
    }
}
