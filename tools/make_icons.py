"""生成扩展图标（纯 Python，无第三方依赖）。

画一个圆角方块（小红书红 #FF2442）+ 白色下载箭头，
用 4x 超采样再降采样得到抗锯齿边缘。
"""
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
SIZES = [16, 32, 48, 128]
SS = 4  # 超采样倍数

RED = (255, 36, 66)
WHITE = (255, 255, 255)


def rounded_rect_alpha(x, y, w, h, r):
    """返回点 (x,y) 在圆角矩形内的覆盖率（0 或 1，超采样后再平均）。"""
    if x < 0 or y < 0 or x >= w or y >= h:
        return 0.0
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    dx = x - cx
    dy = y - cy
    if dx * dx + dy * dy <= r * r:
        return 1.0
    return 0.0


def in_triangle(px, py, a, b, c):
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    d1 = sign((px, py), a, b)
    d2 = sign((px, py), b, c)
    d3 = sign((px, py), c, a)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)


def arrow_alpha(x, y, size):
    """归一化坐标下的下载箭头：竖杆 + 三角箭头 + 底部横线。"""
    u = x / size
    v = y / size

    # 竖杆
    if 0.455 <= u <= 0.545 and 0.185 <= v <= 0.545:
        return 1.0
    # 箭头三角
    a = (0.5, 0.735)
    b = (0.285, 0.495)
    c = (0.715, 0.495)
    if in_triangle(u, v, a, b, c):
        return 1.0
    # 底部横线
    if 0.275 <= u <= 0.725 and 0.775 <= v <= 0.855:
        return 1.0
    return 0.0


def render(size):
    """渲染单个尺寸，返回 RGBA 字节行列表。"""
    big = size * SS
    # 超采样缓冲区：累加 RGBA
    acc = [[0.0, 0.0, 0.0, 0.0] for _ in range(size * size)]

    radius = big * 0.235

    for by in range(big):
        for bx in range(big):
            # 背景圆角方块
            bg = rounded_rect_alpha(bx + 0.5, by + 0.5, big, big, radius)
            if bg <= 0:
                continue
            fg = arrow_alpha(bx + 0.5, by + 0.5, big)
            if fg > 0:
                r, g, b = WHITE
            else:
                r, g, b = RED
            idx = (by // SS) * size + (bx // SS)
            cell = acc[idx]
            cell[0] += r
            cell[1] += g
            cell[2] += b
            cell[3] += 255

    n = SS * SS
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r, g, b, a = acc[y * size + x]
            if a <= 0:
                row += bytes((0, 0, 0, 0))
            else:
                # 未被背景覆盖的采样点贡献 0 alpha，等价于抗锯齿边缘
                row += bytes((
                    int(round(r / n)),
                    int(round(g / n)),
                    int(round(b / n)),
                    int(round(a / n)),
                ))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    return len(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for s in SIZES:
        rows = render(s)
        p = os.path.join(OUT_DIR, "icon%d.png" % s)
        n = write_png(p, s, rows)
        print("  %-28s %4dx%-4d %6d bytes" % (os.path.basename(p), s, s, n))
    print("图标生成完成 ->", os.path.abspath(OUT_DIR))


if __name__ == "__main__":
    main()
