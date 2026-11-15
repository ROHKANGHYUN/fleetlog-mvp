plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "io.fleetlog.demo"
    compileSdk = 35
    defaultConfig {
        applicationId = "io.fleetlog.demo"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0-mock"
    }
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildTypes { release { isMinifyEnabled = false } }
    testOptions.unitTests.all {
        it.systemProperty("fleetlog.repoRoot", rootProject.projectDir.parentFile.parentFile.absolutePath)
    }
    if (providers.gradleProperty("pleosSdk").orNull == "true") {
        useLibrary("android.car")
        sourceSets.getByName("debug").java.srcDir("src/pleos/java")
        sourceSets.getByName("debug").manifest.srcFile("src/pleos/AndroidManifest.xml")
        sourceSets.getByName("testDebug").java.srcDir("src/pleosTest/java")
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    if (providers.gradleProperty("pleosSdk").orNull == "true") {
        implementation("ai.pleos.playground:Vehicle:2.3.2")
    }
}
