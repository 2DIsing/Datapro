"""Draw the DataPro app icon (a Hall hysteresis loop on teal) as PNGs in pages/icons/."""
import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent / 'icons'
OUT.mkdir(exist_ok=True)

S = 1024  # drawn large, scaled down for smoothness
img = Image.new('RGB', (S, S), (10, 108, 128))
d = ImageDraw.Draw(img)

# faint axes
grid = (58, 146, 163)
d.line([(S * 0.14, S / 2), (S * 0.86, S / 2)], fill=grid, width=14)
d.line([(S / 2, S * 0.14), (S / 2, S * 0.86)], fill=grid, width=14)


def branch(sign):
    pts = []
    for i in range(1201):
        b = -1 + 2 * i / 1200
        y = 0.18 * b + 0.62 * math.tanh((b + sign * 0.22) / 0.09)
        pts.append((S / 2 + b * S * 0.33, S / 2 - y * S * 0.42))
    return pts


for sign, colour in [(1, (255, 255, 255)), (-1, (255, 196, 140))]:
    # a dense chain of discs gives a smooth stroke with round ends
    for x, y in branch(sign):
        d.ellipse([x - 23, y - 23, x + 23, y + 23], fill=colour)

for size in (512, 192, 180):
    img.resize((size, size), Image.LANCZOS).save(OUT / f'icon-{size}.png', optimize=True)
print('icons written to', OUT)
