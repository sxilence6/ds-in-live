# ds-in-live

**NDS Performance**: any Nintendo DS ROM inside Ableton Live as a Max for Live instrument. The game's audio comes out of the track, so you can play it with MIDI or a PS5 controller, warp time, glitch its memory, and resample it like any other instrument.

DS emulation is EmulatorJS + DeSmuME (WebAssembly) running in a `jweb~`. Built on little-scale's [ds10-performance-wrapper-](https://github.com/little-scale/ds10-performance-wrapper-), which does deep native control of the Korg DS-10. Check out his [electroplankton-performance-wrapper](https://github.com/little-scale/electroplankton-performance-wrapper) too.

No ROMs are included. Use dumps of games you own.

## Install

Needs Live 12 with Max 9 (`jweb~` with audio).

- **Quick**: download `nds-performance/dist/NDS-Performance.amxd` and `NDS-Performance.html`, keep them in the same folder, and drop the `.amxd` on a MIDI track.
- **From source** (macOS): `./nds-performance/install.sh` builds the device and copies it to `User Library/Presets/Instruments/Max Instrument/NDS Performance`. It also bakes in that folder's absolute path as a fallback, in case Max can't find the HTML next to the device.

Click **Load ROM** and pick a `.nds` file. The device remembers the last ROM and boots it again the next time it loads.

## Play it

### MIDI (Live note names, C3 = 60)

| Notes | Action |
|---|---|
| C0–D#0 | recall save state 1–4 (hit it fast for a stutter) |
| C1–B1 | A B X Y L R Start Select Up Down Left Right, held while the note is held |
| C2–B5 | 8×6 tap grid on the touch screen. C2 is bottom left, the next note is one cell to the right, and each row up is +8 semitones |
| any | remap to any touch point with **Learn** |

### PS5 / game controller

| Controller | DS |
|---|---|
| Circle, Cross, Triangle, Square | A, B, X, Y (the Nintendo layout by position) |
| L1, R1 | L, R |
| Options, Create | Start, Select |
| D-pad, left stick | D-pad |
| right stick + R2 | move the stylus cursor, then touch (R3 recentres it) |
| L2 | slow motion by pressure, on top of the Speed dial |
| L3, touchpad click | save state 1, recall state 1 |

Uses the browser Gamepad API. Connect the controller (USB or Bluetooth) and press any button once so the page sees it. The **Pad** toggle switches it off.

### Device controls

| Control | What it does |
|---|---|
| **Load ROM**, **Start** | pick a ROM; Start boots it if it doesn't start on its own |
| **Pause** | freezes the emulator, and the audio with it |
| **Learn** | switch it on, play a note, click a spot on the touch screen, and repeat. Mappings are saved per game. |
| **Glide** | overlapping touch notes drag the stylus instead of re-tapping, like a mono synth |
| **Stylus**, **Touch X/Y** | hold the stylus down at X/Y. Automate it, LFO it, or map an XY pad to draw. |
| **Speed** | 0.25×–4× slow motion or fast forward |
| **Glitch** | overwrites N random bytes of DS RAM every frame. Games melt or crash, so recall a state to recover. |
| **Stutter** | loops the current moment at a tempo-synced length (1/1 to 1/32, plus triplets). Changing the length keeps the same moment; switching it off and on captures a new one. |
| **Chaos** | the game plays itself: random presses and stylus taps, up to 100% |
| **save / recall 1–4** | save states per game, kept between sessions |

### Resampling

- Arm an audio track whose input is the NDS track, or use Live's **Resampling** input.
- Save a state on a good moment, then hammer C0 from a clip, or turn on Stutter, for a game-state beat repeat.
- Slow motion plus Glitch 2–8 plus a reverb after the device is a good place to start.

## Max messages

For your own patches, these go into the `jweb~`:

`loadrom` `start` `pause` `resume` `freeze 0/1` `button <name> 0/1` `pulse <name> [frames]` `touch x y 0/1` `stylus x y` `stylushold 0/1` `note pitch vel` `allnotesoff` `glide 0/1` `learn 0/1` `maptouch note x y` `mapbutton note name` `mapstate note slot` `unmap note` `mapreset` `mapdump` `save n` `load n` (1–8) `speed r` `stutter index` `bar ms` `chaos 0–100` `pad 0/1` `frameskip 0–5` `layout horizontal|vertical` `glitch n` `glitchrange from to` `ram` `peek addr [len]` `poke addr bytes…` `inspect` `forget` `stats`

Button names: `a b x y l r start select up down left right l2 r2 l3 r3`. Addresses are DS addresses (`0x02000000`–`0x023FFFFF`); mirrors are folded. Replies print to the Max Console as `NDS-Performance: …`.

## How it's built

`nds-performance/build.py` clones little-scale's wrapper (pinned commit) into `upstream/`, and takes the EmulatorJS loader and DeSmuME core from its HTML. It patches two lines of the core and adds the bridge in `nds-performance/src/`. The output is `dist/NDS-Performance.html` and a generated `NDS-Performance.amxd`.

Core patches, which keep the game running when the device is off screen:

- RetroArch was told "window hidden" whenever the page was hidden, and paused. It's now never told.
- Main-loop timing is exposed, so the bridge switches from animation frames to a 60 Hz timer while hidden and back when visible.

A watchdog restarts the loop if frames ever stop while not paused.

## Other DS music software

- **KORG DS-10 Plus**: runs in DS mode (6 tracks). The doubled tracks need a DSi, which DeSmuME doesn't emulate.
- **KORG M01** (DS, Japan), Electroplankton, Jam Sessions, and homebrew such as little-scale's ambient-granulator-for-NDS: playable through buttons, stylus and Learn.
- **Deep control** like the DS-10 device (notes straight into the synth engine) needs per-ROM reverse engineering. `ram`, `peek` and `poke` are the starting tools.
- **KORG DSN-12** is a Nintendo 3DS app, so it doesn't run here. The workable route is native Azahar → BlackHole into Live, plus a MIDI-to-keyboard bridge.

## License

GPL-3.0, matching EmulatorJS (GPL-3.0) and DeSmuME (GPL-2.0-or-later), whose builds are embedded in the HTML. The wrapper approach and the boot code come from little-scale's DS-10 performance wrapper.
