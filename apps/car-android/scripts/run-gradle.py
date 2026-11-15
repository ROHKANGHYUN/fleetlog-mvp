#!/usr/bin/env python3
"""Run exactly Gradle 8.10.2. Does not download software automatically."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
GRADLE_VERSION = "8.10.2"


def main():
    suffix = ".bat" if os.name == "nt" else ""
    java = str(Path(os.environ["JAVA_HOME"]) / "bin" / ("java.exe" if os.name == "nt" else "java")) if os.environ.get("JAVA_HOME") else shutil.which("java")
    if not java:
        sys.exit("JDK 17 is required. Install it and set JAVA_HOME.")
    result = subprocess.run([java, "-version"], capture_output=True, text=True, timeout=15)
    version = re.search(r'version\s+"(\d+)', result.stderr + result.stdout)
    if result.returncode or not version or version.group(1) != "17":
        sys.exit("This starter pins JDK 17. Set JAVA_HOME to your JDK 17 installation; Java 21 alone is not this baseline.")
    local = ROOT / ".bootstrap" / f"gradle-{GRADLE_VERSION}" / "bin" / f"gradle{suffix}"
    executable = str(local) if local.is_file() else shutil.which(f"gradle{suffix}")
    if not executable:
        sys.exit("Gradle 8.10.2 is missing. Run: python3 scripts/bootstrap-gradle.py\nNo official wrapper jar is included.")
    version_result = subprocess.run([executable, "--version"], cwd=ROOT, capture_output=True, text=True, timeout=45)
    if version_result.returncode or not re.search(r"^Gradle 8\.10\.2\s*$", version_result.stdout, re.MULTILINE):
        sys.exit("Gradle version check failed. Use exactly 8.10.2; see README.md.")
    raise SystemExit(subprocess.call([executable, *sys.argv[1:]], cwd=ROOT))


if __name__ == "__main__":
    main()
