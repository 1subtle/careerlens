"""Exercise container startup without Docker: python check_start.py [bash>=4.3]."""

import hashlib
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time


STUB = r'''
import os
from pathlib import Path
import signal
import sys
import time

root = Path(os.environ["CHECK_ROOT"])
case = os.environ["CHECK_CASE"]
kind = Path(sys.argv[0]).name
if kind == "python":
    if sys.argv[1:3] == ["-m", "uvicorn"]:
        kind = "backend"
    elif sys.argv[1] == "-c":
        sys.exit(23 if case == "chromium_failure" else 0)
    else:
        os.execv(sys.executable, [sys.executable, *sys.argv[1:]])
elif kind == "node":
    kind = "frontend"
elif kind == "sleep":
    time.sleep(0.01)
    sys.exit(0)
elif kind == "curl":
    kind = "backend" if ":8000/" in sys.argv[-1] else "frontend"
    if kind == "frontend" and case == "backend_late_exit":
        time.sleep(0.5)
    sys.exit(0 if (root / (kind + ".pid")).exists()
             and case != kind + "_timeout" else 1)

if kind == "backend" and case == "backend_failure":
    sys.exit(11)
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
(root / (kind + ".pid")).write_text(str(os.getpid()))
if kind == "backend" and case == "backend_late_exit":
    time.sleep(0.2)
    sys.exit(17)
if kind == "frontend" and case in {"frontend_exit", "frontend_clean_exit"}:
    time.sleep(0.3)
    sys.exit(17 if case == "frontend_exit" else 0)
while True:
    signal.pause()
'''


def main() -> None:
    bash = sys.argv[1] if len(sys.argv) > 1 else shutil.which("bash")
    assert bash, "Bash 4.3 or newer is required"
    subprocess.run(
        [bash, "-c", "(( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 3) ))"],
        check=True,
    )
    source = Path(__file__).with_name("start.sh").read_text()
    for case, expected in [
        ("healthy", 0), ("repair_model", 0), ("chromium_failure", 23),
        ("backend_failure", 1), ("backend_timeout", 1),
        ("missing_frontend", 1), ("frontend_timeout", 1),
        ("frontend_exit", 17), ("frontend_clean_exit", 1),
        ("backend_late_exit", 17),
    ]:
        with tempfile.TemporaryDirectory(prefix="careerlens-start-") as temporary:
            root = Path(temporary)
            backend, frontend, seed = (root / name for name in ("backend", "frontend", "seed"))
            modules = backend / "app" / "services"
            modules.mkdir(parents=True)
            frontend.mkdir()
            (modules.parent / "__init__.py").touch()
            (modules / "__init__.py").touch()
            (modules.parent / "config.py").write_text(
                "import os\nfrom pathlib import Path\n"
                "class Settings: data_dir = Path(os.environ['DATA_DIR'])\nsettings = Settings()\n"
            )
            files = {"onnx/model.onnx": b"pinned model", "tokenizer.json": b"tokenizer"}
            checksums = {name: hashlib.sha256(value).hexdigest() for name, value in files.items()}
            relative = Path("models/test-model/pinned-revision")
            (modules / "semantic.py").write_text(
                f"from app.config import settings\nFILES = {checksums!r}\n"
                f"def model_dir(): return settings.data_dir / {str(relative)!r}\n"
            )
            for name, value in files.items():
                target = seed / relative / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(value)
                if case == "repair_model":
                    damaged = backend / "data" / relative / name
                    damaged.parent.mkdir(parents=True, exist_ok=True)
                    damaged.write_bytes(b"interrupted copy")
            if case != "missing_frontend":
                (frontend / "server.js").touch()
            executable_dir = root / "bin"
            executable_dir.mkdir()
            for name in ("python", "node", "curl", "sleep"):
                shim = executable_dir / name
                shim.write_text(f"#!{sys.executable}\n" + STUB)
                shim.chmod(0o755)
            script = root / "start.sh"
            script.write_text(source.replace("/app/backend", str(backend))
                              .replace("/app/frontend", str(frontend))
                              .replace("/opt/careerlens-seed", str(seed)))
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(("LLM_", "LOG_"))}
            env.update(PATH=f"{executable_dir}:{os.environ['PATH']}",
                       CHECK_ROOT=str(root), CHECK_CASE=case,
                       DATA_DIR=str(backend / "data"), PYTHONPATH=str(backend))
            with (root / "output.log").open("w+") as output:
                process = subprocess.Popen([bash, str(script)], env=env, stdout=output,
                                           stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    if case in {"healthy", "repair_model"}:
                        deadline = time.monotonic() + 8
                        while "Frontend is ready" not in (root / "output.log").read_text():
                            assert process.poll() is None, (root / "output.log").read_text()
                            assert time.monotonic() < deadline, "Readiness timed out"
                            time.sleep(0.02)
                        process.terminate()
                    assert process.wait(timeout=8) == expected, (root / "output.log").read_text()
                    for name, value in files.items():
                        assert (backend / "data" / relative / name).read_bytes() == value
                    for pidfile in root.glob("*.pid"):
                        try:
                            os.kill(int(pidfile.read_text()), 0)
                        except ProcessLookupError:
                            continue
                        raise AssertionError(f"Child leaked: {pidfile.name}")
                finally:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
            print(f"PASS {case}")


if __name__ == "__main__":
    main()
