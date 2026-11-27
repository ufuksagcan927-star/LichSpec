#!/usr/bin/env python3
"""Phobetor egitimi: onbellekten rastgele kesitlerle agi egitir, belirli araliklarla dogrulama bolumunde
sinif basina kesinlik / duyarlilik olcer ve en iyi modeli kaydeder.

    python train.py --cache cache/euclid --out runs/euclid --steps 20000

Ekran karti (CUDA) varsa otomatik kullanilir; yoksa islemcide calisir (yavas, sadece deneme icin).
"""
import argparse
import csv
import json
import math
import time
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader, Dataset

from common import class_names, decode, finalize_config, make_targets, match, prop_errors, prop_stats, recall_by_mag, summarize
from net import PhobetorNet, focal_loss, offset_loss, prop_loss


# ----------------------------------------------------------------------------------------------
# Veri
# ----------------------------------------------------------------------------------------------
class CacheSplit:
    """Bir bolumun onbellegi: goruntuler bellege degil, ihtiyac oldukca diskten (memmap) okunur."""

    def __init__(self, cache_dir, split):
        self.dir = Path(cache_dir) / split
        self.items = json.loads((self.dir / "index.json").read_text(encoding="utf-8"))
        self._x, self._v, self._lab = {}, {}, {}

    def __len__(self):
        return len(self.items)

    def labels(self, i):
        name = self.items[i]["name"]
        if name not in self._lab:
            z = np.load(self.dir / f"{name}_lab.npz")
            lab = {k: z[k] for k in z.files}
            if "props" not in lab:
                lab["props"] = np.zeros((len(lab["cls"]), 0), np.float32)
            self._lab[name] = lab
        return self._lab[name]

    def get(self, i):
        name = self.items[i]["name"]
        if name not in self._x:
            self._x[name] = np.load(self.dir / f"{name}.npy", mmap_mode="r")
            self._v[name] = np.load(self.dir / f"{name}_valid.npy", mmap_mode="r")
        return self._x[name], self._v[name], self.labels(i)


def augment(img, val, lab, k, flip, c):
    """Kare kesiti 90 derecenin katlari kadar dondurur ve istenirse yatay cevirir; etiket koordinatlarini da.
    (Ozelliklerden yalnizca yone bagli olmayanlar kullanilir: uzaklik, boyut, eksen orani, bicim oylari.)"""
    x, y = lab["x"].copy(), lab["y"].copy()
    if flip:
        img, val = img[:, :, ::-1], val[:, ::-1]
        x = (c - 1) - x
    for _ in range(k):
        img, val = np.rot90(img, 1, axes=(1, 2)), np.rot90(val, 1)
        x, y = y, (c - 1) - x
    out = dict(lab)
    out["x"], out["y"] = x.astype(np.float32), y.astype(np.float32)
    return np.ascontiguousarray(img), np.ascontiguousarray(val), out


class Patches(Dataset):
    def __init__(self, split, cfg, n_items, stats=None, augment_on=True):
        self.split, self.cfg, self.n, self.stats, self.aug = split, cfg, n_items, stats, augment_on

    def __len__(self):
        return self.n

    def __getitem__(self, i):
        rng = np.random.default_rng(int(torch.randint(0, 2 ** 62, ()).item()))
        cfg = self.cfg
        j = int(rng.integers(len(self.split)))
        x, v, lab = self.split.get(j)
        H, W = x.shape[1], x.shape[2]
        c = min(int(cfg["crop"]), H, W)
        present = [k for k in range(1, len(cfg["classes"]) + 1) if (lab["cls"] == k).any()]
        if present and rng.random() < cfg["pos_crop_prob"]:
            # once bir sinif, sonra o siniftan bir nesne: az bulunan siniflar (yildiz, kuasar) daha sik gorulur
            kc = present[int(rng.integers(len(present)))]
            idx = np.nonzero(lab["cls"] == kc)[0]
            k = idx[rng.integers(len(idx))]
            cx = int(lab["x"][k]) + int(rng.integers(-c // 2 + 8, c // 2 - 8))
            cy = int(lab["y"][k]) + int(rng.integers(-c // 2 + 8, c // 2 - 8))
            x0, y0 = int(np.clip(cx - c // 2, 0, W - c)), int(np.clip(cy - c // 2, 0, H - c))
        else:
            x0, y0 = int(rng.integers(0, W - c + 1)), int(rng.integers(0, H - c + 1))
        img = np.asarray(x[:, y0:y0 + c, x0:x0 + c], dtype=np.float32)
        val = np.asarray(v[y0:y0 + c, x0:x0 + c]) == 1   # kayip sadece temiz piksellerde
        m = (lab["x"] >= x0 - 6) & (lab["x"] < x0 + c + 6) & (lab["y"] >= y0 - 6) & (lab["y"] < y0 + c + 6)
        sub = {k2: lab[k2][m] for k2 in ("x", "y", "cls", "mag", "props")}
        sub["x"] = sub["x"] - x0
        sub["y"] = sub["y"] - y0
        if self.aug:
            img, val, sub = augment(img, val, sub, int(rng.integers(4)), bool(rng.random() < 0.5), c)
        t = make_targets(sub, c, c, cfg, valid=val, stats=self.stats)
        return (torch.from_numpy(img),) + tuple(torch.from_numpy(a) for a in t)


# ----------------------------------------------------------------------------------------------
# Tam goruntu uzerinde tahmin ve olcum
# ----------------------------------------------------------------------------------------------
@torch.no_grad()
def predict_full(model, x, device, tile=1024, pad=32):
    """Buyuk goruntuyu ust uste binen parcalarla isler; sinif olasiliklari (K,H,W), kayma (2,H,W)
    ve ozellikler (P,H,W, olceklenmis) dondurur."""
    C, H, W = x.shape
    heat = off = props = None
    step = tile - 2 * pad
    for y0 in range(0, H, step):
        for x0 in range(0, W, step):
            ya, xa = max(0, y0 - pad), max(0, x0 - pad)
            yb, xb = min(H, y0 + step + pad), min(W, x0 + step + pad)
            t = torch.from_numpy(np.asarray(x[:, ya:yb, xa:xb], dtype=np.float32))[None].to(device)
            with torch.autocast(device.type, enabled=device.type == "cuda"):
                h, o, p = model(t)
            h = torch.sigmoid(h.float())[0].cpu().numpy()
            o = o.float()[0].cpu().numpy()
            p = p.float()[0].cpu().numpy() if p is not None else np.zeros((0,) + h.shape[1:], np.float32)
            if heat is None:
                heat = np.zeros((h.shape[0], H, W), np.float32)
                off = np.zeros((2, H, W), np.float32)
                props = np.zeros((p.shape[0], H, W), np.float32)
            ys, xs = y0 - ya, x0 - xa
            ye, xe = min(step, H - y0), min(step, W - x0)
            heat[:, y0:y0 + ye, x0:x0 + xe] = h[:, ys:ys + ye, xs:xs + xe]
            off[:, y0:y0 + ye, x0:x0 + xe] = o[:, ys:ys + ye, xs:xs + xe]
            props[:, y0:y0 + ye, x0:x0 + xe] = p[:, ys:ys + ye, xs:xs + xe]
    return heat, off, props


def evaluate_split(model, split, cfg, device, limit=0, thr_decode=0.05):
    """Her goruntu icin (tespitler, esleme, etiketler) listesi."""
    model.eval()
    results = []
    n = len(split) if not limit else min(limit, len(split))
    for i in range(n):
        x, v, lab = split.get(i)
        heat, off, props = predict_full(model, x, device)
        v = np.asarray(v)
        heat[:, v == 0] = 0.0
        det = decode(heat, off, props, thr=thr_decode)
        m = match(det, lab, cfg)
        # bayrakli piksellerdeki (hayalet, doyma izi...) eslesmeyen tespitler yanlis sayilmaz
        if len(det):
            ix = np.clip(np.floor(det[:, 0] + 0.5).astype(int), 0, v.shape[1] - 1)
            iy = np.clip(np.floor(det[:, 1] + 0.5).astype(int), 0, v.shape[0] - 1)
            m["ign"] |= (m["tgt"] < 0) & (v[iy, ix] == 2)
        results.append((det, m, lab))
    model.train()
    return results


def build_model(cfg, in_ch, device):
    return PhobetorNet(in_ch, base=int(cfg["base_channels"]), n_classes=len(cfg["classes"]),
                       n_props=len(cfg.get("props", []))).to(device)


def full_report(model, split, cfg, device, out, prefix, thr=None, stats=None):
    """Bir bolumun tamami: ozet (json), parlakliga gore duyarlilik ve ozellik hatalari (csv)."""
    res = evaluate_split(model, split, cfg, device)
    sm = summarize(res, cfg, thr=thr)
    t = [sm["esik"][n] for n in class_names(cfg)]
    rb = recall_by_mag(res, cfg, t)
    pe = prop_errors(res, cfg, stats or [], t)
    rb.to_csv(out / f"{prefix}_parlaklik.csv", index=False)
    if len(pe):
        pe.to_csv(out / f"{prefix}_ozellikler.csv", index=False)
    return res, sm, rb, pe


# ----------------------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--steps", type=int, default=20000)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--val-every", type=int, default=1000)
    ap.add_argument("--val-images", type=int, default=0, help="ara dogrulamada kullanilacak goruntu sayisi (0 = hepsi)")
    ap.add_argument("--crop", type=int, default=0, help="ayar dosyasindaki kesit boyutunu degistirir")
    ap.add_argument("--base", type=int, default=0, help="agin temel kanal sayisi (varsayilan: ayar dosyasi)")
    ap.add_argument("--prop-weight", type=float, default=0.5, help="ozellik kaybinin agirligi")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()

    torch.manual_seed(a.seed)
    cache = Path(a.cache)
    cfg = finalize_config(json.loads((cache / "config.json").read_text(encoding="utf-8")))
    if a.crop:
        cfg["crop"] = a.crop
    if a.base:
        cfg["base_channels"] = a.base
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    device = torch.device("cuda" if torch.cuda.is_available() else
                          "mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu")
    train_split, val_split = CacheSplit(cache, "train"), CacheSplit(cache, "val")
    stats = prop_stats([train_split.labels(i) for i in range(len(train_split))], cfg)
    cfg["prop_stats"] = stats
    kinds = [p.get("kind", "reg") for p in cfg.get("props", [])]
    in_ch = int(np.load(train_split.dir / f"{train_split.items[0]['name']}.npy", mmap_mode="r").shape[0])
    model = build_model(cfg, in_ch, device)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=1e-4)
    warm = min(500, a.steps // 10)
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: min(1.0, (s + 1) / max(warm, 1)) * (0.01 + 0.99 * 0.5 * (1 + math.cos(math.pi * min(s, a.steps) / a.steps))))
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")
    cw = torch.tensor(cfg["class_weights"], dtype=torch.float32, device=device)
    step, best = 0, -1.0
    ck = out / "son.pt"
    if a.resume and ck.exists():
        s = torch.load(ck, map_location=device, weights_only=False)
        model.load_state_dict(s["model"]); opt.load_state_dict(s["opt"]); sched.load_state_dict(s["sched"])
        step, best = s["step"], s.get("best", -1.0)
        print(f"devam: adim {step}, en iyi puan {best:.4f}")
    (out / "config.json").write_text(json.dumps(cfg, indent=1, ensure_ascii=False), encoding="utf-8")
    n_par = sum(p.numel() for p in model.parameters()) / 1e6
    names = class_names(cfg)
    print(f"cihaz={device} giris_kanal={in_ch} siniflar={names} ozellik={len(kinds)} parametre={n_par:.1f}M "
          f"egitim_goruntu={len(train_split)} dogrulama_goruntu={len(val_split)} kesit={cfg['crop']} toplu={a.batch}")
    for pr, st in zip(cfg.get("props", []), stats):
        print(f"  ozellik {pr['ad']}: {st['n']} egitim ornegi")

    ds = Patches(train_split, cfg, n_items=(a.steps - step) * a.batch, stats=stats)
    dl = DataLoader(ds, batch_size=a.batch, num_workers=a.workers, pin_memory=device.type == "cuda",
                    persistent_workers=a.workers > 0, drop_last=True)
    log_f = open(out / "log.csv", "a", newline="")
    log = csv.writer(log_f)
    if step == 0:
        log.writerow(["adim", "kayip", "odak", "kayma", "ozellik", "lr", "sn", "puan"] +
                     [f"{n}_{m}" for n in names for m in ("f1", "kesinlik", "duyarlilik")])
    t0, run = time.time(), []
    model.train()
    for batch in dl:
        img, hm, off, pos, wgt, pv, pm = (t.to(device, non_blocking=True) for t in batch)
        with torch.autocast(device.type, enabled=device.type == "cuda"):
            logit, o, pp = model(img)
        lf = focal_loss(logit.float(), hm, pos, wgt, class_weights=cw)
        lo = offset_loss(o.float(), off, pos)
        lp = prop_loss(pp.float(), pv, pm, kinds) if pp is not None else torch.zeros((), device=device)
        loss = lf + lo + a.prop_weight * lp
        opt.zero_grad(set_to_none=True)
        scaler.scale(loss).backward()
        scaler.unscale_(opt)
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
        scaler.step(opt)
        scaler.update()
        sched.step()
        step += 1
        run.append((loss.item(), lf.item(), lo.item(), float(lp)))
        if step % 50 == 0:
            m = np.mean(run[-50:], 0)
            print(f"adim {step}/{a.steps} kayip {m[0]:.4f} (odak {m[1]:.4f}, kayma {m[2]:.4f}, ozellik {m[3]:.4f}) "
                  f"lr {sched.get_last_lr()[0]:.2e} {time.time() - t0:.0f} s", flush=True)
        if step % a.val_every == 0 or step == a.steps:
            res = evaluate_split(model, val_split, cfg, device, limit=a.val_images)
            sm = summarize(res, cfg)
            score = sm["f1_ort"]
            m = np.mean(run, 0) if run else [np.nan] * 4
            log.writerow([step, f"{m[0]:.5f}", f"{m[1]:.5f}", f"{m[2]:.5f}", f"{m[3]:.5f}", f"{sched.get_last_lr()[0]:.3e}",
                          f"{time.time() - t0:.0f}", score] +
                         [sm["sinif"][n][k] for n in names for k in ("f1", "kesinlik", "duyarlilik")])
            log_f.flush()
            run = []
            print("  dogrulama: " + ", ".join(f"{n} F1 {sm['sinif'][n]['f1']:.3f} (k {sm['sinif'][n]['kesinlik']:.3f} "
                                              f"d {sm['sinif'][n]['duyarlilik']:.3f})" for n in names), flush=True)
            state = dict(model=model.state_dict(), opt=opt.state_dict(), sched=sched.state_dict(), step=step,
                         best=max(best, score), cfg=cfg, in_ch=in_ch, val=sm)
            torch.save(state, ck)
            if score > best:
                best = score
                torch.save(dict(model=model.state_dict(), cfg=cfg, in_ch=in_ch, step=step, val=sm), out / "en_iyi.pt")
                print(f"  en iyi model kaydedildi (ortalama F1 {best:.4f})", flush=True)
        if step >= a.steps:
            break
    log_f.close()
    # son: en iyi modelle tum dogrulama bolumu; esikler burada secilir
    s = torch.load(out / "en_iyi.pt", map_location=device, weights_only=False)
    model.load_state_dict(s["model"])
    _, sm, rb, pe = full_report(model, val_split, cfg, device, out, "dogrulama", stats=stats)
    (out / "dogrulama.json").write_text(json.dumps(dict(ozet=sm, adim=s["step"]), indent=1, ensure_ascii=False), encoding="utf-8")
    print("tum dogrulama bolumu:", json.dumps(sm["sinif"], ensure_ascii=False))
    print(rb.to_string(index=False))
    if len(pe):
        print(pe.to_string(index=False))


if __name__ == "__main__":
    main()
