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
    this.school = new EN.School(this.river);

    this.grip = { x: 6.90, y: 1.00 };
    this.netPoint = { x: 6.35, y: -0.10 };   // where a fish is actually landed
    this.rodLength = 3.20;
    this.tip = { x: 5.3, y: 1.9 };
    this.tipTarget = { x: 5.3, y: 1.9 };
    this.gathering = false;

    this.liftStrike = true;             // set the hook by sweeping the rod up
    this.liftThreshold = LIFT_DEFAULT;
    this.tipLag = { x: 5.3, y: 1.9 };
    this.lift = 0;
    this.liftCooldown = 0;

    this.rig = new EN.Rig({ leaderLength: 3.2, pointBead: 3.5, tippet: 0.14 });
    this.rig.layout(this.tip.x, this.tip.y, this.tip.x - 1.0, this.tip.y - 1.2);

    this.phase = 'ready';
    this.phaseTime = 0;
    this.driftTime = 0;
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

    this.say('Left-click or press Space to make a tuck cast upstream.', 'info');
  }

  Game.prototype._blankDrift = function () {
    return { t: 0, submerged: 0, zone: 0, dead: 0, contact: 0, best: 0 };
  };

  Game.prototype.say = function (text, kind) {
    this.messages.unshift({ text: text, kind: kind || 'info', life: 5.5 });
    if (this.messages.length > 4) this.messages.length = 4;
  };

  Game.prototype.coach = function (text) {
    if (this.coachCooldown > 0) return;
    this.coachCooldown = 5.0;
    this.say(text, 'coach');
  };

  Game.prototype.setPreset = function (key) {
    this.river.setPreset(key);
    this.school = new EN.School(this.river);
    this.resetDrift();
    this.say(this.river.preset.name + ' — ' + this.river.preset.blurb, 'info');
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
    this.phase = 'ready';
    this.phaseTime = 0;
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
    var maxR = this.rodLength, minR = 1.1;
    if (d > maxR) { x = this.grip.x + dx / d * maxR; y = this.grip.y + dy / d * maxR; }
    else if (d < minR && d > 1e-6) { x = this.grip.x + dx / d * minR; y = this.grip.y + dy / d * minR; }

    this.tipTarget.x = x;
    this.tipTarget.y = clamp(y, 0.08, EN.WORLD.yTop - 0.15);
  };

  Game.prototype.cast = function () {
    if (this.phase === 'fighting') return;
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

    this.phase = 'drifting';
    this.phaseTime = 0;
    this.driftTime = 0;
    this.drift = this._blankDrift();
    this._resetLift(0.6);
  };

  Game.prototype.strike = function () {
    if (this.phase === 'fighting') return;
    if (this.phase !== 'drifting') { this.cast(); return; }

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
        this.stats.hooked++;
        this.say('Hooked up — ' + fish.lengthCm + ' cm ' + fish.species.name.toLowerCase() + '!', 'good');
      } else {
        fish.state = 'holding';
        fish.cooldown = 3 + Math.random() * 3;
        fish.spook = 1;
        fish.takenFly = null;
        this.rig.anchor = null;
        this.stats.missed++;
        this.say('Lifted into it and came up empty.', 'bad');
        if (this.rig.contact < 0.8) {
          this.coach('There was too much slack to drive the hook. Keep the sighter just taut.');
        } else {
          this.coach('Close. A shorter, faster lift downstream sticks more of those.');
        }
        this._liftFlies();
      }
      return;
    }

    // A strike at nothing is not free: it yanks the flies off the bottom.
    this.stats.missed++;
    this._liftFlies();
    this.say('Nothing there — that lift pulled the flies up.', 'info');
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

    this._updateFish(dt);
    if (this.phase === 'drifting') this._scoreDrift(dt);
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

    if (this.liftStrike && this.phase === 'drifting' &&
        this.liftCooldown <= 0 && this.lift > this.liftThreshold) {
      this.liftCooldown = 0.9;
      this.strike();
    }
  };

  Game.prototype._resetLift = function (delay) {
    this.tipLag.x = this.tip.x;
    this.tipLag.y = this.tip.y;
    this.lift = 0;
    this.liftCooldown = delay || 0;
  };

  Game.prototype._updateFish = function (dt) {
    var flies = [this.rig.point()];
    var dropper = this.rig.dropper();
    if (dropper) flies.push(dropper);

    // Nothing has hold of a fly unless a fish does.
    var busy = this.school.active();
    if (!busy) this.rig.anchor = null;

    for (var i = 0; i < this.school.fish.length; i++) {
      var f = this.school.fish[i];
      if (f.state === 'landed' || f.state === 'lost') continue;

      if (f.state === 'holding') {
        if (this.phase === 'drifting') {
          var ev = f.updateHolding(dt, flies);
          if (ev && ev.type === 'take') {
            this.stats.takes++;
            this._anchorTo(f);
            this.say('Take!', 'alert');
          }
        } else {
          f.updateHolding(dt, []);
        }
      } else if (f.state === 'taken') {
        this._anchorTo(f);
        var rej = f.updateTaken(dt);
        if (rej) {
          this.rig.anchor = null;
          if (this.rig.contact < 0.78) {
            this.say('A fish ate and spat it — you never saw it.', 'bad');
            this.coach('Slack hides takes. Lead the sighter downstream so it stays just tight.');
          } else {
            this.say('A fish ate and spat it out.', 'bad');
          }
        }
      } else if (f.state === 'hooked') {
        this._anchorTo(f);
        var res = f.updateHooked(dt, this.tip, this.rig, this.tippetStrength(), this.netPoint);
        if (!res && f.stamina < 0.45) {
          if ((f.tension || 0) > 0.95) {
            this.coach('Drop the rod tip and lead it to your feet — you cannot land it with the rod held high.');
          } else if (Math.hypot(f.x - this.netPoint.x, f.y - this.netPoint.y) > 1.4) {
            this.coach('It is beaten. Low rod, short line, walk it in to your side.');
          }
        }
        if (res) this._endFight(f, res);
      }
    }
  };

  Game.prototype._endFight = function (fish, res) {
    this.rig.anchor = null;
    this.phase = 'ready';
    this.phaseTime = 0;
    this.rig.lineOut = this.rig.config.leaderLength;

    if (res.type === 'landed') {
      this.stats.landed++;
      this.stats.bestFish = Math.max(this.stats.bestFish, fish.lengthCm);
      this.say('Landed — ' + fish.lengthCm + ' cm ' + fish.species.name.toLowerCase() + '. Nicely done.', 'good');
    } else if (res.type === 'broke') {
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

  Game.prototype._scoreDrift = function (dt) {
    var river = this.river;
    var p = this.rig.point();
    var d = this.drift;
    d.t += dt;

    if (p.y < 0) {
      d.submerged += dt;
      var above = river.heightAboveBed(p.x, p.y);
      var u = river.speedAt(p.x, p.y);
      var dragErr = Math.abs(p.vx - u);

      if (above < 0.28) d.zone += dt;
      if (dragErr < 0.14) d.dead += dt;
      if (this.rig.contact > 0.82 && this.rig.contact < 0.998) d.contact += dt;

      if (d.submerged > 1.2) {
        if (above > 0.55) {
          this.coach('You are riding high. Cast further upstream, go heavier, or lengthen the leader.');
        } else if (this.rig.contact < 0.72) {
          this.coach('Big belly in the leader — raise the tip and lead the sighter with the drift.');
        } else if (dragErr > 0.30 && this.rig.contact > 0.99) {
          this.coach('You are dragging the flies. Let the sighter travel at the speed of the water.');
        } else if (Math.abs(p.vx) < 0.05 && above < 0.05) {
          this.coach('Anchored on the bottom. Lighter bug, or lift a touch.');
        }
      }
    }

    // Drift is over once the flies come level with you.
    if (this.school.active()) return;
    if (p.x > this.grip.x - 0.35 || this.phaseTime > 26) {
      this._finishDrift();
    }
  };

  Game.prototype._finishDrift = function () {
    var d = this.drift;
    this.phase = 'ready';
    this.phaseTime = 0;
    this.rig.anchor = null;

    // A cast that skated through without ever fishing does not get scored.
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
    return {
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
