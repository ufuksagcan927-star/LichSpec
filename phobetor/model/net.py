"""Phobetor agi: tam cozunurluklu isi haritasi ureten kucuk bir U-Net.

Cikislar (giris boyutuyla ayni):
  heat   (K,H,W)  her pikselin k. sinif (yildiz, galaksi, kuasar...) bir nesnenin merkezi olma olasiligi (logit)
  offset (2,H,W)  nesne merkezinin piksel icindeki kaymasi (x, y), -0.5..0.5
  props  (P,H,W)  nesne ozellikleri (uzaklik, boyut, bicim...), nesnenin merkez pikselinde okunur
"""
import torch
import torch.nn as nn
import torch.nn.functional as F


def _gn(c):
    return nn.GroupNorm(min(8, c), c)


class Block(nn.Module):
    def __init__(self, cin, cout):
        super().__init__()
        self.net = nn.Sequential(nn.Conv2d(cin, cout, 3, padding=1, bias=False), _gn(cout), nn.SiLU(inplace=True),
                                 nn.Conv2d(cout, cout, 3, padding=1, bias=False), _gn(cout), nn.SiLU(inplace=True))
        self.skip = nn.Conv2d(cin, cout, 1, bias=False) if cin != cout else nn.Identity()

    def forward(self, x):
        return self.net(x) + self.skip(x)


class PhobetorNet(nn.Module):
    def __init__(self, in_ch, base=32, depth=4, n_classes=1, n_props=0):
        super().__init__()
        ch = [base * 2 ** i for i in range(depth + 1)]
        self.stem = Block(in_ch, ch[0])
        self.down = nn.ModuleList([Block(ch[i], ch[i + 1]) for i in range(depth)])
        self.up = nn.ModuleList([Block(ch[i + 1] + ch[i], ch[i]) for i in reversed(range(depth))])
        self.head_heat = nn.Sequential(nn.Conv2d(ch[0], ch[0], 3, padding=1), nn.SiLU(inplace=True), nn.Conv2d(ch[0], n_classes, 1))
        self.head_off = nn.Sequential(nn.Conv2d(ch[0], ch[0], 3, padding=1), nn.SiLU(inplace=True), nn.Conv2d(ch[0], 2, 1))
        # ozellikler (uzaklik, boyut, bicim...) nesnenin tepe pikselinde okunur; daha genis baglam icin
        # bir alt cozunurluk katmaninin ozellikleri de eklenir
        self.head_props = nn.Sequential(nn.Conv2d(ch[0] + ch[1], ch[1], 3, padding=1), nn.SiLU(inplace=True),
                                        nn.Conv2d(ch[1], ch[1], 3, padding=1), nn.SiLU(inplace=True),
                                        nn.Conv2d(ch[1], n_props, 1)) if n_props else None
        nn.init.constant_(self.head_heat[-1].bias, -4.6)  # baslangicta her piksel ~%1 olasilik
        self.depth = depth

    def forward(self, x):
        h, w = x.shape[-2:]
        m = 2 ** self.depth
        ph, pw = (m - h % m) % m, (m - w % m) % m
        if ph or pw:
            x = F.pad(x, (0, pw, 0, ph), mode="replicate")
        skips = [self.stem(x)]
        for d in self.down:
            skips.append(d(F.max_pool2d(skips[-1], 2)))
        y = skips.pop()
        y1 = None
        for i, u in enumerate(self.up):
            s = skips.pop()
            y = F.interpolate(y, size=s.shape[-2:], mode="bilinear", align_corners=False)
            y = u(torch.cat([y, s], 1))
            if i == len(self.up) - 2:
                y1 = y
        heat = self.head_heat(y)[..., :h, :w]
        off = (torch.sigmoid(self.head_off(y)) - 0.5)[..., :h, :w]
        if self.head_props is None:
            return heat, off, None
        y1 = F.interpolate(y1, size=y.shape[-2:], mode="bilinear", align_corners=False)
        props = self.head_props(torch.cat([y, y1], 1))[..., :h, :w]
        return heat, off, props


def focal_loss(logit, target, pos, weight, alpha=2.0, beta=4.0, class_weights=None):
    """CenterNet odak kaybi, sinif basina ayri normalize edilir (az sayidaki yildiz / kuasar, cok sayidaki
    galaksinin golgesinde kalmasin). logit/target/pos (B,K,H,W), weight (B,1,H,W): 0 olan pikseller yok sayilir."""
    p = torch.sigmoid(logit).clamp(1e-4, 1 - 1e-4)
    pos_l = (-((1 - p) ** alpha) * torch.log(p) * pos).sum((0, 2, 3))
    neg_l = (-((1 - target) ** beta) * (p ** alpha) * torch.log(1 - p) * (1 - pos) * weight).sum((0, 2, 3))
    n = pos.sum((0, 2, 3)).clamp(min=1.0)
    per = (pos_l + neg_l) / n
    if class_weights is not None:
        per = per * class_weights
    return per.sum()


def offset_loss(off, target, pos):
    """pos (B,K,H,W) ya da (B,1,H,W): herhangi bir sinifin tepesinde L1."""
    pos = pos.amax(1, keepdim=True)
    n = pos.sum().clamp(min=1.0)
    return (torch.abs(off - target) * pos).sum() / n


def prop_loss(pred, target, mask, kinds):
    """Nesne ozellikleri: regresyon icin Huber (olceklenmis hedef), oy oranlari icin yumusak ikili capraz entropi.
    Her ozellik kendi ornek sayisiyla normalize edilir; ornegi olmayan ozellik kayba girmez."""
    if pred is None or mask.sum() == 0:
        return pred.sum() * 0.0 if pred is not None else torch.zeros(())
    total = pred.new_zeros(())
    for j, kind in enumerate(kinds):
        m = mask[:, j]
        n = m.sum()
        if n == 0:
            continue
        if kind == "frac":
            l = F.binary_cross_entropy_with_logits(pred[:, j], target[:, j].clamp(0, 1), reduction="none")
        else:
            l = F.smooth_l1_loss(pred[:, j], target[:, j], reduction="none")
        total = total + (l * m).sum() / n
    return total / max(len(kinds), 1)
