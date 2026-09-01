#!/usr/bin/env python3
# 生成 PWA 全套图标：渐变圆角 + 「句」字 + 对勾徽章 + 记录线
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BASE = 1024
FONT = "C:/Windows/Fonts/msyhbd.ttc"

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def diag_gradient(size):
    """对角渐变：左上 #2f6fed -> 右下 #7b5cf0"""
    w, h = size
    img = Image.new("RGB", (w, h))
    px = img.load()
    c1, c2 = (47, 111, 237), (123, 92, 240)
    for y in range(h):
        for x in range(w):
            t = (x + y) / (w + h - 2)
            px[x, y] = lerp(c1, c2, t)
    return img

def draw_icon(maskable=False):
    """返回 1024 尺寸 RGBA 图标；maskable 时主体内容限制在中心 62% 安全区"""
    img = diag_gradient((BASE, BASE)).convert("RGBA")
    d = ImageDraw.Draw(img)

    # 圆角遮罩
    mask = Image.new("L", (BASE, BASE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, BASE - 1, BASE - 1], radius=225, fill=255)
    img.putalpha(mask)

    # 顶部柔和高光
    hl = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    ImageDraw.Draw(hl).ellipse([-200, -300, 900, 500], fill=(255, 255, 255, 46))
    hl = hl.filter(ImageFilter.GaussianBlur(90))
    img = Image.alpha_composite(img, hl)

    # 内容安全区：maskable 时缩放 62%，普通图标内容占 78%
    cx, cy = BASE / 2, BASE / 2
    zone = (BASE * 0.62) if maskable else (BASE * 0.80)

    d2 = ImageDraw.Draw(img)

    # ---- 左上角对勾徽章（打卡成功）----
    bx, by, br = cx - zone * 0.42, cy - zone * 0.44, int(zone * 0.115)
    d2.ellipse([bx - br, by - br, bx + br, by + br], fill=(255, 255, 255, 255))
    lw = max(8, int(br * 0.30))
    # 对勾（绿）
    d2.line([bx - br * 0.45, by + br * 0.02, bx - br * 0.10, by + br * 0.36], fill=(52, 199, 89, 255), width=lw, joint="curve")
    d2.line([bx - br * 0.10, by + br * 0.36, bx + br * 0.50, by - br * 0.34], fill=(52, 199, 89, 255), width=lw, joint="curve")

    # ---- 底部三条记录线（打卡记录）----
    line_w = int(zone * 0.24)
    line_h = int(zone * 0.030)
    lx0 = cx - line_w / 2
    ly0 = cy + zone * 0.34
    gap = int(zone * 0.085)
    for i in range(3):
        x0 = lx0 + i * gap * 0.35
        y0 = ly0 + i * gap
        d2.rounded_rectangle([x0, y0, x0 + line_w, y0 + line_h], radius=line_h / 2, fill=(255, 255, 255, 235))

    # ---- 中央「句」字（带投影）----
    size = int(zone * 0.62)
    font = ImageFont.truetype(FONT, size)
    txt = "句"
    tb = d2.textbbox((0, 0), txt, font=font)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    tx, ty = cx - tw / 2 - tb[0], cy - th / 2 - tb[1] - zone * 0.03
    # 投影
    d2.text((tx + 10, ty + 16), txt, font=font, fill=(0, 0, 0, 70))
    # 主体白字
    d2.text((tx, ty), txt, font=font, fill=(255, 255, 255, 255))

    return img

def save(size, path, maskable=False):
    img = draw_icon(maskable)
    img = img.resize((size, size), Image.LANCZOS)
    img.save(path, "PNG")
    print(f"[OK] {path}  {size}x{size}" + ("  (maskable 62%)" if maskable else ""))

if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    save(512, "icon.png")
    save(512, "icon-512.png")
    save(192, "icon-192.png")
    save(512, "icon-maskable-512.png", maskable=True)
    save(180, "apple-touch-icon.png")
    print("done")
