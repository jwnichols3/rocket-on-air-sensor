#!/usr/bin/env python3
"""Build and validate a stable Apple-signed runtime; never change the live service."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
import uuid

HERE = Path(__file__).resolve().parent
BUNDLE_ID = "com.rocket.onair.receiver"
EXECUTABLE = "OnAirReceiver"


def run(*args):
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True, check=False)
    if result.returncode:
        # codesign may print certificate subjects; keep diagnostics about the step, not identity.
        raise RuntimeError(f"{Path(str(args[0])).name} failed with status {result.returncode}")
    return result.stdout


def digest(file):
    h = hashlib.sha256()
    with Path(file).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""): h.update(chunk)
    return h.hexdigest()


def signed_requirement(path):
    result = subprocess.run(["codesign", "-d", "-r-", str(path)], capture_output=True, text=True)
    description = "\n".join(line for line in (result.stdout + result.stderr).splitlines()
                            if line.startswith("designated =>"))
    if result.returncode or "anchor apple generic" not in description:
        raise RuntimeError("Runtime must use an Apple-issued signing identity; ad-hoc signing is unsupported")
    return description


def verify(app):
    app = Path(app).resolve()
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != BUNDLE_ID or info.get("CFBundleExecutable") != EXECUTABLE:
        raise RuntimeError("Unexpected runtime bundle identity")
    run("codesign", "--verify", "--strict", "--deep", app)
    signed_requirement(app)
    signed_requirement(app / "Contents/Helpers/node")
    metadata = json.loads((app / "Contents/Resources/runtime.json").read_text())
    binary = app / "Contents/Helpers/node"
    if digest(binary) != metadata["signedNodeSha256"]:
        raise RuntimeError("Bundled runtime hash mismatch")
    dependencies = run("otool", "-L", binary)
    if "/opt/homebrew/" in dependencies or "/usr/local/" in dependencies:
        raise RuntimeError("Runtime depends on an external package-manager library")
    observed = run(app / "Contents/MacOS" / EXECUTABLE, "--version").strip()
    if observed != "v" + metadata["version"]:
        raise RuntimeError("Bundled runtime version mismatch")
    return {"bundleId": BUNDLE_ID, "nodeVersion": observed, "archiveSha256": metadata["archiveSha256"],
            "executable": str(app / "Contents/MacOS" / EXECUTABLE)}


def build(args):
    if not args.identity or args.identity == "-":
        raise RuntimeError("Select an Apple-issued identity with --identity or ONAIR_SIGNING_IDENTITY")
    target = Path(args.output).expanduser().resolve()
    if target.exists(): raise RuntimeError("Output already exists; build into a fresh staging path")
    manifest = json.loads(Path(args.manifest).read_text())
    architecture = platform.machine()
    pin = manifest["architectures"][architecture]
    if urllib.parse.urlparse(pin["url"]).scheme != "https" or len(pin["sha256"]) != 64:
        raise RuntimeError("Runtime manifest needs an HTTPS source and SHA-256 checksum")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="onair-runtime-build-", dir=str(target.parent)) as temporary:
        work = Path(temporary)
        archive = Path(args.archive).expanduser().resolve() if args.archive else work / "node.tar.gz"
        if not args.archive:
            with urllib.request.urlopen(pin["url"], timeout=60) as response, archive.open("wb") as file:
                shutil.copyfileobj(response, file)
        if digest(archive) != pin["sha256"]: raise RuntimeError("Runtime archive checksum mismatch")
        app = work / target.name
        for directory in ["MacOS", "Helpers", "Resources"]: (app / "Contents" / directory).mkdir(parents=True)
        with tarfile.open(archive) as tar:
            nodes = [entry for entry in tar.getmembers() if entry.name.endswith("/bin/node") and entry.isfile()]
            if len(nodes) != 1: raise RuntimeError("Archive must contain one regular Node executable")
            source = tar.extractfile(nodes[0])
            with (app / "Contents/Helpers/node").open("wb") as file: shutil.copyfileobj(source, file)
        node = app / "Contents/Helpers/node"
        node.chmod(0o755)
        if run(node, "--version").strip() != "v" + manifest["version"]: raise RuntimeError("Archive version mismatch")
        info = plistlib.loads((HERE / "Info.plist.template").read_bytes())
        info.update(CFBundleVersion=manifest["version"], CFBundleShortVersionString=manifest["version"])
        (app / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
        shutil.copy2(HERE / "probe.mjs", app / "Contents/Resources/probe.mjs")
        run("xcrun", "swiftc", "-swift-version", "5", "-O", HERE / "Launcher.swift", "-o", app / "Contents/MacOS" / EXECUTABLE)
        run("codesign", "--force", "--sign", args.identity, "--identifier", BUNDLE_ID + ".runtime", node)
        (app / "Contents/Resources/runtime.json").write_text(json.dumps({
            "version": manifest["version"], "architecture": architecture,
            "archiveSha256": pin["sha256"], "source": pin["url"], "signedNodeSha256": digest(node),
        }, indent=2) + "\n")
        run("codesign", "--force", "--sign", args.identity, "--identifier", BUNDLE_ID, app)
        verify(app)
        app.rename(target)
    return verify(target)


def install(args):
    source = Path(args.app).resolve()
    verify(source)
    destination = Path(args.destination).expanduser().resolve()
    if source == destination: return verify(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = destination.with_name(destination.name + ".next-" + uuid.uuid4().hex)
    previous = destination.with_name(destination.name + ".previous")
    if previous.exists(): raise RuntimeError("Previous runtime backup exists; preserve or archive it before another replacement")
    shutil.copytree(source, stage)
    verify(stage)
    had_destination = destination.exists()
    signals = [signal.SIGINT, signal.SIGTERM]
    handlers = {number: signal.getsignal(number) for number in signals}
    def interrupted(number, _frame):
        raise SystemExit(128 + number)
    for number in signals: signal.signal(number, interrupted)
    try:
        if had_destination: destination.rename(previous)
        stage.rename(destination)
        result = verify(destination)
        # Registration is not a service start and does not grant Local Network access.
        run("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-f", destination)
    except BaseException:
        # Finish restoring the original before accepting another interruption. Inspect
        # the filesystem, not a flag assigned after rename: a signal can arrive between
        # the successful rename and that assignment.
        for number in signals: signal.signal(number, signal.SIG_IGN)
        if previous.exists():
            if destination.exists(): destination.rename(stage)
            previous.rename(destination)
        elif not had_destination and destination.exists():
            destination.rename(stage)
        raise
    finally:
        for number, handler in handlers.items(): signal.signal(number, handler)
    return {**result, "previous": str(previous) if had_destination else None}


def probe(args):
    if os.getuid() == 0:
        raise RuntimeError("Run the permission probe as the logged-in service user, not root")
    app = Path(args.app).resolve()
    verify(app)
    url = urllib.parse.urlparse(args.url)
    if url.scheme not in ["http", "https"] or not url.hostname or url.username or url.password:
        raise RuntimeError("Probe needs an HTTP(S) URL without credentials")
    uid = os.getuid()
    label = "com.rocket.onair.probe." + uuid.uuid4().hex
    directory = Path(tempfile.mkdtemp(prefix="onair-runtime-probe-"))
    plist = directory / "probe.plist"
    log = directory / "probe.log"
    plist.write_bytes(plistlib.dumps({
        "Label": label, "ProgramArguments": [str(app / "Contents/MacOS" / EXECUTABLE), "--probe", args.url],
        "AssociatedBundleIdentifiers": [BUNDLE_ID], "RunAtLoad": True,
        "ExitTimeOut": 10, "AbandonProcessGroup": False,
        "StandardOutPath": str(log), "StandardErrorPath": str(log),
    }))
    target = f"gui/{uid}/{label}"
    loaded = False
    try:
        run("launchctl", "bootstrap", f"gui/{uid}", plist); loaded = True
        print(json.dumps({"probe": target, "log": str(log), "waiting": "Allow the normal On Air Receiver Local Network prompt if shown"}), flush=True)
        import time
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if log.exists():
                for line in log.read_text(errors="replace").splitlines():
                    try: result = json.loads(line)
                    except ValueError: continue
                    if "ok" in result:
                        if not result["ok"]: raise RuntimeError("Supervised Node GET failed: " + json.dumps(result))
                        return {**result, "log": str(log)}
            time.sleep(0.25)
        raise RuntimeError("Probe timed out; inspect " + str(log))
    finally:
        if loaded: subprocess.run(["launchctl", "bootout", target], capture_output=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    p = commands.add_parser("build")
    p.add_argument("--identity", default=os.environ.get("ONAIR_SIGNING_IDENTITY"))
    p.add_argument("--output", required=True)
    p.add_argument("--archive")
    p.add_argument("--manifest", default=str(HERE / "runtime.json"))
    p = commands.add_parser("verify"); p.add_argument("app"); p.add_argument("--quiet", action="store_true")
    p = commands.add_parser("install"); p.add_argument("app"); p.add_argument("--destination", default=str(Path.home() / "Applications/On Air Receiver.app"))
    p = commands.add_parser("probe"); p.add_argument("app"); p.add_argument("url")
    args = parser.parse_args()
    if sys.platform != "darwin": parser.error("The native runtime is for macOS")
    try:
        result = verify(args.app) if args.command == "verify" else globals()[args.command](args)
        if not getattr(args, "quiet", False): print(json.dumps(result))
    except (OSError, ValueError, KeyError, RuntimeError, tarfile.TarError) as error:
        print("onair-runtime: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__": raise SystemExit(main())
