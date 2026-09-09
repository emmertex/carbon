"""Convert the opt-in Playwright captures to page assets (requires Pillow)."""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[2]
source = root / "e2e/test-results/landing-captures"
target = root / "apps/web/public/shots"
for name in ("capture", "organize", "overview", "phone", "plan", "review"):
    with Image.open(source / f"landing-{name}.png") as image:
        image.save(target / f"landing-{name}.webp", quality=85, method=6)
        if name == "overview":
            image.save(target / "landing-overview.png", optimize=True)
