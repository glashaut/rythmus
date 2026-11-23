"""Erzeugt alle Symbole der App aus einer Vorlage (das ◉-Logo aus der App-Kopfzeile):
- public/icon-192.png, icon-512.png, icon-32.png, favicon.ico   (Web-App / Handy / Browserfenster)
- launcher/rhythmus.ico                                         (Verknüpfungen)
- launcher/rsrc_windows_amd64.syso                              (Symbol fest in Rhythmus.exe)

Aufruf (im Projektordner): python3 tools/make_icons.py
"""
import io
import struct
from PIL import Image, ImageDraw

GREEN = (30, 215, 96, 255)
BG = (15, 16, 18, 255)


def logo(size: int) -> Image.Image:
    """Grüner Ring mit Punkt auf dunklem, abgerundetem Quadrat – wie das ◉ in der App."""
    s = 1024  # groß zeichnen, dann verkleinern = glatte Kanten
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BG)
    c = s / 2
    r_out, ring = s * 0.33, s * 0.075
    d.ellipse([c - r_out, c - r_out, c + r_out, c + r_out], outline=GREEN, width=int(ring))
    r_dot = s * 0.145
    d.ellipse([c - r_dot, c - r_dot, c + r_dot, c + r_dot], fill=GREEN)
    return img.resize((size, size), Image.LANCZOS)


def maskable(size: int) -> Image.Image:
    """Für Android: Vollflächiger Hintergrund, Logo mit Sicherheitsabstand."""
    img = Image.new('RGBA', (size, size), BG)
    inner = logo(int(size * 0.8))
    img.alpha_composite(inner, ((size - inner.width) // 2, (size - inner.height) // 2))
    return img


def dib(img: Image.Image) -> bytes:
    """Icon-Bild im klassischen BMP-Format (für kleine Größen am verlässlichsten)."""
    w, h = img.size
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    px = img.convert('RGBA').load()
    rows = []
    for y in range(h - 1, -1, -1):
        row = bytearray()
        for x in range(w):
            r, g, b, a = px[x, y]
            row += bytes((b, g, r, a))
        rows.append(bytes(row))
    mask_row = ((w + 31) // 32) * 4
    mask = b'\x00' * (mask_row * h)  # Transparenz kommt aus dem Alphakanal
    return header + b''.join(rows) + mask


def png(img: Image.Image) -> bytes:
    b = io.BytesIO()
    img.save(b, 'PNG')
    return b.getvalue()


def icon_images(sizes):
    out = []
    for s in sizes:
        im = logo(s)
        out.append((s, png(im) if s >= 256 else dib(im)))
    return out


def ico_file(images) -> bytes:
    head = struct.pack('<HHH', 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b'', b''
    for s, data in images:
        dim = 0 if s >= 256 else s
        entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        blobs += data
    return head + entries + blobs


def syso(images) -> bytes:
    """COFF-Objekt mit .rsrc-Abschnitt (RT_ICON + RT_GROUP_ICON), wird vom Go-Linker eingebunden."""
    RT_ICON, RT_GROUP_ICON, LANG = 3, 14, 0x0409
    n = len(images)

    # Layout: Wurzel → Typ-Verzeichnisse → Namens-Verzeichnisse → Sprach-Verzeichnisse → Dateneinträge → Daten
    def dir_size(count):
        return 16 + 8 * count

    root_off = 0
    type_icon_off = root_off + dir_size(2)
    type_group_off = type_icon_off + dir_size(n)
    name_icon_offs = []
    pos = type_group_off + dir_size(1)
    for _ in range(n):
        name_icon_offs.append(pos)
        pos += dir_size(1)
    name_group_off = pos
    pos += dir_size(1)
    data_entry_icon_offs = []
    for _ in range(n):
        data_entry_icon_offs.append(pos)
        pos += 16
    data_entry_group_off = pos
    pos += 16

    group = struct.pack('<HHH', 0, 1, n)
    for i, (s, data) in enumerate(images):
        dim = 0 if s >= 256 else s
        group += struct.pack('<BBBBHHIH', dim, dim, 0, 0, 1, 32, len(data), i + 1)

    blobs = []
    data_offs = []
    for _, data in images:
        pos = (pos + 7) & ~7
        data_offs.append(pos)
        blobs.append((pos, data))
        pos += len(data)
    pos = (pos + 7) & ~7
    group_data_off = pos
    blobs.append((pos, group))
    pos += len(group)
    total = (pos + 7) & ~7

    buf = bytearray(total)

    def put_dir(off, entries):
        struct.pack_into('<IIHHHH', buf, off, 0, 0, 0, 0, 0, len(entries))
        for i, (ident, target, is_dir) in enumerate(entries):
            struct.pack_into('<II', buf, off + 16 + 8 * i, ident, target | (0x80000000 if is_dir else 0))

    put_dir(root_off, [(RT_ICON, type_icon_off, True), (RT_GROUP_ICON, type_group_off, True)])
    put_dir(type_icon_off, [(i + 1, name_icon_offs[i], True) for i in range(n)])
    put_dir(type_group_off, [(1, name_group_off, True)])
    for i in range(n):
        put_dir(name_icon_offs[i], [(LANG, data_entry_icon_offs[i], False)])
    put_dir(name_group_off, [(LANG, data_entry_group_off, False)])

    relocs = []
    for i, (_, data) in enumerate(images):
        struct.pack_into('<IIII', buf, data_entry_icon_offs[i], data_offs[i], len(data), 0, 0)
        relocs.append(data_entry_icon_offs[i])
    struct.pack_into('<IIII', buf, data_entry_group_off, group_data_off, len(group), 0, 0)
    relocs.append(data_entry_group_off)
    for off, data in blobs:
        buf[off:off + len(data)] = data

    # COFF-Datei zusammensetzen
    IMAGE_FILE_MACHINE_AMD64 = 0x8664
    IMAGE_REL_AMD64_ADDR32NB = 3
    sec_data_ptr = 20 + 40
    reloc_ptr = sec_data_ptr + len(buf)
    sym_ptr = reloc_ptr + 10 * len(relocs)
    header = struct.pack('<HHIIIHH', IMAGE_FILE_MACHINE_AMD64, 1, 0, sym_ptr, 1, 0, 0)
    section = struct.pack('<8sIIIIIIHHI', b'.rsrc\x00\x00\x00', 0, 0, len(buf), sec_data_ptr,
                          reloc_ptr, 0, len(relocs), 0, 0x40000040)
    reloc_bytes = b''.join(struct.pack('<IIH', off, 0, IMAGE_REL_AMD64_ADDR32NB) for off in relocs)
    symbol = struct.pack('<8sIhHBB', b'.rsrc\x00\x00\x00', 0, 1, 0, 3, 0)
    strtab = struct.pack('<I', 4)
    return header + section + bytes(buf) + reloc_bytes + symbol + strtab


if __name__ == '__main__':
    logo(512).save('public/icon-512.png')
    maskable(192).save('public/icon-192.png')
    logo(32).save('public/icon-32.png')
    maskable(512).save('public/icon-maskable-512.png')
    with open('public/favicon.ico', 'wb') as f:
        f.write(ico_file(icon_images([16, 24, 32, 48, 64, 256])))
    images = icon_images([16, 20, 24, 32, 40, 48, 64, 96, 128, 256])
    with open('launcher/rhythmus.ico', 'wb') as f:
        f.write(ico_file(images))
    with open('launcher/rsrc_windows_amd64.syso', 'wb') as f:
        f.write(syso(images))
    print('Symbole erzeugt')
