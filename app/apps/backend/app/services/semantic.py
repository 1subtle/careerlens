"""Local E5 evidence retrieval. Similarity proposes sources; it never scores skills."""

from functools import lru_cache
from pathlib import Path
from threading import Lock
from typing import Any

from app.config import settings

MODEL = "Xenova/multilingual-e5-small"
REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78"
FILES = {
    "onnx/model_quantized.onnx": "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
    "tokenizer.json": "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
}
_lock = Lock()


def model_dir() -> Path:
    return settings.data_dir / "models" / "multilingual-e5-small" / REVISION


def status() -> dict[str, Any]:
    return {
        "ready": all((model_dir() / name).is_file() for name in FILES),
        "model": MODEL,
        "revision": REVISION,
    }


@lru_cache(maxsize=1)
def load_model(directory: str):
    import onnxruntime as ort
    from tokenizers import Tokenizer

    tokenizer = Tokenizer.from_file(str(Path(directory) / "tokenizer.json"))
    tokenizer.enable_truncation(max_length=512)
    tokenizer.enable_padding(pad_id=1, pad_token="<pad>")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    session = ort.InferenceSession(
        str(Path(directory) / "onnx/model_quantized.onnx"),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    return tokenizer, session


def embed(texts: list[str]):
    import numpy as np

    # ponytail: serialize the small local model; use a worker pool only if concurrent users need it.
    with _lock:
        tokenizer, session = load_model(str(model_dir()))
        vectors = []
        for start in range(0, len(texts), 8):
            batch = tokenizer.encode_batch(texts[start : start + 8])
            inputs = {
                "input_ids": np.asarray([x.ids for x in batch], dtype=np.int64),
                "attention_mask": np.asarray(
                    [x.attention_mask for x in batch], dtype=np.int64
                ),
                "token_type_ids": np.asarray(
                    [x.type_ids for x in batch], dtype=np.int64
                ),
            }
            output = session.run(
                None, {x.name: inputs[x.name] for x in session.get_inputs()}
            )[0]
            mask = inputs["attention_mask"][..., None]
            pooled = (output * mask).sum(axis=1) / mask.sum(axis=1)
            vectors.extend(
                pooled
                / np.maximum(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12)
            )
        return np.asarray(vectors)


def retrieve(requirements: list[dict], evidence: list[dict]) -> list[list[dict]]:
    evidence = [item for item in evidence if item.get("kind") == "experience"]
    if not requirements or not evidence:
        return [[] for _ in requirements]
    if not status()["ready"]:
        raise FileNotFoundError("Local evidence model is not prepared")
    # E5 uses these prefixes for Chinese as well as English; pool with the attention mask.
    queries = ["query: " + r["name"] + "；" + r["source_text"] for r in requirements]
    passages = ["passage: " + e["text"] for e in evidence]
    vectors = embed(queries + passages)
    similarities = vectors[: len(queries)] @ vectors[len(queries) :].T
    return [
        [
            {"evidence_id": evidence[i]["id"], "similarity": round(float(scores[i]), 4)}
            for i in scores.argsort()[::-1][:3]
            if scores[i] >= max(0.85, float(scores.max()) - 0.04)
        ]
        for scores in similarities
    ]
