from PIL import Image, ImageDraw, ImageFont, ImageOps
import os

ROOT = r"F:\MyApp\eternal\memory-eternal"
A = os.path.join(ROOT, "site", "assets")
FONT = r"C:\Windows\Fonts\msyh.ttc"

W, H = 1200, 630
img = Image.new("RGB", (W, H), (11, 12, 14))
d = ImageDraw.Draw(img)

# subtle glow
glow = Image.new("RGB", (W, H), (11, 12, 14))
gd = ImageDraw.Draw(glow)
for r in range(420, 0, -12):
    a = int(10 * (1 - r / 420))
    gd.ellipse([(120 - r, -120 - r), (120 + r, -120 + r)], fill=(11 + a * 3, 12 + a * 2, 14 + a))
img = Image.blend(img, glow, 0.55)
d = ImageDraw.Draw(img)

f_logo = ImageFont.truetype(FONT, 25)
f_small = ImageFont.truetype(FONT, 13)
f_h = ImageFont.truetype(FONT, 50)
f_sub = ImageFont.truetype(FONT, 18)
f_chip = ImageFont.truetype(FONT, 13)
f_foot = ImageFont.truetype(FONT, 12)

# brand mark
cx, cy = 68, 66
d.ellipse([cx - 4, cy - 4, cx + 4, cy + 4], fill=(255, 122, 69))
d.arc([cx - 20, cy - 8, cx + 20, cy + 8], 200, 340, fill=(255, 122, 69), width=2)
d.arc([cx - 18, cy - 20, cx + 18, cy + 20], 110, 250, fill=(255, 122, 69), width=1)
d.text((96, 50), "memory-eternal", font=f_logo, fill=(236, 238, 242))
d.text((96, 82), "LOCAL-FIRST AI MEMORY", font=f_small, fill=(111, 119, 130))

# headline
d.text((60, 150), "让 AI 记住", font=f_h, fill=(236, 238, 242))
d.text((60, 212), "你们一起做过的决定。", font=f_h, fill=(236, 238, 242))
d.text((60, 300), "对话结束自动沉淀成可审核、可 git 管理的知识卡。", font=f_sub, fill=(163, 170, 180))
d.text((60, 330), "召回只取相关小块，省 token，也少噪音。", font=f_sub, fill=(163, 170, 180))

# chips
chips = ["本地 SQLite + Markdown", "零外部依赖", "支持 4 种 Agent"]
x = 60
for c in chips:
    tw = d.textlength(c, font=f_chip)
    d.rounded_rectangle([x, 380, x + tw + 24, 410], radius=7, outline=(46, 50, 58), width=1, fill=(18, 20, 24))
    d.text((x + 12, 388), c, font=f_chip, fill=(163, 170, 180))
    x += tw + 34

# screenshot
shot = Image.open(os.path.join(A, "hero-crop.png")).convert("RGB")
shot = ImageOps.fit(shot, (540, 370), method=Image.LANCZOS, centering=(0.4, 0.25))
# frame
fx, fy = 610, 145
d.rounded_rectangle([fx - 10, fy - 10, fx + 550, fy + 380], radius=16, fill=(18, 20, 24), outline=(60, 65, 74), width=1)
img.paste(shot, (fx, fy))
# frame bar
d.rounded_rectangle([fx - 10, fy - 10, fx + 550, fy + 24], radius=10, fill=(17, 19, 23))
d.ellipse([fx + 2, fy + 2, fx + 7, fy + 7], fill=(91, 58, 49))
d.ellipse([fx + 12, fy + 2, fx + 17, fy + 7], fill=(46, 51, 59))
d.ellipse([fx + 22, fy + 2, fx + 27, fy + 7], fill=(46, 51, 59))
d.text((fx + 38, fy - 2), "memory-eternal / 记忆库", font=f_small, fill=(111, 119, 130))

# footer
d.text((60, 560), "github.com/EternalNight996/memory-eternal", font=f_foot, fill=(111, 119, 130))
d.text((60, 584), "Star if it saves you one explanation.", font=f_foot, fill=(255, 154, 114))

img.save(os.path.join(A, "og.png"), "PNG", optimize=True)
print("wrote og.png", img.size)
