#!/usr/bin/env python3
"""Write 16/48/128 PNG icons (stdlib only)."""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

GLYPHS = {
    "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
}


def write_png(path: Path, w: int, h: int, rgba: bytearray) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    raw = b"".join(b"\x00" + bytes(rgba[y * w * 4 : (y + 1) * w * 4]) for y in range(h))
    out = b"\x89PNG\r\n\x1a\n"
    out += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    out += chunk(b"IDAT", zlib.compress(raw, 9))
    out += chunk(b"IEND", b"")
    path.write_bytes(out)


def set_px(px: bytearray, w: int, x: int, y: int, color: tuple[int, int, int, int]) -> None:
    if 0 <= x < w and 0 <= y < w:
        i = (y * w + x) * 4
        px[i : i + 4] = bytes(color)


def fill_round_rect(
    px: bytearray, w: int, color: tuple[int, int, int, int], rad: int
) -> None:
    rr = rad * rad
    for y in range(w):
        for x in range(w):
            corners = (
                (x < rad and y < rad, rad - 1 - x, rad - 1 - y),
                (x >= w - rad and y < rad, x - (w - rad), rad - 1 - y),
                (x < rad and y >= w - rad, rad - 1 - x, y - (w - rad)),
                (x >= w - rad and y >= w - rad, x - (w - rad), y - (w - rad)),
            )
            skip = False
            for hit, dx, dy in corners:
                if hit and dx * dx + dy * dy > rr:
                    skip = True
                    break
            if not skip:
                set_px(px, w, x, y, color)


def blit_text(
    px: bytearray,
    w: int,
    text: str,
    scale: int,
    color: tuple[int, int, int, int],
    cx: int,
    cy: int,
) -> None:
    gw, gh, gap = 5, 7, 1
    tw = len(text) * gw * scale + (len(text) - 1) * gap * scale
    th = gh * scale
    x0 = cx - tw // 2
    y0 = cy - th // 2
    for gi, ch in enumerate(text):
        ox = x0 + gi * (gw + gap) * scale
        for yy, row in enumerate(GLYPHS[ch]):
            for xx, bit in enumerate(row):
                if bit != "1":
                    continue
                for sy in range(scale):
                    for sx in range(scale):
                        set_px(px, w, ox + xx * scale + sx, y0 + yy * scale + sy, color)


def make(size: int) -> bytearray:
    px = bytearray(size * size * 4)
    fill_round_rect(px, size, (22, 32, 45, 255), max(2, size // 6))
    blit_text(px, size, "-1", max(1, size // 18), (164, 208, 7, 255), size // 2, size // 2)
    return px


def main() -> None:
    here = Path(__file__).resolve().parent / "icons"
    here.mkdir(exist_ok=True)
    for s in (16, 48, 128):
        dest = here / f"{s}.png"
        write_png(dest, s, s, make(s))
        print("wrote", dest)


if __name__ == "__main__":
    main()
