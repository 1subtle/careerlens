"""Download pinned public model files once; resume text never leaves this machine."""

import hashlib
from urllib.request import urlopen

from app.services.semantic import FILES, MODEL, REVISION, model_dir


def main() -> None:
    for name, expected in FILES.items():
        target = model_dir() / name
        if target.is_file():
            with target.open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() == expected:
                    print(f"已校验：{name}", flush=True)
                    continue
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".part")
        print(f"下载：{name}", flush=True)
        try:
            with (
                urlopen(
                    f"https://huggingface.co/{MODEL}/resolve/{REVISION}/{name}",
                    timeout=60,
                ) as response,
                temporary.open("wb") as output,
            ):
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            with temporary.open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
                    raise ValueError(f"模型校验失败：{name}")
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    print("语义证据检索模型已就绪。", flush=True)


if __name__ == "__main__":
    main()
