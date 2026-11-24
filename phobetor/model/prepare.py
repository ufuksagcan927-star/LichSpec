#!/usr/bin/env python3
"""Veri setini egitim onbellegine cevirir: her goruntu icin normalize edilmis float16 dizi (C,H,W),
piksel durum haritasi (0 veri yok, 1 temiz, 2 bayrakli) ve egitim siniflari (1 yildiz, 0 yildiz degil, -1 yok say).

    python prepare.py --config configs/euclid.json --data <veri seti klasoru> --cache cache/euclid

Kesilirse kaldigi yerden devam eder. Onbellek boyutu: goruntu basina C x H x W x 2 bayt (Euclid: ~8 MB).
"""
import argparse
import glob
import json
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

from common import IGN, POS, load_config, mask_unseen_positives, read_image, read_labels


def sample_name(path):
    n = Path(path).name
    for ext in (".fits.gz", ".fits.fz", ".fits", ".fit", ".fz"):
        if n.lower().endswith(ext):
            return n[: -len(ext)]
    return Path(path).stem


def one(job):
    fits_path, label_path, out_dir, cfg = job
    name = sample_name(fits_path)
    done = out_dir / f"{name}_lab.npz"
    if done.exists():
        z = np.load(done)
        x = np.load(out_dir / f"{name}.npy", mmap_mode="r")
        return dict(name=name, h=int(x.shape[1]), w=int(x.shape[2]), n=int(len(z["cls"])),
                    n_pos=int((z["cls"] == POS).sum()), n_ign=int((z["cls"] == IGN).sum()),
                    n_pos_unseen=int(z["n_pos_unseen"]) if "n_pos_unseen" in z.files else 0)
    x, valid, flagged = read_image(fits_path, cfg)
    lab, n_unseen = mask_unseen_positives(read_labels(label_path, cfg), valid)
    lab["n_pos_unseen"] = np.int64(n_unseen)
    np.save(out_dir / f"{name}.npy", x.astype(np.float16))
    # 0 = veri yok, 1 = temiz, 2 = veri var ama bayrakli (kayipta ve olcumde yok sayilir)
    np.save(out_dir / f"{name}_valid.npy", (valid.astype(np.uint8) + flagged.astype(np.uint8)))
    np.savez(done, **lab)
    return dict(name=name, h=int(x.shape[1]), w=int(x.shape[2]), n=int(len(lab["cls"])),
                n_pos=int((lab["cls"] == POS).sum()), n_ign=int((lab["cls"] == IGN).sum()), n_pos_unseen=n_unseen)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--data", required=True, help="veri seti klasoru (train/ val/ test/ burada)")
    ap.add_argument("--cache", required=True)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--limit", type=int, default=0, help="her bolumden en fazla bu kadar goruntu (deneme icin)")
    a = ap.parse_args()
    cfg = load_config(a.config)
    data, cache = Path(a.data), Path(a.cache)
    cache.mkdir(parents=True, exist_ok=True)
    (cache / "config.json").write_text(json.dumps(cfg, indent=1, ensure_ascii=False), encoding="utf-8")
    for split in cfg["splits"]:
        files = sorted(glob.glob(str(data / cfg["image_glob"].format(split=split))))
        if a.limit:
            files = files[: a.limit]
        out = cache / split
        out.mkdir(exist_ok=True)
        jobs = []
        for f in files:
            lp = data / cfg["label_path"].format(split=split, name=sample_name(f))
            if not lp.exists():
                print(f"  etiket yok, atlandi: {lp}")
                continue
            jobs.append((f, lp, out, cfg))
        t0 = time.time()
        with ProcessPoolExecutor(a.workers) as ex:
            items = list(ex.map(one, jobs, chunksize=2))
        (out / "index.json").write_text(json.dumps(items, indent=0), encoding="utf-8")
        n_pos = sum(i["n_pos"] for i in items)
        n_un = sum(i["n_pos_unseen"] for i in items)
        print(f"{split}: {len(items)} goruntu, {n_pos} yildiz (+{n_un} verisiz pikselde, yok sayildi), "
              f"{time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
