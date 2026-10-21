"""Acquire pinned Meta M2M100-418M and convert to CPU int8 locally.

Build-time only. The original 1.94 GB training weights stay in language-build;
only the compact inference model and tokenizer are shipped in runtime/language.
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request

HERE = Path(__file__).resolve().parent
REPO = "facebook/m2m100_418M"
REVISION = "55c2e61bbf05dfb8d7abccdc3fae6fc8512fd636"
SOURCE = HERE / "language-build" / "m2m100-source"
OUTPUT = HERE / "runtime" / "language" / "m2m100-int8"


def main():
    SOURCE.mkdir(parents=True, exist_ok=True)
    info = json.load(urllib.request.urlopen(f"https://huggingface.co/api/models/{REPO}/revision/{REVISION}?blobs=true"))
    files = []
    def fetch(item):
        name = item["rfilename"]
        if name.startswith(".") or name == "rust_model.ot":
            return
        url = f"https://huggingface.co/{REPO}/resolve/{REVISION}/{name}"
        path = SOURCE / name
        if not path.exists():
            temporary = path.with_suffix(path.suffix + ".download")
            urllib.request.urlretrieve(url, temporary)
            temporary.replace(path)
        with path.open("rb") as stream:
            sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
        expected = item.get("lfs", {}).get("sha256")
        if expected and expected != sha256:
            raise ValueError("M2M model hash mismatch")
        files.append({"name": name, "sha256": sha256, "bytes": path.stat().st_size, "url": url,
                      "upstreamHashVerified": bool(expected)})
        print(name, path.stat().st_size, flush=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(fetch, info["siblings"]))
    import ctranslate2
    converter = ctranslate2.converters.TransformersConverter(str(SOURCE), low_cpu_mem_usage=True)
    converter.convert(str(OUTPUT), quantization="int8", force=True)
    for name in ("README.md", "sentencepiece.bpe.model", "special_tokens_map.json", "tokenizer_config.json", "vocab.json"):
        shutil.copy2(SOURCE / name, OUTPUT / name)
    (HERE / "language-m2m-model.json").write_text(json.dumps({"repo": REPO, "revision": REVISION,
        "license": info["cardData"]["license"], "conversion": {"library": "CTranslate2", "version": ctranslate2.__version__, "quantization": "int8"},
        "files": files}, indent=2), encoding="utf-8")
    print("M2M100 int8 conversion complete", flush=True)


if __name__ == "__main__":
    main()
