#!/usr/bin/env python3
"""Read-only Android build/runtime inventory; never installs, wipes or picks a device.

Network metadata is opt-in. --probe-adb may start the standard adb daemon; the
default invocation does not. Device details require an explicit --serial.
"""
import argparse
import io
import json
import os
from pathlib import Path
import platform
import re
import shutil
import ssl
import subprocess
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CATALOG = "https://dl.google.com/android/repository/repository2-3.xml"
IMAGE_CATALOG = "https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml"


def run(argv, timeout=20):
    try:
        result = subprocess.run(argv, text=True, capture_output=True, timeout=timeout)
        return {"exit_code": result.returncode, "stdout": result.stdout.strip(), "stderr": result.stderr.strip()}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"exit_code": None, "error": str(error)}


def existing_parent(path):
    while not path.exists() and path != path.parent:
        path = path.parent
    return path


def disk(path):
    existing = existing_parent(path)
    usage = shutil.disk_usage(existing)
    return {"requested_path": str(path), "measured_path": str(existing), "free_bytes": usage.free,
            "total_bytes": usage.total, "used_bytes": usage.used}


def package_inventory(sdk):
    packages = []
    candidates = [sdk / "platform-tools" / "package.xml", sdk / "emulator" / "package.xml"]
    for folder in ["platforms", "build-tools", "cmdline-tools"]:
        candidates.extend((sdk / folder).glob("*/package.xml"))
    candidates.extend((sdk / "system-images").glob("*/*/*/package.xml"))
    for path in candidates:
        if not path.is_file():
            continue
        try:
            root = ET.parse(path).getroot()
            local = next(node for node in root.iter() if node.tag.split("}")[-1] == "localPackage")
            revision = next((node for node in local if node.tag.split("}")[-1] == "revision"), None)
            packages.append({"path": local.get("path"), "revision": ".".join(node.text or "0" for node in revision) if revision is not None else None,
                             "metadata": str(path)})
        except (ET.ParseError, StopIteration, OSError) as error:
            packages.append({"metadata": str(path), "error": str(error)})
    return packages


def tls_context():
    # Use a verified system CA bundle when a standalone macOS Python lacks one.
    bundle = Path("/etc/ssl/cert.pem")
    return ssl.create_default_context(cafile=str(bundle)) if bundle.is_file() else ssl.create_default_context()


def read_catalog(url, context):
    with urllib.request.urlopen(url, timeout=25, context=context) as response:
        data = response.read(4 * 1024 * 1024 + 1)
    if len(data) > 4 * 1024 * 1024:
        raise ValueError("catalog size exceeds the metadata read limit")
    return ET.fromstring(data)


def select_archive(root, package, host_os, host_arch):
    choices = []
    for node in root.findall("remotePackage"):
        if node.get("path") != package:
            continue
        channel = node.find("channelRef")
        if channel is not None and channel.get("ref") != "channel-0":
            continue
        revision = tuple(int(child.text or "0") for child in node.findall("./revision/*"))
        for archive in node.findall("./archives/archive"):
            if archive.findtext("host-os") not in [None, host_os] or archive.findtext("host-arch") not in [None, host_arch]:
                continue
            choices.append((revision, {"package": package, "revision": ".".join(map(str, revision)),
                                       "compressed_archive_bytes": int(archive.findtext("./complete/size")),
                                       "relative_url": archive.findtext("./complete/url")}))
    if not choices:
        raise ValueError(f"No stable archive for {package}, {host_os}/{host_arch}")
    return max(choices, key=lambda item: item[0])[1]


class RemoteZip(io.RawIOBase):
    """Fetch only bounded ZIP directory ranges, never whole package contents."""
    def __init__(self, url, size, context):
        self.url, self.size, self.context, self.position, self.downloaded = url, size, context, 0, 0

    def seekable(self):
        return True

    def seek(self, offset, whence=0):
        self.position = offset if whence == 0 else self.position + offset if whence == 1 else self.size + offset
        return self.position

    def tell(self):
        return self.position

    def read(self, size=-1):
        size = min(self.size - self.position, self.size - self.position if size < 0 else size)
        if size <= 0:
            return b""
        if size > 8 * 1024 * 1024 or self.downloaded + size > 16 * 1024 * 1024:
            raise ValueError("ZIP directory metadata read limit exceeded")
        start, end = self.position, self.position + size - 1
        request = urllib.request.Request(self.url, headers={"Range": f"bytes={start}-{end}", "Accept-Encoding": "identity"})
        with urllib.request.urlopen(request, timeout=25, context=self.context) as response:
            if response.status != 206 or response.headers.get("Content-Range") != f"bytes {start}-{end}/{self.size}":
                raise ValueError("Server did not honor the exact bounded Range; package download skipped")
            data = response.read(size + 1)
        if len(data) != size:
            raise ValueError("Unexpected metadata range length")
        self.position += size
        self.downloaded += size
        return data


def archive_size(info, base_url, context):
    url = urllib.request.urljoin(base_url, info["relative_url"])
    remote = RemoteZip(url, info["compressed_archive_bytes"], context)
    with zipfile.ZipFile(remote) as archive:
        entries = archive.infolist()
    return {**info, "url": url, "uncompressed_logical_bytes": sum(entry.file_size for entry in entries),
            "entries": len(entries), "metadata_download_bytes": remote.downloaded}


def inventory(args):
    sdk = Path(args.sdk_root or os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT") or Path.home() / "Library/Android/sdk").expanduser().resolve()
    avd = Path(args.avd_home or os.environ.get("ANDROID_AVD_HOME") or Path.home() / ".android/avd").expanduser().resolve()
    java_home = args.java_home or os.environ.get("JAVA_HOME")
    java = str(Path(java_home) / "bin/java") if java_home else shutil.which("java")
    java_result = run([java, "-version"]) if java else {"error": "Java executable not found"}
    match = re.search(r'version\s+"(\d+)', java_result.get("stderr", "") + java_result.get("stdout", ""))
    gradle = ROOT / ".bootstrap/gradle-8.10.2/bin/gradle"
    executable = str(gradle) if gradle.is_file() else shutil.which("gradle")
    components = {name: (sdk / relative).is_file() for name, relative in {
        "platform_35": "platforms/android-35/android.jar", "aapt2_35": "build-tools/35.0.0/aapt2",
        "adb": "platform-tools/adb", "emulator": "emulator/emulator"}.items()}
    components["sdkmanager"] = any((sdk / "cmdline-tools").glob("*/bin/sdkmanager"))
    components["avdmanager"] = any((sdk / "cmdline-tools").glob("*/bin/avdmanager"))
    avds = [{"name": item.stem, "ini_path": str(item)} for item in sorted(avd.glob("*.ini"))]
    result = {"no_app_data_modification": True, "package_install_attempted": False,
              "host": {"system": platform.system(), "machine": platform.machine()},
              "sdk_root": str(sdk), "avd_home": str(avd), "java": {"executable": java, "major": int(match.group(1)) if match else None, **java_result},
              "gradle": {"launcher": str(ROOT / "gradlew"), "kind": "Python launcher, not an official wrapper", "candidate": executable, "required_version": "8.10.2", "version_verified": False},
              "components": components, "installed_packages": package_inventory(sdk), "registered_avds": avds,
              "disks": {"sdk": disk(sdk), "avd": disk(avd), "project": disk(ROOT)},
              "devices": {"probed": False, "selected_serial": args.serial, "items": []},
              "build_prerequisites_found": bool(java_result.get("exit_code") == 0 and match and match.group(1) == "17" and executable and components["platform_35"] and components["aapt2_35"]),
              "android_runtime": "unconfirmed", "pleos_service": "unconfirmed", "blockers": []}
    if not components["emulator"]:
        result["blockers"].append("No emulator executable; an empty emulator directory is not an installation")
    if not avds:
        result["blockers"].append("No registered AVD; no device is auto-created or selected")
    if args.probe_adb:
        if not components["adb"]:
            result["devices"]["error"] = "adb is not installed"
            result["blockers"].append("Device inventory unavailable: adb is not installed")
        else:
            probe = run([str(sdk / "platform-tools/adb"), "devices", "-l"])
            result["devices"].update({"probed": True, "command_exit_code": probe["exit_code"]})
            if probe["exit_code"] != 0:
                result["devices"]["error"] = probe.get("error") or probe.get("stderr") or "adb inventory failed"
                result["blockers"].append("Device inventory failed; this is not an empty connected-device list")
                return add_metadata(result, args)
            devices = []
            for line in probe.get("stdout", "").splitlines():
                if not line.strip() or line.startswith("List of devices"):
                    continue
                pieces = line.split()
                if len(pieces) >= 2:
                    devices.append({"serial": pieces[0], "state": pieces[1]})
            result["devices"].update({"probed": True, "items": devices, "command_exit_code": probe["exit_code"]})
            selected = next((device for device in devices if device["serial"] == args.serial and device["state"] == "device"), None)
            if selected:
                detail = run([str(sdk / "platform-tools/adb"), "-s", args.serial, "shell", "getprop", "ro.build.version.sdk"])
                result["devices"]["selected_api"] = detail.get("stdout")
                result["android_runtime"] = "explicit-device-selected" if detail.get("exit_code") == 0 and detail.get("stdout", "").isdigit() and int(detail["stdout"]) >= 28 else "incompatible-or-unconfirmed"
            elif devices and not args.serial:
                result["blockers"].append("Device selection required: pass --serial for a known test device; none was auto-selected")
            elif not devices:
                result["blockers"].append("No connected device reported by adb")
            else:
                result["blockers"].append("Explicit serial is absent, offline or unauthorized")
    else:
        result["blockers"].append("Device inventory not probed; --probe-adb is opt-in and may start the adb daemon")
    return add_metadata(result, args)


def add_metadata(result, args):
    if args.metadata:
        try:
            context = tls_context()
            host_os = {"Darwin": "macosx", "Linux": "linux", "Windows": "windows"}.get(platform.system(), platform.system().lower())
            host_arch = {"arm64": "aarch64", "x86_64": "x64"}.get(platform.machine(), platform.machine())
            emulator = archive_size(select_archive(read_catalog(CATALOG, context), "emulator", host_os, host_arch), "https://dl.google.com/android/repository/", context)
            image_name = f"system-images;android-{args.api};default;arm64-v8a" if host_arch == "aarch64" else f"system-images;android-{args.api};default;x86_64"
            image = archive_size(select_archive(read_catalog(IMAGE_CATALOG, context), image_name, host_os, host_arch), "https://dl.google.com/android/repository/sys-img/android/", context)
            logical = emulator["uncompressed_logical_bytes"] + image["uncompressed_logical_bytes"]
            result["download_metadata"] = {"catalogs": [CATALOG, IMAGE_CATALOG], "emulator": emulator, "image": image,
                "uncompressed_logical_sum_bytes": logical,
                "compressed_sum_bytes": emulator["compressed_archive_bytes"] + image["compressed_archive_bytes"],
                "regular_extraction_fits_sdk_free_space": logical <= result["disks"]["sdk"]["free_bytes"],
                "avd_userdata_cache_snapshot_extra_bytes": None,
                "note": "ZIP directory logical sizes are measured metadata, not a complete physical installation forecast. Filesystem sparse/compression effects and AVD runtime storage are unmeasured; no package was installed."}
        except Exception as error:
            result["download_metadata"] = {"error": str(error), "classification": "metadata-check-failed", "package_install_attempted": False}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-root")
    parser.add_argument("--java-home")
    parser.add_argument("--avd-home")
    parser.add_argument("--probe-adb", action="store_true", help="Explicitly run adb devices; may start its standard daemon")
    parser.add_argument("--serial", help="Known test serial; never chooses a device implicitly")
    parser.add_argument("--metadata", action="store_true", help="Read official catalogs and bounded ZIP directory ranges; no package install")
    parser.add_argument("--api", type=int, choices=range(28, 36), default=35)
    args = parser.parse_args()
    print(json.dumps(inventory(args), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
