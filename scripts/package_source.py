"""Package committed CareerLens source, or verify an extracted source manifest."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import re
import zipfile

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = "SOURCE-MANIFEST.json"
REQUIRED = {
    "README.md", "LICENSE", "compose.yaml", "compose.hosted.yaml",
    ".env.hosted.example", "app/Dockerfile", "scripts/setup.sh", "scripts/dev.sh",
    "docs/系统运行说明.md", "docs/配置与依赖说明.md", "docs/验证说明.md",
    "app/apps/backend/pyproject.toml", "app/apps/backend/uv.lock",
    "app/apps/backend/.env.example", "app/apps/frontend/package.json",
    "app/apps/frontend/package-lock.json", "app/apps/frontend/.env.example",
}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(ROOT), *args])


def verify(folder: Path) -> None:
    folder = folder.resolve()
    manifest = json.loads((folder / MANIFEST).read_text(encoding="utf-8"))
    files = manifest["files"]
    if not REQUIRED.issubset(files):
        raise ValueError("Manifest is missing required project files")
    for name, expected in files.items():
        path = (folder / name).resolve()
        if not path.is_relative_to(folder) or not path.is_file():
            raise ValueError(f"Missing or invalid path: {name}")
        if digest(path.read_bytes()) != expected:
            raise ValueError(f"Checksum mismatch: {name}")
    print(f"Verified {len(files)} files, commit {manifest['commit']}")


def package() -> None:
    if git("status", "--porcelain", "--untracked-files=all").strip():
        raise SystemExit("Commit or remove pending source changes before packaging.")
    commit = git("rev-parse", "HEAD").decode().strip()
    archive = git("archive", "--format=zip", "--prefix=CareerLens/", commit)
    with zipfile.ZipFile(io.BytesIO(archive)) as source:
        entries = {
            item.filename.removeprefix("CareerLens/"): source.read(item)
            for item in source.infolist() if not item.is_dir()
        }
    if not REQUIRED.issubset(entries):
        raise ValueError(f"Missing required files: {sorted(REQUIRED - entries.keys())}")
    manifest = {
        "project": "CareerLens",
        "commit": commit,
        "committed_at": git("show", "-s", "--format=%cI", commit).decode().strip(),
        "frontend_version": json.loads(entries["app/apps/frontend/package.json"])["version"],
        "backend_version": re.search(r'^version = "([^"]+)"', entries["app/apps/backend/pyproject.toml"].decode(), re.MULTILINE).group(1),
        "files": {name: digest(data) for name, data in sorted(entries.items())},
    }
    output = ROOT / "dist"
    output.mkdir(exist_ok=True)
    path = output / f"CareerLens-source-{commit[:12]}.zip"
    path.write_bytes(archive)
    with zipfile.ZipFile(path, "a", compression=zipfile.ZIP_DEFLATED) as target:
        info = zipfile.ZipInfo("CareerLens/" + MANIFEST, target.infolist()[0].date_time)
        info.compress_type = zipfile.ZIP_DEFLATED
        target.writestr(info, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    with zipfile.ZipFile(path) as result:
        if result.testzip() is not None:
            raise ValueError("ZIP CRC verification failed")
        for name, expected in manifest["files"].items():
            if digest(result.read("CareerLens/" + name)) != expected:
                raise ValueError(f"ZIP checksum mismatch: {name}")
    checksum = digest(path.read_bytes())
    path.with_suffix(".zip.sha256").write_text(f"{checksum}  {path.name}\n", encoding="utf-8")
    print(f"Created {path}\n{len(entries)} source files, {path.stat().st_size:,} bytes\nSHA-256 {checksum}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", type=Path, metavar="DIRECTORY", help="Verify an extracted package")
    args = parser.parse_args()
    if args.verify is not None:
        verify(args.verify)
    else:
        package()
