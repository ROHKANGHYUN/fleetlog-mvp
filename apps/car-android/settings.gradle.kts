pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google(); mavenCentral()
        // Official public Vehicle SDK repository; used only by the explicit SDK probe build.
        if (providers.gradleProperty("pleosSdk").orNull == "true") {
            maven("https://nexus-playground.pleos.ai/repository/maven-releases/")
        }
    }
}
rootProject.name = "FleetLogCarMock"
include(":app")
