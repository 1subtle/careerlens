"""Accept bounded embedded PNG/JPEG photos; never fetch external image URLs."""

import base64
import binascii
import re

from docx.image.image import Image

MAX_PHOTO_BYTES = 1024 * 1024
MAX_PHOTO_URL_LENGTH = 1_400_000


def decode_resume_photo(value: str) -> bytes:
    if len(value) > MAX_PHOTO_URL_LENGTH:
        raise ValueError("照片请压缩到 1 MB 以内")
    match = re.fullmatch(r"data:(image/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)", value)
    if match is None:
        raise ValueError("照片只支持 PNG/JPEG 的内嵌 data URL")
    try:
        data = base64.b64decode(match.group(2), validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("照片编码无效，请重新上传") from None
    if not data or len(data) > MAX_PHOTO_BYTES:
        raise ValueError("照片请压缩到 1 MB 以内")
    try:
        image = Image.from_blob(data)
    except Exception:  # noqa: BLE001 - malformed image parsers must become validation errors
        raise ValueError("照片内容无法识别，请使用有效 PNG/JPEG 图片") from None
    if image.content_type != match.group(1):
        raise ValueError("照片声明格式与实际内容不一致")
    if (
        min(image.px_width, image.px_height) < 1
        or max(image.px_width, image.px_height) > 1600
        or image.px_width * image.px_height > 2_000_000
    ):
        raise ValueError(
            "照片尺寸过大，请使用不超过 1600 像素且总像素不超过 200 万的图片"
        )
    return data
