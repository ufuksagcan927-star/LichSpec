#!/usr/bin/env python3
"""
Convert a trained Phobetor checkpoint (en_iyi.pt) to ONNX so it can run in the browser
(onnxruntime-web). PyTorch is not needed: the checkpoint zip is read with pickle and the
network in phobetor/model/net.py is rebuilt node by node.

    python tools/export_phobetor_onnx.py en_iyi.pt web/models/phobetor_euclid.onnx [--check]

Network (net.py, PhobetorNet): U-Net, depth 4, each Block = 2 x (3x3 conv, GroupNorm(min(8,c)), SiLU)
plus a 1x1 skip when channels change; max-pool down, bilinear (align_corners=False) up, concat
[upsampled, skip]. Outputs: heat = sigmoid(logit) (1,1,H,W) and offset = sigmoid(o) - 0.5 (1,2,H,W).
H and W must be multiples of 16 (the page pads the image before inference).

Weights are stored as float16 and cast back to float32 inside the graph, so the file is half the size
and every operation still runs in float32. --check compares the graph with a numpy forward pass.
"""
import collections
import json
import pickle
import sys
import zipfile

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

DEPTH = 4


# ------------------------------------------------------------------ checkpoint without torch
def load_checkpoint(path):
    z = zipfile.ZipFile(path)
    root = z.namelist()[0].split("/")[0]
    dtypes = {"FloatStorage": np.float32, "HalfStorage": np.float16, "DoubleStorage": np.float64,
              "LongStorage": np.int64, "IntStorage": np.int32, "BoolStorage": np.bool_, "ByteStorage": np.uint8}

    class Storage:
        def __init__(self, name):
            self.name = name

    def rebuild(storage, offset, size, stride, *_):
        if not size:
            return storage[offset].copy()
        return np.lib.stride_tricks.as_strided(storage[offset:], shape=tuple(size),
                                               strides=tuple(s * storage.itemsize for s in stride)).copy()

    class Unpickler(pickle.Unpickler):
        def find_class(self, mod, name):
            if (mod, name) == ("torch._utils", "_rebuild_tensor_v2"):
                return rebuild
            if (mod, name) == ("torch._utils", "_rebuild_parameter"):
                return lambda data, *_: data
            if mod == "torch" and name.endswith("Storage"):
                return Storage(name)
            if (mod, name) == ("collections", "OrderedDict"):
                return collections.OrderedDict
            if mod == "torch" and name == "device":
                return lambda *a: a
            return super().find_class(mod, name)

        def persistent_load(self, pid):
            _, stype, key, _loc, _n = pid
            return np.frombuffer(z.read(f"{root}/data/{key}"), dtype=dtypes[stype.name]).copy()

    with z.open(f"{root}/data.pkl") as f:
        return Unpickler(f).load()


# ------------------------------------------------------------------ graph
class Builder:
    def __init__(self, sd):
        self.sd, self.nodes, self.inits, self.n = sd, [], [], 0

    def name(self, p):
        self.n += 1
        return f"{p}_{self.n}"

    def weight(self, key, fp16=True):
        w = self.sd[key].astype(np.float32)
        if not fp16:
            self.inits.append(numpy_helper.from_array(w, key))
            return key
        self.inits.append(numpy_helper.from_array(w.astype(np.float16), key + "_h"))
        self.nodes.append(helper.make_node("Cast", [key + "_h"], [key], to=TensorProto.FLOAT))
        return key

    def const(self, arr, p="c"):
        nm = self.name(p)
        self.inits.append(numpy_helper.from_array(np.asarray(arr), nm))
        return nm

    def op(self, typ, inputs, **attrs):
        out = self.name(typ.lower())
        self.nodes.append(helper.make_node(typ, inputs, [out], **attrs))
        return out

    def conv(self, x, key, k, bias=False):
        ins = [x, self.weight(key + ".weight")]
        if bias:
            ins.append(self.weight(key + ".bias", fp16=False))
        return self.op("Conv", ins, kernel_shape=[k, k], pads=[k // 2] * 4)

    def groupnorm(self, x, key, c):
        g = min(8, c)
        shp = self.op("Shape", [x])
        r = self.op("Reshape", [x, self.const(np.array([0, g, -1], np.int64), "gshape")])
        n = self.op("InstanceNormalization", [r, self.const(np.ones(g, np.float32), "one"), self.const(np.zeros(g, np.float32), "zero")], epsilon=1e-5)
        back = self.op("Reshape", [n, shp])
        gam = self.const(self.sd[key + ".weight"].astype(np.float32).reshape(c, 1, 1), "gamma")
        bet = self.const(self.sd[key + ".bias"].astype(np.float32).reshape(c, 1, 1), "beta")
        return self.op("Add", [self.op("Mul", [back, gam]), bet])

    def silu(self, x):
        return self.op("Mul", [x, self.op("Sigmoid", [x])])

    def block(self, x, key, cin, cout):
        y = self.silu(self.groupnorm(self.conv(x, key + ".net.0", 3), key + ".net.1", cout))
        y = self.silu(self.groupnorm(self.conv(y, key + ".net.3", 3), key + ".net.4", cout))
        s = self.conv(x, key + ".skip", 1) if cin != cout else x
        return self.op("Add", [y, s])


def build(ck):
    sd, cfg = ck["model"], ck["cfg"]
    base, cin = int(cfg["base_channels"]), int(ck["in_ch"])
    ch = [base * 2 ** i for i in range(DEPTH + 1)]
    b = Builder(sd)
    x = "x"
    skips = [b.block(x, "stem", cin, ch[0])]
    for i in range(DEPTH):
        p = b.op("MaxPool", [skips[-1]], kernel_shape=[2, 2], strides=[2, 2])
        skips.append(b.block(p, f"down.{i}", ch[i], ch[i + 1]))
    y = skips.pop()
    scales = b.const(np.array([1, 1, 2, 2], np.float32), "scales")
    for j, i in enumerate(reversed(range(DEPTH))):
        s = skips.pop()
        up = b.op("Resize", [y, "", scales], mode="linear", coordinate_transformation_mode="half_pixel")
        y = b.block(b.op("Concat", [up, s], axis=1), f"up.{j}", ch[i + 1] + ch[i], ch[i])
    h = b.conv(b.silu(b.conv(y, "head_heat.0", 3, bias=True)), "head_heat.2", 1, bias=True)
    b.nodes.append(helper.make_node("Sigmoid", [h], ["heat"]))
    o = b.conv(b.silu(b.conv(y, "head_off.0", 3, bias=True)), "head_off.2", 1, bias=True)
    b.nodes.append(helper.make_node("Sub", [b.op("Sigmoid", [o]), b.const(np.array(0.5, np.float32), "half")], ["offset"]))
    graph = helper.make_graph(
        b.nodes, "phobetor",
        [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, cin, "H", "W"])],
        [helper.make_tensor_value_info("heat", TensorProto.FLOAT, [1, 1, "H", "W"]),
         helper.make_tensor_value_info("offset", TensorProto.FLOAT, [1, 2, "H", "W"])],
        b.inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)], producer_name="lichspec")
    model.ir_version = 8
    meta = {"in_ch": cin, "base": base, "depth": DEPTH, "bands": cfg.get("bands"), "stretch": cfg.get("stretch", 3.0),
            "threshold": float(ck.get("val", {}).get("esik", 0.5)), "step": int(ck.get("step", 0)),
            "val": ck.get("val"), "note": cfg.get("_aciklama", "")}
    helper.set_model_props(model, {"lichspec": json.dumps(meta, ensure_ascii=False)})
    onnx.checker.check_model(model)
    return model, meta


# ------------------------------------------------------------------ numpy reference (for --check)
def np_forward(sd, x):
    def conv(x, w, b=None):
        O, C, k, _ = w.shape
        p = k // 2
        H, W = x.shape[1:]
        xp = np.pad(x, ((0, 0), (p, p), (p, p)))
        cols = np.stack([xp[:, i:i + H, j:j + W] for i in range(k) for j in range(k)], 1)  # C, k*k, H, W
        y = np.einsum("ock,ckhw->ohw", w.reshape(O, C, k * k), cols, optimize=True)
        return y + (b[:, None, None] if b is not None else 0)

    def gn(x, g, b):
        c = x.shape[0]
        G = min(8, c)
        r = x.reshape(G, -1)
        r = (r - r.mean(1, keepdims=True)) / np.sqrt(r.var(1, keepdims=True) + 1e-5)
        return r.reshape(x.shape) * g[:, None, None] + b[:, None, None]

    silu = lambda v: v / (1 + np.exp(-v))

    def block(x, key):
        y = silu(gn(conv(x, sd[key + ".net.0.weight"]), sd[key + ".net.1.weight"], sd[key + ".net.1.bias"]))
        y = silu(gn(conv(y, sd[key + ".net.3.weight"]), sd[key + ".net.4.weight"], sd[key + ".net.4.bias"]))
        s = conv(x, sd[key + ".skip.weight"]) if key + ".skip.weight" in sd else x
        return y + s

    def up2(y):  # bilinear x2, half-pixel centres, edge clamp (= torch align_corners=False)
        C, H, W = y.shape
        def axis(n):
            src = (np.arange(2 * n) + 0.5) / 2 - 0.5
            i0 = np.clip(np.floor(src).astype(int), 0, n - 1)
            i1 = np.clip(i0 + 1, 0, n - 1)
            t = np.clip(src - np.floor(src), 0, 1)
            t = np.where(src < 0, 0, t)
            return i0, i1, t
        r0, r1, rt = axis(H)
        c0, c1, ct = axis(W)
        a = y[:, r0][:, :, c0] * (1 - ct) + y[:, r0][:, :, c1] * ct
        bb = y[:, r1][:, :, c0] * (1 - ct) + y[:, r1][:, :, c1] * ct
        return a * (1 - rt)[None, :, None] + bb * rt[None, :, None]

    pool = lambda v: v.reshape(v.shape[0], v.shape[1] // 2, 2, v.shape[2] // 2, 2).max((2, 4))
    skips = [block(x, "stem")]
    for i in range(DEPTH):
        skips.append(block(pool(skips[-1]), f"down.{i}"))
    y = skips.pop()
    for j in range(DEPTH):
        s = skips.pop()
        y = block(np.concatenate([up2(y), s], 0), f"up.{j}")
    h = conv(silu(conv(y, sd["head_heat.0.weight"], sd["head_heat.0.bias"])), sd["head_heat.2.weight"], sd["head_heat.2.bias"])
    o = conv(silu(conv(y, sd["head_off.0.weight"], sd["head_off.0.bias"])), sd["head_off.2.weight"], sd["head_off.2.bias"])
    return 1 / (1 + np.exp(-h)), 1 / (1 + np.exp(-o)) - 0.5


def main():
    src, dst = sys.argv[1], sys.argv[2]
    ck = load_checkpoint(src)
    model, meta = build(ck)
    onnx.save(model, dst)
    import os
    print(f"{dst}: {os.path.getsize(dst) / 1e6:.1f} MB, {sum(v.size for v in ck['model'].values())} parameters")
    print(json.dumps(meta, ensure_ascii=False))
    if "--check" in sys.argv:
        import onnxruntime as ort
        rng = np.random.default_rng(1)
        x = rng.normal(0, 1, (1, int(ck["in_ch"]), 48, 64)).astype(np.float32)
        sess = ort.InferenceSession(dst, providers=["CPUExecutionProvider"])
        heat, off = sess.run(None, {"x": x})
        sd16 = {k: v.astype(np.float16).astype(np.float32) if v.ndim == 4 else v.astype(np.float32) for k, v in ck["model"].items()}
        h_ref, o_ref = np_forward(sd16, x[0].astype(np.float64))
        print("max |heat - ref| =", float(np.abs(heat[0] - h_ref).max()), " max |offset - ref| =", float(np.abs(off[0] - o_ref).max()))


if __name__ == "__main__":
    main()
