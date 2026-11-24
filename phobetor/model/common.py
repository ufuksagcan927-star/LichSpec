"""Phobetor ortak araclari: ayar dosyasi, goruntu normalizasyonu, etiket kurallari, egitim hedefleri,
tepe noktasi cozumleme ve olcum (kesinlik / duyarlilik).

Koordinat kurali (butun veri setlerinde ayni): x = sutun, y = satir, piksel merkezi tam sayi, 0'dan baslar.
Numpy'da bir yildizin pikseli dizi[round(y), round(x)].
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

POS, NEG, IGN = 1, 0, -1


# ----------------------------------------------------------------------------------------------
# Ayar dosyasi
# ----------------------------------------------------------------------------------------------
DEFAULTS = dict(
    splits=["train", "val", "test"],
    image_glob="{split}/goruntuler/*.fits",
    label_path="{split}/etiketler/{name}.csv",
    noise=None,                 # gurultu katmanlari (RMS); yoksa her goruntunun gurultusu MAD ile tahmin edilir
    noise_kind="rms",           # "rms" ya da "weight" (ters varyans)
    flag_hdu=None,              # kayipta maskelenecek piksel bayraklari (istege bagli)
    flag_mask=0,
    x_col="x", y_col="y", mag_col=None,
    positive="",                # pandas query: pozitif (yildiz) kaynaklar
    ignore="",                  # pandas query: kayipta yok sayilan kaynaklar
    stretch=3.0,                # asinh yumusatmasi, gurultu biriminde
    heatmap_sigma_px=1.0,
    match_radius_px=2.0,
    ignore_radius_px=3.0,
    crop=256,
    pos_crop_prob=0.5,          # kesitlerin bu kadari rastgele bir yildizin cevresinden alinir
    mag_bins=[16, 18, 20, 22, 23, 24, 25, 26, 28],
    base_channels=32,
)


def load_config(path):
    cfg = dict(DEFAULTS)
    cfg.update(json.loads(Path(path).read_text(encoding="utf-8")))
    for k in ("bands",):
        if k not in cfg:
            raise ValueError(f"ayar dosyasinda '{k}' eksik: {path}")
    return cfg


# ----------------------------------------------------------------------------------------------
# Goruntu okuma ve normalizasyon
# ----------------------------------------------------------------------------------------------
def _hdu(h, key):
    return h[key] if isinstance(key, str) else h[int(key)]


def read_image(fits_path, cfg):
    """FITS'ten bantlari okuyup normalize eder.
    Donus: x (C,H,W) float32 = asinh(S/N / stretch), valid (H,W) bool (veri var), flagged (H,W) bool
    (veri var ama piksel bayragi hatali diyor: hayalet, doyma, tasma...). Bayrakli pikseller girise aynen
    verilir (ag gercek goruntulerde de bunlari gorecek), sadece kayipta ve olcumde yok sayilir."""
    from astropy.io import fits
    with fits.open(fits_path, memmap=False) as h:
        sci = [np.asarray(_hdu(h, b).data, dtype=np.float32) for b in cfg["bands"]]
        noise = [np.asarray(_hdu(h, b).data, dtype=np.float32) for b in cfg["noise"]] if cfg.get("noise") else None
        flag = np.asarray(_hdu(h, cfg["flag_hdu"]).data).astype(np.int64) if cfg.get("flag_hdu") else None
    return normalize(sci, noise, flag, cfg)


def normalize(sci, noise, flag, cfg):
    sci = [np.asarray(s, dtype=np.float32) for s in sci]
    valid = np.ones(sci[0].shape, bool)
    for s in sci:
        valid &= np.isfinite(s)
    valid &= sci[0] != 0                        # Euclid kapsanmayan/sifirlanan pikseller (parlak yildiz merkezleri)
    out = []
    for i, s in enumerate(sci):
        s = np.where(np.isfinite(s), s, 0.0)
        if noise is not None:
            n = np.asarray(noise[i], dtype=np.float32)
            if cfg.get("noise_kind", "rms") == "weight":
                n = np.where(n > 0, 1.0 / np.sqrt(np.maximum(n, 1e-30)), np.inf)
            good = np.isfinite(n) & (n > 0) & (n < 1e10)
            z = np.where(good, s / np.where(good, n, 1.0), 0.0)
            if i == 0:
                valid &= good
        else:
            v = s[valid] if valid.any() else s.ravel()
            med = float(np.median(v))
            mad = float(np.median(np.abs(v - med))) * 1.4826
            z = (s - med) / max(mad, 1e-12)
        z = np.clip(z, -50.0, 1e6)
        out.append(np.arcsinh(z / float(cfg["stretch"])).astype(np.float32))
    x = np.stack(out)
    x[:, ~valid] = 0.0
    flagged = np.zeros_like(valid)
    if flag is not None and cfg.get("flag_mask"):
        flagged = valid & ((flag & int(cfg["flag_mask"])) != 0)
    return x, valid, flagged


# ----------------------------------------------------------------------------------------------
# Etiketler
# ----------------------------------------------------------------------------------------------
def read_labels(csv_path, cfg):
    """Resmi katalog etiketlerini egitim sinifina cevirir: 1 = yildiz, -1 = yok say, 0 = diger (yildiz degil).
    Etiketlerin kendisi degismez; sadece hangi resmi etiketin nasil kullanilacagi secilir."""
    d = pd.read_csv(csv_path, low_memory=False)
    cls = np.full(len(d), NEG, np.int8)
    if cfg.get("ignore"):
        cls[d.eval(cfg["ignore"]).fillna(False).to_numpy(bool)] = IGN
    if cfg.get("positive"):
        cls[d.eval(cfg["positive"]).fillna(False).to_numpy(bool)] = POS
    mag = d[cfg["mag_col"]].to_numpy(np.float32) if cfg.get("mag_col") and cfg["mag_col"] in d else np.full(len(d), np.nan, np.float32)
    return dict(x=d[cfg["x_col"]].to_numpy(np.float32), y=d[cfg["y_col"]].to_numpy(np.float32), cls=cls, mag=mag)


def mask_unseen_positives(lab, valid):
    """Merkezi goruntu disinda ya da gecersiz (bayrakli / verisiz) bir piksele dusen yildizlar yok sayilir:
    orada veri olmadigi icin ag onlari goremez. Etiket degismez, sadece kayipta ve olcumde kullanilmaz.
    Donus: (yeni etiket sozlugu, yok sayilan yildiz sayisi)."""
    h, w = valid.shape
    ix = np.floor(lab["x"] + 0.5).astype(np.int64)
    iy = np.floor(lab["y"] + 0.5).astype(np.int64)
    inside = (ix >= 0) & (ix < w) & (iy >= 0) & (iy < h)
    seen = np.zeros(len(ix), bool)
    seen[inside] = valid[iy[inside], ix[inside]]
    bad = (lab["cls"] == POS) & ~seen
    out = dict(lab)
    out["cls"] = lab["cls"].copy()
    out["cls"][bad] = IGN
    return out, int(bad.sum())


# ----------------------------------------------------------------------------------------------
# Egitim hedefleri (CenterNet tarzi isi haritasi)
# ----------------------------------------------------------------------------------------------
def make_targets(lab, h, w, cfg, valid=None):
    """Isi haritasi (1,H,W), alt-piksel kaymasi (2,H,W), pozitif tepe maskesi (1,H,W), kayip agirligi (1,H,W)."""
    sigma = float(cfg["heatmap_sigma_px"])
    rad = max(1, int(np.ceil(3 * sigma)))
    hm = np.zeros((h, w), np.float32)
    off = np.zeros((2, h, w), np.float32)
    pos = np.zeros((h, w), np.float32)
    wgt = np.ones((h, w), np.float32) if valid is None else valid.astype(np.float32)

    p = lab["cls"] == POS
    if p.any():
        x, y = lab["x"][p], lab["y"][p]
        ix, iy = np.floor(x + 0.5).astype(np.int64), np.floor(y + 0.5).astype(np.int64)
        inside = (ix >= 0) & (ix < w) & (iy >= 0) & (iy < h)
        x, y, ix, iy = x[inside], y[inside], ix[inside], iy[inside]
        dy, dx = np.mgrid[-rad:rad + 1, -rad:rad + 1]
        g = np.exp(-(dx ** 2 + dy ** 2) / (2 * sigma ** 2)).astype(np.float32)
        yy = (iy[:, None, None] + dy[None]).ravel()
        xx = (ix[:, None, None] + dx[None]).ravel()
        vv = np.broadcast_to(g, (len(ix),) + g.shape).ravel()
        ok = (xx >= 0) & (xx < w) & (yy >= 0) & (yy < h)
        np.maximum.at(hm, (yy[ok], xx[ok]), vv[ok])
        hm[iy, ix] = 1.0
        pos[iy, ix] = 1.0
        off[0, iy, ix] = x - ix
        off[1, iy, ix] = y - iy

    q = lab["cls"] == IGN
    if q.any():
        r = float(cfg["ignore_radius_px"])
        ri = int(np.ceil(r))
        ix = np.floor(lab["x"][q] + 0.5).astype(np.int64)
        iy = np.floor(lab["y"][q] + 0.5).astype(np.int64)
        dy, dx = np.mgrid[-ri:ri + 1, -ri:ri + 1]
        disc = (dx ** 2 + dy ** 2) <= r * r
        dx, dy = dx[disc], dy[disc]
        yy = (iy[:, None] + dy[None]).ravel()
        xx = (ix[:, None] + dx[None]).ravel()
        ok = (xx >= 0) & (xx < w) & (yy >= 0) & (yy < h)
        wgt[yy[ok], xx[ok]] = 0.0
    wgt[pos > 0] = 1.0  # pozitif tepe her zaman kayipta
    return hm[None], off, pos[None], wgt[None]


# ----------------------------------------------------------------------------------------------
# Cozumleme ve olcum
# ----------------------------------------------------------------------------------------------
def decode(heat, offset, thr=0.05, max_det=200000):
    """heat (H,W) olasilik, offset (2,H,W) -> tespitler (N,3): x, y, skor. 3x3 yerel tepe."""
    from scipy.ndimage import maximum_filter
    peaks = (heat == maximum_filter(heat, size=3, mode="constant")) & (heat >= thr)
    iy, ix = np.nonzero(peaks)
    s = heat[iy, ix]
    if len(s) > max_det:
        keep = np.argsort(-s)[:max_det]
        iy, ix, s = iy[keep], ix[keep], s[keep]
    x = ix + offset[0, iy, ix]
    y = iy + offset[1, iy, ix]
    return np.stack([x, y, s], 1).astype(np.float32)


def match(det, lab, cfg):
    """Tespitleri etiketlerle eslestirir: skora gore azalan sirayla, her tespit en yakin bos yildiza.
    Donus: state (N,) 1=dogru, 0=yanlis, -1=yok sayilan bir kaynagin ustunde; hit_score (P,) yildizi bulan
    tespitin skoru (bulunmadiysa 0); pmag (P,) yildizlarin parlakligi.
    Sirali esleme sayesinde daha yuksek bir esikteki sonuc, bu listenin basindan aynen okunur."""
    from scipy.spatial import cKDTree
    r = float(cfg["match_radius_px"])
    p = lab["cls"] == POS
    px, py, pmag = lab["x"][p], lab["y"][p], lab["mag"][p]
    state = np.zeros(len(det), np.int8)
    hit_score = np.zeros(int(p.sum()), np.float32)
    if len(det) == 0:
        return state, hit_score, pmag
    order = np.argsort(-det[:, 2], kind="stable")
    tree = cKDTree(np.stack([px, py], 1)) if p.any() else None
    q = lab["cls"] == IGN
    itree = cKDTree(np.stack([lab["x"][q], lab["y"][q]], 1)) if q.any() else None
    ir = max(r, float(cfg["ignore_radius_px"]))
    taken = np.zeros(int(p.sum()), bool)
    for j in order:
        x, y = float(det[j, 0]), float(det[j, 1])
        if tree is not None:
            cand = [c for c in tree.query_ball_point([x, y], r) if not taken[c]]
            if cand:
                c = cand[int(np.argmin((px[cand] - x) ** 2 + (py[cand] - y) ** 2))]
                taken[c] = True
                hit_score[c] = det[j, 2]
                state[j] = 1
                continue
        if itree is not None and itree.query_ball_point([x, y], ir):
            state[j] = -1
            continue
        state[j] = 0
    return state, hit_score, pmag


def summarize(results, thr=None):
    """results: [(det, state, hit_score, pmag), ...]. thr verilmezse F1'i en yuksek yapan esik secilir."""
    n_pos = int(sum(len(r[2]) for r in results))
    scores = np.concatenate([r[0][:, 2] for r in results]) if results else np.zeros(0, np.float32)
    states = np.concatenate([r[1] for r in results]) if results else np.zeros(0, np.int8)
    o = np.argsort(-scores, kind="stable")
    s_sorted, st = scores[o], states[o]
    tp = np.cumsum(st == 1)
    fp = np.cumsum(st == 0)
    if thr is None:
        if len(s_sorted) == 0:
            thr, n_at = 0.5, 0
        else:
            prec = tp / np.maximum(tp + fp, 1)
            rec = tp / max(n_pos, 1)
            f1 = 2 * prec * rec / np.maximum(prec + rec, 1e-12)
            k = int(np.argmax(f1))
            thr = float(s_sorted[k])
            n_at = int(np.sum(s_sorted >= thr))
    else:
        n_at = int(np.sum(s_sorted >= thr))
    t = int(tp[n_at - 1]) if n_at > 0 else 0
    f = int(fp[n_at - 1]) if n_at > 0 else 0
    prec = t / max(t + f, 1)
    rec = t / max(n_pos, 1)
    f1 = 2 * prec * rec / max(prec + rec, 1e-12)
    return dict(esik=round(float(thr), 4), kesinlik=round(prec, 4), duyarlilik=round(rec, 4), f1=round(f1, 4),
                yildiz=n_pos, dogru=t, yanlis=f, kacan=n_pos - t)


def recall_by_mag(results, cfg, thr):
    """Esik thr'de, parlaklik araliklarina gore duyarlilik (bulunan yildiz orani)."""
    if not results:
        return pd.DataFrame()
    mag = np.concatenate([r[3] for r in results])
    hit = np.concatenate([r[2] for r in results]) >= thr
    hit &= np.concatenate([r[2] for r in results]) > 0
    rows = []
    bins = cfg["mag_bins"]
    for lo, hi in zip(bins[:-1], bins[1:]):
        m = (mag >= lo) & (mag < hi)
        rows.append(dict(parlaklik=f"{lo}-{hi}", yildiz=int(m.sum()), bulunan=int(hit[m].sum()),
                         duyarlilik=round(float(hit[m].mean()), 4) if m.any() else np.nan))
    m = ~np.isfinite(mag)
    if m.any():
        rows.append(dict(parlaklik="bilinmiyor", yildiz=int(m.sum()), bulunan=int(hit[m].sum()),
                         duyarlilik=round(float(hit[m].mean()), 4)))
    return pd.DataFrame(rows)
