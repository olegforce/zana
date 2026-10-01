#!/usr/bin/env python3
"""Render a narrated Zana Mobile walkthrough. Needs Pillow, ffmpeg, and edge-tts."""
from pathlib import Path
from functools import lru_cache
import argparse
import math
import json
import hashlib
import subprocess
import wave
import asyncio
import shutil
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
W, H, FPS, DURATION = 1920, 1080, 24, 84
BG = '#101321'
WHITE = '#f5f4ff'
MUTED = '#b5bad0'
ACCENT = '#baa9ff'
PURPLE = '#6543c0'
GREEN = '#7ce4bd'
CODE = '7A2F-9C4D-81E3-5B60'
DOMAIN = 'grebmann.zana-ide.com'
VOICE = 'en-US-AvaMultilingualNeural'
VOICE_RATE = '-5%'
FONT_DIR = Path('/System/Library/Fonts/Supplemental')
SCENES = [
    (0, 4, 'intro', 'Your agents.\nIn your pocket.', 'Connect Zana Mobile to your computer.\nWe’ll install the phone app along the way.'),
    (4, 12, 'desktop', 'Start on your\ncomputer.', 'Open Settings → Remote access.\nSelect Get a connect code.'),
    (12, 24, 'code', 'Sign in.\nGet your code.', 'Sign in with GitHub in your browser.\nChoose an address, then copy your code.'),
    (24, 32, 'paste', 'Paste.\nYou’re paired.', 'Return to Zana and paste the code.\nYour computer connects automatically.'),
    (32, 46, 'install', 'Scan. Install.\nOpen Zana.', 'On your computer, open Settings → Phone.\nScan the install QR with your iPhone Camera.'),
    (46, 55, 'phone', 'Now, open\nZana Mobile.', 'Tap Continue with GitHub.\nUse the same account as your computer.'),
    (55, 64, 'approve', 'Approve\nyour phone.', 'Tap Approve phone in the browser.\nThen return to Zana Mobile.'),
    (64, 71, 'choose', 'Choose your\ncomputer.', 'Find your computer in the list.\nTap its Connect button.'),
    (71, 84, 'outro', 'Your agents.\nAt a glance.', 'Follow your agents from the mobile board.\nKeep your computer awake and online.'),
]

# Caption chunks are the narration transcript. The on-screen address is an example;
# narration asks viewers to choose their own subdomain.
NARRATION = [
    (0.3, 3.7, 'Connect Zana Mobile to your computer.'),
    (4.4, 11.6, 'On your computer, open Settings, then Remote access. Select Get a connect code.'),
    (12.3, 20.7, 'Sign in with GitHub, then choose your subdomain.'),
    (20.8, 23.7, 'Reserve the address, then copy your code.'),
    (24.4, 31.6, 'Return to Zana and paste the code. Your computer connects automatically.'),
    (32.4, 39.5, 'Once your computer is connected, open Settings, then Phone. Scan the QR code with your iPhone camera.'),
    (39.7, 45.6, 'Accept the TestFlight invitation and install Zana. Then open the app.'),
    (46.4, 54.6, 'Now open Zana Mobile. Tap Continue with GitHub, and use the same account as your computer.'),
    (55.4, 63.6, 'In the browser, tap Approve phone. Then tap Return to Zana Mobile.'),
    (64.4, 70.5, 'Choose your computer from the list, and tap Connect.'),
    (71.4, 78.9, 'You’re connected. Follow your agents from the mobile kanban, with their status at a glance.'),
    (79.2, 83.6, 'Keep Zana running, and your computer awake and online.'),
]

@lru_cache(None)
def font(size, bold=False, mono=False):
    path = Path('/System/Library/Fonts/SFNSMono.ttf') if mono else FONT_DIR / ('Arial Bold.ttf' if bold else 'Arial.ttf')
    if not path.exists():
        path = Path('/usr/share/fonts/truetype/dejavu') / ('DejaVuSansMono.ttf' if mono else 'DejaVuSans-Bold.ttf' if bold else 'DejaVuSans.ttf')
    return ImageFont.truetype(str(path), size)

def txt(im, xy, text, size=24, fill=WHITE, bold=False, mono=False, anchor=None):
    ImageDraw.Draw(im).text(xy, text, font=font(size, bold, mono), fill=fill, anchor=anchor, stroke_width=0)

def wrap(im, xy, text, width, size=24, fill=WHITE, bold=False, gap=1.4):
    d = ImageDraw.Draw(im)
    x, y = xy
    for para in text.split('\n'):
        line = ''
        for word in para.split():
            candidate = (line + ' ' + word).strip()
            if line and d.textlength(candidate, font=font(size, bold)) > width:
                txt(im, (x, y), line, size, fill, bold)
                y += int(size * gap)
                line = word
            else:
                line = candidate
        txt(im, (x, y), line, size, fill, bold)
        y += int(size * gap)
    return y

def rr(im, box, fill, radius=18, outline=None, width=1):
    ImageDraw.Draw(im).rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)

def button(im, box, label, primary=True, size=22, dark=False, accent=PURPLE):
    rr(im, box, accent if primary else ('#282c3b' if dark else '#ffffff'), 14, None if primary else ('#373d50' if dark else '#e1ddeb'))
    txt(im, ((box[0]+box[2])/2, (box[1]+box[3])/2), label, size, '#ffffff' if primary or dark else '#241d35', True, anchor='mm')

def check(im, x, y, r=25, color=GREEN):
    d = ImageDraw.Draw(im)
    d.ellipse((x-r, y-r, x+r, y+r), fill=color)
    d.line([(x-r*.43, y), (x-r*.08, y+r*.32), (x+r*.47, y-r*.34)], fill='#0b3026', width=max(3, int(r*.15)), joint='curve')

def badge(im, xy, text, color=ACCENT, fill='#28233f'):
    width = int(ImageDraw.Draw(im).textlength(text, font=font(20, True))) + 32
    rr(im, (xy[0], xy[1], xy[0]+width, xy[1]+42), fill, 21)
    txt(im, (xy[0]+16, xy[1]+10), text, 20, color, True)

@lru_cache(None)
def shadow(width, height, radius):
    shade = Image.new('RGBA', (width+100, height+100))
    rr(shade, (50, 55, width+50, height+50), (0,0,0,130), radius)
    return shade.filter(ImageFilter.GaussianBlur(24))

def add_shadow(canvas, tile, x, y, radius=32):
    canvas.alpha_composite(shadow(tile.width,tile.height,radius), (x-50, y-35))
    canvas.alpha_composite(tile, (x,y))

@lru_cache(None)
def desktop(state='start', typed=19):
    im = Image.new('RGBA', (1040, 600))
    rr(im, (0,0,1039,599), '#1e1e1e', 22, '#4a4b55', 2)
    d = ImageDraw.Draw(im)
    for i, c in enumerate(['#ff6865','#f5c14b','#56c86a']):
        d.ellipse((23+i*24,21,35+i*24,33), fill=c)
    txt(im, (520,28), 'Zana', 18, '#d3d3df', anchor='mm')
    d.line((0,54,1040,54), fill='#383943')
    txt(im, (27,87), 'Settings', 24, WHITE, True)
    for i, label in enumerate(['General','Appearance','Agents','Remote access','Machines']):
        y = 151+i*58
        if label == 'Remote access':
            rr(im, (15,y-10,218,y+35), '#293d59', 8)
        txt(im, (29,y), label, 20, '#91bcff' if label == 'Remote access' else '#b6b6c2')
    d.line((234,55,234,600), fill='#383943')
    txt(im, (274,95), 'Remote access', 32, WHITE, True)
    wrap(im, (274,151), 'Connect to this computer from your phone or browser.', 694, 21, '#aeb0be')
    rr(im, (271,213,1000,538), '#25262b', 17, '#3e404c')
    if state == 'connected':
        check(im, 317,266,21)
        txt(im, (352,252), 'Connected', 27, WHITE, True)
        txt(im, (299,321), DOMAIN, 25, '#bdd4ff')
        txt(im, (299,380), 'Your computer is ready for Zana Mobile.', 22, '#c5c5d0')
        badge(im, (299,451), 'Remote access is on', GREEN, '#1d4439')
    else:
        txt(im, (299,238), 'Connect this computer', 25, WHITE, True)
        wrap(im, (299,280), 'Get a code in your browser, then paste it here.', 663, 20, '#b8b8c7')
        button(im, (299,335,618,388), 'Get a connect code', size=22, accent='#2f81f7')
        txt(im, (299,414), 'Connect code', 18, '#c4c4ce')
        rr(im, (299,447,811,506), '#191b20', 9, '#85b4ff' if state == 'paste' else '#484b59', 2)
        value = CODE[:typed] if state == 'paste' else 'XXXX-XXXX-XXXX-XXXX'
        txt(im, (315,467), value, 24, WHITE if state=='paste' else '#858894', mono=True)
        button(im, (832,447,972,506), 'Connect', size=20, accent='#2f81f7')
    return im

@lru_cache(None)
def browser(state='account'):
    im = Image.new('RGBA', (1040,650))
    rr(im, (0,0,1039,649), '#fafaff', 22, '#5f6073', 2)
    rr(im, (17,14,1023,60), '#eeeeF6', 12)
    txt(im, (520,37), 'zana-ide.com/connect', 20, '#4f4a65', anchor='mm')
    txt(im, (48,100), 'Zana Connect', 27, '#261d3b', True)
    badge(im, (748,90), 'GitHub · grebmann', '#615283', '#ece7fa')
    rr(im, (47,159,992,610), '#ffffff', 17, '#dedbea')
    if state=='account':
        txt(im, (83,197), 'Connect your first computer', 31, '#261d3b', True)
        wrap(im, (83,251), 'Choose your permanent address, then connect the computer that will keep this Zana running.', 828, 23, '#676076')
        txt(im, (83,348), 'Your address', 20, '#352b4d', True)
        rr(im, (83,389,916,452), '#faf9fe', 11, '#b8acd4', 2)
        txt(im, (106,409), 'grebmann', 25, '#241b3b')
        txt(im, (502,410), '.zana-ide.com', 25, '#777083')
        button(im, (83,495,612,554), 'Reserve address and get code', size=23)
    else:
        txt(im, (83,197), 'Connect your computer', 31, '#261d3b', True)
        txt(im, (83,249), DOMAIN, 25, PURPLE, True)
        wrap(im, (83,303), 'In the desktop app, open Settings → Remote access and paste this code. It connects automatically.', 833, 23, '#676076')
        rr(im, (83,393,916,464), '#f0eafb', 11)
        txt(im, (500,430), CODE, 37, '#4e308e', True, True, anchor='mm')
        txt(im, (83,481), 'Example code · use your own one-time code', 18, '#746987')
        button(im, (83,527,341,580), 'Copy code', size=23)
    return im

@lru_cache(None)
def install_qr():
    """Use an approved invitation QR when provided, otherwise a labeled QR icon.

    The icon deliberately contains no encoded payload. Viewers are directed to
    their desktop's real install QR, never to a fabricated invitation URL.
    """
    real=OUT/'install-qr.png'
    if real.exists():
        return Image.open(real).convert('RGBA').resize((264,264),Image.Resampling.NEAREST)
    im=Image.new('RGBA',(264,264),'#ffffff')
    d=ImageDraw.Draw(im)
    cell, offset, count=8,16,29
    for y in range(count):
        for x in range(count):
            if (x<9 and y<9) or (x>19 and y<9) or (x<9 and y>19): continue
            if (x*7+y*13+x*y)%5<2:
                d.rectangle((offset+x*cell,offset+y*cell,offset+(x+1)*cell-1,offset+(y+1)*cell-1),fill='#241b39')
    for x,y in [(0,0),(22,0),(0,22)]:
        px,py=offset+x*cell,offset+y*cell
        rr(im,(px,py,px+55,py+55),'#241b39',7)
        rr(im,(px+8,py+8,px+47,py+47),'#ffffff',3)
        rr(im,(px+16,py+16,px+39,py+39),'#241b39',3)
    rr(im,(53,107,250,164),'#ffffff',10)
    txt(im,(151,127),'QR IN ZANA',18,'#241b39',True,anchor='mm')
    txt(im,(151,149),'illustration',14,'#625d76',anchor='mm')
    return im

@lru_cache(None)
def install_desktop():
    im=Image.new('RGBA',(1040,650))
    rr(im,(0,0,1039,649),'#1e1e1e',22,'#4a4b55',2)
    d=ImageDraw.Draw(im)
    for i,c in enumerate(['#ff6865','#f5c14b','#56c86a']):
        d.ellipse((23+i*24,21,35+i*24,33),fill=c)
    txt(im,(520,28),'Zana',18,'#d3d3df',anchor='mm')
    d.line((0,54,1040,54),fill='#383943')
    txt(im,(27,87),'Settings',24,WHITE,True)
    for i,label in enumerate(['General','Appearance','Agents','Remote access','Phone','Machines']):
        y=151+i*58
        if label=='Phone': rr(im,(15,y-10,218,y+35),'#293d59',8)
        txt(im,(29,y),label,20,'#91bcff' if label=='Phone' else '#b6b6c2')
    d.line((234,55,234,650),fill='#383943')
    rr(im,(271,79,1000,153),'#19372e',12,'#295247')
    check(im,306,116,18)
    txt(im,(340,93),'Computer connected',21,WHITE,True)
    txt(im,(340,125),DOMAIN,17,GREEN)
    txt(im,(274,184),'Phone',31,WHITE,True)
    txt(im,(274,233),'Scan to join the Zana beta',24,WHITE,True)
    rr(im,(271,282,1000,583),'#25262b',17,'#3e404c')
    qr=install_qr()
    im.alpha_composite(qr,(291,301))
    for y,num,title,body in [
        (305,'1','Scan with Camera','Open the invitation on your iPhone.'),
        (391,'2','Accept and install','Install Zana in TestFlight.'),
        (477,'3','Open Zana','Continue with your GitHub account.')
    ]:
        rr(im,(580,y,612,y+32),'#3c315b',16)
        txt(im,(596,y+16),num,17,ACCENT,True,anchor='mm')
        txt(im,(627,y+3),title,21,WHITE,True)
        wrap(im,(627,y+35),body,336,17,MUTED,gap=1.25)
    txt(im,(274,606),'Need TestFlight? Install it, then open the invitation again.',18,'#b5bad0')
    return im

@lru_cache(None)
def install_phone(state='camera'):
    im=Image.new('RGBA',(458,808))
    rr(im,(0,0,457,807),'#080a12',58,'#717488',3)
    rr(im,(13,13,444,795),'#f6f5fa',48)
    rr(im,(157,26,300,58),'#080a12',16)
    txt(im,(45,38),'9:41',17,'#211b32',True)
    rr(im,(158,778,302,784),'#29233b',3)
    if state=='camera':
        rr(im,(25,82,433,717),'#151724',20)
        txt(im,(229,127),'CAMERA',18,'#c8c9d3',True,anchor='mm')
        im.alpha_composite(install_qr(),(97,230))
        d=ImageDraw.Draw(im)
        for x,y,dx,dy in [(78,210,1,1),(380,210,-1,1),(78,514,1,-1),(380,514,-1,-1)]:
            d.line([(x,y+dy*38),(x,y),(x+dx*38,y)],fill='#f8d976',width=5)
        button(im,(52,551,406,616),'Open TestFlight invitation',size=19,accent='#80671b')
        txt(im,(229,672),'Scan the QR in desktop Zana',17,'#c8c9d3',anchor='mm')
    else:
        txt(im,(229,108),'TestFlight',27,'#211b32',True,anchor='mm')
        icon=Image.open(ROOT/'website/public/zana-icon-512.png').convert('RGBA').resize((110,110),Image.Resampling.LANCZOS)
        im.alpha_composite(icon,(174,170))
        txt(im,(229,321),'Zana',31,'#211b32',True,anchor='mm')
        txt(im,(229,369),'Your agents, anywhere.',21,'#625d76',anchor='mm')
        if state=='ready':
            check(im,229,469,38,'#bdebd9')
            txt(im,(229,536),'Ready to open',22,'#251b3c',True,anchor='mm')
            button(im,(71,597,387,659),'OPEN',size=22,accent='#1267db')
        else:
            wrap(im,(62,441),'Accept the invitation, then install Zana on your iPhone.',334,23,'#625d76',gap=1.4)
            button(im,(71,597,387,659),'INSTALL',size=22,accent='#1267db')
        txt(im,(229,716),'iPhone installation',17,'#625d76',anchor='mm')
    return im

@lru_cache(None)
def phone(state='signin'):
    im = Image.new('RGBA', (458,808))
    rr(im, (0,0,457,807), '#080a12', 58, '#717488', 3)
    rr(im, (13,13,444,795), '#f6f5fa', 48)
    rr(im, (157,26,300,58), '#080a12', 16)
    txt(im, (45,38), '9:41', 17, '#211b32', True)
    ImageDraw.Draw(im).rounded_rectangle((381,38,408,51), 3, outline='#29233b', width=2)
    rr(im, (385,42,402,47), '#29233b', 1)
    rr(im, (158,778,302,784), '#29233b', 3)
    if state in ('approval','approved'):
        rr(im, (35,82,423,124), '#e9e6ee', 13)
        txt(im, (229,103), 'zana-ide.com', 18, '#534a66', anchor='mm')
        rr(im, (34,152,424,671), '#ffffff', 18, '#e0dae9')
        txt(im, (58,184), 'ZANA MOBILE', 17, PURPLE, True)
        if state=='approval':
            wrap(im, (58,226), 'Sign in on\nZana on iPhone?', 338, 29, '#251b3c', True, 1.2)
            wrap(im, (58,322), 'Approve only if you started this sign-in in Zana Mobile. This phone can use agents and projects on computers connected to your GitHub account.', 331, 20, '#625d76', gap=1.35)
            button(im, (58,558,400,611), 'Approve phone', size=22)
            txt(im, (229,639), 'Decline', 20, '#675a80', anchor='mm')
        else:
            check(im,229,294,44, '#bdebd9')
            wrap(im, (58,376), 'Your phone\nis approved', 340, 29, '#251b3c', True, 1.2)
            wrap(im, (58,467), 'Return to Zana Mobile and choose your computer.', 337, 20, '#625d76', gap=1.4)
            button(im, (58,566,400,624), 'Return to Zana Mobile', size=19)
    elif state=='connected':
        mobile_product(im, state)
    else:
        title = 'Choose your\ncomputer' if state=='computers' else 'Your agents,\nanywhere.'
        wrap(im,(40,113),title,378,32,'#211830',True,1.2)
        wrap(im,(40,211),'Sign in with the same GitHub account as Zana on your computer. Connect securely over Wi-Fi or cellular internet.',375,19,'#625d76',gap=1.4)
        if state=='computers':
            button(im,(40,355,418,413),'My laptop · Connect',size=22)
            txt(im,(40,432),DOMAIN,19,'#625d76')
            button(im,(40,479,418,531),'Refresh computers',False,size=20)
            button(im,(40,549,418,601),'Sign in again',False,size=20)
        else:
            button(im,(40,355,418,413),'Continue with GitHub',size=21)
            wrap(im,(40,438),'On your computer: Settings → Remote access → connect your GitHub account. Keep Zana running while you use your phone.',373,18,'#625d76',gap=1.4)
        button(im,(40,635,418,691),'Manage account and devices',False,size=17)
        button(im,(40,709,418,755),'Try a demo without connecting',False,size=16)
    return im

def mobile_product(im, state):
    """Use a capture of the real MobileAgentBoard component and product CSS."""
    capture=Image.open(OUT/'mobile-kanban.png').convert('RGBA')
    assert capture.size==(430,682)
    # The native status and gesture areas follow the dark connected web shell.
    rr(im,(13,13,444,795),'#181818',48)
    rr(im,(157,26,300,58),'#080a12',16)
    txt(im,(45,38),'9:41',17,'#f4f3fc',True)
    d=ImageDraw.Draw(im)
    d.rounded_rectangle((381,38,408,51),3,outline='#e6edf3',width=2)
    rr(im,(385,42,402,47),'#e6edf3',1)
    rr(im,(158,778,302,784),'#e6edf3',3)
    im.alpha_composite(capture,(14,78))

def ease(x):
    x=max(0,min(1,x)); return 1-(1-x)**3

def pulse(im, xy, t, start, mouse=False):
    elapsed=t-start
    if -1.1 < elapsed < 1.15:
        d=ImageDraw.Draw(im)
        x,y=xy
        if elapsed>=0:
            p=elapsed/1.15
            r=19+43*p
            d.ellipse((x-r,y-r,x+r,y+r),outline=(170,142,255,int(220*(1-p))),width=4)
            d.ellipse((x-9,y-9,x+9,y+9),fill=(170,142,255,int(150*(1-p))))
        if mouse:
            offset=56*(1-ease((elapsed+1.1)/1.1))
            x+=offset; y+=offset
            points=[(x,y),(x+3,y+34),(x+12,y+26),(x+22,y+40),(x+31,y+35),(x+21,y+21),(x+32,y+17)]
            d.polygon(points,fill='#ffffff',outline='#181329',width=2)

def highlight(im, box, t, start=1.5, end=6):
    if start<t<end:
        a=round(140+65*math.sin(t*3))
        rr(im,(box[0]-5,box[1]-5,box[2]+5,box[3]+5),None,18,(186,169,255,a),3)

@lru_cache(None)
def backdrop():
    small=Image.new('RGB',(W//4,H//4)); p=small.load()
    for y in range(H//4):
        for x in range(W//4):
            glow=math.exp(-(((x-355)/180)**2+((y-113)/150)**2))
            p[x,y]=(int(15+14*glow),int(18+11*glow),int(30+34*glow))
    im=small.resize((W,H),Image.Resampling.BICUBIC).convert('RGBA')
    d=ImageDraw.Draw(im)
    for r in (430,540,650):
        d.ellipse((1390-r,470-r,1390+r,470+r),outline=(97,96,156,20),width=1)
    icon=Image.open(ROOT/'website/public/zana-icon-512.png').convert('RGBA').resize((48,48),Image.Resampling.LANCZOS)
    im.alpha_composite(icon,(96,62)); txt(im,(160,71),'Zana',29,WHITE,True)
    d.line((249,69,249,103),fill='#45425c',width=1)
    txt(im,(273,79),'MOBILE QUICK START',17,'#bcb6d0',True)
    return im

def frame(seconds):
    start,end,kind,title,body=next((s for s in SCENES if s[0]<=seconds<s[1]),SCENES[-1])
    t=seconds-start
    im=backdrop().copy()
    layer=Image.new('RGBA',(W,H))
    number=next((i for i,s in enumerate(SCENES) if s[2]==kind),0)
    if kind=='intro':
        badge(layer,(98,242),'Zana Mobile',ACCENT)
    elif kind=='outro':
        badge(layer,(98,242),'Connected to your computer',GREEN,'#1b3c36')
    else:
        txt(layer,(98,247),f'{number:02d} / 07',23,ACCENT,True)
    y=wrap(layer,(94,317),title,770,75,WHITE,True,1.13)
    wrap(layer,(99,y+42),body,640,29,MUTED,gap=1.48)
    if kind=='desktop':
        add_shadow(layer,desktop(),798,247,22)
        highlight(layer,(1097,582,1416,635),t,2,7.5)
        pulse(layer,(1350,609),t,6.5,True)
        badge(layer,(99,775),'One-time desktop setup')
    elif kind=='code':
        state='account' if t<8.8 else 'code'
        add_shadow(layer,browser(state),798,206,22)
        pulse(layer,(1255,733) if state=='account' else (1033,758),t,8.1 if state=='account' else 10.7,True)
        badge(layer,(99,797),DOMAIN)
    elif kind=='paste':
        typed=int(max(0,min(1,(t-1.1)/1.4))*len(CODE))
        state='connected' if t>4.5 else 'paste'
        add_shadow(layer,desktop(state,typed),798,247,22)
        if state=='paste':
            highlight(layer,(1097,694,1609,753),t,.8,4.5)
        else:
            badge(layer,(99,775),'Computer connected',GREEN,'#1b3c36')
    elif kind=='install':
        add_shadow(layer,install_desktop(),798,206,22)
        highlight(layer,(1087,505,1359,773),t,1,7.5)
        if t>3.5:
            state='camera' if t<7.6 else 'install' if t<11.2 else 'ready'
            mobile=install_phone(state).resize((298,525),Image.Resampling.LANCZOS)
            enter=ease((t-3.5)/.65)
            x=1517+int(50*(1-enter))
            if enter<1: mobile.putalpha(mobile.getchannel('A').point(lambda a:int(a*enter)))
            add_shadow(layer,mobile,x,383,40)
            if state!='camera': pulse(layer,(1666,791),t,9.5 if state=='install' else 12.5)
        badge(layer,(99,775),'Accept → Install → Open',ACCENT)
        txt(layer,(99,850),'Your computer is connected to your subdomain.',23,MUTED)
    elif kind=='phone':
        add_shadow(layer,phone('signin'),1182,132,58)
        pulse(layer,(1411,516),t,5.5)
        highlight(layer,(1222,487,1600,545),t,1,7.5)
        badge(layer,(99,775),'Same GitHub account',ACCENT)
    elif kind=='approve':
        state='approval' if t<4.8 else 'approved'
        add_shadow(layer,phone(state),1182,132,58)
        pulse(layer,(1411,717) if state=='approval' else (1411,727),t,4.1 if state=='approval' else 7.4)
        badge(layer,(99,775),'Browser → Zana Mobile')
    elif kind=='choose':
        state='computers' if t<5 else 'connected'
        add_shadow(layer,phone(state),1182,132,58)
        if state=='computers': pulse(layer,(1411,516),t,3.9)
        else: badge(layer,(99,775),'Connected',GREEN,'#1b3c36')
    elif kind=='intro':
        computer=desktop('connected').resize((770,444),Image.Resampling.LANCZOS)
        add_shadow(layer,computer,935,344,20)
        mobile=phone('signin').resize((341,602),Image.Resampling.LANCZOS)
        add_shadow(layer,mobile,1445,239,45)
    else:
        add_shadow(layer,phone('connected'),1182,132,58)
        badge(layer,(99,780),DOMAIN,ACCENT)
        txt(layer,(99,852),'Keep Zana running on your computer.',24,MUTED)
    alpha=min(ease(t/.45),ease((end-seconds)/.3))
    if alpha<1:
        layer.putalpha(layer.getchannel('A').point(lambda a:int(a*alpha)))
    im.alpha_composite(layer,(0,int(12*(1-ease(t/.45)))))
    d=ImageDraw.Draw(im)
    rr(im,(96,984,1824,988),'#36344c',2)
    rr(im,(96,984,96+int(1728*seconds/DURATION),988),ACCENT,2)
    footer='Mobile board · product UI with sample agents' if kind=='outro' else 'Scan the install QR in Settings → Phone on your computer' if kind=='install' else 'Illustrated walkthrough · example connect code'
    txt(im,(97,1015),footer,17,'#9292ac')
    txt(im,(1824,1015),f'{int(seconds):02d} / {DURATION}',17,'#b8b4d0',mono=True,anchor='ra')
    return im.convert('RGB')

def stamp(sec, sep=','):
    ms=round(sec*1000)
    return f'00:{ms//60000:02d}:{ms//1000%60:02d}{sep}{ms%1000:03d}'

def write_text_assets():
    OUT.mkdir(parents=True,exist_ok=True)
    srt=[]; vtt=['WEBVTT\n']
    for i,(start,end,caption) in enumerate(NARRATION,1):
        srt.append(f'{i}\n{stamp(start)} --> {stamp(end)}\n{caption}\n')
        vtt.append(f'{stamp(start,".")} --> {stamp(end,".")}\n{caption}\n')
    (OUT/'mobile-connect.en.srt').write_text('\n'.join(srt))
    (OUT/'mobile-connect.en.vtt').write_text('\n'.join(vtt))
    (OUT/'README.md').write_text('''# Zana Mobile connection walkthrough

84-second, 1920 × 1080, 24 fps MP4 with English neural voiceover (Microsoft Ava Multilingual),
on-screen instructions, and a complete subtitle transcript.
Illustrated screens use the current product's button labels and sample project data.
The on-screen address **grebmann.zana-ide.com** and connect code are examples.
The narration asks viewers to choose their own subdomain.
The video starts with Zana installed on the computer. Phone installation is shown after the computer connects to the chosen subdomain.

1. On the computer: **Settings → Remote access → Get a connect code**.
2. In the browser, sign in with GitHub and choose your subdomain. Select **Reserve address and get code**. Copy the code.
3. Paste the code into desktop Zana. The computer connects automatically.
4. On the connected computer, open **Settings → Phone**. Scan the install QR with the iPhone Camera, accept the TestFlight invitation, and install Zana. Then open the app. If TestFlight is missing, install it first and reopen the invitation.
5. In Zana Mobile, tap **Continue with GitHub**, using the same account.
6. Tap **Approve phone** in the browser, then return to Zana Mobile.
7. Choose the computer and tap its **Connect** button.
8. The ending stays on the mobile kanban, captured from the actual MobileAgentBoard component and product styles with sample agents.

The QR scene directs viewers to the installation QR in their desktop app. Without an `install-qr.png` asset, it uses an explicitly labeled, non-encoded QR illustration. Supply a verified public TestFlight invitation QR as `install-qr.png` to make the QR in the video scannable.

Keep Zana running on the computer and keep the computer awake and online.

`mobile-connect-with-install.mp4` is the shareable video; the other MP4 filenames are copies of the same current export. SRT and VTT files provide captions;
`poster.jpg` is a thumbnail. `render.py` is the editable source (Pillow + ffmpeg + edge-tts).
`voiceover.wav` is the finished narration track; `narration.txt` is the editable transcript.
Speech snippets are cached under `audio-neural/`. Rendering checks each line fits its scene,
then normalizes the assembled narration to -16 LUFS and encodes it as AAC.
Run `python3 render.py --stills` to review key frames, or `python3 render.py` to render.

Product references: `OnlineConnect.tsx`, `ConnectCodePairing.tsx`,
`ComputerCode.tsx`, `PhoneSignIn.tsx`, `PhoneSettingsView.tsx`, `MobileShellChrome.tsx`,
`MobileAgentBoard.tsx`, `mobile-shell.css`, and `docs/mobile-connect.md`.
The board capture uses `board-preview.tsx` with the product component and CSS.
Voice synthesis uses [edge-tts](https://github.com/rany2/edge-tts); cached MP3 clips make subsequent renders offline.
Install the rendering dependencies with `python3 -m pip install Pillow edge-tts`.
''')
    (OUT/'narration.txt').write_text('\n\n'.join(f'{stamp(start, ".")} — {stamp(end, ".")}\n{line}' for start,end,line in NARRATION)+'\n')
    (OUT/'index.html').write_text('''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Zana Mobile</title><style>body{margin:0;background:#101321;color:#f5f4ff;font:16px system-ui;padding:32px}main{max-width:1100px;margin:auto}h1{font-size:28px}p{color:#b5bad0;line-height:1.6}video{width:100%;border-radius:16px;background:#101321}a{color:#baa9ff}.meta{display:flex;justify-content:space-between;gap:20px}</style><main><h1>Connect Zana Mobile</h1><p>An 84-second illustrated walkthrough with English voiceover and captions.</p><video controls playsinline preload="metadata" poster="poster.jpg"><source src="mobile-connect-with-install.mp4" type="video/mp4"><track kind="captions" src="mobile-connect.en.vtt" srclang="en" label="English"></video><div class="meta"><p>Connect your computer → Scan to install → Phone sign-in → Mobile kanban</p><p><a href="mobile-connect-with-install.mp4" download>Download MP4</a></p></div></main></html>''')

def stills():
    moments=[1.5,8,17,30,39,49,59,67,78]
    sheet=Image.new('RGB',(1920,1080),'#111322')
    for i,t in enumerate(moments):
        im=frame(t)
        thumb=im.resize((640,360),Image.Resampling.LANCZOS)
        sheet.paste(thumb,(i%3*640,i//3*360))
    sheet.save(OUT/'contact-sheet.jpg',quality=93)
    frame(1.5).save(OUT/'poster.jpg',quality=95)
    for name,t in [('desktop',8),('browser',17),('install-qr',35),('install-camera',38),('install-app',42),('install-open',45),('phone',49),('approval',57),('computers',67),('app',73),('kanban',78)]:
        frame(t).save(OUT/f'preview-{name}.jpg',quality=92)

def duration(path):
    result=subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','json',str(path)])
    return float(json.loads(result)['format']['duration'])

def narration():
    audio_dir=OUT/'audio-neural'; audio_dir.mkdir(exist_ok=True)
    sample_rate=48000
    timeline=bytearray(DURATION*sample_rate*2)
    timings=[]
    for i,(start,end,line) in enumerate(NARRATION):
        spoken=line
        digest=hashlib.sha256(f'{VOICE}|{VOICE_RATE}|{spoken}'.encode()).hexdigest()[:12]
        source=audio_dir/f'{digest}.mp3'
        if not source.exists():
            cached=next((p for p in audio_dir.glob(f'*-{digest}.mp3') if p.stat().st_size>=1000),None)
            if cached: shutil.copy2(cached,source)
        if not source.exists() or source.stat().st_size<1000:
            text_file=source.with_suffix('.txt'); text_file.write_text(spoken)
            import edge_tts
            pending_source=source.with_suffix('.pending.mp3')
            asyncio.run(edge_tts.Communicate(spoken, VOICE, rate=VOICE_RATE).save(str(pending_source)))
            pending_source.replace(source)
        # Trim trailing TTS silence and leave a short lead-in for natural phrasing.
        trimmed=source.with_suffix('.wav')
        subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-i',str(source),'-af','silenceremove=start_periods=1:start_threshold=-48dB:start_silence=0.04,areverse,silenceremove=start_periods=1:start_threshold=-48dB:start_silence=0.10,areverse','-ar','48000','-ac','1',str(trimmed)],check=True)
        raw=duration(trimmed)
        speed=max(1,raw/(end-start))
        if speed>1.22:
            raise ValueError(f'Narration line {i} needs rewriting: {raw:.2f}s in a {end-start:.2f}s slot')
        if speed>1:
            paced=source.with_suffix('.paced.wav')
            subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-i',str(trimmed),'-af',f'atempo={speed:.6f}',str(paced)],check=True)
            trimmed=paced
        with wave.open(str(trimmed),'rb') as clip:
            assert (clip.getframerate(),clip.getnchannels(),clip.getsampwidth())==(sample_rate,1,2)
            samples=clip.readframes(clip.getnframes())
        offset=round(start*sample_rate)*2
        assert offset+len(samples)<=round(end*sample_rate)*2+sample_rate//10
        timeline[offset:offset+len(samples)]=samples
        timings.append({'start':start,'end':end,'speech_seconds':round(raw/speed,3),'tempo':round(speed,4),'text':line})
    assembled=audio_dir/'assembled.wav'
    with wave.open(str(assembled),'wb') as output:
        output.setparams((1,2,sample_rate,0,'NONE','not compressed'))
        output.writeframes(timeline)
    subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-i',str(assembled),'-af','loudnorm=I=-16:TP=-1.5:LRA=7','-ar',str(sample_rate),'-ac','1','-t',str(DURATION),str(OUT/'voiceover.wav')],check=True)
    assert abs(duration(OUT/'voiceover.wav')-DURATION)<.05
    (audio_dir/'timings.json').write_text(json.dumps(timings,indent=2)+'\n')
    print('Narration ready:', json.dumps(timings),flush=True)

def render():
    narration()
    pending=OUT/'mobile-connect.pending.mp4'
    cmd=['ffmpeg','-y','-hide_banner','-loglevel','warning','-f','rawvideo','-vcodec','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-i',str(OUT/'voiceover.wav'),'-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-t',str(DURATION),'-movflags','+faststart','-metadata','title=Connect Zana Mobile','-metadata','comment=Illustrated walkthrough; English synthetic narration; example code and real mobile kanban UI with sample agents.',str(pending)]
    process=subprocess.Popen(cmd,stdin=subprocess.PIPE)
    try:
        for n in range(FPS*DURATION):
            process.stdin.write(frame(n/FPS).tobytes())
            if n % (FPS*10)==0: print(f'Rendered {n//FPS}/{DURATION} seconds',flush=True)
    finally:
        process.stdin.close()
    if process.wait()!=0: raise RuntimeError('ffmpeg encoding failed')
    pending.replace(OUT/'mobile-connect.mp4')
    shutil.copy2(OUT/'mobile-connect.mp4',OUT/'mobile-connect-neural.mp4')
    shutil.copy2(OUT/'mobile-connect.mp4',OUT/'mobile-connect-final.mp4')
    shutil.copy2(OUT/'mobile-connect.mp4',OUT/'mobile-connect-with-install.mp4')

if __name__=='__main__':
    args=argparse.ArgumentParser(); args.add_argument('--stills',action='store_true'); opts=args.parse_args()
    write_text_assets(); stills()
    if not opts.stills: render()
