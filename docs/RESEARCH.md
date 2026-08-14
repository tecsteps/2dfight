# How Prince of Persia moved, and what we took from it

Research notes behind this engine. The primary source is Jordan Mechner's own
Apple II source, which he released publicly — in particular `SEQTABLE.S` and
`FRAMEDEF.S`. Everything quoted below is from that source verbatim.

## The rotoscope

Mechner had already used rotoscoping on *Karateka* (1984), shooting reference
on Super 8. For *Prince of Persia* (1985–89) he switched to VHS and filmed his
younger brother David running, jumping, stumbling and hanging off things in
white clothes in a parking lot, then traced the frames. Sword-fighting
reference came from Errol Flynn pictures — *The Adventures of Robin Hood*
above all. The tracing was semi-automated: they built a process to reduce
filmed footage to something like a pen-and-ink drawing, which is what made a
frame count that large affordable on a 1985 Apple II.

The consequence that matters technically: the animation was **measured**, not
invented. Each traced frame came with a real-world displacement attached to
it. That fact is what the engine was then built around.

## Movement is a property of the drawing

This is the whole thing. From `SEQTABLE.S`:

```
runcyc1 db 7,chx,5
runcyc2 db 8,chx,1
runcyc3 db tap,1,9,chx,2
runcyc4 db 10,chx,4
runcyc5 db 11,chx,5
runcyc6 db 12,chx,2
runcyc7 db tap,1,13,chx,3
runcyc8 db 14,chx,4
        db goto
        dw runcyc1
```

Eight frames, twenty-six pixels, then jump back to the top. There is no
velocity variable, no acceleration, no friction. "Show frame 7 and move five
pixels" *is* the physics. The character is a program counter walking a byte
stream.

Everything inherits from that. The standing jump:

```
standjump
 db act,1
 db 16
 db 17,chx,2
 ...
 db 22,chx,7
 db 23,chx,9
 db 24,chx,5,chy,-6
sjland db 25,chx,1,chy,6
 db 26,chx,4
 db jard
 db tap,1,27,chx,-3
```

The arc — up six pixels, down six — is authored, not simulated. `chx,-3` on
the landing frame is the character's weight settling backwards as he absorbs
the impact. A physics engine would have to be *told* to do that. A rotoscope
just records it.

This is why the game feels heavy and committed. Once a sequence starts you are
watching a recording play out. You cannot steer mid-jump because there is
nothing to steer.

## The instruction set

The complete list, from the top of `SEQTABLE.S`:

```
goto = -1      aboutface = -2  up = -3        down = -4
chx = -5       chy = -6        act = -7       setfall = -8
ifwtless = -9  die = -10       jaru = -11     jard = -12
effect = -13   tap = -14       nextlevel = -15
```

Positive bytes are frame numbers; negatives are opcodes. Notable ones:

- **`chx` / `chy`** — move the character, in the facing direction for x.
- **`act`** — the action state (standing, running, hanging, in air, free
  fall…). The engine's collision logic branches on this, so a sequence
  declares what kind of thing it currently is.
- **`jard` / `jaru`** — "is there ground below / a ledge above". The only
  points at which the world is allowed to interrupt the animation.
- **`setfall`** — hand over to free fall with an initial velocity. Free fall
  is the *one* place the original integrates a velocity, because a fall has no
  fixed length and so cannot be baked into frames.
- **`aboutface`** — flips facing. Note where it appears in `turn`:

  ```
  turn
   db act,7
   db aboutface,chx,6
   db 45,chx,1
   db 46,chx,2
   ...
  ```

  The flip happens *first*; the eight frames that follow play in the new
  direction, resolving out of the pivot. Sprites were stored facing one way
  and mirrored, which halved the sprite budget.

- **`up` / `down`** — change room mid-animation. `climbup` does this:

  ```
  climbup
   db act,1
   db 135 136 137 138 139 140
   db chx,5
   db chy,-63
   db up
   db act,5 ;to clr flags
   db 141 142 ... 149
  ```

  It teleports the character a full tile upward and switches rooms halfway
  through the pull-up. The frames after that point were drawn against the
  *upper* floor. `chy,-63` is also how we know the tile height.

## Geometry

- A room is 10 × 3 tiles and does not scroll; walking off an edge hard-cuts to
  the neighbour. That is how a castle fits in memory on a machine with 48K.
- `chy,-63` in `climbup` fixes the tile height at 63 pixels.
- The Apple II original is 280 pixels wide with 28-pixel tiles; the DOS
  release is 320 wide with 32-pixel tiles. The `chx` values in `SEQTABLE.S`
  are Apple II pixels, so porting them to the DOS layout means scaling by 8/7.
  Do that to the run cycle and 26 becomes ~30 — almost exactly one tile per
  eight-frame cycle, which is how it reads on screen.

## Frames carry a separate sword

`FRAMEDEF` gives each frame an `image`, a `sword` image, `dx`, `dy` and flags.
The blade is a *separate bitmap* per frame rather than being drawn into the
body sprite — so one set of body frames serves an armed and an unarmed
character.

## What this engine does with it

| Original | Here |
|---|---|
| Rotoscoped VHS frames | Hand-authored joint-angle poses, keyframed and interpolated, baked to bitmaps at boot |
| `SEQTABLE.S` byte stream | `src/game/seq.js` — same opcode set, assembled to a flat `Int16Array` |
| `FRAMEDEF.S` | `src/game/frames.js` — numbered frames, each with a body and a sword bitmap |
| VGA mode 13h framebuffer | `Uint8Array` indexed framebuffer, one `putImageData` per frame |
| Masked sprite blits | Hand-written blitter with clipping and horizontal mirroring |
| Palette tricks for flashes and light | Same — a colour-index remap, no blending |

Frame counts and `chx`/`chy` values are taken from the real table wherever a
sequence exists in both, so the *timing and displacement* are the original's
even though the drawings are ours.

## Sources

- [Jordan Mechner — Prince of Persia](https://www.jordanmechner.com/en/games-movies/prince-of-persia/) (source code, journals and rotoscope footage in the Library)
- [`SEQTABLE.S`, Prince-of-Persia-Apple-II](https://github.com/jmechner/Prince-of-Persia-Apple-II) — the sequence table quoted above
- [NagyD/SDLPoP](https://github.com/NagyD/SDLPoP) — disassembly-based port of the DOS version; `seg006.c` holds the frame tables
- [Prince of Persia (1989 video game) — Wikipedia](https://en.wikipedia.org/wiki/Prince_of_Persia_(1989_video_game))
- [How The Original 'Prince Of Persia' Changed Video Game Animation — Forbes](https://www.forbes.com/sites/sethporges/2017/12/19/how-the-original-prince-of-persia-changed-video-game-animation/)
- [Prince of Persia Rotoscopy — Game Anim](https://www.gameanim.com/2014/01/07/prince-persia-rotoscopy/)
