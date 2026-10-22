# -*- coding: utf-8 -*-
"""生成桌面快捷方式图标：assets/icon-app.ico（惠民云，橙底白「惠」）、assets/icon-manager.ico（服务管理，深灰底橙齿轮）。"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

S = 256
RADIUS = 58
BRAND = (242, 111, 33, 255)       # 品牌主色（橙）#F26F21
SLATE = (52, 58, 66, 255)         # 深灰 #343A42
WHITE = (255, 255, 255, 255)

FONTS = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]


def load_font(size):
    for fp in FONTS:
        if os.path.exists(fp):
            return ImageFont.truetype(fp, size)
    return ImageFont.load_default()


def shape_mask():
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).rounded_rectangle([8, 8, S - 8, S - 8], radius=RADIUS, fill=255)
    return m


def apply_sheen(img):
    """顶部 45% 白色渐变高光，裁剪到圆角矩形内。"""
    overlay = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    px = overlay.load()
    top_h = int(S * 0.45)
    for y in range(top_h):
        a = int(80 * (1 - y / top_h))
        for x in range(S):
            px[x, y] = (255, 255, 255, a)
    overlay = Image.composite(overlay, Image.new("RGBA", (S, S), (0, 0, 0, 0)), shape_mask())
    return Image.alpha_composite(img, overlay)


def make_app():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([8, 8, S - 8, S - 8], radius=RADIUS, fill=BRAND)
    font = load_font(168)
    text = "惠"
    bbox = d.textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((S - w) / 2 - bbox[0], (S - h) / 2 - bbox[1] - 4), text, font=font, fill=WHITE)
    return apply_sheen(img)


def make_manager():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([8, 8, S - 8, S - 8], radius=RADIUS, fill=SLATE)
    cx = cy = S // 2
    n = 8
    r1, r2 = 60, 96
    half = math.radians(11)

    def polar(r, a):
        return (cx + r * math.cos(a), cy + r * math.sin(a))

    for i in range(n):
        a = 2 * math.pi * i / n
        d.polygon([polar(r1, a - half), polar(r2, a - half), polar(r2, a + half), polar(r1, a + half)], fill=BRAND)
    d.ellipse([cx - (r1 + 3), cy - (r1 + 3), cx + (r1 + 3), cy + (r1 + 3)], fill=BRAND)
    d.ellipse([cx - 25, cy - 25, cx + 25, cy + 25], fill=SLATE)
    return apply_sheen(img)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    app = make_app()
    mgr = make_manager()
    app.save(os.path.join(here, "icon-app.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    mgr.save(os.path.join(here, "icon-manager.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    app.save(os.path.join(here, "preview-app.png"))
    mgr.save(os.path.join(here, "preview-manager.png"))
    print("icons generated")


if __name__ == "__main__":
    main()
