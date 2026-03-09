#!/usr/bin/env python3
"""Generate checksums.json from existing extracted *_details.json files."""

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTRACTED_DIR = ROOT / "extracted"
CHECKSUMS_PATH = EXTRACTED_DIR / "checksums.json"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8192), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_checksums() -> dict[str, str]:
    checksums: dict[str, str] = {}
    for path in sorted(EXTRACTED_DIR.glob("*_details.json")):
        if path.is_file():
            checksums[path.name] = sha256_file(path)
    return checksums


def main() -> int:
    checksums = build_checksums()
    if not checksums:
        print(f"No *_details.json files found in {EXTRACTED_DIR}")
        return 1

    with CHECKSUMS_PATH.open("w", encoding="utf-8") as handle:
        json.dump(checksums, handle, sort_keys=True, indent=2)
        handle.write("\n")

    print(f"Wrote {len(checksums)} checksums to {CHECKSUMS_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
