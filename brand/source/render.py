"""Renders the PNG/ICO files, the social previews and preview.png from the SVGs.

Run after kit.py:  python3 brand/source/render.py
Needs Python 3, Pillow and Playwright (pip install pillow playwright; playwright install chromium).
Set CHROME=/path/to/chrome to use an installed Chrome instead of Playwright's.
"""
import asyncio
import base64
import os

from PIL import Image
from playwright.async_api import async_playwright

from kit import CORE, OXIDE, WORD_VB
from motion import F_D, GLYPHS, CUR, D, I_INK, P_TOP, PU

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))


def b64(path, mime):
    with open(path, 'rb') as f:
        return f'data:{mime};base64,' + base64.b64encode(f.read()).decode()


def img(rel, style=''):
    return f'<img alt="" src="{b64(os.path.join(ROOT, rel), "image/svg+xml")}" style="display:block;{style}">'


FONTS = ''.join(
    f"@font-face{{font-family:Barlow;font-weight:{w};src:url({b64(os.path.join(HERE, 'fonts', f'barlow-latin-{w}-normal.woff2'), 'font/woff2')}) format('woff2')}}"
    for w in (400, 500, 700))


def page(body, bg='transparent', extra=''):
    return (f'<!DOCTYPE html><html><head><meta charset="utf-8"><style>{FONTS}'
            f'html,body{{margin:0;background:{bg}}}body{{font-family:Barlow,sans-serif}}{extra}</style></head>'
            f'<body>{body}</body></html>')


def social_svg(w, h, word_w):
    """Wordmark on Night with faint field contours around the whole word."""
    vb = [float(v) for v in WORD_VB.split()]
    s = word_w / vb[2]
    tx, ty = (w - 1274 * s) / 2, h * 0.43 - 70.6 * s
    shape = F_D + ''.join(g['d'] for g in GLYPHS) + D(CUR, I_INK, P_TOP, PU)
    lw = 2.4 / s
    base = h * 0.43 + 150 * s + 64
    fs = round(h * 0.047)
    # keep the field lines out from behind the tagline (screen box -> wordmark units)
    cx0, cy0, cx1, cy1 = w / 2 - 12.5 * fs, base - 1.35 * fs, w / 2 + 12.5 * fs, base + 0.75 * fs
    clear = (f'<rect x="{(cx0 - tx) / s:.1f}" y="{(cy0 - ty) / s:.1f}" width="{(cx1 - cx0) / s:.1f}" '
             f'height="{(cy1 - cy0) / s:.1f}" rx="{0.6 * fs / s:.1f}" fill="#000"/>')
    rings, masks = [], []
    for i, (dist, op) in enumerate([(46, .15), (104, .10), (176, .065), (266, .04)]):
        masks.append(f'<mask id="c{i}" maskUnits="userSpaceOnUse" x="-2000" y="-2000" width="6000" height="4500">'
                     f'<path d="{shape}" fill="none" stroke="#fff" stroke-linejoin="round" stroke-width="{2 * dist + lw:.1f}"/>'
                     f'<path d="{shape}" fill="none" stroke="#000" stroke-linejoin="round" stroke-width="{2 * dist - lw:.1f}"/>'
                     f'<path d="{shape}" fill="#000"/>{clear}</mask>')
        rings.append(f'<rect x="-2000" y="-2000" width="6000" height="4500" fill="{CORE["cream"]}" opacity="{op}" mask="url(#c{i})"/>')
    with open(os.path.join(ROOT, 'logo/ferricade-wordmark-rust-on-dark.svg')) as f:
        word = f.read()
    inner = word[word.index('</title>') + 8:word.rindex('</svg>')]
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
            f'<rect width="{w}" height="{h}" fill="{CORE["night"]}"/>'
            f'<g transform="translate({tx:.2f} {ty:.2f}) scale({s:.5f})"><defs>{"".join(masks)}</defs>{"".join(rings)}{inner}</g>'
            f'<text x="{w / 2}" y="{base}" text-anchor="middle" font-family="Barlow" font-weight="500" '
            f'font-size="{fs}" fill="#A9A59E">Admin console for a self-hosted RustDesk server</text></svg>')


def board():
    sw = lambda name, hexv, ink: (f'<div class="sw"><span style="background:{hexv};{"box-shadow:inset 0 0 0 1px #d8d4ce;" if ink else ""}"></span>'
                                  f'<b>{name}</b><i>{hexv}</i></div>')
    swatches = (sw('Iron', CORE['iron'], 0) + sw('Night', CORE['night'], 0) + sw('Cream', CORE['cream'], 1) + sw('Paper', CORE['paper'], 1) +
                sw('Rust', CORE['rust'], 0) + sw('Rust on dark', CORE['rust-on-dark'], 0) +
                sw('Oxide face', OXIDE['on-light']['face'], 0) + sw('Oxide rim', OXIDE['on-light']['rim'], 0))
    icons = ''.join(img('app-icons/favicon.svg', f'width:{s}px;height:{s}px') for s in (96, 48, 32, 16))
    css = ('.b{width:1600px;padding:56px;box-sizing:border-box;background:#f7f5f2;color:#2b2e33}'
           'h1{font:700 40px/1 Barlow;margin:0 0 6px}.sub{font:400 18px Barlow;color:#5d6168;margin:0 0 32px}'
           '.row{display:grid;gap:20px;margin-bottom:20px}.two{grid-template-columns:1fr 1fr}'
           '.p{border-radius:14px;display:grid;place-items:center;position:relative}.n{background:#181a1d}.l{background:#f0eeeb;box-shadow:inset 0 0 0 1px #dcd8d2}'
           '.p em{position:absolute;left:16px;bottom:10px;font:500 14px Barlow;font-style:normal;color:#8a8780}'
           '.five{grid-template-columns:repeat(5,1fr)}.sws{display:grid;grid-template-columns:repeat(8,1fr);gap:16px}'
           '.sw span{display:block;height:84px;border-radius:10px}.sw b{display:block;font:500 15px Barlow;margin-top:8px}.sw i{font:400 14px Barlow;font-style:normal;color:#5d6168}'
           '.ic{display:flex;align-items:end;gap:18px}')
    body = (f'<div class="b"><h1>Ferricade brand kit</h1><p class="sub">Hero B: corner F, rusted pointer over the ı. Rust for large sizes, flat for small.</p>'
            f'<div class="row two"><div class="p n" style="height:250px">{img("logo/ferricade-wordmark-rust-on-dark.svg", "width:600px")}<em>Wordmark, rust, on dark</em></div>'
            f'<div class="p l" style="height:250px">{img("logo/ferricade-wordmark-rust-on-light.svg", "width:600px")}<em>Wordmark, rust, on light</em></div></div>'
            f'<div class="row two"><div class="p n" style="height:150px">{img("logo/ferricade-wordmark-flat-on-dark.svg", "width:360px")}<em>Flat, under 360 px</em></div>'
            f'<div class="p l" style="height:150px">{img("logo/ferricade-wordmark-flat-on-light.svg", "width:360px")}<em>Flat, under 360 px</em></div></div>'
            f'<div class="row five">'
            f'<div class="p n" style="height:230px">{img("logo/ferricade-mark-rust-on-dark.svg", "height:150px")}<em>Mark</em></div>'
            f'<div class="p l" style="height:230px">{img("logo/ferricade-mark-rust-on-light.svg", "height:150px")}<em>Mark</em></div>'
            f'<div class="p l" style="height:230px">{img("app-icons/icon.svg", "width:150px")}<em>App icon</em></div>'
            f'<div class="p l" style="height:230px"><div class="ic">{icons}</div><em>Favicon, flat tip</em></div>'
            f'<div class="p l" style="height:230px">{img("logo/ferricade-pointer-rust-on-light.svg", "height:150px")}<em>Pointer</em></div></div>'
            f'<div class="sws">{swatches}</div></div>')
    return page(body, extra=css)


async def main():
    jobs = []
    for ground in ('on-dark', 'on-light'):
        for width in (1280, 2560):
            jobs.append((f'logo/ferricade-wordmark-rust-{ground}.svg', width, round(width * 219 / 1278), f'logo/png/ferricade-wordmark-rust-{ground}-{width}.png'))
        jobs.append((f'logo/ferricade-wordmark-flat-{ground}.svg', 1280, round(1280 * 219 / 1278), f'logo/png/ferricade-wordmark-flat-{ground}-1280.png'))
        for style in ('rust', 'flat'):
            jobs.append((f'logo/ferricade-mark-{style}-{ground}.svg', 340, 512, f'logo/png/ferricade-mark-{style}-{ground}-512.png'))
    jobs += [('app-icons/icon.svg', 512, 512, 'app-icons/icon-512.png'),
             ('app-icons/icon.svg', 192, 192, 'app-icons/icon-192.png'),
             ('app-icons/icon-maskable.svg', 512, 512, 'app-icons/icon-maskable-512.png'),
             ('app-icons/apple-touch-icon.svg', 180, 180, 'app-icons/apple-touch-icon.png')]
    jobs += [('app-icons/favicon.svg', s, s, f'app-icons/favicon-{s}.png') for s in (16, 32, 48)]

    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('CHROME') or None, args=['--no-sandbox'])
        pg = await browser.new_page()
        for src, w, h, dst in jobs:
            await pg.set_viewport_size({'width': w, 'height': h})
            await pg.set_content(page(img(src, f'width:{w}px;height:{h}px')))
            await pg.screenshot(path=os.path.join(ROOT, dst), omit_background=True)
            print(dst)
        for w, h, word_w, dst in [(1280, 640, 820, 'social/ferricade-social-1280x640.png'), (1200, 630, 780, 'social/ferricade-og-1200x630.png')]:
            await pg.set_viewport_size({'width': w, 'height': h})
            await pg.set_content(page(social_svg(w, h, word_w)))
            await pg.evaluate('document.fonts.ready')
            await pg.screenshot(path=os.path.join(ROOT, dst))
            print(dst)
        await pg.set_viewport_size({'width': 1600, 'height': 900})
        await pg.set_content(page(board()))
        await pg.evaluate('document.fonts.ready')
        await pg.locator('.b').screenshot(path=os.path.join(ROOT, 'preview.png'))
        print('preview.png')
        await browser.close()

    icos = [Image.open(os.path.join(ROOT, f'app-icons/favicon-{s}.png')) for s in (16, 32, 48)]
    icos[2].save(os.path.join(ROOT, 'app-icons/favicon.ico'), format='ICO', sizes=[(16, 16), (32, 32), (48, 48)], append_images=icos[:2])
    print('app-icons/favicon.ico')


if __name__ == '__main__':
    asyncio.run(main())
