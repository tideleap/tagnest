#!/usr/bin/env python3
"""Add hex fallbacks for every `oklch(...)` value in theme.css.

Browsers without `oklch()` support drop the whole declaration, leaving themes
blank. For each `--p-*: oklch(L C H [/ A]);` line we emit a preceeding
`--p-*: #rrggbb[aa];` line (browser uses the last one it understands), so old
engines get the sRGB fallback while modern ones still get the wide-gamut oklch.

Conversion: OKLab -> sRGB reference (Bjorn Ottosson, D65).

Usage: python scripts/oklch-fallback.py [path...]
"""
import math
import re
import sys

OKLCH_RE = re.compile(r"oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*/\s*([0-9.]+))?\s*\)")


def oklch_to_hex(L, C, H_deg, alpha=None):
    H = math.radians(H_deg)
    ca = C * math.cos(H)
    cb = C * math.sin(H)
    l_ = L + 0.3963377774 * ca + 0.2158037573 * cb
    m_ = L - 0.1055613458 * ca - 0.0638541728 * cb
    s_ = L - 0.0894841775 * ca - 1.2914855480 * cb
    l = l_ ** 3
    m = m_ ** 3
    s = s_ ** 3
    r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s

    def clamp(x):
        return 0.0 if x < 0 else (1.0 if x > 1 else x)

    hex_rgb = "".join("%02x" % round(clamp(x) * 255) for x in (r, g, b))
    if alpha is None:
        return "#" + hex_rgb
    return "#" + hex_rgb + "%02x" % round(alpha * 255)


def convert_file(path):
    with open(path, "r", encoding="utf-8") as f:
        lines = f.read().splitlines(keepends=True)

    out = []
    added = 0
    for line in lines:
        m = OKLCH_RE.search(line)
        # Only touch token declarations, not arbitrary oklch in comments.
        prop = re.match(r"^(\s*)(--[a-z0-9-]+)\s*:", line)
        if not (m and prop):
            out.append(line)
            continue
        L = float(m.group(1))
        C = float(m.group(2))
        H = float(m.group(3))
        alpha = float(m.group(4)) if m.group(4) else None
        hexv = oklch_to_hex(L, C, H, alpha)
        out.append(f"{prop.group(1)}{prop.group(2)}: {hexv};\n")
        out.append(line)
        added += 1

    with open(path, "w", encoding="utf-8") as f:
        f.write("".join(out))
    return added


if __name__ == "__main__":
    anchors = [("oklch(1 0 0)", "#ffffff"), ("oklch(0 0 0)", "#000000")]
    for raw, expect in anchors:
        m = OKLCH_RE.search(raw)
        got = oklch_to_hex(float(m.group(1)), float(m.group(2)), float(m.group(3)))
        status = "OK" if got == expect else f"MISMATCH (expected {expect})"
        print(f"anchor {raw} -> {got} {status}")
    for p in sys.argv[1:]:
        n = convert_file(p)
        print(f"converted {p}: +{n} fallback lines")
