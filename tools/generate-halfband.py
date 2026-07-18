#!/usr/bin/env python3
import hashlib, math, struct

def i0(x):
    term=1.0; total=1.0; k=1
    while True:
        term *= (x*x/4)/(k*k); nxt=total+term
        if nxt==total: return total
        total=nxt; k+=1
N=129; M=64; beta=9.0; fc=.25
raw=[]
for k in range(-M,M+1):
    ideal=.5 if k==0 else (0.0 if k%2==0 else math.sin(2*math.pi*fc*k)/(math.pi*k))
    window=i0(beta*math.sqrt(max(0.0,1-(k/M)**2)))/i0(beta)
    raw.append(ideal*window)
s=sum(raw); taps=[x/s for x in raw]
b=b''.join(struct.pack('<f',x) for x in taps)
print(hashlib.sha256(b).hexdigest())
print('pub(crate) const HALF_BAND_TAPS: [f32; 129] = [')
for x in taps: print(f'    {struct.unpack("<f",struct.pack("<f",x))[0]:.9e},')
print('];')
