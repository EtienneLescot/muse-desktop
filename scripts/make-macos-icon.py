# Regenerates the macOS icon (src-tauri/icons/macos-icon-1024.png, then icon.icns
# with iconutil): a white squircle on the Apple 824/1024 grid, transparent
# around it, so macOS 26 does not wrap it in its grey fallback plate.
# Usage: python3 scripts/make-macos-icon.py 0.86 src-tauri/icons/macos-icon-1024.png  (needs Pillow)
import sys
from PIL import Image, ImageDraw
S=1024; SS=4                      # supersampling for smooth edges
INSET=100; SIDE=824               # Apple macOS icon grid: 824x824 body on 1024
LOGO_W=float(sys.argv[1]) if len(sys.argv)>1 else 0.80   # logo width / body width
out=sys.argv[2] if len(sys.argv)>2 else 'icon_1024.png'

# Squircle (superellipse n=5, close to Apple's continuous-corner shape).
big=S*SS; mask=Image.new('L',(big,big),0); d=ImageDraw.Draw(mask)
cx=cy=big/2; a=SIDE*SS/2; n=5.0
import math
pts=[]
for i in range(2000):
    t=2*math.pi*i/2000; c=math.cos(t); s=math.sin(t)
    pts.append((cx+a*math.copysign(abs(c)**(2/n),c), cy+a*math.copysign(abs(s)**(2/n),s)))
d.polygon(pts,fill=255)
mask=mask.resize((S,S),Image.LANCZOS)

icon=Image.new('RGBA',(S,S),(0,0,0,0))
body=Image.new('RGBA',(S,S),(255,255,255,255))
icon.paste(body,(0,0),mask)

logo=Image.open(str(__import__('pathlib').Path(__file__).resolve().parents[1] / 'public' / 'muse-logo.png')).convert('RGBA')
logo=logo.crop((180,264,1166,998))            # ink bbox + 10px
w=round(SIDE*LOGO_W); h=round(logo.height*w/logo.width)
logo=logo.resize((w,h),Image.LANCZOS)
x=(S-w)//2; y=(S-h)//2 + 4                    # a hair low: the M's mass sits high
layer=Image.new('RGBA',(S,S),(0,0,0,0)); layer.paste(logo,(x,y),logo)
# keep the logo inside the body
la=layer.getchannel('A'); from PIL import ImageChops
layer.putalpha(ImageChops.multiply(la,mask))
icon=Image.alpha_composite(icon,layer)
icon.save(out)
print(out, w, h)
