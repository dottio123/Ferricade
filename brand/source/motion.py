"""Builds the Ferricade loader + intro SVGs and the motion preview page (../motion/).

Run: python3 brand/source/motion.py

Geometry matches the Affinity "Final" sheet: Bahnschrift Bold outlines at 248 pt,
corner F with gusset, rusty tip, pointer at u=3.6 hovering over the dotless i.
"""
import json, math, os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "motion")

# ---------------- geometry ----------------
H, XH, Fw = 176.07, 125.7, 115.64
st, t, Wm = 34.39, 31.0, 100.0
m0, m1 = H / 2 - t / 2, H / 2 + t / 2
ch, gp, gs = 44.0, 4.5, 10.0
leg = ch - gp * math.sqrt(2)
F_BODY = [(0, ch), (ch, 0), (Fw, 0), (Fw, t), (st + gs, t), (st, t + gs), (st, m0), (Wm, m0),
          (Wm, m1), (st, m1), (st, H), (0, H)]
TIP_U = leg / 7.5
TIP_UNITS = [(0, 0), (7.5, 0), (0, 7.5)]
TIP_TRI = [(0, 0), (leg, 0), (0, leg)]
CUR = [(0, 0), (0, 17), (4, 13), (7, 20), (9, 19), (6, 12), (12, 12)]
I_INK, PU = 612.15, 3.6
P_TOP = H - XH - 15 - 20 * PU          # pointer top, above the cap line
GLYPHS = json.load(open(os.path.join(HERE, 'glyphs.json')))
WORD_W = 1273.97


def s_ax(p):
    return (p[0] + 2 * p[1]) / math.sqrt(5)


def clip(pts, f):
    out = []
    for i, a in enumerate(pts):
        c = pts[(i + 1) % len(pts)]
        fa, fc = f(a), f(c)
        if fa >= 0:
            out.append(a)
        if (fa >= 0) != (fc >= 0):
            tt = fa / (fa - fc)
            out.append((a[0] + (c[0] - a[0]) * tt, a[1] + (c[1] - a[1]) * tt))
    return out


PTR_TIP = clip(CUR, lambda p: 6.0 - s_ax(p))
PTR_BODY = clip(CUR, lambda p: s_ax(p) - 7.1)


def area(P):
    return sum(P[i][0] * P[(i + 1) % len(P)][1] - P[(i + 1) % len(P)][0] * P[i][1] for i in range(len(P)))


def inside(p, P):
    c = False
    j = len(P) - 1
    for i in range(len(P)):
        xi, yi = P[i]
        xj, yj = P[j]
        if (yi > p[1]) != (yj > p[1]) and p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi:
            c = not c
        j = i
    return c


def inset(P, d):
    S = 1 if area(P) > 0 else -1
    lines = []
    for i, a in enumerate(P):
        c = P[(i + 1) % len(P)]
        dx, dy = c[0] - a[0], c[1] - a[1]
        L = math.hypot(dx, dy)
        lines.append(((a[0] + S * -dy / L * d, a[1] + S * dx / L * d), (dx, dy)))
    out = []
    for i in range(len(lines)):
        (p1, d1), (p2, d2) = lines[i - 1], lines[i]
        den = d1[0] * d2[1] - d1[1] * d2[0]
        tt = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den
        out.append((p1[0] + d1[0] * tt, p1[1] + d1[1] * tt))
    return out


def mulberry(seed):
    st_ = [seed & 0xFFFFFFFF]
    imul = lambda a, b: (a * b) & 0xFFFFFFFF

    def r():
        st_[0] = (st_[0] + 0x6D2B79F5) & 0xFFFFFFFF
        x = st_[0]
        x = imul(x ^ (x >> 15), 1 | x)
        x = ((x + imul(x ^ (x >> 7), 61 | x)) & 0xFFFFFFFF) ^ x
        return ((x ^ (x >> 14)) & 0xFFFFFFFF) / 4294967296
    return r


def eroded(P, rnd, rough, step=0.25):
    S = 1 if area(P) > 0 else -1
    out = []
    for i, a in enumerate(P):
        c = P[(i + 1) % len(P)]
        dx, dy = c[0] - a[0], c[1] - a[1]
        L = math.hypot(dx, dy)
        nx, ny = S * -dy / L, S * dx / L
        n = max(2, round(L / step))
        for k in range(n):
            tt = k / n
            d = 0.0
            if k > 0:
                d = (0.22 + rnd() * 0.22 if rnd() < 0.07 else rnd() * 0.1) * rough
                if tt < 0.05 or tt > 0.95:
                    d *= 0.3
            out.append((a[0] + dx * tt + nx * d, a[1] + dy * tt + ny * d))
    return out


def blob(rnd, cx, cy, r, jit=0.35, n=10):
    return [(cx + math.cos(i / n * 2 * math.pi) * r * (1 - jit / 2 + rnd() * jit),
             cy + math.sin(i / n * 2 * math.pi) * r * (1 - jit / 2 + rnd() * jit)) for i in range(n)]


def rust_spec(P, seed, rough, counts, flakes=()):
    rnd = mulberry(seed)
    xs, ys = [p[0] for p in P], [p[1] for p in P]

    def pt():
        while True:
            p = (min(xs) + rnd() * (max(xs) - min(xs)), min(ys) + rnd() * (max(ys) - min(ys)))
            if inside(p, P):
                return p
    base = eroded(P, rnd, rough)
    kids = [(eroded(inset(P, 0.6), rnd, rough * 1.6, 0.3), 'r-face')]
    for _ in range(counts[0]):
        kids.append((blob(rnd, *pt(), 0.3 + rnd() * 0.55, 0.5), 'r-warm'))
    for _ in range(counts[1]):
        kids.append((blob(rnd, *pt(), 0.2 + rnd() * 0.35, 0.5), 'r-bright'))
    for _ in range(counts[2]):
        kids.append((blob(rnd, *pt(), 0.25 + rnd() * 0.45, 0.5), 'r-dark'))
    for _ in range(counts[3]):
        kids.append((blob(rnd, *pt(), (0.07 + rnd() * 0.14) * max(1, rough * 0.8), 0.4, 7), 'r-pit'))
    for i in range(counts[4]):   # fine speckle in place of Affinity's colour noise
        kids.append((blob(rnd, *pt(), (0.05 + rnd() * 0.06) * max(1, rough * 0.7), 0.3, 6), 'r-bright' if i % 2 else 'r-pit'))
    fl = [blob(rnd, ex, ey, 0.22 * max(1, rough * 0.7), 0.6, 6) for ex, ey in flakes]
    return base, kids, fl


def D(pts, x=0.0, y=0.0, u=1.0):
    return 'M' + 'L'.join(f'{x + a * u:.2f} {y + b * u:.2f}' for a, b in pts) + 'Z'


def rusty(pid, P, x, y, u, seed, rough, counts, flakes=()):
    base, kids, fl = rust_spec(P, seed, rough, counts, flakes)
    bd = D(base, x, y, u)
    s = [f'<clipPath id="{pid}"><path d="{bd}"/></clipPath>', f'<path class="r-rim" d="{bd}"/>',
         f'<g clip-path="url(#{pid})">']
    s += [f'<path class="{cls}" d="{D(k, x, y, u)}"/>' for k, cls in kids]
    s.append('</g>')
    s += [f'<path class="r-flake" d="{D(f, x, y, u)}"/>' for f in fl]
    return ''.join(s)


F_D = D(F_BODY)
TIP_D = D(TIP_TRI)


def tip_svg(px):
    return rusty(f'{px}-tipc', TIP_UNITS, 0, 0, TIP_U, 5, 1.2, [3, 2, 2, 5, 14])


def pointer_svg(px, style):
    if style == 'a':
        return (rusty(f'{px}-ptc', PTR_TIP, I_INK, P_TOP, PU, 11, 1.8, [4, 2, 2, 6, 10]) +
                f'<path class="fx-ink" d="{D(PTR_BODY, I_INK, P_TOP, PU)}"/>' +
                f'<path class="fi-flash" d="{D(PTR_TIP, I_INK, P_TOP, PU)}"/>')
    return (rusty(f'{px}-pfc', CUR, I_INK, P_TOP, PU, 11, 1.8, [10, 4, 6, 12, 30], [(10.6, 13.0)]) +
            f'<path class="fi-flash" d="{D(CUR, I_INK, P_TOP, PU)}"/>')


def rings(px, kind, region):
    x, y, w, h = region
    defs, rects = [], []
    for i in (1, 2, 3):
        defs.append(f'<mask id="{px}-m{i}" maskUnits="userSpaceOnUse" x="{x}" y="{y}" width="{w}" height="{h}">'
                    f'<path class="{kind}-w d{i}" d="{F_D}"/><path class="{kind}-b d{i}" d="{F_D}"/>'
                    f'<path d="{F_D}" fill="#000"/></mask>')
        rects.append(f'<rect class="fx-ring {kind}-ring d{i}" mask="url(#{px}-m{i})" x="{x}" y="{y}" width="{w}" height="{h}"/>')
    return '<defs>' + ''.join(defs) + '</defs>' + ''.join(rects)


# ---------------- CSS ----------------
LD, LW = 72, 3.0            # loader ring reach / line width (F units)
IDR, IW = 80, 2.0           # intro ring reach / line width
S0 = 1.9
VB_I = (-110, -230, 1494, 636)
CX, CY = VB_I[0] + VB_I[2] / 2, VB_I[1] + VB_I[3] / 2
TX, TY = CX - Fw / 2 * S0, CY - H / 2 * S0

DARK = dict(ink='#ECE6DC', ring='#ECE6DC', rim='#843210', face='#B04214', warm='#CC5820', bright='#E27838',
            dark='#802E0E', pit='#461A09', flake='#AA4014', glow='#F5AE78')
LIGHT = dict(ink='#2B2E33', ring='#2B2E33', rim='#56200B', face='#9E3A11', warm='#BE4E1A', bright='#D66C2E',
             dark='#762A0D', pit='#3E1608', flake='#8C3410', glow='#F08A4A')
vars_ = lambda p: ';'.join(f'--fx-{k}:{v}' for k, v in p.items())

CSS = f"""
.fx{{{vars_(DARK)}}}
@media (prefers-color-scheme:light){{.fx:not(.night){{{vars_(LIGHT)}}}}}
.fx.paper{{{vars_(LIGHT)}}}
.fx .fx-ink{{fill:var(--fx-ink)}}
.fx .fx-ring{{fill:var(--fx-ring);opacity:0}}
.fx .r-rim{{fill:var(--fx-rim)}}.fx .r-face{{fill:var(--fx-face)}}.fx .r-warm{{fill:var(--fx-warm)}}
.fx .r-bright{{fill:var(--fx-bright)}}.fx .r-dark{{fill:var(--fx-dark)}}.fx .r-pit{{fill:var(--fx-pit)}}.fx .r-flake{{fill:var(--fx-flake)}}
.fx .fl-glow,.fx .fi-glow{{fill:var(--fx-glow);opacity:0}}
.fx [class*="-w "],.fx [class*="-b "]{{fill:none;stroke-linejoin:round}}
.fx .fl-w,.fx .fi-w{{stroke:#fff}}
.fx .fl-b,.fx .fi-b{{stroke:#000}}
/* loader: 3.6 s loop, a ring lands every 1.2 s */
.fx .fl-w{{animation:fl-w 3.6s cubic-bezier(.45,0,.9,.55) infinite}}
.fx .fl-b{{animation:fl-b 3.6s cubic-bezier(.45,0,.9,.55) infinite}}
.fx .fl-ring{{animation:fl-op 3.6s linear infinite}}
.fx .fl-glow{{animation:fl-glow 1.2s ease-out infinite}}
.fx .fl-w.d2,.fx .fl-b.d2,.fx .fl-ring.d2{{animation-delay:-1.2s}}
.fx .fl-w.d3,.fx .fl-b.d3,.fx .fl-ring.d3{{animation-delay:-2.4s}}
@keyframes fl-w{{from{{stroke-width:{2 * LD + LW}px}}to{{stroke-width:{LW}px}}}}
@keyframes fl-b{{from{{stroke-width:{2 * LD - LW}px}}to{{stroke-width:0}}}}
@keyframes fl-op{{0%{{opacity:0}}30%{{opacity:.22}}86%{{opacity:.62}}100%{{opacity:0}}}}
@keyframes fl-glow{{0%{{opacity:.42}}55%{{opacity:0}}100%{{opacity:0}}}}
/* intro: plays once, ~4.1 s */
.fx .fi-w,.fx .fi-b,.fx .fi-ring{{animation-duration:1.3s;animation-timing-function:cubic-bezier(.45,0,.9,.55);animation-fill-mode:both}}
.fx .fi-w{{animation-name:fi-w}}.fx .fi-b{{animation-name:fi-b}}.fx .fi-ring{{animation-name:fi-op;animation-timing-function:linear}}
.fx .fi-w.d2,.fx .fi-b.d2,.fx .fi-ring.d2{{animation-delay:.25s}}
.fx .fi-w.d3,.fx .fi-b.d3,.fx .fi-ring.d3{{animation-delay:.5s}}
@keyframes fi-w{{from{{stroke-width:{2 * IDR + IW}px}}to{{stroke-width:{IW}px}}}}
@keyframes fi-b{{from{{stroke-width:{2 * IDR - IW}px}}to{{stroke-width:0}}}}
@keyframes fi-op{{0%{{opacity:0}}30%{{opacity:.25}}86%{{opacity:.65}}100%{{opacity:0}}}}
.fx .fi-body{{animation:fx-in .9s ease .55s both}}
.fx .fi-tip{{animation:fi-tip .55s cubic-bezier(.34,1.56,.64,1) 1.35s both}}
.fx .fi-glow{{animation:fi-glow .9s ease-out 1.75s both}}
.fx .fi-f{{animation:fi-move .95s cubic-bezier(.65,0,.35,1) 2s both}}
.fx .fi-l{{animation:fi-pull .8s cubic-bezier(.22,1,.36,1) both}}
{''.join(f'.fx .fi-l.l{i}{{animation-delay:{2.62 + i * 0.06:.2f}s}}' for i in range(8))}
.fx .fi-p{{transform-origin:{I_INK}px {P_TOP:.2f}px;animation:fi-ptr .7s cubic-bezier(.22,1,.36,1) 3.3s both,fi-click .52s 4.05s}}
.fx .fi-flash{{fill:var(--fx-glow);opacity:0;animation:fi-flash .55s ease-out 4.1s both}}
.fx .fi-rip{{fill:none;stroke:var(--fx-glow);stroke-width:2.5;vector-effect:non-scaling-stroke;transform-box:fill-box;transform-origin:center;opacity:0;animation:fi-rip .8s cubic-bezier(.2,.7,.3,1) 4.12s both}}
.fx .fi-rip.r2{{stroke:var(--fx-ink);animation-delay:4.26s}}
.fx .fi-l.l3{{animation:fi-pull .8s cubic-bezier(.22,1,.36,1) 2.80s both,fi-dip .36s 4.08s}}
@keyframes fx-in{{from{{opacity:0}}to{{opacity:1}}}}
@keyframes fi-tip{{from{{transform:translate(-26px,-26px);opacity:0}}to{{transform:none;opacity:1}}}}
@keyframes fi-glow{{0%{{opacity:0}}15%{{opacity:.5}}100%{{opacity:0}}}}
@keyframes fi-move{{from{{transform:translate({TX:.2f}px,{TY:.2f}px) scale({S0})}}to{{transform:none}}}}
@keyframes fi-pull{{from{{transform:translateX(70px);opacity:0}}to{{transform:none;opacity:1}}}}
@keyframes fi-ptr{{from{{transform:translate(46px,-46px);opacity:0}}to{{transform:none;opacity:1}}}}
@keyframes fi-click{{0%{{transform:none;animation-timing-function:cubic-bezier(.4,0,1,1)}}24%{{transform:translateY(5px) scale(.82);animation-timing-function:cubic-bezier(.2,1.7,.4,1)}}100%{{transform:none}}}}
@keyframes fi-flash{{0%{{opacity:0}}18%{{opacity:.6}}100%{{opacity:0}}}}
@keyframes fi-rip{{0%{{transform:scale(.3);opacity:0}}8%{{opacity:.95}}100%{{transform:scale(3.6);opacity:0}}}}
@keyframes fi-dip{{0%{{transform:none;animation-timing-function:cubic-bezier(.4,0,1,1)}}35%{{transform:translateY(5px);animation-timing-function:cubic-bezier(.2,1.5,.4,1)}}100%{{transform:none}}}}
@media (prefers-reduced-motion:reduce){{
.fx .fx-ring{{display:none}}
.fx .fl-glow{{animation-duration:3.6s}}
.fx .fi-f,.fx .fi-body,.fx .fi-tip,.fx .fi-l,.fx .fi-l.l3,.fx .fi-p{{animation:fx-in .6s ease both}}
.fx .fi-glow,.fx .fi-rip,.fx .fi-flash{{display:none}}
}}
""".strip()


def loader_svg(px, cls='', standalone=False):
    vb = (Fw / 2 - 170, H / 2 - 170, 340, 340)
    body = (rings(px, 'fl', (-130, -110, 380, 400)) + f'<path class="fx-ink" d="{F_D}"/>' + tip_svg(px) +
            f'<path class="fl-glow" d="{TIP_D}"/>')
    c = ('fx ' + cls).strip()
    head = f'<svg xmlns="http://www.w3.org/2000/svg" class="{c}" viewBox="{vb[0]:.2f} {vb[1]:.2f} {vb[2]} {vb[3]}" role="img" aria-label="Loading">'
    style = f'<style>{CSS}</style>' if standalone else ''
    return head + style + body + '</svg>'


def intro_svg(px, pointer='a', cls='', standalone=False):
    letters = ''.join(f'<path class="fx-ink fi-l l{i}" d="{g["d"]}"/>' for i, g in enumerate(GLYPHS))
    body = (f'<g class="fi-f">' + rings(px, 'fi', (-130, -130, 380, 440)) +
            f'<path class="fx-ink fi-body" d="{F_D}"/><g class="fi-tip">{tip_svg(px)}</g>'
            f'<path class="fi-glow" d="{TIP_D}"/></g>' + letters +
            f'<circle class="fi-rip r1" cx="{I_INK + 1:.2f}" cy="{P_TOP + 5:.2f}" r="10"/>'
            f'<circle class="fi-rip r2" cx="{I_INK + 1:.2f}" cy="{P_TOP + 5:.2f}" r="10"/>' +
            f'<g class="fi-p">{pointer_svg(px, pointer)}</g>')
    c = ('fx ' + cls).strip()
    head = f'<svg xmlns="http://www.w3.org/2000/svg" class="{c}" viewBox="{" ".join(str(v) for v in VB_I)}" role="img" aria-label="Ferricade">'
    style = f'<style>{CSS}</style>' if standalone else ''
    return head + style + body + '</svg>'


if __name__ == '__main__':
    files = {
        'ferricade-loader.svg': loader_svg('fl', standalone=True),
        'ferricade-intro.svg': intro_svg('fib', 'b', standalone=True),
        'ferricade-intro-pointer-a.svg': intro_svg('fia', 'a', standalone=True),
    }
    for name, svg in files.items():
        open(os.path.join(OUT, name), 'w').write(svg)

    page = open(os.path.join(HERE, 'page.html')).read()
    page = (page.replace('/*FX_CSS*/', CSS)
            .replace('<!--LOADER_NIGHT-->', loader_svg('ln', 'night'))
            .replace('<!--LOADER_PAPER-->', loader_svg('lp', 'paper'))
            .replace('/*INTRO_DATA*/', 'const INTRO=' + json.dumps({'a': intro_svg('ia', 'a'), 'b': intro_svg('ib', 'b')}) + ';'
                     + 'const FILES=' + json.dumps({'loader': files['ferricade-loader.svg'], 'a': files['ferricade-intro-pointer-a.svg'], 'b': files['ferricade-intro.svg']}) + ';'))
    open(os.path.join(OUT, 'preview.html'), 'w').write(page)
    print({k: len(v) for k, v in files.items()}, 'page', len(page))
