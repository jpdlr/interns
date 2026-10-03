"""Contact sheets: many images as one numbered grid, so an intern can look at
a dozen photos with a single Read instead of a dozen. Used by photo-library
and ig-research. Needs Pillow (requirements.txt)."""
import os


def contact_sheet(paths, out, cols=4, tile=360, labels=None):
    """Write a JPEG grid of `paths` (missing or unreadable files are skipped)
    to `out`. Each tile carries its number (1-based) or labels[i]. Returns the
    list of paths actually placed, in grid order."""
    from PIL import Image, ImageDraw, ImageOps

    placed, tiles = [], []
    for i, p in enumerate(paths):
        try:
            with Image.open(p) as im:
                im = ImageOps.exif_transpose(im).convert("RGB")
                im.thumbnail((tile, tile))
                tiles.append((im.copy(), labels[i] if labels else str(len(placed) + 1)))
                placed.append(p)
        except Exception:
            continue
    if not tiles:
        return []
    cols = max(1, min(cols, len(tiles)))
    rows = (len(tiles) + cols - 1) // cols
    gap = 6
    sheet = Image.new("RGB", (cols * (tile + gap) + gap, rows * (tile + gap) + gap), (24, 24, 27))
    draw = ImageDraw.Draw(sheet)
    for n, (im, label) in enumerate(tiles):
        x = gap + (n % cols) * (tile + gap) + (tile - im.width) // 2
        y = gap + (n // cols) * (tile + gap) + (tile - im.height) // 2
        sheet.paste(im, (x, y))
        lx, ly = gap + (n % cols) * (tile + gap) + 6, gap + (n // cols) * (tile + gap) + 6
        w = 10 + 9 * len(label)
        draw.rectangle([lx, ly, lx + w, ly + 22], fill=(0, 0, 0))
        draw.text((lx + 5, ly + 5), label, fill=(255, 255, 255))
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    sheet.save(out, "JPEG", quality=82)
    return placed
