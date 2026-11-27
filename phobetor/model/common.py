"""Phobetor ortak araclari: ayar dosyasi, goruntu normalizasyonu, etiket kurallari, egitim hedefleri,
tepe noktasi cozumleme ve olcum (kesinlik / duyarlilik).

Koordinat kurali (butun veri setlerinde ayni): x = sutun, y = satir, piksel merkezi tam sayi, 0'dan baslar.
Numpy'da bir yildizin pikseli dizi[round(y), round(x)].
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

POS, NEG, IGN = 1, 0, -1   # POS = ilk sinif (yildiz); cok sinifli ayarda k = k. sinif


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
    positive="",                # (eski bicim) pandas query: pozitif (yildiz) kaynaklar; "classes" yoksa kullanilir
    classes=None,               # [{"ad": "yildiz", "query": "...", "match_radius_px": 2}, ...]
    extra_label_path=None,      # ek etiket dosyasi (object_id ile birlesir), ornegin "{split}/etiketler_ek/{name}.csv"
    props=[],                   # nesne ozellikleri: [{"ad", "col", "tf": none|log10|log1p, "kind": reg|frac, "classes", ...}]
    class_weights=None,
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
    return finalize_config(cfg)


def finalize_config(cfg):
    if not cfg.get("classes"):
        cfg["classes"] = [dict(ad="yildiz", query=cfg["positive"])]
    if not cfg.get("class_weights"):
        cfg["class_weights"] = [1.0] * len(cfg["classes"])
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
def class_names(cfg):
    return [c["ad"] for c in cfg["classes"]]


def class_radius(cfg):
    """Sinif basina esleme yaricapi (piksel); indeks 0 kullanilmaz."""
    return np.array([0.0] + [float(c.get("match_radius_px", cfg["match_radius_px"])) for c in cfg["classes"]], np.float32)


def _tf(v, kind):
    if kind == "log10":
        return np.log10(np.where(v > 0, v, np.nan))
    if kind == "log1p":
        return np.log1p(np.where(v > -1, v, np.nan))
    return v


def _inv_tf(v, kind):
    if kind == "log10":
        return 10.0 ** v
    if kind == "log1p":
        return np.expm1(v)
    return v


def read_labels(csv_path, cfg, extra_path=None):
    """Resmi katalog etiketlerini egitim sinifina cevirir: k >= 1 = cfg['classes'] icindeki k. sinif,
    -1 = yok say, 0 = hicbir sinif (ornegin sahte tespit; ag burada bir sey bulmamali).
    Etiketlerin kendisi degismez; sadece hangi resmi etiketin nasil kullanilacagi secilir.
    Ozellikler (cfg['props']) ek etiket dosyasindan okunur, donusturulur (log vb.); eksikse NaN."""
    d = pd.read_csv(csv_path, low_memory=False)
    if extra_path is not None and Path(extra_path).exists():
        e = pd.read_csv(extra_path, low_memory=False)
        e = e.drop(columns=[c for c in e.columns if c in d.columns and c != "object_id"])
        d = d.merge(e, on="object_id", how="left") if "object_id" in d else pd.concat([d, e], axis=1)
    cls = np.full(len(d), NEG, np.int8)
    if cfg.get("ignore"):
        cls[d.eval(cfg["ignore"]).fillna(False).to_numpy(bool)] = IGN
    for k, c in enumerate(cfg["classes"], start=1):
        cls[d.eval(c["query"]).fillna(False).to_numpy(bool)] = k
    mag = d[cfg["mag_col"]].to_numpy(np.float32) if cfg.get("mag_col") and cfg["mag_col"] in d else np.full(len(d), np.nan, np.float32)
    props = np.full((len(d), len(cfg.get("props", []))), np.nan, np.float32)
    names = class_names(cfg)
    for j, pr in enumerate(cfg.get("props", [])):
        if pr["col"] not in d:
            continue
        v = d[pr["col"]].to_numpy(np.float64) * float(pr.get("scale", 1.0))
        lo, hi = pr.get("range", [-np.inf, np.inf])
        v = np.where((v >= lo) & (v <= hi), v, np.nan)
        if pr.get("query"):
            v = np.where(d.eval(pr["query"]).fillna(False).to_numpy(bool), v, np.nan)
        ok_cls = np.isin(cls, [names.index(c) + 1 for c in pr.get("classes", names)])
        props[:, j] = np.where(ok_cls, _tf(v, pr.get("tf", "none")), np.nan)
    return dict(x=d[cfg["x_col"]].to_numpy(np.float32), y=d[cfg["y_col"]].to_numpy(np.float32), cls=cls, mag=mag,
                props=props)


def mask_unseen_positives(lab, valid):
    """Merkezi goruntu disinda ya da gecersiz (bayrakli / verisiz) bir piksele dusen nesneler yok sayilir:
    orada veri olmadigi icin ag onlari goremez. Etiket degismez, sadece kayipta ve olcumde kullanilmaz.
    Donus: (yeni etiket sozlugu, yok sayilan nesne sayisi)."""
    h, w = valid.shape
    ix = np.floor(lab["x"] + 0.5).astype(np.int64)
    iy = np.floor(lab["y"] + 0.5).astype(np.int64)
    inside = (ix >= 0) & (ix < w) & (iy >= 0) & (iy < h)
    seen = np.zeros(len(ix), bool)
    seen[inside] = valid[iy[inside], ix[inside]]
    bad = (lab["cls"] > 0) & ~seen
    out = dict(lab)
    out["cls"] = lab["cls"].copy()
    out["cls"][bad] = IGN
    return out, int(bad.sum())


def prop_stats(labs, cfg):
    """Egitim bolumunden ozelliklerin ortalama / standart sapmasi (regresyon hedeflerini olceklemek icin)."""
    P = len(cfg.get("props", []))
    if not P:
        return []
    allp = np.concatenate([lab["props"] for lab in labs if len(lab["props"])], 0) if labs else np.zeros((0, P))
    out = []
    for j, pr in enumerate(cfg["props"]):
        v = allp[:, j]
        v = v[np.isfinite(v)]
        if pr.get("kind", "reg") == "frac":
            out.append(dict(mean=0.0, std=1.0, n=int(len(v))))
        else:
            out.append(dict(mean=float(v.mean()) if len(v) else 0.0, std=float(v.std()) if len(v) > 1 else 1.0, n=int(len(v))))
    return out


# ----------------------------------------------------------------------------------------------
# Egitim hedefleri (CenterNet tarzi, sinif basina isi haritasi)
# ----------------------------------------------------------------------------------------------
def make_targets(lab, h, w, cfg, valid=None, stats=None):
    """Isi haritasi (K,H,W), alt-piksel kaymasi (2,H,W), tepe maskesi (K,H,W), kayip agirligi (1,H,W),
    ozellik degerleri (P,H,W) ve ozellik maskesi (P,H,W) (sadece nesne tepe pikselinde dolu)."""
    K = len(cfg["classes"])
    P = len(cfg.get("props", []))
    sigma = float(cfg["heatmap_sigma_px"])
    rad = max(1, int(np.ceil(3 * sigma)))
    hm = np.zeros((K, h, w), np.float32)
    off = np.zeros((2, h, w), np.float32)
    pos = np.zeros((K, h, w), np.float32)
    pv = np.zeros((P, h, w), np.float32)
    pm = np.zeros((P, h, w), np.float32)
    wgt = np.ones((h, w), np.float32) if valid is None else valid.astype(np.float32)

    p = lab["cls"] > 0
    if p.any():
        x, y, c = lab["x"][p], lab["y"][p], lab["cls"][p].astype(np.int64) - 1
        pr = lab["props"][p] if P else None
        ix, iy = np.floor(x + 0.5).astype(np.int64), np.floor(y + 0.5).astype(np.int64)
        inside = (ix >= 0) & (ix < w) & (iy >= 0) & (iy < h)
        x, y, c, ix, iy = x[inside], y[inside], c[inside], ix[inside], iy[inside]
        dy, dx = np.mgrid[-rad:rad + 1, -rad:rad + 1]
        g = np.exp(-(dx ** 2 + dy ** 2) / (2 * sigma ** 2)).astype(np.float32)
        cc = np.repeat(c, g.size)
        yy = (iy[:, None, None] + dy[None]).ravel()
        xx = (ix[:, None, None] + dx[None]).ravel()
        vv = np.broadcast_to(g, (len(ix),) + g.shape).ravel()
        ok = (xx >= 0) & (xx < w) & (yy >= 0) & (yy < h)
        np.maximum.at(hm, (cc[ok], yy[ok], xx[ok]), vv[ok])
        hm[c, iy, ix] = 1.0
        pos[c, iy, ix] = 1.0
        off[0, iy, ix] = x - ix
        off[1, iy, ix] = y - iy
        if P:
            pr = pr[inside]
            for j in range(P):
                v = pr[:, j]
                f = np.isfinite(v)
                if stats is not None:
                    v = (v - stats[j]["mean"]) / max(stats[j]["std"], 1e-6)
                pv[j, iy[f], ix[f]] = v[f]
                pm[j, iy[f], ix[f]] = 1.0

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
    wgt[pos.max(0) > 0] = 1.0  # nesne tepeleri her zaman kayipta
    return hm, off, pos, wgt[None], pv, pm


# ----------------------------------------------------------------------------------------------
# Cozumleme
# ----------------------------------------------------------------------------------------------
def decode(heat, offset, props=None, thr=0.05, max_det=200000):
    """heat (K,H,W) olasilik, offset (2,H,W), props (P,H,W) -> tespitler (N, 4+K+P):
    x, y, skor (en yuksek sinif olasiligi), sinif (1..K), K sinif olasiligi, P ozellik (olceklenmis).
    Tepe: sinif olasiliklarinin en buyugu uzerinde 3x3 yerel en buyuk."""
    from scipy.ndimage import maximum_filter
    if heat.ndim == 2:
        heat = heat[None]
    m = heat.max(0)
    peaks = (m == maximum_filter(m, size=3, mode="constant")) & (m >= thr)
    iy, ix = np.nonzero(peaks)
    s = m[iy, ix]
    if len(s) > max_det:
        keep = np.argsort(-s)[:max_det]
        iy, ix, s = iy[keep], ix[keep], s[keep]
    c = heat[:, iy, ix].argmax(0) + 1
    cols = [ix + offset[0, iy, ix], iy + offset[1, iy, ix], s, c]
    out = np.concatenate([np.stack(cols, 1), heat[:, iy, ix].T] +
                         ([props[:, iy, ix].T] if props is not None and len(props) else []), 1)
    return out.astype(np.float32)


# ----------------------------------------------------------------------------------------------
# Esleme ve olcum
# ----------------------------------------------------------------------------------------------
def match(det, lab, cfg):
    """Tespitleri etiketli nesnelere (hangi sinif olursa olsun) eslestirir: skora gore azalan sirayla,
    her tespit yaricap icindeki en yakin bos nesneye. Yaricap nesnenin sinifina gore (class_radius).
    Donus: dict
      tgt  (N,) eslesen nesnenin etiket dizisindeki sirasi, yoksa -1
      ign  (N,) eslesmedi ama yok sayilan bir kaynagin ustunde (yanlis sayilmaz)
    Sirali esleme sayesinde daha yuksek bir esikteki sonuc, bu listenin basindan aynen okunur."""
    from scipy.spatial import cKDTree
    rad = class_radius(cfg)
    p = np.nonzero(lab["cls"] > 0)[0]
    tgt = np.full(len(det), -1, np.int64)
    ign = np.zeros(len(det), bool)
    if len(det) == 0:
        return dict(tgt=tgt, ign=ign)
    order = np.argsort(-det[:, 2], kind="stable")
    px, py, pr = lab["x"][p], lab["y"][p], rad[lab["cls"][p]]
    tree = cKDTree(np.stack([px, py], 1)) if len(p) else None
    rmax = float(rad.max()) if len(p) else 0.0
    q = lab["cls"] == IGN
    itree = cKDTree(np.stack([lab["x"][q], lab["y"][q]], 1)) if q.any() else None
    ir = max(float(cfg["match_radius_px"]), float(cfg["ignore_radius_px"]))
    taken = np.zeros(len(p), bool)
    for j in order:
        x, y = float(det[j, 0]), float(det[j, 1])
        if tree is not None:
            cand = [k for k in tree.query_ball_point([x, y], rmax) if not taken[k]]
            if cand:
                cand = np.array(cand)
                d2 = (px[cand] - x) ** 2 + (py[cand] - y) ** 2
                ok = d2 <= pr[cand] ** 2
                if ok.any():
                    k = cand[ok][int(np.argmin(d2[ok]))]
                    taken[k] = True
                    tgt[j] = p[k]
                    continue
        if itree is not None and itree.query_ball_point([x, y], ir):
            ign[j] = True
    return dict(tgt=tgt, ign=ign)


def _pool(results):
    """results: [(det, m, lab), ...] -> birlestirilmis diziler."""
    dets, tcls, ign, ntrue, tmag, hit_score, hit_cls, tprops = [], [], [], [], [], [], [], []
    for det, m, lab in results:
        dets.append(det)
        tc = np.where(m["tgt"] >= 0, lab["cls"][np.maximum(m["tgt"], 0)], 0)
        tcls.append(tc)
        ign.append(m["ign"])
        p = np.nonzero(lab["cls"] > 0)[0]
        ntrue.append(lab["cls"][p])
        tmag.append(lab["mag"][p])
        hs = np.zeros(len(lab["cls"]), np.float32)
        hc = np.zeros(len(lab["cls"]), np.int64)
        ok = m["tgt"] >= 0
        hs[m["tgt"][ok]] = det[ok, 2]
        hc[m["tgt"][ok]] = det[ok, 3].astype(np.int64)
        hit_score.append(hs[p])
        hit_cls.append(hc[p])
        tprops.append(lab["props"][np.maximum(m["tgt"], 0)])
    cat = lambda a, dt=None: np.concatenate(a) if a else np.zeros(0, dt)  # noqa: E731
    return dict(det=cat(dets) if dets else np.zeros((0, 4)), tcls=cat(tcls), ign=cat(ign), ntrue=cat(ntrue),
                tmag=cat(tmag), hit_score=cat(hit_score), hit_cls=cat(hit_cls),
                tprops=np.concatenate(tprops) if tprops else np.zeros((0, 0)))


def _best_thr(score, tp, fp, n_true):
    o = np.argsort(-score, kind="stable")
    s, t, f = score[o], np.cumsum(tp[o]), np.cumsum(fp[o])
    if len(s) == 0:
        return 0.5
    prec = t / np.maximum(t + f, 1)
    rec = t / max(n_true, 1)
    f1 = 2 * prec * rec / np.maximum(prec + rec, 1e-12)
    return float(s[int(np.argmax(f1))])


def summarize(results, cfg, thr=None):
    """Sinif basina kesinlik / duyarlilik / F1 ve karisiklik tablosu.
    Bir tespit k sinifi icin dogru sayilir: ag k dedi ve eslestigi nesnenin resmi sinifi k.
    thr: sinif basina esik listesi; verilmezse her sinif icin F1'i en yuksek yapan esik secilir."""
    names = class_names(cfg)
    K = len(names)
    a = _pool(results)
    det, tcls, ign = a["det"], a["tcls"], a["ign"]
    pcls = det[:, 3].astype(np.int64) if len(det) else np.zeros(0, np.int64)
    score = det[:, 2] if len(det) else np.zeros(0, np.float32)
    if thr is None:
        thr = []
        for k in range(1, K + 1):
            sel = (pcls == k) & ~((tcls == 0) & ign)
            tp = (tcls[sel] == k)
            thr.append(_best_thr(score[sel], tp, ~tp, int((a["ntrue"] == k).sum())))
    thr = [float(t) for t in thr]
    kept = score >= np.array([0.0] + thr, np.float32)[pcls] if len(det) else np.zeros(0, bool)
    out = dict(esik={n: round(t, 4) for n, t in zip(names, thr)}, sinif={})
    for k, n in enumerate(names, start=1):
        sel = kept & (pcls == k)
        tp = int((sel & (tcls == k)).sum())
        fp = int((sel & (tcls != k) & ~((tcls == 0) & ign)).sum())
        n_true = int((a["ntrue"] == k).sum())
        found = int(((a["ntrue"] == k) & (a["hit_score"] >= np.array([0.0] + thr)[a["hit_cls"]]) & (a["hit_score"] > 0)).sum())
        prec = tp / max(tp + fp, 1)
        rec = tp / max(n_true, 1)
        out["sinif"][n] = dict(sayi=n_true, dogru=tp, yanlis=fp, kesinlik=round(prec, 4), duyarlilik=round(rec, 4),
                               f1=round(2 * prec * rec / max(prec + rec, 1e-12), 4),
                               bulundu_sinif_farketmez=round(found / max(n_true, 1), 4))
    # karisiklik: satir = resmi sinif, sutun = agin dedigi (esigi gecen eslesmeler) + "bulunamadi"
    conf = np.zeros((K, K + 1), np.int64)
    for k in range(1, K + 1):
        m = kept & (tcls == k)
        for j in range(1, K + 1):
            conf[k - 1, j - 1] = int((m & (pcls == j)).sum())
        conf[k - 1, K] = int((a["ntrue"] == k).sum()) - int(conf[k - 1, :K].sum())
    out["karisiklik"] = pd.DataFrame(conf, index=names, columns=names + ["bulunamadi"]).to_dict()
    out["sahte_tespit"] = int((kept & (tcls == 0) & ~ign).sum())
    f1s = [out["sinif"][n]["f1"] for n in names]
    out["f1_ort"] = round(float(np.mean(f1s)), 4)
    return out


def recall_by_mag(results, cfg, thr):
    """Sinif basina, parlaklik araliklarina gore duyarlilik (dogru sinifla bulunan nesne orani)."""
    a = _pool(results)
    names = class_names(cfg)
    t = np.array([0.0] + list(thr), np.float32)
    rows = []
    bins = cfg["mag_bins"]
    for k, n in enumerate(names, start=1):
        sel = a["ntrue"] == k
        hit = sel & (a["hit_score"] > 0) & (a["hit_score"] >= t[a["hit_cls"]]) & (a["hit_cls"] == k)
        mag = a["tmag"]
        for lo, hi in zip(bins[:-1], bins[1:]):
            m = sel & (mag >= lo) & (mag < hi)
            if m.any():
                rows.append(dict(sinif=n, parlaklik=f"{lo}-{hi}", sayi=int(m.sum()), bulunan=int(hit[m].sum()),
                                 duyarlilik=round(float(hit[m].mean()), 4)))
    return pd.DataFrame(rows)


def prop_errors(results, cfg, stats, thr):
    """Dogru eslesen nesnelerde ozellik tahmin hatalari (resmi katalog degerine gore)."""
    props = cfg.get("props", [])
    if not props:
        return pd.DataFrame()
    a = _pool(results)
    det, tcls = a["det"], a["tcls"]
    K = len(cfg["classes"])
    if not len(det):
        return pd.DataFrame()
    pcls = det[:, 3].astype(np.int64)
    kept = (det[:, 2] >= np.array([0.0] + list(thr), np.float32)[pcls]) & (tcls > 0)
    rows = []
    for j, pr in enumerate(props):
        tv = a["tprops"][:, j]
        pv = det[:, 4 + K + j]
        m = kept & np.isfinite(tv)
        if not m.any():
            continue
        kind, tf = pr.get("kind", "reg"), pr.get("tf", "none")
        if kind == "frac":
            p = 1 / (1 + np.exp(-pv[m]))
            t = tv[m]
            conf = np.abs(t - 0.5) > 0.3      # oylarda acik cogunluk olanlar
            acc = float(((p > 0.5) == (t > 0.5))[conf].mean()) if conf.any() else np.nan
            rows.append(dict(ozellik=pr["ad"], sayi=int(m.sum()), ortalama_mutlak_hata=round(float(np.abs(p - t).mean()), 4),
                             net_oylarda_dogruluk=round(acc, 4) if np.isfinite(acc) else np.nan, net_oy_sayisi=int(conf.sum())))
            continue
        p = pv[m] * stats[j]["std"] + stats[j]["mean"]
        t = tv[m]
        row = dict(ozellik=pr["ad"], sayi=int(m.sum()), ortalama_mutlak_hata=round(float(np.abs(p - t).mean()), 4),
                   ilinti=round(float(np.corrcoef(p, t)[0, 1]), 4) if m.sum() > 2 else np.nan,
                   taban_hata=round(float(np.abs(t - stats[j]["mean"]).mean()), 4))
        if pr["col"] in ("z_foto", "kuasar_z"):
            zp, zt = _inv_tf(p, tf), _inv_tf(t, tf)
            dz = (zp - zt) / (1 + zt)
            row["nmad_dz"] = round(float(1.4826 * np.median(np.abs(dz - np.median(dz)))), 4)
            row["aykiri_orani"] = round(float((np.abs(dz) > 0.15).mean()), 4)
        rows.append(row)
    return pd.DataFrame(rows)
