#!/usr/bin/env python3
"""Render the approved desktop-to-Safari walkthrough, using the existing visual kit."""
from pathlib import Path
from functools import lru_cache
import argparse
import asyncio
import hashlib
import importlib.util
import json
import math
import subprocess
import wave
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[2]
KIT = OUT.parent / 'mobile-connect'
spec = importlib.util.spec_from_file_location('video_kit', KIT / 'render.py')
kit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kit)
font, txt, wrap, rr = kit.font, kit.txt, kit.wrap, kit.rr
button, check, badge = kit.button, kit.check, kit.badge
add_shadow, ease, pulse, highlight = kit.add_shadow, kit.ease, kit.pulse, kit.highlight
W, H, FPS, DURATION = 1920, 1080, 24, 64
WHITE, MUTED, ACCENT, GREEN = '#f5f4ff', '#b5bad0', '#baa9ff', '#7ce4bd'
DOMAIN = 'my-domain.zana-ide.com'
CODE = '7A2F-9C4D-81E3-5B60'
VOICE, VOICE_RATE = 'en-US-AvaMultilingualNeural', '-5%'
SCENES = [
    (0, 4, 'intro', 'Use Zana\neverywhere.', 'Your desktop. Your iPhone.\nOne place for your agents.'),
    (4, 14, 'remote', 'Start on your\ncomputer.', 'Click Remote access in the bottom-left.\nThen select Get a connect code.'),
    (14, 25, 'address', 'Your own\nZana address.', 'Sign in with GitHub. Enter my-domain.\nReserve your address and copy the code.'),
    (25, 35, 'paste', 'Paste.\nYou’re connected.', 'Paste the code back into Zana.\nYour computer connects automatically.'),
    (35, 44, 'safari', 'Now, pick up\nyour iPhone.', 'Open Safari and enter\nyour new Zana address.'),
    (44, 52, 'signin', 'Same account.\nYou’re in.', 'Sign in with the same GitHub account.\nTap Open Zana.'),
    (52, 64, 'board', 'Your agents.\nEverywhere.', 'Follow their progress from the kanban,\nwherever you are.'),
]
NARRATION = [
    (0.4, 3.6, 'Use Zana everywhere.'),
    (4.4, 13.6, 'On your computer, click the Remote access icon in the bottom-left corner, then Get a connect code.'),
    (14.4, 24.6, 'Sign in with GitHub and enter my-domain. Reserve your address, then copy the connect code.'),
    (25.4, 34.6, 'Back in Zana, paste the code. Your computer connects automatically, and your dedicated address is ready.'),
    (35.4, 43.6, 'Now pick up your iPhone. Open Safari and enter your new Zana address.'),
    (44.4, 51.6, 'Sign in with the same GitHub account, then tap Open Zana.'),
    (52.4, 62.8, 'And voilà! Your agents, right on your phone. Follow their progress from the kanban, wherever you are.'),
]


@lru_cache(None)
def logo(size):
    return Image.open(ROOT / 'website/public/zana-icon-512.png').convert('RGBA').resize((size, size), Image.Resampling.LANCZOS)


def remote_icon(im, x, y, size=22, color=WHITE):
    d = ImageDraw.Draw(im)
    rr(im, (x-size*.33, y-size*.5, x+size*.33, y+size*.5), None, 4, color, 2)
    d.line((x-3, y+size*.32, x+3, y+size*.32), fill=color, width=2)


def window_chrome(im, title='Zana'):
    d = ImageDraw.Draw(im)
    for i, color in enumerate(['#ff6865', '#f5c14b', '#56c86a']):
        d.ellipse((23+i*24, 21, 35+i*24, 33), fill=color)
    txt(im, (520, 28), title, 18, '#d3d3df', anchor='mm')
    d.line((0, 54, 1040, 54), fill='#383943')


@lru_cache(None)
def desktop(state='home', typed=0):
    im = Image.new('RGBA', (1040, 650))
    rr(im, (0, 0, 1039, 649), '#1e1e1e', 22, '#4a4b55', 2)
    window_chrome(im)
    d = ImageDraw.Draw(im)
    im.alpha_composite(logo(28), (25, 78))
    txt(im, (66, 81), 'Zana', 22, WHITE, True)
    for i, label in enumerate(['Inbox', 'Agents', 'Projects', 'Schedules']):
        y = 144+i*56
        if label == 'Agents' and state == 'home': rr(im, (16, y-9, 218, y+34), '#30313a', 9)
        txt(im, (30, y), label, 21, WHITE if label == 'Agents' else '#b6b6c2')
    txt(im, (30, 415), 'PROJECTS', 13, '#888c99', True)
    for i, (name, color) in enumerate([('Zana', '#a68cff'), ('Website', '#54bde3')]):
        d.ellipse((30, 457+i*44, 38, 465+i*44), fill=color)
        txt(im, (50, 450+i*44), name, 18, '#b6b6c2')
    d.line((234, 55, 234, 650), fill='#383943')
    d.line((15, 581, 220, 581), fill='#383943')
    txt(im, (30, 607), 'Settings', 18, '#b6b6c2')
    # Same order as SidebarRail: Settings, bug report, Remote access.
    d.ellipse((150, 606, 164, 624), outline='#aeb0be', width=2)
    d.line((154, 602, 152, 598), fill='#aeb0be', width=2)
    d.line((160, 602, 162, 598), fill='#aeb0be', width=2)
    for dy in (608, 615, 622):
        d.line((146, dy-2, 150, dy), fill='#aeb0be', width=2)
        d.line((164, dy, 168, dy-2), fill='#aeb0be', width=2)
    rr(im, (178, 594, 221, 638), '#292737' if state == 'home' else '#333049', 10)
    remote_icon(im, 200, 616, 23, ACCENT)
    if state == 'home':
        txt(im, (273, 94), 'Agents', 32, WHITE, True)
        button(im, (844, 84, 1004, 128), '+ New agent', size=18, accent='#2f81f7')
        for x, heading, count in [(273, 'Needs you', '0'), (518, 'Working', '2'), (763, 'Done', '1')]:
            txt(im, (x, 170), heading, 20, MUTED, True)
            badge(im, (x+163, 159), count)
            rr(im, (x, 211, x+222, 538), '#242429', 12)
        for x, y, title, provider, color in [(531, 228, 'Polish the mobile\nexperience', 'Codex', '#d2b774'), (531, 358, 'Review the\nlatest changes', 'Claude', '#d2b774'), (776, 228, 'Connection\nwalkthrough', 'Codex', GREEN)]:
            rr(im, (x, y, x+196, y+111), '#2d2d33', 10, '#4a4540')
            wrap(im, (x+13, y+13), title, 178, 18, WHITE, True, 1.3)
            txt(im, (x+13, y+83), provider, 15, '#9d9dac')
            d.ellipse((x+177, y+86, x+183, y+92), fill=color)
    else:
        txt(im, (274, 94), 'Remote access', 32, WHITE, True)
        wrap(im, (274, 147), 'Your agents and projects, reachable from your browser.', 700, 22, '#aeb0be')
        rr(im, (274, 210, 1004, 552), '#25262b', 17, '#3e404c')
        if state == 'connected':
            check(im, 315, 258, 21)
            txt(im, (351, 243), 'Connected', 28, WHITE, True)
            txt(im, (301, 311), 'Your browser address', 19, '#b8b8c7')
            txt(im, (301, 353), DOMAIN, 30, '#bdd4ff', True)
            button(im, (301, 422, 509, 477), 'Open Zana', size=22, accent='#2f81f7')
            button(im, (528, 422, 741, 477), 'Copy address', primary=False, dark=True, size=22)
            rr(im, (939, 103, 996, 132), '#2f81f7', 15)
            d.ellipse((968, 107, 989, 128), fill=WHITE)
            txt(im, (300, 506), 'Remote access is on', 19, GREEN)
        else:
            txt(im, (300, 237), 'Connect this computer', 25, WHITE, True)
            txt(im, (300, 282), 'Get a one-time code from your Zana account.', 21, '#b8b8c7')
            button(im, (300, 331, 638, 388), 'Get a connect code', size=23, accent='#2f81f7')
            txt(im, (300, 416), 'Paste it here — it connects automatically.', 20, '#c4c4ce')
            rr(im, (300, 458, 822, 516), '#191b20', 9, '#85b4ff' if state == 'paste' else '#484b59', 2)
            value = CODE[:typed] if state == 'paste' else 'XXXX-XXXX-XXXX-XXXX'
            txt(im, (318, 475), value, 24, WHITE if state == 'paste' else '#858894', mono=True)
            button(im, (838, 458, 978, 516), 'Connect', size=20, accent='#2f81f7')
        txt(im, (274, 584), 'Keep this computer awake and Zana running.', 20, '#aeb0be')
    return im


@lru_cache(None)
def browser(state='signin', typed=9, copied=False):
    im = Image.new('RGBA', (1040, 650))
    rr(im, (0, 0, 1039, 649), '#fafaff', 22, '#5f6073', 2)
    rr(im, (17, 14, 1023, 60), '#eeeef6', 12)
    txt(im, (520, 37), 'zana-ide.com/connect', 20, '#4f4a65', anchor='mm')
    im.alpha_composite(logo(38), (47, 90))
    txt(im, (99, 99), 'Your Zana', 27, '#261d3b', True)
    if state != 'signin': badge(im, (757, 91), 'GitHub · signed in', '#615283', '#ece7fa')
    rr(im, (47, 159, 992, 612), '#ffffff', 17, '#dedbea')
    if state == 'signin':
        txt(im, (83, 200), 'Your agents and projects,', 33, '#261d3b', True)
        txt(im, (83, 245), 'reachable anywhere.', 33, '#261d3b', True)
        wrap(im, (83, 319), 'A home for your connected devices.', 835, 25, '#676076')
        button(im, (83, 407, 512, 474), 'Sign in with GitHub', size=25)
        txt(im, (83, 513), 'Uses your GitHub profile. No repository access required.', 20, '#746987')
    elif state == 'address':
        txt(im, (83, 197), 'Connect your first computer', 31, '#261d3b', True)
        wrap(im, (83, 251), 'Choose your permanent address, then connect the computer that will keep this Zana running.', 828, 23, '#676076')
        txt(im, (83, 348), 'Your address', 20, '#352b4d', True)
        rr(im, (83, 389, 916, 452), '#faf9fe', 11, '#b8acd4', 2)
        txt(im, (106, 409), 'my-domain'[:typed], 25, '#241b3b')
        txt(im, (502, 410), '.zana-ide.com', 25, '#777083')
        button(im, (83, 495, 612, 554), 'Reserve address and get code', size=23)
    else:
        txt(im, (83, 197), 'Connect your computer', 31, '#261d3b', True)
        txt(im, (83, 249), DOMAIN, 27, '#6543c0', True)
        wrap(im, (83, 307), 'In the desktop app, open Settings → Remote access and paste this code. It connects automatically.', 833, 23, '#676076')
        rr(im, (83, 396, 916, 467), '#f0eafb', 11)
        txt(im, (500, 431), CODE, 37, '#4e308e', True, True, anchor='mm')
        txt(im, (83, 487), 'Waiting for your computer…', 19, '#746987')
        button(im, (83, 531, 341, 584), 'Copied' if copied else 'Copy code', size=23, accent='#387d68' if copied else '#6543c0')
    return im


def safari_toolbar(im, address, dark=False, editing=False):
    d = ImageDraw.Draw(im)
    top = 419 if editing else 677
    bg, ink = ('#333338', '#ececf3') if dark else ('#e8e7ee', '#322d40')
    rr(im, (28, top, 429, top+46), bg, 15)
    txt(im, (45, top+13), 'aA', 17, ink)
    txt(im, (237, top+23), address, 18, ink, anchor='mm')
    if not editing:
        d.arc((402, top+16, 415, top+29), 40, 330, fill=ink, width=2)
        d.polygon([(413, top+13), (417, top+19), (410, top+19)], fill=ink)
        y = 752
        d.line([(60, y-9), (50, y), (60, y+9)], fill='#7995e8', width=3)
        d.line([(133, y-9), (143, y), (133, y+9)], fill='#85828c', width=3)
        d.rectangle((222, y-2, 238, y+12), outline='#7995e8', width=2)
        d.line((230, y+4, 230, y-14), fill='#7995e8', width=2)
        d.line([(224, y-9), (230, y-15), (236, y-9)], fill='#7995e8', width=2)
        d.line([(308, y+10), (308, y-8), (321, y-6), (334, y-8), (334, y+10), (321, y+12), (308, y+10)], fill='#7995e8', width=2)
        d.line((321, y-6, 321, y+12), fill='#7995e8', width=2)
        rr(im, (388, y-9, 408, y+11), None, 4, '#7995e8', 2)
        rr(im, (384, y-13, 404, y+7), None, 4, '#7995e8', 2)


def keyboard(im):
    rr(im, (15, 477, 443, 769), '#cdced5', 5)
    for chars, x0, y in [('qwertyuiop', 22, 498), ('asdfghjkl', 44, 554), ('zxcvbnm', 87, 610)]:
        for i, char in enumerate(chars):
            x = x0+i*42
            rr(im, (x, y, x+36, y+45), '#f9f9fc', 6)
            txt(im, (x+18, y+20), char, 23, '#191922', anchor='mm')
    button(im, (22, 674, 83, 720), '123', size=17, accent='#b7b9c3')
    rr(im, (92, 674, 324, 720), '#fafaff', 6)
    txt(im, (208, 697), 'space', 18, '#31313c', anchor='mm')
    button(im, (333, 674, 428, 720), 'Go', size=20, accent='#3478ee')


@lru_cache(None)
def board_capture():
    image = Image.open(KIT / 'mobile-kanban.png').convert('RGBA')
    assert image.size == (430, 682)
    return image


@lru_cache(None)
def phone(state='start', typed=0, scroll=0):
    im = Image.new('RGBA', (458, 810))
    rr(im, (0, 0, 457, 809), '#090a10', 58, '#565769', 3)
    dark = state == 'board'
    background = '#1e1e1e' if dark else '#f8f7fc'
    rr(im, (13, 13, 444, 795), background, 48)
    rr(im, (157, 26, 300, 58), '#080a12', 16)
    ink = '#f4f3fc' if dark else '#292238'
    txt(im, (45, 38), '9:41', 17, ink, True)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((381, 38, 408, 51), 3, outline=ink, width=2)
    rr(im, (385, 42, 402, 47), ink, 1)
    rr(im, (158, 778, 302, 784), ink, 3)
    if state in ('start', 'typing'):
        if state == 'start':
            txt(im, (46, 127), 'Safari', 32, '#272039', True)
            txt(im, (46, 207), 'Favorites', 22, '#272039', True)
            im.alpha_composite(logo(74), (48, 255))
            txt(im, (85, 346), 'Zana', 18, '#524c61', anchor='mm')
            safari_toolbar(im, 'Search or enter website')
        else:
            txt(im, (46, 123), 'Open your Zana address', 24, '#272039', True)
            rr(im, (34, 182, 424, 281), '#ffffff', 15, '#e4e0ef')
            im.alpha_composite(logo(46), (51, 207))
            txt(im, (112, 204), 'Your Zana', 22, '#272039', True)
            txt(im, (112, 241), DOMAIN, 17, '#6d647e')
            safari_toolbar(im, DOMAIN[:typed], editing=True)
            keyboard(im)
    elif state in ('signin', 'open'):
        im.alpha_composite(logo(42), (42, 96))
        txt(im, (99, 106), 'Your Zana', 24, '#271d3e', True)
        rr(im, (32, 177, 426, 617), '#ffffff', 18, '#e2dbea')
        if state == 'signin':
            wrap(im, (55, 211), 'Your agents and\nprojects, reachable\nanywhere.', 347, 28, '#291d3e', True, 1.2)
            wrap(im, (55, 347), 'A home for your\nconnected devices.', 346, 21, '#706580', gap=1.35)
            button(im, (55, 451, 402, 511), 'Sign in with GitHub', size=22)
            wrap(im, (55, 542), 'Uses your GitHub profile.\nNo repository access required.', 345, 17, '#746987', gap=1.4)
        else:
            txt(im, (55, 212), 'ZANA CONNECT', 15, '#7c689e', True)
            txt(im, (55, 255), 'Open My computer', 27, '#291d3e', True)
            txt(im, (55, 321), 'Continue to', 21, '#706580')
            txt(im, (55, 361), DOMAIN, 23, '#6543c0', True)
            wrap(im, (55, 407), 'to use your agents and projects in this browser.', 344, 22, '#706580', gap=1.4)
            button(im, (55, 525, 402, 583), 'Open Zana', size=23)
        safari_toolbar(im, 'zana-ide.com')
    else:
        capture = board_capture()
        im.alpha_composite(capture.crop((0, 0, 430, 228)), (14, 78))
        im.alpha_composite(capture.crop((0, 228+scroll, 430, 582+scroll)), (14, 306))
        safari_toolbar(im, DOMAIN, dark=True)
        d.line((24, 669, 434, 669), fill='#45434e', width=1)
    return im


@lru_cache(None)
def backdrop():
    small = Image.new('RGB', (W//4, H//4))
    pixels = small.load()
    for y in range(H//4):
        for x in range(W//4):
            glow = math.exp(-(((x-355)/180)**2+((y-113)/150)**2))
            pixels[x, y] = (int(15+14*glow), int(18+11*glow), int(30+34*glow))
    im = small.resize((W, H), Image.Resampling.BICUBIC).convert('RGBA')
    d = ImageDraw.Draw(im)
    for r in (430, 540, 650): d.ellipse((1390-r, 470-r, 1390+r, 470+r), outline=(97, 96, 156, 20), width=1)
    im.alpha_composite(logo(48), (96, 62))
    txt(im, (160, 71), 'Zana', 29, WHITE, True)
    d.line((249, 69, 249, 103), fill='#45425c', width=1)
    txt(im, (273, 79), 'USE ZANA EVERYWHERE', 17, '#bcb6d0', True)
    return im


def frame(seconds):
    start, end, kind, title, body = next((s for s in SCENES if s[0] <= seconds < s[1]), SCENES[-1])
    t = seconds-start
    im = backdrop().copy()
    layer = Image.new('RGBA', (W, H))
    if kind == 'intro': badge(layer, (98, 242), 'Desktop → iPhone')
    elif kind == 'board': badge(layer, (98, 242), 'Connected in Safari', GREEN, '#1b3c36')
    else: txt(layer, (98, 247), f'{SCENES.index((start, end, kind, title, body)):02d} / 05', 23, ACCENT, True)
    title_size = 70 if kind == 'paste' else 75
    y = wrap(layer, (94, 317), title, 700, title_size, WHITE, True, 1.13)
    wrap(layer, (99, y+42), body, 663, 28, MUTED, gap=1.48)
    if kind == 'intro':
        add_shadow(layer, desktop('home').resize((770, 481), Image.Resampling.LANCZOS), 935, 326, 20)
        add_shadow(layer, phone('board').resize((341, 603), Image.Resampling.LANCZOS), 1445, 218, 45)
    elif kind == 'remote':
        state = 'home' if t < 5.8 else 'setup'
        panel = desktop(state).copy()
        if state == 'home':
            highlight(panel, (178, 594, 221, 638), t, 1.5, 5.7)
            pulse(panel, (200, 616), t, 5.15, mouse=True)
            rr(panel, (132, 538, 307, 578), '#4b3a73', 9)
            txt(panel, (219, 558), 'Remote access', 18, WHITE, True, anchor='mm')
        else:
            highlight(panel, (300, 331, 638, 388), t, 6.1, 9.9)
            pulse(panel, (559, 360), t, 9.1, mouse=True)
        add_shadow(layer, panel, 798, 206, 22)
        badge(layer, (99, 792), 'One-time desktop setup')
    elif kind == 'address':
        state = 'signin' if t < 2.7 else 'address' if t < 7.5 else 'code'
        typed = min(9, max(0, int((t-3.1)*5)))
        panel = browser(state, typed, copied=t > 10.0).copy()
        if state == 'signin': pulse(panel, (320, 441), t, 2.1, mouse=True)
        elif state == 'address':
            highlight(panel, (83, 389, 916, 452), t, 3, 6.2)
            pulse(panel, (516, 528), t, 6.8, mouse=True)
        else: pulse(panel, (240, 558), t, 9.6, mouse=True)
        add_shadow(layer, panel, 798, 206, 22)
        badge(layer, (99, 792), DOMAIN)
    elif kind == 'paste':
        state = 'paste' if t < 4.1 else 'connected'
        panel = desktop(state, len(CODE) if t > 1.7 else 0).copy()
        if state == 'paste':
            highlight(panel, (300, 458, 822, 516), t, .5, 3.7)
            pulse(panel, (476, 487), t, 1.5, mouse=True)
        else:
            highlight(panel, (297, 345, 891, 397), t, 4.8, 9.7)
            badge(layer, (99, 792), 'Computer connected', GREEN, '#1b3c36')
        add_shadow(layer, panel, 798, 206, 22)
    elif kind == 'safari':
        state = 'start' if t < 2.1 else 'typing'
        typed = max(0, min(len(DOMAIN), int((t-2.7)*10)))
        panel = phone(state, typed).copy()
        if state == 'start': pulse(panel, (229, 700), t, 1.6)
        else:
            highlight(panel, (28, 419, 429, 465), t, 2.5, 7.3)
            pulse(panel, (380, 697), t, 8.0)
        add_shadow(layer, panel, 1182, 132, 58)
        badge(layer, (99, 792), DOMAIN)
    elif kind == 'signin':
        state = 'signin' if t < 4.4 else 'open'
        panel = phone(state).copy()
        pulse(panel, (229, 481) if state == 'signin' else (229, 554), t, 3.7 if state == 'signin' else 7.1)
        add_shadow(layer, panel, 1182, 132, 58)
        badge(layer, (99, 792), 'Same GitHub account')
    else:
        scroll = round(40*ease((t-3.0)/3.7))
        add_shadow(layer, phone('board', scroll=scroll), 1182, 132, 58)
        badge(layer, (99, 755), DOMAIN)
        wrap(layer, (99, 837), 'Keep your computer awake and online,\nwith Zana running.', 665, 23, MUTED, gap=1.4)
    alpha = min(ease(t/.4), ease((end-seconds)/.25))
    if alpha < 1: layer.putalpha(layer.getchannel('A').point(lambda a: int(a*alpha)))
    im.alpha_composite(layer, (0, int(12*(1-ease(t/.4)))))
    rr(im, (96, 984, 1824, 988), '#36344c', 2)
    rr(im, (96, 984, 96+int(1728*seconds/DURATION), 988), ACCENT, 2)
    footer = 'Product kanban with sample agents · Safari' if kind == 'board' else 'Illustrated walkthrough · example address and connect code'
    txt(im, (97, 1015), footer, 17, '#9292ac')
    txt(im, (1824, 1015), f'{int(seconds):02d} / {DURATION}', 17, '#b8b4d0', mono=True, anchor='ra')
    return im.convert('RGB')


def duration(path):
    data = subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(path)])
    return float(json.loads(data)['format']['duration'])


def narration():
    audio_dir = OUT / 'audio-neural'
    audio_dir.mkdir(exist_ok=True)
    rate = 48000
    timeline = bytearray(DURATION*rate*2)
    timings = []
    for i, (start, end, caption) in enumerate(NARRATION):
        spoken = caption.replace('my-domain', 'my domain')
        digest = hashlib.sha256(f'{VOICE}|{VOICE_RATE}|{spoken}'.encode()).hexdigest()[:12]
        source = audio_dir / f'{digest}.mp3'
        source.with_suffix('.txt').write_text(spoken)
        if not source.exists() or source.stat().st_size < 1000:
            import edge_tts
            pending = source.with_suffix('.pending.mp3')
            asyncio.run(edge_tts.Communicate(spoken, VOICE, rate=VOICE_RATE).save(str(pending)))
            pending.replace(source)
        trimmed = source.with_suffix('.wav')
        subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', str(source), '-af', 'silenceremove=start_periods=1:start_threshold=-48dB:start_silence=0.04,areverse,silenceremove=start_periods=1:start_threshold=-48dB:start_silence=0.10,areverse', '-ar', str(rate), '-ac', '1', str(trimmed)], check=True)
        raw = duration(trimmed)
        if raw > end-start:
            raise ValueError(f'Extend scene {i}: {raw:.2f}s narration exceeds {end-start:.2f}s slot. Preserve natural voice pace.')
        with wave.open(str(trimmed), 'rb') as clip:
            assert (clip.getframerate(), clip.getnchannels(), clip.getsampwidth()) == (rate, 1, 2)
            samples = clip.readframes(clip.getnframes())
        offset = round(start*rate)*2
        timeline[offset:offset+len(samples)] = samples
        timings.append({'start': start, 'end': round(start+raw, 3), 'slot_end': end, 'speech_seconds': round(raw, 3), 'tempo': 1, 'text': caption})
        print(f'Narration {i+1}/{len(NARRATION)}: {raw:.2f}s / {end-start:.2f}s', flush=True)
    assembled = audio_dir / 'assembled.wav'
    with wave.open(str(assembled), 'wb') as output:
        output.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        output.writeframes(timeline)
    subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', str(assembled), '-af', 'loudnorm=I=-16:TP=-1.5:LRA=7', '-ar', str(rate), '-ac', '1', '-t', str(DURATION), str(OUT/'voiceover.wav')], check=True)
    assert abs(duration(OUT/'voiceover.wav')-DURATION) < .05
    (audio_dir/'timings.json').write_text(json.dumps(timings, indent=2)+'\n')


def text_assets():
    srt, vtt = [], ['WEBVTT\n']
    for i, (start, end, line) in enumerate(NARRATION, 1):
        srt.append(f'{i}\n{kit.stamp(start)} --> {kit.stamp(end)}\n{line}\n')
        vtt.append(f'{kit.stamp(start, ".")} --> {kit.stamp(end, ".")}\n{line}\n')
    (OUT/'zana-everywhere.en.srt').write_text('\n'.join(srt))
    (OUT/'zana-everywhere.en.vtt').write_text('\n'.join(vtt))
    (OUT/'narration.txt').write_text('\n\n'.join(line for _, _, line in NARRATION)+'\n')
    (OUT/'index.html').write_text('''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Use Zana everywhere</title><style>body{margin:0;background:#101321;color:#f5f4ff;font:16px system-ui;padding:32px}main{max-width:1100px;margin:auto}h1{font-size:28px}p{color:#b5bad0;line-height:1.6}video{width:100%;border-radius:16px;background:#101321}a{color:#baa9ff}</style><main><h1>Use Zana everywhere</h1><p>From your desktop to Safari on your iPhone. 64 seconds, with Ava neural voiceover.</p><video controls playsinline preload="metadata" poster="poster.jpg"><source src="zana-everywhere.mp4" type="video/mp4"><track kind="captions" src="zana-everywhere.en.vtt" srclang="en" label="English"></video><p><a href="zana-everywhere.mp4" download>Download MP4</a></p></main></html>''')


def stills():
    moments = [('intro', 2), ('remote-icon', 8), ('remote-panel', 12), ('github', 15.5), ('address', 19.7), ('copy', 24.3), ('paste', 28), ('connected', 32), ('safari', 41), ('phone-signin', 46), ('open-zana', 50), ('kanban', 60)]
    sheet = Image.new('RGB', (1920, 1440), '#101321')
    for i, (name, second) in enumerate(moments):
        im = frame(second)
        im.save(OUT/f'preview-{name}.jpg', quality=93)
        sheet.paste(im.resize((640, 360), Image.Resampling.LANCZOS), (i%3*640, i//3*360))
    sheet.save(OUT/'contact-sheet.jpg', quality=94)
    frame(2).save(OUT/'poster.jpg', quality=95)


def render():
    pending = OUT/'zana-everywhere.pending.mp4'
    cmd = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'warning', '-f', 'rawvideo', '-vcodec', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-', '-i', str(OUT/'voiceover.wav'), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-t', str(DURATION), '-movflags', '+faststart', '-metadata', 'title=Use Zana everywhere', '-metadata', 'comment=Illustrated desktop-to-Safari walkthrough; Ava synthetic narration; example address and code; product kanban with sample agents.', str(pending)]
    process = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    try:
        for n in range(FPS*DURATION):
            process.stdin.write(frame(n/FPS).tobytes())
            if n % (FPS*8) == 0: print(f'Rendered {n//FPS}/{DURATION} seconds', flush=True)
    finally:
        process.stdin.close()
    if process.wait() != 0: raise RuntimeError('ffmpeg encoding failed')
    pending.replace(OUT/'zana-everywhere.mp4')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--stills', action='store_true')
    parser.add_argument('--audio-only', action='store_true')
    args = parser.parse_args()
    text_assets()
    if args.audio_only: narration()
    else:
        stills()
        if not args.stills:
            narration()
            render()
