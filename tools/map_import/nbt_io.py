"""NBT と region(.mca) の読み書き(標準ライブラリだけ)。

- NBT はすべてのタグ型を読み書きする。型は値のクラスで保持する
  (Byte/Short/Int/Long/Float/Double は int/float のサブクラス、
  String は str、List は NBTList、Compound は Compound(dict)、
  ByteArray は bytes、IntArray/LongArray は array.array)。
  読んで書き戻すとバイト単位で同じになる(Java の Modified UTF-8 も扱う)。
- region は 4KiB セクタの表(位置・タイムスタンプ)を読み、書き直すときは
  表を作り直す。変更していないチャンクは圧縮済みのバイト列をそのまま書く。
- block_states の詰め方(1.16 以降: 1 個のエントリが long をまたがない)の
  符号化・復号と、編集後のパレット整理もここに置く。
"""
import array
import gzip
import os
import struct
import sys
import time
import zlib

# ---------------------------------------------------------------- タグ型

TAG_END, TAG_BYTE, TAG_SHORT, TAG_INT, TAG_LONG, TAG_FLOAT, TAG_DOUBLE = range(7)
TAG_BYTE_ARRAY, TAG_STRING, TAG_LIST, TAG_COMPOUND, TAG_INT_ARRAY, TAG_LONG_ARRAY = range(7, 13)


class Byte(int):
    tag_id = TAG_BYTE


class Short(int):
    tag_id = TAG_SHORT


class Int(int):
    tag_id = TAG_INT


class Long(int):
    tag_id = TAG_LONG


class Float(float):
    tag_id = TAG_FLOAT


class Double(float):
    tag_id = TAG_DOUBLE


class NBTList(list):
    """要素の型 elem_type を持つ list(空リストでも型を失わない)。"""
    tag_id = TAG_LIST

    def __init__(self, items=(), elem_type=TAG_END):
        super().__init__(items)
        self.elem_type = elem_type


class Compound(dict):
    tag_id = TAG_COMPOUND


_BIG = sys.byteorder == 'little'


def _arr(code, raw):
    a = array.array(code)
    a.frombytes(raw)
    if _BIG:
        a.byteswap()
    return a


def tag_type_of(v):
    t = getattr(v, 'tag_id', None)
    if t is not None:
        return t
    if isinstance(v, str):
        return TAG_STRING
    if isinstance(v, (bytes, bytearray)):
        return TAG_BYTE_ARRAY
    if isinstance(v, array.array):
        if v.typecode in ('i', 'l') and v.itemsize == 4:
            return TAG_INT_ARRAY
        if v.typecode in ('q',):
            return TAG_LONG_ARRAY
    if isinstance(v, dict):
        return TAG_COMPOUND
    if isinstance(v, list):
        return TAG_LIST
    raise TypeError('NBT の型が分からない値: %r' % (type(v),))


# ---------------------------------------------------------------- 文字列

def _decode_mutf8(raw):
    try:
        if b'\xc0\x80' not in raw and b'\xed' not in raw:
            return raw.decode('utf-8')
    except UnicodeDecodeError:
        pass
    # Modified UTF-8: NUL は C0 80、BMP 外は代用対を 3 バイトずつ。
    # 正しい代用対は 1 文字にまとめる(書くときにまた分けるので同じバイトに戻る)
    s = raw.replace(b'\xc0\x80', b'\x00').decode('utf-8', 'surrogatepass')
    if any('\ud800' <= c <= '\udfff' for c in s):
        s = s.encode('utf-16-le', 'surrogatepass').decode('utf-16-le', 'surrogatepass')
    return s


def _encode_mutf8(s):
    if any(ord(c) > 0xFFFF for c in s):
        out = []
        for c in s:
            o = ord(c)
            if o > 0xFFFF:
                o -= 0x10000
                out.append(chr(0xD800 + (o >> 10)))
                out.append(chr(0xDC00 + (o & 0x3FF)))
            else:
                out.append(c)
        s = ''.join(out)
    return s.encode('utf-8', 'surrogatepass').replace(b'\x00', b'\xc0\x80')


# ---------------------------------------------------------------- 読み

_ub = struct.unpack_from


def _read(buf, i, t):
    if t == TAG_COMPOUND:
        d = Compound()
        while True:
            et = buf[i]
            i += 1
            if et == 0:
                return d, i
            n = _ub('>H', buf, i)[0]
            i += 2
            name = _decode_mutf8(bytes(buf[i:i + n]))
            i += n
            d[name], i = _read(buf, i, et)
    if t == TAG_STRING:
        n = _ub('>H', buf, i)[0]
        i += 2
        return _decode_mutf8(bytes(buf[i:i + n])), i + n
    if t == TAG_BYTE:
        return Byte(_ub('>b', buf, i)[0]), i + 1
    if t == TAG_SHORT:
        return Short(_ub('>h', buf, i)[0]), i + 2
    if t == TAG_INT:
        return Int(_ub('>i', buf, i)[0]), i + 4
    if t == TAG_LONG:
        return Long(_ub('>q', buf, i)[0]), i + 8
    if t == TAG_FLOAT:
        return Float(_ub('>f', buf, i)[0]), i + 4
    if t == TAG_DOUBLE:
        return Double(_ub('>d', buf, i)[0]), i + 8
    if t == TAG_LIST:
        et = buf[i]
        n = _ub('>i', buf, i + 1)[0]
        i += 5
        out = NBTList(elem_type=et)
        for _ in range(max(n, 0)):
            v, i = _read(buf, i, et)
            out.append(v)
        return out, i
    if t == TAG_BYTE_ARRAY:
        n = _ub('>i', buf, i)[0]
        i += 4
        return bytes(buf[i:i + n]), i + n
    if t == TAG_INT_ARRAY:
        n = _ub('>i', buf, i)[0]
        i += 4
        return _arr('i', bytes(buf[i:i + 4 * n])), i + 4 * n
    if t == TAG_LONG_ARRAY:
        n = _ub('>i', buf, i)[0]
        i += 4
        return _arr('q', bytes(buf[i:i + 8 * n])), i + 8 * n
    raise ValueError('不明な NBT タグ型 %d (位置 %d)' % (t, i))


def loads(raw):
    """名前付きのルートタグを読む。(名前, 値) を返す。"""
    t = raw[0]
    if t == TAG_END:
        return '', None
    n = _ub('>H', raw, 1)[0]
    name = _decode_mutf8(bytes(raw[3:3 + n]))
    val, end = _read(raw, 3 + n, t)
    return name, val


# ---------------------------------------------------------------- 書き

def _write(out, v, t):
    p = out.append
    if t == TAG_COMPOUND:
        for k, x in v.items():
            et = tag_type_of(x)
            kb = _encode_mutf8(k)
            p(struct.pack('>BH', et, len(kb)))
            p(kb)
            _write(out, x, et)
        p(b'\x00')
    elif t == TAG_STRING:
        b = _encode_mutf8(v)
        p(struct.pack('>H', len(b)))
        p(b)
    elif t == TAG_BYTE:
        p(struct.pack('>b', v))
    elif t == TAG_SHORT:
        p(struct.pack('>h', v))
    elif t == TAG_INT:
        p(struct.pack('>i', v))
    elif t == TAG_LONG:
        p(struct.pack('>q', v))
    elif t == TAG_FLOAT:
        p(struct.pack('>f', v))
    elif t == TAG_DOUBLE:
        p(struct.pack('>d', v))
    elif t == TAG_LIST:
        et = getattr(v, 'elem_type', None)
        if et is None or (et == TAG_END and len(v)):
            et = tag_type_of(v[0]) if len(v) else TAG_END
        p(struct.pack('>Bi', et, len(v)))
        for x in v:
            _write(out, x, et)
    elif t == TAG_BYTE_ARRAY:
        p(struct.pack('>i', len(v)))
        p(bytes(v))
    elif t in (TAG_INT_ARRAY, TAG_LONG_ARRAY):
        code = 'i' if t == TAG_INT_ARRAY else 'q'
        a = v if (isinstance(v, array.array) and v.typecode == code) else array.array(code, v)
        if _BIG:
            a = array.array(code, a)
            a.byteswap()
        p(struct.pack('>i', len(a)))
        p(a.tobytes())
    else:
        raise ValueError('書けない NBT タグ型 %r' % (t,))


def dumps(value, name=''):
    t = tag_type_of(value)
    out = []
    nb = _encode_mutf8(name)
    out.append(struct.pack('>BH', t, len(nb)))
    out.append(nb)
    _write(out, value, t)
    return b''.join(out)


def load_file(path):
    """gzip でも非圧縮でも読める NBT ファイル。(名前, 値, gzip か) を返す。"""
    with open(path, 'rb') as f:
        raw = f.read()
    gz = raw[:2] == b'\x1f\x8b'
    if gz:
        raw = gzip.decompress(raw)
    name, val = loads(raw)
    return name, val, gz


def save_file(path, value, name='', gz=True):
    raw = dumps(value, name)
    if gz:
        raw = gzip.compress(raw, mtime=0)
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(raw)
    os.replace(tmp, path)


# ---------------------------------------------------------------- region

SECTOR = 4096


class RegionFile:
    """r.X.Z.mca 1 個。chunks[(cx, cz)] = [圧縮方式, 圧縮バイト列, timestamp]。

    cx, cz はリージョン内の位置 0..31。get_chunk で NBT にし、
    set_chunk で書き戻しを予約する(save で全体を書き直す)。
    """

    def __init__(self, path):
        self.path = path
        m = os.path.basename(path).split('.')
        self.rx, self.rz = int(m[1]), int(m[2])
        self.chunks = {}
        self.dirty = set()
        with open(path, 'rb') as f:
            data = f.read()
        if len(data) < 2 * SECTOR:
            return
        for idx in range(1024):
            loc = _ub('>I', data, idx * 4)[0]
            off, cnt = loc >> 8, loc & 0xFF
            if off == 0 or cnt == 0:
                continue
            ts = _ub('>I', data, SECTOR + idx * 4)[0]
            start = off * SECTOR
            length = _ub('>I', data, start)[0]
            ctype = data[start + 4]
            payload = data[start + 5:start + 4 + length]
            cx, cz = idx & 31, idx >> 5
            if ctype & 0x80:  # 外部ファイル c.X.Z.mcc
                ext = os.path.join(os.path.dirname(path), 'c.%d.%d.mcc' % (
                    self.rx * 32 + cx, self.rz * 32 + cz))
                with open(ext, 'rb') as f:
                    payload = f.read()
                ctype &= 0x7F
            self.chunks[(cx, cz)] = [ctype, payload, ts]

    @staticmethod
    def decompress(ctype, payload):
        if ctype == 2:
            return zlib.decompress(payload)
        if ctype == 1:
            return gzip.decompress(payload)
        if ctype == 3:
            return payload
        raise ValueError('未対応の圧縮方式 %d' % ctype)

    def raw_chunk(self, cx, cz):
        e = self.chunks.get((cx, cz))
        if e is None:
            return None
        return self.decompress(e[0], e[1])

    def get_chunk(self, cx, cz):
        raw = self.raw_chunk(cx, cz)
        if raw is None:
            return None
        return loads(raw)[1]

    def set_chunk(self, cx, cz, value, timestamp=None):
        raw = dumps(value, '')
        self.chunks[(cx, cz)] = [2, zlib.compress(raw, 6),
                                 int(time.time()) if timestamp is None else timestamp]
        self.dirty.add((cx, cz))

    def save(self, path=None):
        path = path or self.path
        d = os.path.dirname(path)
        loc = bytearray(SECTOR)
        tss = bytearray(SECTOR)
        body = []
        sector = 2
        for (cx, cz) in sorted(self.chunks, key=lambda k: (k[1], k[0])):
            ctype, payload, ts = self.chunks[(cx, cz)]
            idx = cx + cz * 32
            ext_name = os.path.join(d, 'c.%d.%d.mcc' % (self.rx * 32 + cx, self.rz * 32 + cz))
            blob = struct.pack('>IB', len(payload) + 1, ctype) + payload
            if len(blob) > 255 * SECTOR:  # 大きすぎるチャンクは外部ファイルへ
                with open(ext_name, 'wb') as f:
                    f.write(payload)
                blob = struct.pack('>IB', 1, ctype | 0x80)
            elif os.path.exists(ext_name):
                os.remove(ext_name)
            n = (len(blob) + SECTOR - 1) // SECTOR
            blob += b'\x00' * (n * SECTOR - len(blob))
            struct.pack_into('>I', loc, idx * 4, (sector << 8) | n)
            struct.pack_into('>I', tss, idx * 4, ts & 0xFFFFFFFF)
            body.append(blob)
            sector += n
        tmp = path + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(loc)
            f.write(tss)
            for b in body:
                f.write(b)
        os.replace(tmp, path)
        self.dirty.clear()


# ---------------------------------------------------------------- block_states

def bits_for_palette(n):
    """ブロック用: 4 ビット以上。"""
    b = max(1, (n - 1).bit_length())
    return max(4, b)


def decode_states(palette_len, data, count=4096, min_bits=4):
    """block_states.data(long 配列)を count 個の添字に戻す。

    1.16 以降の詰め方: 1 long に floor(64/bits) 個、long をまたがない。
    パレットが 1 個なら data は無く、全部 0。
    """
    if palette_len <= 1 or data is None or len(data) == 0:
        return [0] * count
    bits = max(min_bits, (palette_len - 1).bit_length())
    per = 64 // bits
    mask = (1 << bits) - 1
    out = []
    ext = out.extend
    shifts = range(0, per * bits, bits)
    for v in data:
        v &= 0xFFFFFFFFFFFFFFFF
        ext([(v >> s) & mask for s in shifts])
    del out[count:]
    if len(out) < count:
        raise ValueError('block_states.data が短い (%d < %d)' % (len(out), count))
    return out


def encode_states(indices, palette_len, min_bits=4):
    """添字の列を long 配列(array('q'))にする。パレットが 1 個なら None。"""
    if palette_len <= 1:
        return None
    bits = max(min_bits, (palette_len - 1).bit_length())
    per = 64 // bits
    n = len(indices)
    nlongs = (n + per - 1) // per
    out = array.array('q', bytes(8 * nlongs))
    for li in range(nlongs):
        v = 0
        base = li * per
        chunk = indices[base:base + per]
        for j, x in enumerate(chunk):
            v |= x << (j * bits)
        if v >= 1 << 63:
            v -= 1 << 64
        out[li] = v
    return out


def repalette(palette, indices):
    """使われていないパレット項目を落とし、同じ項目(Name+Properties)を一つにまとめる。

    (新しいパレット, 新しい添字) を返す。並びは最初に出てきた順を保つ
    (元のパレットの順序をなるべく崩さないよう、元の添字の小さい順)。
    """
    used = sorted(set(indices))
    newpal = NBTList(elem_type=TAG_COMPOUND)
    keymap = {}
    remap = {}
    for old in used:
        e = palette[old]
        key = state_key(e)
        if key in keymap:
            remap[old] = keymap[key]
        else:
            keymap[key] = len(newpal)
            remap[old] = len(newpal)
            newpal.append(e)
    if all(remap[k] == k for k in used) and len(newpal) == len(palette):
        return palette, indices
    return newpal, [remap[x] for x in indices]


def state_key(entry):
    props = entry.get('Properties')
    if props:
        return (entry['Name'], tuple(sorted(props.items())))
    return (entry['Name'], ())


def make_state(name, props=None):
    c = Compound()
    c['Name'] = name
    if props:
        p = Compound()
        for k, v in props.items():
            p[k] = v
        c['Properties'] = p
    return c


class Section:
    """1 セクション(16x16x16)のブロックを編集するための入れ物。

    index = y*256 + z*16 + x。set_block / commit で block_states に書き戻す。
    """

    def __init__(self, sec):
        self.sec = sec
        bs = sec.get('block_states')
        self.bs = bs
        self.palette = bs['palette'] if bs is not None else NBTList([make_state('minecraft:air')], TAG_COMPOUND)
        self._idx = None
        self.dirty = False

    @property
    def y(self):
        return int(self.sec['Y'])

    @property
    def indices(self):
        if self._idx is None:
            self._idx = decode_states(len(self.palette), self.bs.get('data') if self.bs is not None else None)
        return self._idx

    def name_at(self, i):
        if len(self.palette) == 1:
            return self.palette[0]['Name']
        return self.palette[self.indices[i]]['Name']

    def state_at(self, i):
        if len(self.palette) == 1:
            return self.palette[0]
        return self.palette[self.indices[i]]

    def palette_index_for(self, state):
        key = state_key(state)
        for k, e in enumerate(self.palette):
            if state_key(e) == key:
                return k
        self.palette.append(state)
        return len(self.palette) - 1

    def set_state(self, i, state):
        idx = self.indices  # 先に復号(パレット長が変わる前に)
        k = self.palette_index_for(state)
        if idx[i] != k:
            idx[i] = k
            self.dirty = True

    def commit(self):
        """編集を block_states に戻す。他のタグは触らない。"""
        if not self.dirty:
            return False
        pal, idx = repalette(self.palette, self._idx)
        bs = self.bs
        bs['palette'] = pal if isinstance(pal, NBTList) else NBTList(pal, TAG_COMPOUND)
        data = encode_states(idx, len(pal))
        if data is None:
            if 'data' in bs:
                del bs['data']
        else:
            bs['data'] = data
        self.palette = bs['palette']
        self._idx = idx
        self.dirty = False
        return True
