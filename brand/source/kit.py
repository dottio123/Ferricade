"""Builds the static Ferricade brand assets (SVG) and design tokens.

Run: python3 brand/source/kit.py   (then render.py for the PNG/ICO files)

Geometry and the rust texture come from motion.py, so the logo files, the loader
and the intro all share one drawing. The rust texture is procedural with fixed
seeds: rerunning gives the same pattern.
"""
import json
import os
import re

from motion import (CUR, F_D, Fw, GLYPHS, H, I_INK, P_TOP, PU, TIP_D, TIP_U, TIP_UNITS, D, rusty)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))

CORE = {
    'iron': '#2B2E33', 'night': '#181A1D', 'cream': '#ECE6DC', 'paper': '#F0EEEB',
    'rust': '#B7410E', 'rust-on-dark': '#D65C26',
}
OXIDE = {
    'on-light': {'rim': '#56200B', 'face': '#9E3A11', 'warm': '#BE4E1A', 'bright': '#D66C2E', 'dark': '#762A0D', 'pit': '#3E1608', 'flake': '#8C3410'},
    'on-dark': {'rim': '#843210', 'face': '#B04214', 'warm': '#CC5820', 'bright': '#E27838', 'dark': '#802E0E', 'pit': '#461A09', 'flake': '#AA4014'},
}
PAL = {
    'on-light': dict(ink=CORE['iron'], accent=CORE['rust'], **OXIDE['on-light']),
    'on-dark': dict(ink=CORE['cream'], accent=CORE['rust-on-dark'], **OXIDE['on-dark']),
}
CLASSMAP = {'fx-ink': 'ink', 'r-rim': 'rim', 'r-face': 'face', 'r-warm': 'warm', 'r-bright': 'bright',
            'r-dark': 'dark', 'r-pit': 'pit', 'r-flake': 'flake'}


def paint(markup, pal):
    """Swap the motion code's CSS classes for plain fill attributes (portable SVG)."""
    return re.sub(r'class="([\w-]+)"', lambda m: f'fill="{pal[CLASSMAP[m.group(1)]]}"', markup)


def svg(view_box, body, title, w=None, h=None):
    size = f' width="{w}" height="{h}"' if w else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view_box}"{size} role="img">'
            f'<title>{title}</title>{body}</svg>\n')


def f_mark(pid, rust, pal):
    tip = (rusty(f'{pid}-tip', TIP_UNITS, 0, 0, TIP_U, 5, 1.2, [3, 2, 2, 5, 14]) if rust
           else f'<path fill="{pal["accent"]}" d="{TIP_D}"/>')
    return f'<path class="fx-ink" d="{F_D}"/>' + tip


def pointer(pid, rust, pal):
    if rust:
        return rusty(f'{pid}-ptr', CUR, I_INK, P_TOP, PU, 11, 1.8, [10, 4, 6, 12, 30], [(10.6, 13.0)])
    return f'<path fill="{pal["accent"]}" d="{D(CUR, I_INK, P_TOP, PU)}"/>'


def wordmark(pid, rust, pal):
    letters = ''.join(f'<path class="fx-ink" d="{g["d"]}"/>' for g in GLYPHS)
    return paint(f_mark(pid, rust, pal) + letters + pointer(pid, rust, pal), pal)


WORD_VB = '-2 -39 1278 219'
MARK_VB = '-2 -2 119.64 180.07'


def icon(pid, rust, size=512, radius=112, f_height=0.6, bg=CORE['iron']):
    k = size * f_height / H
    tx, ty = (size - Fw * k) / 2, (size - H * k) / 2
    plate = f'<rect width="{size}" height="{size}" rx="{radius}" fill="{bg}"/>'
    mark = paint(f_mark(pid, rust, PAL['on-dark']), PAL['on-dark'])
    return plate + f'<g transform="translate({tx:.2f} {ty:.2f}) scale({k:.4f})">{mark}</g>'


def write(rel, text):
    path = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', newline='\n') as f:
        f.write(text)
    return rel


def build():
    out = []
    for ground, pal in PAL.items():
        for style in ('rust', 'flat'):
            out.append(write(f'logo/ferricade-wordmark-{style}-{ground}.svg',
                             svg(WORD_VB, wordmark(f'w{style[0]}{ground[3]}', style == 'rust', pal), 'Ferricade')))
            out.append(write(f'logo/ferricade-mark-{style}-{ground}.svg',
                             svg(MARK_VB, paint(f_mark(f'm{style[0]}{ground[3]}', style == 'rust', pal), pal), 'Ferricade')))
        big = rusty(f'p{ground[3]}', CUR, 0, 0, 30, 11, 1.0, [16, 6, 10, 22, 40], [(10.6, 13.0), (8.6, 20.4)])
        out.append(write(f'logo/ferricade-pointer-rust-{ground}.svg', svg('-6 -6 380 640', paint(big, pal), 'Ferricade pointer')))

    out.append(write('app-icons/icon.svg', svg('0 0 512 512', icon('ic', True), 'Ferricade')))
    out.append(write('app-icons/icon-flat.svg', svg('0 0 512 512', icon('if', False), 'Ferricade')))
    out.append(write('app-icons/favicon.svg', svg('0 0 512 512', icon('fv', False, radius=96, f_height=0.7), 'Ferricade')))
    out.append(write('app-icons/icon-maskable.svg', svg('0 0 512 512', icon('im', True, radius=0, f_height=0.42), 'Ferricade')))
    out.append(write('app-icons/apple-touch-icon.svg', svg('0 0 512 512', icon('ia', True, radius=0, f_height=0.58), 'Ferricade')))

    tokens = {
        'color': {
            'core': {k: {'value': v} for k, v in CORE.items()},
            'oxide': {g: {k: {'value': v} for k, v in p.items()} for g, p in OXIDE.items()},
            'logo': {
                'ink': {'on-light': CORE['iron'], 'on-dark': CORE['cream']},
                'accent': {'on-light': CORE['rust'], 'on-dark': CORE['rust-on-dark']},
                'ground': {'light': CORE['paper'], 'dark': CORE['night']},
            },
        },
        'font': {
            'display': {'value': 'Bahnschrift, Barlow, "DIN Alternate", system-ui, sans-serif',
                        'note': 'Brand display type. The wordmark itself is drawn outlines; never retype it.'},
            'ui': {'value': 'Inter Variable, ui-sans-serif, system-ui, sans-serif', 'note': 'App UI type, per DESIGN.md.'},
        },
        'motion': {
            'loader': {'duration': '3.6s', 'ringInterval': '1.2s', 'iteration': 'infinite'},
            'intro': {'duration': '4.85s', 'iteration': 1},
        },
    }
    out.append(write('tokens/tokens.json', json.dumps(tokens, indent=2) + '\n'))
    css = [':root {', '  /* Core */']
    css += [f'  --fc-{k}: {v};' for k, v in CORE.items()]
    for g, p in OXIDE.items():
        css.append(f'  /* Oxide texture, {g.replace("-", " ")} */')
        css += [f'  --fc-oxide-{k}{"" if g == "on-light" else "-on-dark"}: {v};' for k, v in p.items()]
    css += ['  /* Type */',
            '  --fc-font-display: Bahnschrift, "Barlow", "DIN Alternate", system-ui, sans-serif;',
            '  /* Logo colours that follow the colour scheme (needs color-scheme: light dark) */',
            '  --fc-logo-ink: light-dark(var(--fc-iron), var(--fc-cream));',
            '  --fc-logo-accent: light-dark(var(--fc-rust), var(--fc-rust-on-dark));',
            '  --fc-logo-ground: light-dark(var(--fc-paper), var(--fc-night));',
            '}', '']
    out.append(write('tokens/tokens.css', '\n'.join(css)))
    return out


if __name__ == '__main__':
    for f in build():
        print(f, os.path.getsize(os.path.join(ROOT, f)))
