"""
Generate icon PNG files for the extension.
Run this once: python generate_icon.py
No external libraries needed.
"""
import struct
import zlib

def make_png(size, r, g, b):
    """Create a solid color PNG with rounded feel."""
    raw = b''
    for y in range(size):
        raw += b'\x00'  # filter type none
        for x in range(size):
            # Simple circle mask for rounded icon feel
            cx, cy = size / 2, size / 2
            dist = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            radius = size * 0.45
            if dist <= radius:
                raw += bytes([r, g, b, 255])  # RGBA inside circle
            else:
                raw += bytes([0, 0, 0, 0])    # transparent outside

    def chunk(name, data):
        c = name + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)

    # RGBA PNG (color type 6)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    compressed = zlib.compress(raw, 9)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', ihdr)
    png += chunk(b'IDAT', compressed)
    png += chunk(b'IEND', b'')
    return png

# Purple accent color: #7c6af7 = (124, 106, 247)
R, G, B = 124, 106, 247

for size in [16, 32, 48, 96, 128]:
    filename = f'icon{size}.png'
    with open(filename, 'wb') as f:
        f.write(make_png(size, R, G, B))
    print(f'Created {filename}')

print('Done! All icons generated.')
