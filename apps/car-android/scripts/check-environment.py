#!/usr/bin/env python3
"""Read-only baseline check. No downloads, SDK license acceptance, or settings changes."""
import os
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
failures = []
java = str(Path(os.environ["JAVA_HOME"]) / "bin" / ("java.exe" if os.name == "nt" else "java")) if os.environ.get("JAVA_HOME") else shutil.which("java")
if java:
    try:
        output = subprocess.run([java, "-version"], text=True, capture_output=True, timeout=15)
        match = re.search(r'version\s+"(\d+)', output.stderr + output.stdout)
        if not match or match.group(1) != "17":
            failures.append("JDK 17 is required (set JAVA_HOME).")
    except (OSError, subprocess.TimeoutExpired):
        failures.append("Could not run Java.")
else:
    failures.append("Java was not found.")

sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
if not sdk:
    failures.append("Set ANDROID_HOME to an installed Android SDK. This check does not parse local.properties.")
else:
    for relative in ["platforms/android-35/android.jar", "build-tools/35.0.0"]:
        if not (Path(sdk) / relative).exists():
            failures.append("Missing Android SDK component: " + relative)

gradle_name = "gradle.bat" if os.name == "nt" else "gradle"
local = ROOT / ".bootstrap" / "gradle-8.10.2" / "bin" / gradle_name
if not local.is_file() and not shutil.which(gradle_name):
    failures.append("Gradle 8.10.2 missing; explicitly run scripts/bootstrap-gradle.py or install that version.")

if failures:
    print("ANDROID BUILD NOT READY:")
    for failure in failures:
        print("- " + failure)
    raise SystemExit(1)
print("Baseline prerequisites found. ./gradlew will verify the exact Gradle version. APK build still needs to be run.")
