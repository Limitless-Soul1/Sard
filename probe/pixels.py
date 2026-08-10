#!/usr/bin/env python3
"""Is the reading area actually blank? — DIAGNOSTIC, throwaway.

"Blank" is a claim about pixels, and until now every measurement in this investigation has been
about objects. This reads the captured screen and answers three separate questions that the word
"blank" runs together:

  * how many distinct colours are on screen at all (a dead render has very few);
  * whether the lower area — where the page sits, below the chrome — carries any ink;
  * what the dominant colour of that area is, which distinguishes "the host's cream background with
    nothing on it" from "the themed paper with text on it".

Reads PNG without Pillow: the runner has ImageMagick for capture but no Python imaging, and adding a
dependency to answer a yes/no question is not worth it.
"""
import struct
import sys
import zlib
from collections import Counter


def read_png(path):
    d = open(path, "rb").read()
    if d[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat, w, h, bpp = 8, b"", 0, 0, 3
    while pos < len(d):
        ln = struct.unpack(">I", d[pos:pos + 4])[0]
        typ = d[pos + 4:pos + 8]
        body = d[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, depth, colour = struct.unpack(">IIBB", body[:10])
            if depth != 8 or colour not in (2, 6):
                raise ValueError(f"unsupported PNG depth={depth} colour={colour}")
            bpp = 3 if colour == 2 else 4
        elif typ == b"IDAT":
            idat += body
        elif typ == b"IEND":
            break
        pos += 12 + ln
    raw = zlib.decompress(idat)
    stride = w * bpp
    out, prev = [], bytearray(stride)
    i = 0
    for _ in range(h):
        f = raw[i]; i += 1
        line = bytearray(raw[i:i + stride]); i += stride
        if f == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                c = prev[x - bpp] if x >= bpp else 0
                b = prev[x]
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out.append(bytes(line))
        prev = line
    return w, h, bpp, out


def report(path):
    try:
        w, h, bpp, rows = read_png(path)
    except Exception as e:
        print(f"  {path}: unreadable ({e})")
        return
    # The page area: below the chrome, inset from the edges.
    y0, y1 = int(h * 0.25), int(h * 0.95)
    x0, x1 = int(w * 0.15), int(w * 0.85)
    colours = Counter()
    for y in range(y0, y1, 3):
        row = rows[y]
        for x in range(x0, x1, 3):
            o = x * bpp
            colours[(row[o], row[o + 1], row[o + 2])] += 1
    total = sum(colours.values())
    top, topn = colours.most_common(1)[0]
    # "Ink" = pixels far enough from the dominant background to be text or an image.
    ink = sum(n for c, n in colours.items() if abs(c[0] - top[0]) + abs(c[1] - top[1]) + abs(c[2] - top[2]) > 60)
    print(f"  {path.split('/')[-1]}: {w}x{h}")
    print(f"      distinct colours in the page area : {len(colours)}")
    print(f"      dominant colour                   : #{top[0]:02x}{top[1]:02x}{top[2]:02x} ({100*topn//total}% of sampled pixels)")
    print(f"      ink pixels (far from dominant)    : {ink} ({100*ink//total}%)")
    print(f"      VERDICT                           : {'HAS CONTENT' if ink > total * 0.005 else 'BLANK'}")


for p in sys.argv[1:]:
    report(p)
