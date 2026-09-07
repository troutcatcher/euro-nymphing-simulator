# Euro Nymphing Simulator

A browser simulator for tight-line (Euro) nymphing. No install, no build step, no
dependencies — open `index.html` and fish.

![The riffle beat mid-drift](docs/screenshot.png)

It is not a fishing arcade game. The point is the thing that is genuinely hard to
learn on the water and impossible to see once your flies are under the surface:
**where your nymphs actually are, and how much slack is between them and your
hand.** The simulator draws the whole system in cross-section so you can watch
the leader bag out, watch the point fly ride up out of the zone, and watch a fish
eat and spit while your sighter never twitches.

## Running it

**On a computer:** open `index.html`. That is the whole thing — it works straight
off the filesystem.

Hit ⤢ (or <kbd>F</kbd>) for full screen: the side panel gets out of the way, the
river takes the whole window, and the instruments you actually fish by — contact,
depth off the bed, drag, and tippet load while a fish is on — move to a compact
strip along the top edge. On a phone it asks for native full screen and a
landscape lock where the browser allows it, and falls back to filling the frame
where it does not. Held sideways is the view this wants; held upright it pulls
the camera in closer and says so.

**On a phone or tablet:** use `dist/euro-nymphing-simulator.html` instead. It is
the same simulator with the stylesheet and all six scripts inlined into one file.
Android and iOS open downloaded files through a `content://` (or equivalent)
provider that cannot resolve relative paths to sibling files, so the multi-file
version loads as bare unstyled HTML with no canvas. The bundle has no external
references at all and works anywhere.

## The 3D build

`3d.html` is the same simulator — same leader physics, same fish, same sighter
detection, same sound — drawn with WebGL instead of a flat cross-section: a lit
river bed under a moving water surface, the leader and sighter as real
three-dimensional line, the fish as skinned bodies that swim, run and jump, and
the angler on the shingle netting them. It uses [three.js](https://threejs.org/)
(r158, vendored in `vendor/` under its MIT licence), so it still needs no build
step and no network: open `3d.html` from disk, or use the single-file
`dist/euro-nymphing-3d.html` on a phone.

It is also a Progressive Web App. Served over HTTPS (GitHub Pages, or any static
host) it can be installed to a phone's home screen from the browser menu —
**Add to Home Screen** in Chrome on Android, **Share → Add to Home Screen** in
Safari on iOS — and then launches full screen in landscape, works offline, and
opens straight into the river with the panel hidden. Installation needs a real
URL: a downloaded copy of the file plays fine but cannot be installed.

The 3D renderer lives in `src/render3d.js` and exposes the same four-method
interface as `src/render.js`, so `main.js` and the physics do not know which one
they are running under. Everything that fits in the game plane fits here: the rig
and the fish live at `z = 0`, the boulders are shifted just beyond it so the lane
stays visible, and the pointer is projected onto that plane to move the rod.

If you would rather serve it:

```sh
python3 -m http.server 8000
# then http://localhost:8000
```

Rebuild the bundle after changing anything in `src/` or `index.html`:

```sh
node tools/build-single-file.js
```

## Playing it

There are no cast or strike buttons. Everything is done with the rod.

| Action | Input |
| --- | --- |
| Hold the rod tip | move the pointer |
| Cast | sweep the rod: load back, drive upstream, stop |
| Strike | sweep the rod tip up |
| Gather line (while a fish is on) | hold the pointer button, or <kbd>Space</kbd> |
| Sound | the speaker button, or <kbd>M</kbd> |
| Full screen | the ⤢ button, or <kbd>F</kbd> |
| Reset the rig under the tip | <kbd>R</kbd> |
| Tuck cast (fallback) | <kbd>C</kbd> |
| Learning mode (reveal lies and fish) | <kbd>L</kbd> |
| Pause | <kbd>P</kbd> |
| Switch beat | <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> |

The natural way to strike is the real one: sweep the rod tip up, or up and
slightly downstream. A lift is measured as how much ground the tip gained on a
lagged copy of itself over the last fifth of a second, so it reads the *gesture*
rather than raw speed — easing the rod up through a drift never trips it, a sharp
sweep always does. Measured on both mouse and touch, leading a drift peaks around
0.12 while a deliberate sweep lands between 0.45 and 0.71, against a default
trigger of 0.26. There is a sensitivity control, and you can turn it off.

On a touchscreen a tap cannot mean both "put the rod here" and "strike" — you
would set the hook every time you moved the rod. So on touch devices the water
only aims the rod, a flick up sets the hook, and a round button handles casting
and gathering line. This switches on automatically.

The loop: sweep the flies upstream, lead the sighter downstream at the speed of
the water, keep the contact meter in its band, and lift at anything the sighter
does that the current cannot explain. Then keep a bend in the rod, give line when
it runs, and drop the rod tip to lead a beaten fish to your feet.

The river has four drift lanes across it — at your feet, the seam, mid-river and
a far lane — each with its own depth and its own fish. <kbd>[</kbd> and
<kbd>]</kbd>, the ◂ ▸ pill in the top bar, or the Cast section of the panel move
you across. The further out you fish, the more of the rod is spent reaching over
and the shorter the flies land, so the far lane is a genuine reach and mid-river
wants more weight to get down.

Casting is a real cast, not a button. The leader is a rope with mass on the end,
so you load it by moving the rod back, drive it upstream, and stop — the stop is
what unloads it and throws the flies. A slow drag just tows them. A good sweep
gains one to three metres of upstream water; do it twice to reach the top of the
run. **Nothing anywhere in the simulator asks how the flies got wet** — a fly in
the water is fishing, full stop.

Five beats, each of which wants something different:

- **Riffle run** — shallow, quick, forgiving. Short leash, high rod.
- **Deep pocket** — you will not reach the bottom on the default rig. Lengthen the
  leader and go heavier.
- **Glassy tailout** — slow and clear. Fish see drag instantly and spook.
- **Boulder garden** *(blind)* — broken white water over a spiky bed. Trout sit up
  in the cushion and feed through more of the column, but the water twitches the
  sighter constantly, so you strike at a lot of nothing.
- **Tea-stained run** *(blind)* — peat-dark and even. Nothing shows below the
  surface, but the water is quiet, so a take is unmistakable if you are tight.

### The blind beats

On the two blind beats nothing is drawn below the surface and **nothing announces
a take** — no message, no highlight. A hooked fish becomes visible once it is on,
and learning mode still reveals everything if you want to see what you missed.
The only thing reporting back is the sighter.

That works because a trout does not ease onto a nymph, it turns and stabs, and
that sharp first moment travels up the leader in proportion to how tight you were.
Measured on the tea-stained run, holding a settled drift and comparing the take
against the drift's own jitter:

| Contact | Take signal | Drift noise (median) | Readable |
| --- | --- | --- | --- |
| 0.91 (tight) | 3.2 – 4.1 | 0.18 | 10 / 10 |
| 0.71 (slack) | 0.3 – 1.1 | 0.13 | 0 / 10 |

Slack does not just cost you the hookup — it costs you ever knowing there was a
fish. That is the entire lesson of the technique, and here it is a measurement
rather than a claim.

## Sound

Every sound is synthesised in the Web Audio graph — there are no audio files, so
the page stays a single self-contained document. The river is two layers of
filtered noise, a body of low rolling water and a brighter hiss of broken
surface, and the balance between them comes from the beat: the boulder garden
runs about four times the hiss of a glassy tailout.

Everything else is fired by something that actually happened in the physics —
the strike, flies breaking the film, a tungsten bead knocking a stone, a fish
clearing the surface and coming back down, line tearing through water with its
band opening as the tippet loads.

The strike is two narrow resonances a little over an octave apart, both drifting
downward, over a lowpassed wash that opens up underneath. The pair of formants
is what makes it read as tubed and vowel-like — water moving inside something
rather than splashing off the top of it — and it scales with how much of the rig
is actually submerged. It was picked by ear from twenty candidates built by
different synthesis methods, all level-matched so the choice was about character
rather than volume.

There is deliberately **no sound for a take**. You cannot hear a trout eat a
nymph, and on the blind beats the sighter has to stay the only witness.

Browsers will not start audio without a gesture, so the context is created on
your first interaction and the on/off choice is remembered.

## What is actually simulated

The behaviour is emergent, not scripted. Four models do the work.

**The current** (`src/river.js`) is a 1/6-power boundary layer over a smoothed bed
profile: the water dies to nothing at the stones and runs fastest at the surface.
Continuity gives shallow water more speed than deep water, so a riffle rips and a
pocket loafs. That velocity gradient is the reason a nymph in the bottom 30 cm
gets a slow, natural drift while your leader up in the fast water is being dragged
downstream ahead of it.

**The leader** (`src/rig.js`) is a position-based-dynamics rope of 28 nodes. Two
details make it behave like real tackle:

- Segment constraints only ever *pull*. Slack is real slack, so a belly forms and
  stays until you take it up.
- Drag is applied as exponential relaxation toward the local water velocity, with
  a rate per material. Thin mono is drag-dominated and effectively rides the
  current; a tungsten bead is mass-dominated and keeps sinking through it. The
  bead sizes are tuned to real still-water sink rates (2.5 mm ≈ 0.24 m/s,
  4.5 mm ≈ 0.52 m/s).

Bed and boulder collision with tangential friction gives you the ticking — and
the anchored, dragging nymph when you go too heavy.

Fishing state is derived, never declared. A drift begins when the point fly goes
under and ends when it comes out or reaches you; trout evaluate any fly that is
in the water. An earlier version gated all of this behind a cast button, so flies
flicked out by hand drifted through a lie completely ignored — the kind of bug
that only a state machine can produce.

**The picture** (`src/render.js`) is drawn to match the physics rather than to
decorate it: light shafts through the surface and a caustic net crawling over the
stones, air dragged under by broken water working its way back up, sediment
hanging in the slow layer at the bed, rings spreading from wherever the tackle
goes through the film, and a dimple of light where the leader pierces it. Trout
are drawn from a fusiform profile with a travelling wave down the spine, so the
whole body swims and a hooked one thrashes. The stones never move, so they are
baked once into an offscreen canvas and blitted, which holds 58–61 fps on both
desktop and a phone.

**The fish** (`src/fish.js`) judge a fly the way a trout would: how close it is,
how near the bed it is, and how far its velocity differs from the water around it.
Interest accumulates while the fly is good and decays when it is not; a fly towed
across the window spooks them instead. A fish that eats holds the fly for
somewhere between 0.8 and 1.1 seconds, and the only reason you ever find out is
that its turn tugs the leader — which reaches your sighter only in proportion to
how tight you were.

Hook-up probability is a direct function of contact at the moment you lift, and
of how long you took. Fishing well pays twice: a better drift makes a fish take
more confidently, which also means it holds on longer and gives you more time to
react. With ordinary contact (0.75–0.85) and an ordinary reaction (0.45–0.60 s)
you convert 57–79% of takes; with a slack leader (0.65) that falls to about 45%,
and with a genuinely tight one (0.95) it reaches 85–90%.

**The fight** gives the fish something to decide. Every couple of seconds it
picks a behaviour weighted by how much it has left: a fresh fish runs — upstream
or down, committed — and jumps; a tiring one bores deep or sulks with its nose in
the flow; a beaten one wallows on the top. A jump is genuinely ballistic, clear
of the water at up to half a metre, and slack while it is up there is twice as
likely to lose you the hook. Rod and leader are a spring with about half a metre
of give, so load builds instead of snapping instantly.

Beating a fish does not end it. The angler unships the net, sinks it in front of
them, draws the fish over the hoop and lifts — two seconds during which the fish
follows the mouth of the net along the same path the net is drawn on, so the
picture and the physics cannot disagree. Hold on through a surge and you pop
the tippet; let go and line slips under load. A fish is landed at your feet, not
at the rod tip, which is why you have to drop the rod at the end.

## Layout

```
index.html        markup, HUD, controls
dist/             generated single-file bundle (do not edit by hand)
tools/            the bundler
src/style.css     styling
src/river.js      bed geometry, velocity field, the three beats
src/rig.js        leader physics (PBD rope, drag, bed collision)
src/fish.js       holding, judging a drift, taking, fighting
src/game.js       phases, scoring, the coach
src/render.js     canvas drawing
src/main.js       input, frame loop, HUD updates
```

Plain scripts on a shared `EN` global — no modules, so it runs off the filesystem.
`window.EN.game` is exposed if you want to poke at the running sim from the
console.

## Tuning

The numbers worth playing with:

- `src/river.js` — `PRESETS`: bed profiles, `flow`, `spook`, and where the lies are.
- `src/rig.js` — `DEFAULTS` (tippet defaults to 0.18 mm) and `beadSinkRate()`.
- `src/fish.js` — the interest rate in `updateHolding`, `hookChance`, the
  behaviour weights in `_pickBehaviour`, and the fight constants in
  `updateHooked`.
- `src/game.js` — drift scoring thresholds, the coaching rules in `_scoreDrift`,
  and `LIFT_LAG` / `LIFT_DEFAULT` for hookset detection.

## Licence

MIT. See [LICENSE](LICENSE).
