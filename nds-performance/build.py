#!/usr/bin/env python3
"""Build NDS-Performance.html + NDS-Performance.amxd from little-scale's DS-10 wrapper.

Reuses the upstream EmulatorJS loader and DeSmuME core (embedded js/wasm) and replaces the
DS-10-specific RAM hooks with the game-agnostic bridge in src/.
"""
import argparse, base64, json, re, struct, sys
from pathlib import Path
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
UPSTREAM_REPO = 'https://github.com/little-scale/ds10-performance-wrapper-.git'
UPSTREAM_COMMIT = '66fc780'
UPSTREAM_DIR = HERE.parent / 'upstream' / 'ds10-performance-wrapper'
UPSTREAM = UPSTREAM_DIR / 'DS10-performance.html'
DIST = HERE / 'dist'
NAME = 'NDS-Performance'


CORE_PATCHES = [
    # RetroArch pauses when told the window is hidden; a Live device is often off screen.
    ('_platform_emscripten_update_window_hidden_cb(document.visibilityState=="hidden")',
     '_platform_emscripten_update_window_hidden_cb(false)'),
    # Expose main-loop timing so the bridge can run on a timer while hidden (animation frames stop).
    ('var _emscripten_set_main_loop_timing=(mode,value)=>{',
     'var _emscripten_set_main_loop_timing=Module["setMainLoopTiming"]=(mode,value)=>{'),
]


def patch_core(tag_line):
    open_tag = 'id="embedded-js">'
    prefix, rest = tag_line.split(open_tag, 1)
    data, suffix = rest.rsplit('</script>', 1)
    js = base64.b64decode(data).decode('utf-8')
    for old, new in CORE_PATCHES:
        assert js.count(old) == 1, 'core patch target not found: ' + old
        js = js.replace(old, new)
    return prefix + open_tag + base64.b64encode(js.encode('utf-8')).decode('ascii') + '</script>' + suffix


def fetch_upstream():
    if UPSTREAM.exists():
        return
    import subprocess
    subprocess.run(['git', 'clone', '-q', UPSTREAM_REPO, str(UPSTREAM_DIR)], check=True)
    subprocess.run(['git', '-C', str(UPSTREAM_DIR), 'checkout', '-q', UPSTREAM_COMMIT], check=True)


def build_html():
    fetch_upstream()
    lines = UPSTREAM.read_text(encoding='utf-8').split('\n')
    # Upstream layout: 13 = EmulatorJS CSS, 541 = loader, 542/543 = embedded core js/wasm, 552 = core metadata.
    ejs_css, loader, core_js, core_wasm = lines[12], lines[540], lines[541], lines[542]
    assert ejs_css.startswith('</style><style>.ejs_parent') and ejs_css.endswith('</head><body>')
    assert loader.startswith('class EJS_STORAGE')
    assert core_js.startswith('</script><script type="application/octet-stream" id="embedded-js">')
    assert core_wasm.startswith('<script type="application/octet-stream" id="embedded-wasm">')
    core_js = patch_core(core_js)
    meta = re.search(r'const metadata=(\{.*\}), build=(\{.*\});', lines[551])
    assert meta, 'core metadata not found'
    src = HERE / 'src'
    boot = (src / 'boot.js').read_text().replace('__METADATA__', meta.group(1)).replace('__BUILD__', meta.group(2))
    html = ''.join([
        (src / 'head.html').read_text(), ejs_css, '\n',
        (src / 'body.html').read_text(),
        '<script>\n', (src / 'bridge.js').read_text(), '\n</script><script>\n',
        loader, '\n', core_js, '\n', core_wasm, '\n',
        '<script>\n', boot, '\n</script></body></html>\n',
    ])
    (DIST / f'{NAME}.html').write_text(html, encoding='utf-8')


# ---------- Max for Live device ----------

boxes, lines, params = [], [], {}


def box(id, maxclass, rect, inlets, outlets, otypes=None, **attrs):
    b = {'id': id, 'maxclass': maxclass, 'numinlets': inlets, 'numoutlets': outlets,
         'patching_rect': [float(v) for v in rect]}
    if otypes is not None:
        b['outlettype'] = otypes
    b.update(attrs)
    boxes.append({'box': b})
    return id


def obj(id, text, rect, inlets, outlets, otypes):
    return box(id, 'newobj', rect, inlets, outlets, otypes, text=text, hidden=1)


def msg(id, text, rect):
    return box(id, 'message', rect, 2, 1, [''], text=text, hidden=1)


def wire(src, dst, outlet=0, inlet=0):
    lines.append({'patchline': {'destination': [dst, inlet], 'source': [src, outlet]}})


def present(rect):
    return {'presentation': 1, 'presentation_rect': [float(v) for v in rect]}


def param(id, longname, shortname, valueof, **attrs):
    params[id] = [longname, shortname, 0]
    v = {'parameter_longname': longname, 'parameter_shortname': shortname, 'parameter_modmode': 0}
    v.update(valueof)
    return dict(parameter_enable=1, varname=longname, saved_attribute_attributes={'valueof': v}, **attrs)


def text_button(id, label, longname, prect, rect, toggle=False, texton=None, invisible=0, annotation='', initial=None):
    valueof = {'parameter_enum': ['val1', 'val2'], 'parameter_mmax': 1, 'parameter_type': 2}
    if invisible:
        valueof['parameter_invisible'] = invisible
    if initial is not None:
        valueof.update(parameter_initial_enable=1, parameter_initial=[initial])
    return box(id, 'live.text', rect, 1, 2, ['', ''], mode=1 if toggle else 0, text=label,
               texton=texton or label, annotation=annotation,
               **param(id, longname, longname, valueof), **present(prect))


def dial(id, longname, shortname, lo, hi, initial, prect, rect, integer=True, exponent=None, unitstyle=None, annotation=''):
    valueof = {'parameter_mmin': float(lo), 'parameter_mmax': float(hi), 'parameter_type': 1 if integer else 0,
               'parameter_unitstyle': (0 if integer else 1) if unitstyle is None else unitstyle,
               'parameter_initial_enable': 1, 'parameter_initial': [initial]}
    if exponent:
        valueof['parameter_exponent'] = exponent
    return box(id, 'live.dial', rect, 1, 2, ['', 'float'], annotation=annotation,
               **param(id, longname, shortname, valueof), **present(prect))


def menu(id, longname, items, prect, rect, annotation=''):
    valueof = {'parameter_enum': items, 'parameter_mmax': len(items) - 1, 'parameter_type': 2,
               'parameter_initial_enable': 1, 'parameter_initial': [0]}
    return box(id, 'live.menu', rect, 1, 3, ['', '', 'float'], annotation=annotation,
               **param(id, longname, longname, valueof), **present(prect))


def comment(id, text, prect, size=9.0):
    return box(id, 'live.comment', prect, 1, 0, None, text=text, fontsize=size, textjustification=0, **present(prect))


def build_device(fallback_dir=None):
    W = 732
    midi_help = ('MIDI: C0–D#0 recall states 1–4 · C1–B1 A B X Y L R Start Select Up Down Left Right · '
                 'C2–B5 8×6 touch grid (C2 bottom left). Learn remaps any note to a touch point.')
    box('web', 'jweb~', [0, 0, 452, 169], 1, 3, ['signal', 'signal', ''], rendermode=1, latency=64.0,
        disablefind=0, annotation=midi_help, **present([0, 0, 452, 169]))
    box('gain', 'live.gain~', [620, 200, 36, 160], 2, 5, ['signal', 'signal', '', 'float', 'list'],
        showname=0, shownumber=0, lastchannelcount=0,
        **param('gain', 'Gain', 'Gain', {'parameter_mmin': -70.0, 'parameter_mmax': 6.0, 'parameter_type': 0,
                                          'parameter_unitstyle': 4, 'parameter_modmode': 3,
                                          'parameter_initial_enable': 1, 'parameter_initial': [0.0]}),
        **present([692, 3, 36, 162]))
    obj('out', 'plugout~', [620, 400, 70, 22], 2, 2, ['signal', 'signal'])
    wire('web', 'gain', 0, 0); wire('web', 'gain', 1, 1)
    wire('gain', 'out', 0, 0); wire('gain', 'out', 1, 1)

    obj('load', 'loadbang', [0, 200, 60, 22], 1, 1, ['bang'])
    obj('delay', 'delay 500', [0, 230, 65, 22], 2, 1, ['bang'])
    msg('file', f'readfile {NAME}.html', [0, 260, 200, 22])
    wire('load', 'delay'); wire('delay', 'file'); wire('file', 'web')
    if fallback_dir:
        # If the HTML next to the device is not on Max's search path, load it from the install folder.
        url = 'file://' + quote(str(Path(fallback_dir).expanduser().resolve() / f'{NAME}.html'))
        obj('fallback-delay', 'delay 5000', [0, 300, 70, 22], 2, 1, ['bang'])
        obj('fallback-gate', 'gate 1 1', [0, 330, 50, 22], 2, 1, [''])
        msg('fallback-url', f'url {url}', [0, 360, 400, 22])
        msg('fallback-close', '0', [120, 300, 30, 22])
        wire('load', 'fallback-delay'); wire('fallback-delay', 'fallback-gate', 0, 1)
        wire('fallback-gate', 'fallback-url'); wire('fallback-url', 'web')
        wire('fallback-close', 'fallback-gate', 0, 0)

    obj('notein', 'notein', [220, 200, 41, 22], 1, 3, ['int', 'int', 'int'])
    obj('pair', 'pack i i', [220, 230, 46, 22], 2, 1, [''])
    obj('note', 'prepend note', [220, 260, 80, 22], 1, 1, [''])
    wire('notein', 'pair', 0, 0); wire('notein', 'pair', 1, 1); wire('pair', 'note'); wire('note', 'web')

    # Page replies: print everything; when the bridge (re)connects, re-send the stored parameter values.
    obj('print', 'print NDS-Performance', [320, 230, 130, 22], 1, 0, [])
    obj('route', 'route bridge title', [320, 260, 110, 22], 3, 3, ['', '', ''])
    obj('resend', 't b', [320, 290, 30, 22], 1, 1, ['bang'])
    wire('web', 'print', 2); wire('web', 'route', 2); wire('route', 'resend')
    if fallback_dir:
        wire('route', 'fallback-close', 0); wire('route', 'fallback-close', 1)

    x0 = 456
    def command(id, src_outlet_obj, text, rect):
        obj(id, text, rect, 1, 1, [''])
        wire(src_outlet_obj, id)
        wire(id, 'web')

    def toggle_cmd(id, text, rect):
        # live.text toggles on bang, so keep its value in [i] for re-sending.
        obj(id + '-store', 'i', [rect[0], rect[1] - 25, 30, 22], 2, 1, ['int'])
        wire(id, id + '-store')
        command(id + '-cmd', id + '-store', text, rect)

    def button_cmd(id, label, longname, prect, message, rect, invisible=0, annotation=''):
        text_button(id, label, longname, prect, rect, invisible=invisible, annotation=annotation)
        obj(id + '-sel', 'sel 1', [rect[0], rect[1] + 25, 40, 22], 2, 2, ['bang', ''])
        msg(id + '-msg', message, [rect[0], rect[1] + 50, 70, 22])
        wire(id, id + '-sel'); wire(id + '-sel', id + '-msg'); wire(id + '-msg', 'web')

    button_cmd('rom', 'Load ROM', 'Load ROM', [x0, 3, 58, 16], 'loadrom', [500, 450, 58, 16], invisible=2,
               annotation='Choose a .nds file. The last ROM is remembered and boots with the device.')
    button_cmd('start', 'Start', 'Start', [x0 + 61, 3, 38, 16], 'start', [580, 450, 38, 16], invisible=2)
    text_button('pause', 'Pause', 'Pause', [x0 + 102, 3, 60, 16], [660, 450, 60, 16], toggle=True, texton='Paused',
                annotation='Freeze the emulator (audio stops).')
    toggle_cmd('pause', 'prepend freeze', [660, 500, 90, 22])

    text_button('learn', 'Learn', 'Learn', [x0, 22, 50, 16], [500, 550, 50, 16], toggle=True, invisible=2,
                annotation='Learn: play a MIDI note, then click the touch screen. Repeat; switch off when done.')
    command('learn-cmd', 'learn', 'prepend learn', [500, 575, 90, 22])
    text_button('glide', 'Glide', 'Glide', [x0 + 53, 22, 50, 16], [580, 550, 50, 16], toggle=True,
                annotation='Glide: overlapping touch notes drag the stylus instead of re-tapping.')
    toggle_cmd('glide', 'prepend glide', [580, 600, 90, 22])
    text_button('hold', 'Stylus', 'Stylus Hold', [x0 + 106, 22, 56, 16], [660, 550, 56, 16], toggle=True,
                texton='Touching', annotation='Hold the stylus down at Touch X/Y. Automate X/Y to draw.')
    toggle_cmd('hold', 'prepend stylushold', [660, 600, 110, 22])

    dial('tx', 'Touch X', 'Touch X', 0, 255, 128, [x0, 42, 40, 48], [500, 650, 41, 48],
         annotation='Stylus X on the lower screen (0–255).')
    dial('ty', 'Touch Y', 'Touch Y', 0, 191, 96, [x0 + 40, 42, 40, 48], [550, 650, 41, 48],
         annotation='Stylus Y on the lower screen (0–191).')
    obj('xy', 'pak 0 0', [500, 710, 50, 22], 2, 1, [''])
    wire('tx', 'xy', 0, 0); wire('ty', 'xy', 0, 1)
    command('xy-cmd', 'xy', 'prepend stylus', [500, 740, 90, 22])
    dial('speed', 'Speed', 'Speed', 0.25, 4.0, 1.0, [x0 + 80, 42, 40, 48], [600, 650, 41, 48], integer=False,
         exponent=2.32, annotation='Emulation speed: below 1 is slow motion, above 1 fast forward.')
    command('speed-cmd', 'speed', 'prepend speed', [600, 710, 90, 22])
    dial('glitch', 'Glitch', 'Glitch', 0, 256, 0, [x0 + 120, 42, 41, 48], [650, 650, 41, 48],
         annotation='Overwrite this many random DS RAM bytes per frame. Recall a saved state to recover.')
    command('glitch-cmd', 'glitch', 'prepend glitch', [650, 740, 90, 22])

    # Second column: Stutter (tempo-synced state loop), Chaos (self-playing), controller toggle.
    x1 = 626
    comment('stutter-label', 'stutter', [x1, 1, 60, 13])
    menu('stutter', 'Stutter', ['off', '1/1', '1/2', '1/4', '1/8', '1/16', '1/32', '1/4T', '1/8T', '1/16T'],
         [x1, 15, 60, 16], [800, 650, 60, 16],
         annotation='Loop the current moment at this length, synced to Live tempo. Switching it on captures a new moment.')
    command('stutter-cmd', 'stutter', 'prepend stutter', [800, 680, 100, 22])
    msg('bar-note', '1n', [900, 650, 30, 22])
    obj('bar-ms', 'translate notevalues ms', [900, 680, 140, 22], 2, 1, [''])
    command('bar-cmd', 'bar-ms', 'prepend bar', [900, 710, 80, 22])
    wire('load', 'bar-note'); wire('bar-note', 'bar-ms')
    dial('chaos', 'Chaos', 'Chaos', 0, 100, 0, [x1, 42, 41, 48], [800, 750, 41, 48], unitstyle=5,
         annotation='The game plays itself: random button presses and stylus taps. 0 = off.')
    command('chaos-cmd', 'chaos', 'prepend chaos', [800, 810, 90, 22])
    text_button('pad', 'Pad', 'Controller', [x1, 96, 60, 16], [900, 750, 60, 16], toggle=True, initial=1,
                annotation='PS5 / game controller: Circle A, Cross B, Triangle X, Square Y, R-stick + R2 stylus, '
                           'L2 slow motion, L3 save 1, touchpad recall 1.')
    toggle_cmd('pad', 'prepend pad', [900, 800, 90, 22])
    comment('pad-help', 'R-stick+R2 stylus · L2 slow · L3 save · pad recall', [x1, 115, 64, 50], size=8.0)

    for id in ('pause-store', 'glide-store', 'hold-store', 'pad-store', 'tx', 'ty', 'speed', 'glitch', 'chaos', 'stutter', 'bar-note'):
        wire('resend', id)

    comment('save-label', 'save', [x0, 97, 36, 14])
    comment('recall-label', 'recall', [x0, 117, 36, 14])
    for i in range(1, 5):
        bx = x0 + 37 + (i - 1) * 31
        button_cmd(f'save{i}', str(i), f'Save State {i}', [bx, 96, 28, 16], f'save {i}', [800 + i * 80, 450, 28, 16],
                   annotation=f'Save the current moment to slot {i}.')
        button_cmd(f'recall{i}', str(i), f'Recall State {i}', [bx, 116, 28, 16], f'load {i}', [800 + i * 80, 550, 28, 16],
                   annotation=f'Jump back to slot {i} (also MIDI note C0+{i - 1}).')
    comment('help', 'C0 recall · C1 buttons · C2 touch grid', [x0, 138, 164, 28], size=8.5)

    patcher = {
        'fileversion': 1,
        'appversion': {'major': 9, 'minor': 0, 'revision': 9, 'architecture': 'x64', 'modernui': 1},
        'classnamespace': 'box',
        'rect': [100.0, 100.0, 1200.0, 800.0],
        'openrect': [0.0, 0.0, 0.0, 169.0],
        'openinpresentation': 1,
        'devicewidth': float(W),
        'gridsize': [15.0, 15.0],
        'description': 'Any Nintendo DS ROM inside Live: audio out, MIDI to buttons/touch, save-state recall, speed, RAM glitch.',
        'boxes': boxes,
        'lines': lines,
        'parameters': {**params, 'inherited_shortname': 1},
        'dependency_cache': [],
        'latency': 0, 'is_mpe': 0, 'external_mpe_tuning_enabled': 0,
        'minimum_live_version': '', 'minimum_max_version': '', 'platform_compatibility': 0,
        'project': {'version': 1, 'creationdate': 3874340520, 'modificationdate': 3874340520,
                    'viewrect': [0.0, 0.0, 300.0, 500.0], 'autoorganize': 1, 'hideprojectwindow': 1,
                    'showdependencies': 1, 'autolocalize': 0, 'contents': {'patchers': {}}, 'layout': {},
                    'searchpath': {}, 'detailsvisible': 0, 'amxdtype': 1768515945, 'readonly': 0,
                    'devpathtype': 0, 'devpath': '.', 'sortmode': 0, 'viewmode': 0, 'includepackages': 0},
        'autosave': 0,
    }
    data = (json.dumps({'patcher': patcher}, indent='\t', separators=(',', ' : '), ensure_ascii=False) + '\n').encode() + b'\0'
    header = b'ampf' + struct.pack('<I', 4) + b'iiii' + b'meta' + struct.pack('<II', 4, 0) + b'ptch' + struct.pack('<I', len(data))
    (DIST / f'{NAME}.amxd').write_bytes(header + data)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--fallback-dir', help='install folder baked in as an absolute fallback for loading the HTML')
    args = ap.parse_args()
    DIST.mkdir(exist_ok=True)
    build_html()
    build_device(args.fallback_dir)
    print('built', *(p.name for p in sorted(DIST.iterdir())), file=sys.stderr)
