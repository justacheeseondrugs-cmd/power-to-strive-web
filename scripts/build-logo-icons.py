"""Build PWA cat logo icons from the image supplied by the app owner.
Source is self-contained: icons/user-cat-logo.svg contains a WebP preview of
the supplied logo. PNG assets are generated solely for app branding.
"""
import base64
import io
import re
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
source = (ROOT / "icons" / "user-cat-logo.svg").read_text(encoding="utf-8")
match = re.search(r"data:image/webp;base64,([A-Za-z0-9+/=]+)", source)
if not match:
    raise ValueError("Embedded logo image was not found")
image = Image.open(io.BytesIO(base64.b64decode(match.group(1), validate=True))).convert("RGB")
image.load()
if image.width != image.height:
    raise ValueError("Logo source must be square")
icons = ROOT / "icons"
for size in (192, 512):
    image.resize((size,size), Image.Resampling.LANCZOS).save(
        icons / f"logo-{size}.png",format="PNG",optimize=True)
maskable = Image.new("RGB", (512,512), image.getpixel((0,0)))
maskable.paste(image.resize((384,384),Image.Resampling.LANCZOS), (64,64))
maskable.save(icons / "logo-maskable-512.png",format="PNG",optimize=True)
print("Generated app icons: 192x192, 512x512, and 512x512 maskable")
