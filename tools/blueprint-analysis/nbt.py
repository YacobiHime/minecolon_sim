"""Structurize の設計図（.blueprint、gzip の NBT）を読む最小限のパーサー。"""
import gzip, struct
def _r(b,i,t):
    if t==1: return struct.unpack_from('>b',b,i)[0],i+1
    if t==2: return struct.unpack_from('>h',b,i)[0],i+2
    if t==3: return struct.unpack_from('>i',b,i)[0],i+4
    if t==4: return struct.unpack_from('>q',b,i)[0],i+8
    if t==5: return struct.unpack_from('>f',b,i)[0],i+4
    if t==6: return struct.unpack_from('>d',b,i)[0],i+8
    if t==7:
        n=struct.unpack_from('>i',b,i)[0]; i+=4; return b[i:i+n],i+n
    if t==8:
        n=struct.unpack_from('>H',b,i)[0]; i+=2; return b[i:i+n].decode('utf-8','replace'),i+n
    if t==9:
        et=b[i]; n=struct.unpack_from('>i',b,i+1)[0]; i+=5; out=[]
        for _ in range(n): v,i=_r(b,i,et); out.append(v)
        return out,i
    if t==10:
        d={}
        while True:
            et=b[i]; i+=1
            if et==0: return d,i
            n=struct.unpack_from('>H',b,i)[0]; i+=2; k=b[i:i+n].decode(); i+=n
            d[k],i=_r(b,i,et)
    if t==11:
        n=struct.unpack_from('>i',b,i)[0]; i+=4; return list(struct.unpack_from('>%di'%n,b,i)),i+4*n
    if t==12:
        n=struct.unpack_from('>i',b,i)[0]; i+=4; return list(struct.unpack_from('>%dq'%n,b,i)),i+8*n
    raise ValueError(t)
def load(p):
    b=open(p,'rb').read()
    try: b=gzip.decompress(b)
    except OSError: pass
    t=b[0]; n=struct.unpack_from('>H',b,1)[0]; v,_=_r(b,3+n,t); return v
