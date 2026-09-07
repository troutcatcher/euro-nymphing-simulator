/*
 * game.js — session state: casting, drifting, the take, the strike, the fight,
 * plus the drift scoring and the coach that tells you why you keep missing.
 */
(function (EN) {
  'use strict';

  var clamp = EN.clamp;
  var PHYS_DT = 1 / 240;

  // How a lift is recognised. The rod tip is compared against a lagged copy of
  // itself, so what counts is how much ground it gained in the last fifth of a
  // second — a sharp sweep trips it, easing the rod up through a drift does not.
  var LIFT_LAG = 0.20;
  var LIFT_DEFAULT = 0.26;

  var TIPPET = {
    0.10: { label: '0.10 mm (7X)', strength: 0.62 },
    0.12: { label: '0.12 mm (6X)', strength: 0.80 },
    0.14: { label: '0.14 mm (5X)', strength: 1.00 },
    0.16: { label: '0.16 mm (4X)', strength: 1.22 },
    0.18: { label: '0.18 mm (3X)', strength: 1.45 }
  };

  function Game() {
    this.river = new EN.River('riffle');
    this.lane = 0;
    this.schools = this._makeSchools();
    this.school = this.schools[0];

    this.grip = { x: 6.90, y: 1.00 };
    this.netPoint = { x: 6.35, y: -0.10 };   // where a fish is actually landed
    this.netFish = null;
    this.netTime = 0;
    this.netProgress = 0;
    this.rodLength = 3.20;
    this.tip = { x: 5.3, y: 1.9 };
    this.tipTarget = { x: 5.3, y: 1.9 };
    this.gathering = false;

    this.liftStrike = true;             // set the hook by sweeping the rod up
    this.liftThreshold = LIFT_DEFAULT;
    this.tipLag = { x: 5.3, y: 1.9 };
    this.lift = 0;
    this.liftCooldown = 0;
    this.tipSpeed = 0;
    this.whooshCooldown = 0;

    this.rig = new EN.Rig({ leaderLength: 3.2, pointBead: 3.5, tippet: 0.18 });
    this.rig.layout(this.tip.x, this.tip.y, this.tip.x - 1.0, this.tip.y - 1.2);

    // Only two states now. Everything that is not playing a fish is fishing,
    // however the flies got into the water.
    this.phase = 'fishing';
    this.phaseTime = 0;
    this.driftActive = false;
    this.driftLocked = false;
    this.dryTime = 0;
    this.showLies = false;
    this.paused = false;

    this.stats = {
      drifts: 0, takes: 0, hooked: 0, landed: 0, lost: 0, missed: 0,
      bestFish: 0, zonePct: 0, contactPct: 0, deadPct: 0
    };
    this.drift = this._blankDrift();
    this.lastDrift = null;

    this.messages = [];
    this.coachCooldown = 0;
    this.events = [];

    this.say('Sweep the rod upstream to flick the flies out, then lead them down.', 'info');
  }

  Game.prototype._blankDrift = function () {
    return { t: 0, submerged: 0, zone: 0, dead: 0, contact: 0, best: 0 };
  };

  Game.prototype.say = function (text, kind) {
    this.messages.unshift({ text: text, kind: kind || 'info', life: 4.5 });
    if (this.messages.length > 3) this.messages.length = 3;
  };

  Game.prototype.coach = function (text) {
    if (this.coachCooldown > 0) return;
    this.coachCooldown = 5.0;
    this.say(text, 'coach');
  };

  Game.prototype.setPreset = function (key) {
    this.river.setPreset(key);
    if (EN.audio) EN.audio.setRiver(this.river.preset);
    this.schools = this._makeSchools();
    this.school = this.schools[this.lane];
    this.resetDrift();
    this.say(this.river.preset.name + ' — ' + this.river.preset.blurb, 'info');
  };

  /** One school of fish per lane, each laid out on its own lane's bed. */
  Game.prototype._makeSchools = function () {
    var out = [];
    for (var i = 0; i < EN.LANES.length; i++) out.push(new EN.School(this.river, i));
    return out;
  };

  Game.prototype.laneZ = function () { return EN.LANES[this.lane].z; };

  /**
   * How far the tip can be held upstream in the current lane: the rod's
   * length less what it spends reaching across.
   */
  Game.prototype.reach = function () {
    var dz = EN.LANES[this.lane].z - 0.28;
    return Math.sqrt(Math.max(1.6, this.rodLength * this.rodLength - dz * dz));
  };

  /**
   * Fish a different lane. The rig stays where it is in its own plane and the
   * plane moves across the river; the renderer swings it there.
   */
  Game.prototype.setLane = function (i) {
    i = Math.max(0, Math.min(EN.LANES.length - 1, i | 0));
    if (i === this.lane) return false;
    if (this.school.active()) { this.say('Deal with that fish before you change lanes.', 'coach'); return false; }
    this.lane = i;
    this.river.lane = i;
    this.school = this.schools[i];
    this.setTipTarget(this.tipTarget.x, this.tipTarget.y);
    var L = EN.LANES[i];
    this.say(L.name + ' — ' + L.blurb, 'info');
    return true;
  };

  Game.prototype.setRig = function (patch) {
    this.rig.configure(patch);
    this.resetDrift();
  };

  Game.prototype.tippetStrength = function () {
    var t = TIPPET[this.rig.config.tippet];
    return t ? t.strength : 1.0;
  };

  Game.prototype.resetDrift = function () {
    this.rig.anchor = null;
    this.rig.gathering = false;
    this.rig.lineOut = this.rig.config.leaderLength;
    this.rig.layout(this.tip.x, this.tip.y, this.tip.x - 0.9, this.tip.y - 1.3);
    this.phase = 'fishing';
    this.phaseTime = 0;
    this.driftActive = false;
    this.driftLocked = false;
    this.dryTime = 0;
    this.netFish = null;
    this.netProgress = 0;
    this.drift = this._blankDrift();
    this._resetLift(0);
  };

  /** Rod tip follows the pointer, but only as far as a 10'6" rod can reach. */
  Game.prototype.setTipTarget = function (x, y) {
    // You cannot hold the tip much past your own downstream shoulder, and it
    // has to stay in the frame.
    x = clamp(x, EN.WORLD.xMin + 0.25, Math.min(this.grip.x + 0.35, EN.WORLD.xMax - 0.25));
    y = clamp(y, 0.08, EN.WORLD.yTop - 0.15);

    var dx = x - this.grip.x, dy = y - this.grip.y;
    var d = Math.hypot(dx, dy);
    var maxR = this.reach(), minR = 1.1;
    if (d > maxR) { x = this.grip.x + dx / d * maxR; y = this.grip.y + dy / d * maxR; }
    else if (d < minR && d > 1e-6) { x = this.grip.x + dx / d * minR; y = this.grip.y + dy / d * minR; }

    this.tipTarget.x = x;
    this.tipTarget.y = clamp(y, 0.08, EN.WORLD.yTop - 0.15);
  };

  Game.prototype.cast = function () {
    if (this.phase === 'fighting' || this.phase === 'netting') return;
    var reach = this.rig.config.leaderLength * 0.82;
    var tx = clamp(this.tip.x - reach, EN.WORLD.xMin + 0.4, this.tip.x - 0.9);
    var ty = 0.22;

    this.rig.layout(this.tip.x, this.tip.y, tx, ty);
    // A tuck cast: the flies are driven down and slightly back under the tip so
    // they enter the water leading the leader, not trailing it.
    this.rig.setPointVelocity(0.35, -2.4);
    var d = this.rig.dropper();
    if (d) { d.vx = 0.3; d.vy = -1.9; }

    for (var i = 0; i < this.school.fish.length; i++) {
      var f = this.school.fish[i];
      // Landing the rig on a fish's head costs you.
      var near = Math.abs(f.x - tx);
      if (near < 0.5) f.spook = Math.min(1, f.spook + this.river.preset.spook * (1 - near / 0.5));
    }

    this.driftActive = false;
    this.driftLocked = false;
    this.dryTime = 0;
    this.drift = this._blankDrift();
    this._resetLift(0.6);
  };

  Game.prototype.strike = function () {
    if (this.phase === 'fighting' || this.phase === 'netting') return;

    if (EN.audio) {
      // How much of the rig is under water is how much of it you hear move.
      var nodes = this.rig.nodes, wet = 0;
      for (var w = 0; w < nodes.length; w++) if (nodes[w].y < 0) wet++;
      EN.audio.strike(0.25 + 0.75 * (wet / nodes.length));
    }

    var fish = this.school.active();
    if (fish && fish.state === 'taken') {
      var chance = fish.hookChance(this.rig.contact, fish.holdTime);
      if (Math.random() < chance) {
        fish.hookUp();
        this._anchorTo(fish);
        // Come tight straight away: the lift that set the hook also took up the
        // slack, so the fight starts with a bend in the rod.
        var fly = this.rig.anchor.node;
        var span = Math.hypot(fly.x - this.tip.x, fly.y - this.tip.y);
        this.rig.lineOut = clamp(span - 0.25, 0.9, this.rig.config.leaderLength);
        this.phase = 'fighting';
        this.phaseTime = 0;
        this.driftActive = false;
        this.stats.hooked++;
        if (EN.audio) EN.audio.hook();
        this.say('Hooked up — ' + fish.lengthCm + ' cm ' + fish.species.name.toLowerCase() + '!', 'good');
      } else {
        fish.state = 'holding';
        fish.cooldown = 3 + Math.random() * 3;
        fish.spook = 1;
        fish.takenFly = null;
        this.rig.anchor = null;
        this.stats.missed++;
        this.say('Lifted into it and came up empty.', 'bad');
        var late = fish.holdTime / Math.max(0.1, fish.holdWindow);
        if (late > 0.55 && this.rig.contact >= 0.8) {
          this.coach('A shade slow. Set the moment the sighter does anything odd — do not wait to be sure.');
        } else if (this.rig.contact < 0.8) {
          this.coach('There was too much slack to drive the hook. Keep the sighter just taut.');
        } else {
          this.coach('Close. A shorter, faster sweep downstream sticks more of those.');
        }
        this._liftFlies();
      }
    }
    // A lift with nothing on it is just how you pick the flies up to recast.
    // The cost is already real — you gave up the rest of the drift.
  };

  Game.prototype._liftFlies = function () {
    this._resetLift(0.5);
    var p = this.rig.point();
    p.vy += 2.4; p.vx -= 0.5;
    var d = this.rig.dropper();
    if (d) { d.vy += 2.0; d.vx -= 0.4; }
  };

  Game.prototype.update = function (dt) {
    if (this.paused) return;
    dt = Math.min(dt, 0.05);

    this.river.update(dt);
    this.phaseTime += dt;
    this.coachCooldown = Math.max(0, this.coachCooldown - dt);
    for (var m = this.messages.length - 1; m >= 0; m--) {
      this.messages[m].life -= dt;
      if (this.messages[m].life <= 0) this.messages.splice(m, 1);
    }

    // Rod tip lags the hand a little; that lag is where slack comes from.
    var k = Math.min(1, dt * 16);
    this.tip.x += (this.tipTarget.x - this.tip.x) * k;
    this.tip.y += (this.tipTarget.y - this.tip.y) * k;

    this._updateLift(dt);

    this.rig.gathering = this.gathering && this.phase === 'fighting';
    if (this.phase === 'fighting') {
      var min = 0.85, max = this.rig.config.leaderLength + 2.2;
      var load = this.hudState().tension;
      if (this.gathering) {
        this.rig.lineOut = Math.max(min, this.rig.lineOut - dt * 0.5);
      } else {
        // Let go and the rod and your hand yield, but only once it is really
        // pulling. That give is what saves the tippet on a surge.
        this.rig.lineOut = Math.min(max, this.rig.lineOut + dt * Math.max(0, load - 0.55) * 1.7);
      }
    }

    var steps = Math.max(1, Math.min(8, Math.round(dt / PHYS_DT)));
    var sub = dt / steps;
    for (var s = 0; s < steps; s++) this.rig.step(sub, this.tip, this.river);

    if (EN.audio && this.rig.bedHits > 0) {
      EN.audio.tick(Math.min(1, this.rig.bedHits));
      this.rig.bedHits = 0;
    }

    this._updateFish(dt);
    if (this.phase === 'netting') this._updateNetting(dt);
    if (this.phase === 'fishing') this._trackDrift(dt);
  };

  Game.prototype._anchorTo = function (fish) {
    var m = fish.mouth();
    this.rig.anchor = { x: m.x, y: m.y, node: fish.takenFly || this.rig.point() };
  };

  /**
   * Watch the rod tip for a hookset. A lift is measured as displacement against
   * a lagged copy of the tip rather than instantaneous speed, so it reads the
   * gesture — a sharp sweep up and slightly downstream — instead of firing on
   * one jittery frame.
   */
  Game.prototype._updateLift = function (dt) {
    var lag = 1 - Math.exp(-dt / LIFT_LAG);
    this.tipLag.x += (this.tip.x - this.tipLag.x) * lag;
    this.tipLag.y += (this.tip.y - this.tipLag.y) * lag;
    this.liftCooldown = Math.max(0, this.liftCooldown - dt);

    // Up counts fully; a downstream sweep counts for half, the way a sideways
    // set still drives the hook home.
    this.lift = (this.tip.y - this.tipLag.y)
              + Math.max(0, this.tip.x - this.tipLag.x) * 0.5;

    // Rod speed, for the sound of line moving through air.
    var moved = Math.hypot(this.tip.x - this.tipLag.x, this.tip.y - this.tipLag.y);
    this.tipSpeed = moved / LIFT_LAG;
    this.whooshCooldown = Math.max(0, this.whooshCooldown - dt);
    if (EN.audio && this.tipSpeed > 1.9 && this.whooshCooldown <= 0) {
      this.whooshCooldown = 0.45;
      EN.audio.whoosh(clamp((this.tipSpeed - 1.9) / 3, 0.2, 1));
    }

    // Only a lift with the flies actually in the water can set a hook.
    if (this.liftStrike && this.phase === 'fishing' && this._anyFlyWet() &&
        this.liftCooldown <= 0 && this.lift > this.liftThreshold) {
      this.liftCooldown = 0.9;
      this.strike();
    }
  };

  Game.prototype._anyFlyWet = function () {
    if (this.rig.point().y < 0) return true;
    var d = this.rig.dropper();
    return !!(d && d.y < 0);
  };

  Game.prototype._resetLift = function (delay) {
    this.tipLag.x = this.tip.x;
    this.tipLag.y = this.tip.y;
    this.lift = 0;
    this.liftCooldown = delay || 0;
  };

  Game.prototype._updateFish = function (dt) {
    // A fly only fishes when it is in the water. How it got there — a tuck
    // cast, or a sweep of the rod — is none of the trout's business.
    var flies = [];
    if (this.phase === 'fishing') {
      var point = this.rig.point();
      if (point.y < 0) flies.push(point);
      var dropper = this.rig.dropper();
      if (dropper && dropper.y < 0) flies.push(dropper);
    }

    // Nothing has hold of a fly unless a fish does.
    var busy = this.school.active();
    if (!busy) this.rig.anchor = null;

    for (var i = 0; i < this.school.fish.length; i++) {
      var f = this.school.fish[i];
      if (f.state === 'landed' || f.state === 'lost') continue;

      if (f.state === 'holding') {
        var ev = f.updateHolding(dt, flies);
        if (ev && ev.type === 'take') {
          this.stats.takes++;
          this._anchorTo(f);
          this.say('Take!', 'alert');
        }
      } else if (f.state === 'taken') {
        this._anchorTo(f);
        var rej = f.updateTaken(dt);
        if (rej) {
          this.rig.anchor = null;
          if (this.rig.contact < 0.78) {
            this.say('A fish ate and spat it — you never saw it.', 'bad');
            this.coach('Slack hides takes. Lead the sighter downstream so it stays just tight.');
          } else if (this.river.preset.blind) {
            this.say('That was a fish. The sighter told you — you did not lift.', 'bad');
            this.coach('On water like this, set at anything odd. Being wrong costs you a drift; being slow costs you the fish.');
          } else {
            this.say('A fish ate and spat it out.', 'bad');
          }
        }
      } else if (f.state === 'hooked') {
        this._anchorTo(f);
        if (EN.audio) {
          EN.audio.setFight(f.airborne ? 0 : (f.tension || 0));
          if (f.jumpEvent === 'launch') EN.audio.thrash();
          else if (f.jumpEvent === 'land') EN.audio.splash(1);
          // A fish rolling on the surface makes a noise you can place.
          else if (!f.airborne && f.y > -0.10 && !f._splashed) {
            f._splashed = 1; EN.audio.thrash();
          }
          if (f.y < -0.22) f._splashed = 0;
        }
        if (f.jumpEvent === 'launch') this.say(fish_jumped(f), 'alert');
        var res = f.updateHooked(dt, this.tip, this.rig, this.tippetStrength(), this.netPoint);
        if (!res && f.stamina < 0.45) {
          if ((f.tension || 0) > 0.95) {
            this.coach('Drop the rod tip and lead it to your feet — you cannot land it with the rod held high.');
          } else if (Math.hypot(f.x - this.netPoint.x, f.y - this.netPoint.y) > 1.4) {
            this.coach('It is beaten. Low rod, short line, walk it in to your side.');
          }
        }
        if (res) {
          if (res.type === 'landed') this._beginNetting(f);
          else this._endFight(f, res);
        }
      }
    }
  };

  function fish_jumped(f) {
    return f.lengthCm + ' cm ' + f.species.name.toLowerCase() + ' — airborne!';
  }

  /**
   * Bringing a beaten fish to the net. The rod work is over; what is left is
   * the part every session actually ends with — unship the net, sink it in
   * front of you, draw the fish over it, and lift.
   */
  Game.prototype._beginNetting = function (fish) {
    this.phase = 'netting';
    this.netFish = fish;
    this.netTime = 0;
    this.netProgress = 0;
    this._netSplashed = false;
    fish.state = 'netting';
    fish.airborne = false;
    if (EN.audio) EN.audio.setFight(null);
  };

  var NET_SECONDS = 2.0;

  // Where the mouth of the net is through the sequence. The fish rides this
  // same path once it is over the hoop, so the picture and the physics agree.
  var NET_PATH = [
    { p: 0.00, x: 0.58, y: 0.95 },    // stowed on the angler's back
    { p: 0.26, x: -0.16, y: -0.24 },  // sunk in front of them
    { p: 0.58, x: 0.02, y: -0.19 },   // drawn back under the fish
    { p: 0.80, x: 0.14, y: 0.24 },    // lifted clear, water pouring out
    { p: 1.00, x: 0.16, y: 0.30 }
  ];

  Game.prototype.netMouth = function (p) {
    var a = NET_PATH[0], b = NET_PATH[NET_PATH.length - 1];
    for (var i = 1; i < NET_PATH.length; i++) {
      if (p <= NET_PATH[i].p) { a = NET_PATH[i - 1]; b = NET_PATH[i]; break; }
      a = NET_PATH[i - 1]; b = NET_PATH[i];
    }
    var span = Math.max(1e-6, b.p - a.p);
    var t = clamp((p - a.p) / span, 0, 1);
    t = t * t * (3 - 2 * t);                       // ease in and out
    return { x: this.netPoint.x + a.x + (b.x - a.x) * t,
             y: a.y + (b.y - a.y) * t };
  };

  Game.prototype._updateNetting = function (dt) {
    var f = this.netFish;
    if (!f) { this.phase = 'fishing'; return; }

    this.netTime += dt;
    this.netProgress = clamp(this.netTime / NET_SECONDS, 0, 1);
    var mouth = this.netMouth(this.netProgress);

    if (this.netProgress < 0.5) {
      // Still being drawn across in front of the angler.
      var k = Math.min(1, dt * 3.4);
      f.x += (this.netPoint.x - 0.05 - f.x) * k;
      f.y += (-0.16 - f.y) * k;
    } else {
      // Over the hoop and then riding it out of the water.
      var k2 = Math.min(1, dt * 11);
      f.x += (mouth.x - f.x) * k2;
      f.y += (mouth.y - 0.045 - f.y) * k2;
    }
    f.vx *= 0.82;
    f.vy *= 0.82;
    this._anchorTo(f);

    if (!this._netSplashed && this.netProgress > 0.62) {
      this._netSplashed = true;
      if (EN.audio) EN.audio.landed();
    }

    if (this.netProgress >= 1) this._finishNetting();
  };

  Game.prototype._finishNetting = function () {
    var fish = this.netFish;
    this.netFish = null;
    this.netProgress = 0;
    this.rig.anchor = null;
    this.phase = 'fishing';
    this.phaseTime = 0;
    this.driftActive = false;
    this.driftLocked = true;
    this.dryTime = 0;
    this.rig.lineOut = this.rig.config.leaderLength;

    fish.state = 'landed';
    this.stats.landed++;
    this.stats.bestFish = Math.max(this.stats.bestFish, fish.lengthCm);
    this.say('Netted — ' + fish.lengthCm + ' cm ' + fish.species.name.toLowerCase()
             + '. Nicely done.', 'good');
    this.school.reset();
  };

  Game.prototype._endFight = function (fish, res) {
    this.rig.anchor = null;
    this.phase = 'fishing';
    this.phaseTime = 0;
    this.driftActive = false;
    this.driftLocked = true;
    this.dryTime = 0;
    this.rig.lineOut = this.rig.config.leaderLength;

    if (EN.audio) {
      EN.audio.setFight(null);
      if (res.type === 'broke') EN.audio.snap();
    }
    if (res.type === 'broke') {
      this.stats.lost++;
      this.say('Snap. Tippet gone.', 'bad');
      this.coach('Give line when it surges — drop the rod tip downstream instead of holding hard.');
    } else {
      this.stats.lost++;
      this.say('Hook pulled free.', 'bad');
      this.coach('Keep a steady bend on. Slack lets the hook fall out.');
    }
    this.school.reset();
  };

  /**
   * A drift begins when the point fly goes into the water and ends when it
   * comes out again or reaches you. Nothing here cares how the flies got there,
   * which is the whole point: flick them upstream with the rod and you are
   * fishing, exactly as you would be off a tuck cast.
   */
  Game.prototype._trackDrift = function (dt) {
    var p = this.rig.point();
    var wet = p.y < 0;
    var past = p.x > this.grip.x - 0.35;

    if (!wet) {
      this.dryTime += dt;
      // A moment in the air is a wave slapping the fly, not the end of a drift.
      if (this.dryTime > 0.35) {
        this.driftLocked = false;
        if (this.driftActive) {
          this.driftActive = false;
          this._finishDrift();
        }
      }
      return;
    }

    if (this.dryTime > 0.05 && EN.audio) {
      // The flies just went in — how hard depends on how fast they were falling.
      EN.audio.splash(clamp(Math.abs(p.vy) / 3, 0.25, 1));
    }
    this.dryTime = 0;
    // Once the flies have swung past you they have to be put back upstream
    // before they count as a new drift.
    if (this.driftLocked && !past && p.x < this.grip.x - 1.2) this.driftLocked = false;

    if (!this.driftActive) {
      if (this.driftLocked || past) return;
      this.driftActive = true;
      this.drift = this._blankDrift();
      this.driftTime = 0;
      // Don't read the tail of the casting sweep as a hookset.
      this._resetLift(0.3);
    }

    this.driftTime += dt;
    this._scoreDrift(dt);

    if (past && !this.school.active()) {
      this.driftActive = false;
      this.driftLocked = true;
      this._finishDrift();
    }
  };

  Game.prototype._scoreDrift = function (dt) {
    var river = this.river;
    var p = this.rig.point();
    var d = this.drift;
    d.t += dt;
    d.submerged += dt;

    var above = river.heightAboveBed(p.x, p.y);
    var u = river.speedAt(p.x, p.y);
    var dragErr = Math.abs(p.vx - u);

    if (above < 0.28) d.zone += dt;
    if (dragErr < 0.14) d.dead += dt;
    if (this.rig.contact > 0.82 && this.rig.contact < 0.998) d.contact += dt;

    if (d.submerged > 1.2) {
      if (above > 0.55) {
        this.coach('You are riding high. Flick the flies further upstream, go heavier, or lengthen the leader.');
      } else if (this.rig.contact < 0.72) {
        this.coach('Big belly in the leader — raise the tip and lead the sighter with the drift.');
      } else if (dragErr > 0.30 && this.rig.contact > 0.99) {
        this.coach('You are dragging the flies. Let the sighter travel at the speed of the water.');
      } else if (Math.abs(p.vx) < 0.05 && above < 0.05) {
        this.coach('Anchored on the bottom. Lighter bug, or lift a touch.');
      }
    }
  };

  Game.prototype._finishDrift = function () {
    var d = this.drift;
    this.phaseTime = 0;

    // A pass that skated through without ever fishing does not get scored.
    if (d.submerged < 0.4) return;
    this.stats.drifts++;

    var base = Math.max(0.2, d.submerged);
    var res = {
      zone: clamp(d.zone / base, 0, 1),
      dead: clamp(d.dead / base, 0, 1),
      contact: clamp(d.contact / base, 0, 1),
      length: d.submerged
    };
    res.score = Math.round((res.zone * 0.4 + res.dead * 0.35 + res.contact * 0.25) * 100);
    this.lastDrift = res;

    var n = this.stats.drifts;
    this.stats.zonePct += (res.zone * 100 - this.stats.zonePct) / Math.max(1, n);
    this.stats.deadPct += (res.dead * 100 - this.stats.deadPct) / Math.max(1, n);
    this.stats.contactPct += (res.contact * 100 - this.stats.contactPct) / Math.max(1, n);
  };

  Game.prototype.hudState = function () {
    var p = this.rig.point();
    var river = this.river;
    var above = river.heightAboveBed(p.x, p.y);
    var u = river.speedAt(p.x, p.y);
    var fish = this.school.active();
    var lane = EN.LANES[this.lane];
    return {
      lane: this.lane, laneName: lane.name, laneZ: lane.z,
      depth: p.y < 0 ? above : null,
      totalDepth: river.depth(p.x),
      drag: p.y < 0 ? p.vx - u : 0,
      contact: this.rig.contact,
      tension: fish && fish.state === 'hooked' ? (fish.tension || 0) : 0,
      stamina: fish && fish.state === 'hooked' ? fish.stamina : 0,
      lineOut: this.rig.lineOut,
      fish: fish
    };
  };

  EN.Game = Game;
  EN.TIPPET = TIPPET;
})(window.EN = window.EN || {});
