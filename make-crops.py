from PIL import Image
import os

ROOT = r"F:\MyApp\eternal\memory-eternal"
A = os.path.join(ROOT, "site", "assets")

def crop(src, box, out):
    im = Image.open(os.path.join(A, src)).convert("RGB")
    im.crop(box).save(os.path.join(A, out), "PNG", optimize=True)
    print(out, im.crop(box).size)

# 3 cards, readable at ~530px
crop("hero.png", (240, 300, 1000, 840), "hero-crop.png")
# showcase: full content area
crop("hero.png", (228, 250, 1368, 900), "library-showcase.png")
# audit: right preview pane
crop("audit.png", (250, 130, 1408, 860), "audit-crop.png")
# reader: modal body
crop("reader.png", (200, 54, 1240, 860), "reader-crop.png")
# graph: content area
crop("graph.png", (228, 60, 1408, 900), "graph-crop.png")
