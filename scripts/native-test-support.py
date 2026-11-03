"""Share only AgentCore compilation, never the native regression harnesses."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import uuid

CORE_FLAGS = (
    "-swift-version", "6", "-parse-as-library", "-emit-module", "-emit-library",
    "-module-name", "AgentCore",
    "-Xlinker", "-install_name", "-Xlinker", "@rpath/libAgentCore.dylib",
)
COMPILER_ENV = (
    "DEVELOPER_DIR", "SDKROOT", "TOOLCHAINS", "MACOSX_DEPLOYMENT_TARGET",
    "CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "LIBRARY_PATH",
)


def add_core_arguments(parser):
    parser.add_argument("--fresh-core", action="store_true",
                        help="Rebuild AgentCore even if a matching cached build exists")


def core_link_flags(core):
    return ["-I", core, "-L", core, "-lAgentCore", "-Xlinker", "-rpath", "-Xlinker", core]


def build_agent_core(root, *, fresh=False, flags=CORE_FLAGS):
    root = Path(root).resolve()
    sources = sorted((root / "Packages/PortalsKit/Sources/AgentCore").glob("*.swift"))
    if not sources:
        raise RuntimeError("AgentCore sources not found")
    compiler = shutil.which("swiftc")
    if compiler is None:
        raise RuntimeError("swiftc not found")

    def output(command):
        return subprocess.check_output(command, text=True, stderr=subprocess.STDOUT).strip()

    sdk = os.environ.get("SDKROOT") or output(["xcrun", "--sdk", "macosx", "--show-sdk-path"])
    settings = Path(sdk) / "SDKSettings.json"
    # Hash and compile the same bytes, even if originals change while we wait.
    source_inputs = [(path, path.read_bytes()) for path in sources]
    identity = {
        "format": 2,
        "sources": [(str(path), hashlib.sha256(data).hexdigest()) for path, data in source_inputs],
        "compiler": compiler,
        "compiler_stat": (Path(compiler).stat().st_size, Path(compiler).stat().st_mtime_ns),
        "version": output([compiler, "--version"]),
        "target": output([compiler, "-print-target-info"]),
        "architecture": platform.machine(),
        "sdk": sdk,
        "sdk_build": output(["xcrun", "--sdk", "macosx", "--show-sdk-build-version"]),
        "sdk_settings": hashlib.sha256(settings.read_bytes()).hexdigest() if settings.exists() else None,
        "environment": {name: os.environ.get(name) for name in COMPILER_ENV},
        "flags": [*flags, "-sdk", sdk],
    }
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    cache = root / ".build/native-agent-core"
    cache.mkdir(parents=True, exist_ok=True)
    # Lock files outlive builds: removing one could give a waiter a different lock.
    with (cache / f"{key}.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        entry = cache / key
        entry.mkdir(exist_ok=True)
        current = entry / "current"
        artifacts = ("AgentCore.swiftmodule", "libAgentCore.dylib")
        if not fresh and all((current / name).is_file() for name in artifacts):
            print("AgentCore: cached", flush=True)
            return current.resolve()

        print("AgentCore: building", flush=True)
        with tempfile.TemporaryDirectory(prefix=".building-", dir=entry) as temporary:
            staging = Path(temporary)
            snapshot = staging / "sources"
            snapshot.mkdir()
            snapshot_sources = []
            for path, data in source_inputs:
                copied = snapshot / path.name
                copied.write_bytes(data)
                snapshot_sources.append(str(copied))
            subprocess.run([compiler, *flags, "-sdk", sdk, *snapshot_sources,
                            "-emit-module-path", str(staging / "AgentCore.swiftmodule"),
                            "-o", str(staging / "libAgentCore.dylib")], check=True)
            if not all((staging / name).is_file() for name in artifacts):
                raise RuntimeError("AgentCore compiler did not produce the module and library")
            (staging / "identity.json").write_text(json.dumps(identity, sort_keys=True, indent=2) + "\n")
            # Generations remain valid for harnesses already linked to them, even
            # when another launcher forces a rebuild. Publish only complete builds.
            generation = entry / f"build-{uuid.uuid4().hex}"
            staging.rename(generation)
        pending = entry / f".current-{uuid.uuid4().hex}"
        try:
            pending.symlink_to(generation.name, target_is_directory=True)
            pending.replace(current)
        finally:
            pending.unlink(missing_ok=True)
        return generation
