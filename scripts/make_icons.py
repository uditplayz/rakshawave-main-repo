"""Generate the PWA icons in ui/icons (run: python scripts/make_icons.py)."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "ui" / "icons"
BG, CYAN, TEAL = (11, 15, 25), (6, 182, 212), (10, 38, 51)


def icon(size: int, maskable: bool = False) -> Image.Image:
    s = 4  # supersample
    n = size * s
    im = Image.new("RGBA", (n, n), BG if maskable else (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if not maskable:
        d.rounded_rectangle((0, 0, n, n), radius=int(n * 0.22), fill=BG)
    k = 0.62 if maskable else 0.74          # safe zone for maskable icons
    cx, cy, r = n / 2, n / 2, n * k / 2
    d.ellipse((cx - r * 1.25, cy - r * 1.25, cx + r * 1.25, cy + r * 1.25), fill=TEAL)
    w = max(2, int(n * 0.028))
    pts = [(cx, cy - r), (cx + r * .82, cy - r * .62), (cx + r * .82, cy + r * .05),
           (cx, cy + r), (cx - r * .82, cy + r * .05), (cx - r * .82, cy - r * .62)]
    d.line(pts + [pts[0]], fill=CYAN, width=w, joint="curve")
    wave = []
    for i in range(41):                      # the signature wave inside the shield
        x = cx - r * .42 + i / 40 * r * .84
        y = cy - r * .02 + __import__("math").sin(i / 40 * 4 * 3.14159) * r * .13
        wave.append((x, y))
    d.line(wave, fill=CYAN, width=w, joint="curve")
    return im.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
for name, size, mask in [("icon-192.png", 192, False), ("icon-512.png", 512, False),
                         ("maskable-512.png", 512, True), ("apple-touch-icon.png", 180, True)]:
    icon(size, mask).save(OUT / name)
print("icons written to", OUT)
