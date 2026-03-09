#!/usr/bin/env python3
"""Step 6 visual gate: compare current screenshots to baseline."""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

try:
    from PIL import Image  # type: ignore

    PIL_AVAILABLE = True
except Exception:  # pragma: no cover - optional dependency
    Image = None
    PIL_AVAILABLE = False


ROOT = Path(__file__).resolve().parents[2]
BASELINE_DIR = ROOT / "frontend" / "tests" / "visual" / "baseline"
CURRENT_DIR = ROOT / "frontend" / "tests" / "visual" / "current"


@dataclass
class CompareResult:
    file: str
    ok: bool
    reason: str


def _png_dims_stdlib(path: Path) -> tuple[int, int] | None:
    # Read PNG IHDR via stdlib only.
    with path.open("rb") as f:
        sig = f.read(8)
        if sig != b"\x89PNG\r\n\x1a\n":
            return None
        _len = f.read(4)
        typ = f.read(4)
        if typ != b"IHDR":
            return None
        data = f.read(13)
        w = int.from_bytes(data[0:4], "big")
        h = int.from_bytes(data[4:8], "big")
        return (w, h)


def _image_dims(path: Path) -> tuple[int, int] | None:
    if PIL_AVAILABLE and Image is not None:
        try:
            with Image.open(path) as img:
                return (int(img.width), int(img.height))
        except Exception:
            return None
    return _png_dims_stdlib(path)


def compare_one(base: Path, cur: Path) -> CompareResult:
    if not cur.exists():
        return CompareResult(base.name, False, "missing current")

    b_dims = _image_dims(base)
    c_dims = _image_dims(cur)
    if b_dims and c_dims and b_dims != c_dims:
        return CompareResult(base.name, False, f"dimension mismatch {b_dims} != {c_dims}")

    # Fallback check if dimensions are unavailable or to catch obvious mismatch.
    b_size = base.stat().st_size
    c_size = cur.stat().st_size
    if b_size == 0 or c_size == 0:
        return CompareResult(base.name, False, "empty file")

    if b_dims is None or c_dims is None:
        if b_size != c_size:
            return CompareResult(base.name, False, f"byte-size mismatch {b_size} != {c_size}")

    return CompareResult(base.name, True, "ok")


def main() -> None:
    BASELINE_DIR.mkdir(parents=True, exist_ok=True)
    CURRENT_DIR.mkdir(parents=True, exist_ok=True)

    baseline_pngs = sorted([p for p in BASELINE_DIR.glob("*.png") if p.is_file()])
    current_pngs = sorted([p for p in CURRENT_DIR.glob("*.png") if p.is_file()])

    if not baseline_pngs:
        print("FAIL: No baseline PNG files found.")
        print(f"Expected: {BASELINE_DIR}")
        sys.exit(1)

    if not current_pngs:
        print("FAIL: No current PNG files found.")
        print(f"Expected: {CURRENT_DIR}")
        sys.exit(1)

    results: list[CompareResult] = []

    baseline_names = {p.name for p in baseline_pngs}
    current_names = {p.name for p in current_pngs}

    missing_in_baseline = sorted(current_names - baseline_names)
    for name in missing_in_baseline:
        results.append(CompareResult(name, False, "missing baseline"))

    missing_in_current = sorted(baseline_names - current_names)
    for name in missing_in_current:
        results.append(CompareResult(name, False, "missing current"))

    for base in baseline_pngs:
        if base.name in current_names:
            cur = CURRENT_DIR / base.name
            results.append(compare_one(base, cur))

    ok_count = sum(1 for r in results if r.ok)
    fail_count = len(results) - ok_count

    print("Visual Verify Report")
    print(f"Baseline dir: {BASELINE_DIR}")
    print(f"Current dir : {CURRENT_DIR}")
    print(f"Image meta  : {'Pillow' if PIL_AVAILABLE else 'stdlib PNG header'}")
    print(f"Total       : {len(results)}")
    print(f"Pass        : {ok_count}")
    print(f"Fail        : {fail_count}")

    for r in results:
        status = "PASS" if r.ok else "FAIL"
        print(f"- {status} {r.file}: {r.reason}")

    if fail_count:
        sys.exit(1)


if __name__ == "__main__":
    main()
