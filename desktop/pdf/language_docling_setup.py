"""Build-time download of the two actual Docling inference models."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE / "runtime" / "language" / "docling-models"


def main():
    records, tasks = [], []
    for repo, revision in [("docling-project/docling-layout-heron", "8f39ad3c0b4c58e9c2d2c84a38465abf757272d8"),
                           ("docling-project/docling-models", "v2.3.0")]:
        info = json.load(urllib.request.urlopen(f"https://huggingface.co/api/models/{repo}/revision/{revision}?blobs=true"))
        record = {"repo": repo, "revision": info["sha"], "license": info.get("cardData", {}).get("license"), "files": []}
        for file in info["siblings"]:
            name = file["rfilename"]
            if name.startswith(".") or "/fast/" in name or name.endswith(".png"):
                continue
            tasks.append((record, name, file.get("lfs", {}).get("sha256")))
        records.append(record)

    def fetch(item):
        record, name, expected = item
        url = f"https://huggingface.co/{record['repo']}/resolve/{record['revision']}/{name}"
        path = ROOT / record["repo"].replace("/", "--") / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            temporary = path.with_suffix(path.suffix + ".download")
            urllib.request.urlretrieve(url, temporary)
            temporary.replace(path)
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if expected and digest != expected:
            raise ValueError("Model does not match upstream SHA-256")
        record["files"].append({"path": str(path.relative_to(ROOT)).replace("\\", "/"), "sha256": digest,
                                "bytes": path.stat().st_size, "url": url, "upstreamHashVerified": bool(expected)})
        print(name, path.stat().st_size, flush=True)

    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(fetch, tasks))
    (HERE / "language-docling-models.json").write_text(json.dumps(records, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
