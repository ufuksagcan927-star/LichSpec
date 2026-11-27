#!/usr/bin/env python3
"""Sabah ozeti icin iki kontrol resmi: ozet_kontrol.png (alan/bolum basina etiketli kesitler) ve
ozet_yakin.png (yildiz etiketlerinin yakindan gorunumu)."""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from PIL import Image, ImageDraw, ImageFont

out = Path(sys.argv[1] if len(sys.argv) > 1 else "euclid_v1")
dst = Path(sys.argv[2] if len(sys.argv) > 2 else ".")
idx = pd.read_csv(out / "index.csv")
COL = {"yildiz": (0, 229, 255), "galaksi": (255, 152, 0), "kuasar": (255, 64, 255), "kuresel_kume": (118, 255, 3),
       "belirsiz": (189, 189, 189), "sahte": (255, 23, 68)}
AD = {"yildiz": "yıldız", "galaksi": "galaksi", "kuasar": "kuasar", "kuresel_kume": "küresel küme",
      "belirsiz": "belirsiz", "sahte": "sahte"}


def font(sz):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf"):
        if Path(p).exists():
            return ImageFont.truetype(p, sz)
    return ImageFont.load_default()


def draw_labels(im, lab, scale=1.0, x0=0, y0=0, r=9, w=2):
    d = ImageDraw.Draw(im)
    for t in lab.itertuples():
        x, y = (t.x - x0) * scale, (t.y - y0) * scale
        if x < -20 or y < -20 or x > im.width + 20 or y > im.height + 20:
            continue
        c = COL.get(t.sinif, (255, 255, 255))
        if t.sinif == "sahte":
            d.line([(x - r * .7, y - r * .7), (x + r * .7, y + r * .7)], fill=c, width=w)
            d.line([(x - r * .7, y + r * .7), (x + r * .7, y - r * .7)], fill=c, width=w)
        else:
            d.ellipse([x - r, y - r, x + r, y + r], outline=c, width=w)


PRESENT = [k for k in ("yildiz", "galaksi", "kuasar", "kuresel_kume", "belirsiz", "sahte")
           if k in ("yildiz", "galaksi", "sahte", "belirsiz") or idx[k].sum() > 0]


def legend(width, h=46):
    im = Image.new("RGB", (width, h), (18, 18, 22))
    d = ImageDraw.Draw(im)
    f = font(20)
    x = 14
    for k in PRESENT:
        c = COL[k]
        if k == "sahte":
            d.line([(x, 14), (x + 18, 32)], fill=c, width=3)
            d.line([(x, 32), (x + 18, 14)], fill=c, width=3)
        else:
            d.ellipse([x, 14, x + 18, 32], outline=c, width=3)
        d.text((x + 26, 11), AD[k], fill=(235, 235, 235), font=f)
        x += 26 + d.textlength(AD[k], font=f) + 30
    return im


def panel_grid():
    rng = np.random.default_rng(7)
    picks = []
    for alan in ("EDF-N", "EDF-F", "EDF-S"):
        for grp in (("train",), ("val", "test")):
            s = idx[(idx.alan == alan) & idx.bolum.isin(grp)]
            s = s[s.ad.apply(lambda a: (out / "kontrol" / f"{a}_etiketli.jpg").exists())]
            if len(s):
                picks.append(s.iloc[int(rng.integers(len(s)))])
    tile = 560
    cols = 3
    rows = int(np.ceil(len(picks) / cols))
    W = cols * tile + (cols + 1) * 10
    canvas = Image.new("RGB", (W, rows * (tile + 40) + 10 + 46), (18, 18, 22))
    d = ImageDraw.Draw(canvas)
    f = font(20)
    for i, r in enumerate(picks):
        im = Image.open(out / r.bolum / "onizleme" / f"{r.ad}.jpg").resize((tile, tile), Image.LANCZOS)
        lab = pd.read_csv(out / r.bolum / "etiketler" / f"{r.ad}.csv", usecols=["x", "y", "sinif"])
        draw_labels(im, lab, scale=tile / 1024, x0=-0.5, y0=-0.5, r=6, w=2)
        x = 10 + (i % cols) * (tile + 10)
        y = 10 + (i // cols) * (tile + 40)
        canvas.paste(im, (x, y + 30))
        d.text((x, y + 4), f"{r.alan} · {r.bolum} · yıldız {r.yildiz_vis} (VIS) · kaynak {r.kaynak}",
               fill=(235, 235, 235), font=f)
    canvas.paste(legend(W), (0, canvas.height - 46))
    canvas.save(dst / "ozet_kontrol.png")


def zooms():
    """Rastgele kesitlerden, VIS'te de bulunan yildizlarin cevresinden 160x160 piksel (16") yakin gorunum."""
    rng = np.random.default_rng(11)
    crops = []
    cand = idx[idx.yildiz_vis > 0].sample(frac=1, random_state=3)
    for r in cand.itertuples():
        lab = pd.read_csv(out / r.bolum / "etiketler" / f"{r.ad}.csv", usecols=["x", "y", "sinif", "vis_det", "mag_vis"])
        st = lab[(lab.sinif == "yildiz") & (lab.vis_det == 1) & (lab.mag_vis < 23)]
        st = st[(st.x > 80) & (st.x < 944) & (st.y > 80) & (st.y < 944)]
        if not len(st):
            continue
        s = st.iloc[int(rng.integers(len(st)))]
        x0, y0 = int(round(s.x)) - 80, int(round(s.y)) - 80
        im = Image.open(out / r.bolum / "onizleme" / f"{r.ad}.jpg").crop((x0, y0, x0 + 160, y0 + 160))
        im = im.resize((320, 320), Image.NEAREST)
        draw_labels(im, lab, scale=2.0, x0=x0 - 0.5, y0=y0 - 0.5, r=14, w=2)
        crops.append((im, f"{r.alan} · VIS {s.mag_vis:.1f} kadir"))
        if len(crops) == 8:
            break
    cols = 4
    W = cols * 320 + (cols + 1) * 10
    rows = int(np.ceil(len(crops) / cols))
    canvas = Image.new("RGB", (W, rows * 360 + 10 + 46), (18, 18, 22))
    d = ImageDraw.Draw(canvas)
    f = font(18)
    for i, (im, t) in enumerate(crops):
        x = 10 + (i % cols) * 330
        y = 10 + (i // cols) * 360
        canvas.paste(im, (x, y + 28))
        d.text((x, y + 4), t, fill=(235, 235, 235), font=f)
    canvas.paste(legend(W), (0, canvas.height - 46))
    canvas.save(dst / "ozet_yakin.png")


panel_grid()
zooms()
print("tamam")
