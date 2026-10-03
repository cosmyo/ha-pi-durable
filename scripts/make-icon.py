"""Rasterize an original geometric hearth mark without external packages."""
import struct
import zlib
from pathlib import Path

size = 256
polygons = [
    ([(21, 106), (107, 106), (107, 112), (21, 112)], (136, 216, 190)),
    ([(21, 100), (21, 51), (64, 21), (107, 51), (107, 100), (99, 100), (99, 55), (64, 31), (29, 55), (29, 100)], (136, 216, 190)),
    ([(64, 98), (46, 93), (41, 80), (46, 66), (55, 58), (58, 44), (72, 58), (74, 72), (80, 64), (87, 78), (84, 91)], (255, 197, 142)),
    ([(57, 96), (54, 87), (64, 74), (65, 84), (74, 91), (72, 96)], (233, 150, 103)),
]
def inside(x, y, points):
    result = False
    for i, (ax, ay) in enumerate(points):
        bx, by = points[i - 1]
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            result = not result
    return result
rows = []
for y in range(size):
    row = bytearray([0])
    for x in range(size):
        color = (25, 38, 41)
        for shape, fill in polygons:
            if inside(x / 2, y / 2, shape):
                color = fill
        row.extend(color)
    rows.append(row)
def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b'')
for name in ['icon.png', 'logo.png']:
    Path('hearth_pi', name).write_bytes(png)
