"""Phobetor agi: tam cozunurluklu isi haritasi ureten kucuk bir U-Net.

Cikislar (giris boyutuyla ayni):
  heat   (1,H,W)  her pikselin bir yildiz merkezi olma olasiligi (logit)
  offset (2,H,W)  yildiz merkezinin piksel icindeki kaymasi (x, y), -0.5..0.5
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
    def __init__(self, in_ch, base=32, depth=4):
        super().__init__()
        ch = [base * 2 ** i for i in range(depth + 1)]
        self.stem = Block(in_ch, ch[0])
        self.down = nn.ModuleList([Block(ch[i], ch[i + 1]) for i in range(depth)])
        self.up = nn.ModuleList([Block(ch[i + 1] + ch[i], ch[i]) for i in reversed(range(depth))])
        self.head_heat = nn.Sequential(nn.Conv2d(ch[0], ch[0], 3, padding=1), nn.SiLU(inplace=True), nn.Conv2d(ch[0], 1, 1))
        self.head_off = nn.Sequential(nn.Conv2d(ch[0], ch[0], 3, padding=1), nn.SiLU(inplace=True), nn.Conv2d(ch[0], 2, 1))
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
        for u in self.up:
            s = skips.pop()
            y = F.interpolate(y, size=s.shape[-2:], mode="bilinear", align_corners=False)
            y = u(torch.cat([y, s], 1))
        heat = self.head_heat(y)[..., :h, :w]
        off = (torch.sigmoid(self.head_off(y)) - 0.5)[..., :h, :w]
        return heat, off


def focal_loss(logit, target, pos, weight, alpha=2.0, beta=4.0):
    """CenterNet odak kaybi. pos: tepe pikselleri, weight: 0 olan pikseller kayipta yok sayilir."""
    p = torch.sigmoid(logit).clamp(1e-4, 1 - 1e-4)
    pos_l = -((1 - p) ** alpha) * torch.log(p) * pos
    neg_l = -((1 - target) ** beta) * (p ** alpha) * torch.log(1 - p) * (1 - pos) * weight
    n = pos.sum().clamp(min=1.0)
    return (pos_l.sum() + neg_l.sum()) / n


def offset_loss(off, target, pos):
    n = pos.sum().clamp(min=1.0)
    return (torch.abs(off - target) * pos).sum() / n
