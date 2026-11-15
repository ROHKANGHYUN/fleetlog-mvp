#!/usr/bin/env python3
"""Install a pinned Gradle distribution after verifying its official SHA-256 checksum.

Explicit opt-in download. The generated ZIP does not contain a wrapper jar or Gradle binary.
Uses only Python's standard library. Requires network access to official Gradle distribution hosts.
"""
import hashlib
import os
from pathlib import Path
import re
import shutil
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = "8.10.2"
NAME = f"gradle-{VERSION}-bin.zip"
BASE = "https://services.gradle.org/distributions/"


def main():
    target = ROOT / ".bootstrap"
    target.mkdir(exist_ok=True)
    installed = target / f"gradle-{VERSION}"
    if installed.exists():
        print(f"Already present: {installed}. run-gradle.py will check its version.")
        return
    with urllib.request.urlopen(BASE + NAME + ".sha256", timeout=30) as response:
        expected = response.read(1024).decode("ascii").strip().lower()
    if not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise RuntimeError("Official checksum response was not a SHA-256 value; refusing download.")
    with tempfile.TemporaryDirectory(prefix="gradle-download-", dir=target) as working:
        archive = Path(working) / NAME
        digest = hashlib.sha256()
        count = 0
        with urllib.request.urlopen(BASE + NAME, timeout=60) as response, archive.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                count += len(chunk)
                if count > 256 * 1024 * 1024:
                    raise RuntimeError("Unexpected distribution size; download stopped.")
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != expected:
            raise RuntimeError("Checksum mismatch; nothing will be installed.")
        extraction = Path(working) / "extracted"
        extraction.mkdir()
        with zipfile.ZipFile(archive) as zf:
            for item in zf.infolist():
                location = (extraction / item.filename).resolve()
                if extraction.resolve() not in location.parents:
                    raise RuntimeError("Unsafe archive path; nothing will be installed.")
            zf.extractall(extraction)
        source = extraction / f"gradle-{VERSION}"
        if not (source / "bin" / "gradle").is_file():
            raise RuntimeError("Unexpected distribution layout.")
        if os.name != "nt":
            (source / "bin" / "gradle").chmod(0o755)
        shutil.move(str(source), installed)
        (target / f"{NAME}.sha256").write_text(expected + "\n", encoding="ascii")
    print(f"Verified Gradle {VERSION} installed. Next: ./gradlew :app:assembleDebug")


if __name__ == "__main__":
    main()
