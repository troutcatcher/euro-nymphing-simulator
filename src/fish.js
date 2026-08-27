/*
 * fish.js — trout that hold in lies, judge your drift, eat, and then fight.
 *
 * A fish only commits when the fly is (a) down in its window and (b) moving at
 * the speed of the water around it. Once it eats, whether you ever find out
 * depends on how much slack is between the sighter and the hook.
 */
(function (EN) {
  'use strict';

  var clamp = EN.clamp;

  var SPECIES = [
    { key: 'brown', name: 'Brown', body: '#a8813f', belly: '#e6d2a0', spot: '#4a2f14' },
    { key: 'rainbow', name: 'Rainbow', body: '#7d8b96', belly: '#e8eef2', spot: '#2f3a44' }
  ];

  function rand(a, b) { return a + Math.random() * (b - a); }

  function Fish(river, lie, index) {
    this.river = river;
    this.lie = lie;
    this.index = index;
    this.species = SPECIES[Math.floor(Math.random() * SPECIES.length)];

    this.lengthCm = Math.round(rand(24, 30 + lie.quality * 22));
    this.mass = Math.pow(this.lengthCm / 30, 3);   // relative "how much it pulls"

    var hold = river.preset.hold || [0.10, 0.20];
    this.x = lie.x;
    this.y = river.bedY(lie.x) + rand(hold[0], hold[1]);
    this.homeY = this.y;
    this.vx = 0; this.vy = 0;

    this.state = 'holding';      // holding | taken | hooked | landed | lost | spooked
    this.interest = 0;
    this.spook = 0;
    this.cooldown = 0;
    this.sway = Math.random() * Math.PI * 2;

    this.takenFly = null;
    this.holdTime = 0;
    this.holdWindow = 0;

    this.stamina = 1;
    this.surge = 0;
    this.surgeTimer = rand(0.4, 1.4);
    this.slackTime = 0;
    this.tippetDamage = 0;
  }

  /** The point in front of the fish where it will actually intercept a fly. */
  Fish.prototype.mouth = function () {
    return { x: this.x + 0.06, y: this.y + 0.02 };
  };

  Fish.prototype.visible = function () {
    return this.state !== 'landed' && this.state !== 'lost';
  };

  /**
   * Score a fly the way the fish would: is it deep enough, and is it moving
   * with the water rather than being towed across it?
   */
  Fish.prototype.judge = function (node) {
    var river = this.river;
    var m = this.mouth();
    var dx = node.x - m.x, dy = node.y - m.y;
    var dist = Math.hypot(dx, dy);
    var window = 0.38 + this.lengthCm / 240;
    if (dist > window) return null;

    var u = river.speedAt(node.x, node.y);
    var dragErr = Math.hypot(node.vx - u, node.vy * 0.6);
    var dead = clamp(1 - dragErr / 0.34, 0, 1);

    var above = river.heightAboveBed(node.x, node.y);
    var band = river.preset.feedBand || 0.42;
    var depthScore = clamp(1 - Math.max(0, above - 0.14) / band, 0, 1);

    var proximity = clamp(1 - dist / window, 0, 1);

    return {
      dead: dead,
      depth: depthScore,
      proximity: proximity,
      dragErr: dragErr,
      quality: Math.pow(dead, 1.5) * depthScore * (0.45 + 0.55 * proximity)
    };
  };

  Fish.prototype.updateHolding = function (dt, flies) {
    this.sway += dt * 1.6;
    var target = this.homeY + Math.sin(this.sway) * 0.015;
    this.y += (target - this.y) * Math.min(1, dt * 4);
    this.x += (this.lie.x - this.x) * Math.min(1, dt * 2);

    this.spook = Math.max(0, this.spook - dt * 0.22);
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      this.interest = 0;
      return null;
    }

    var best = null, bestFly = null;
    for (var i = 0; i < flies.length; i++) {
      var verdict = this.judge(flies[i]);
      if (verdict && (!best || verdict.quality > best.quality)) {
        best = verdict; bestFly = flies[i];
      }
    }

    if (!best) {
      this.interest = Math.max(0, this.interest - dt * 0.9);
      return null;
    }

    // A fly ripping across the window is worse than no fly at all.
    if (best.dragErr > 0.55 && best.proximity > 0.5) {
      this.spook = Math.min(1, this.spook + dt * this.river.preset.spook * 2.2);
    }

    var willing = (1 - this.spook) * this.lie.quality;
    this.interest += dt * best.quality * willing * 7.5;

    if (this.interest >= 1) {
      this.eat(bestFly, best);
      return { type: 'take', quality: best.quality };
    }
    return null;
  };

  Fish.prototype.eat = function (fly, verdict) {
    this.state = 'taken';
    this.takenFly = fly;
    this.holdTime = 0;
    // Confident fish on a good drift hold longer; a suspicious one spits fast.
    this.holdWindow = 0.52 + verdict.quality * 0.45 + (1 - this.river.preset.spook) * 0.20;
    this.interest = 0;
    this.turn = { x: this.x - 0.05, y: this.y - 0.04 };
  };

  Fish.prototype.updateTaken = function (dt) {
    this.holdTime += dt;
    // The fish turns down and slightly across as it closes on the fly. That
    // small movement is the only thing the sighter has to work with.
    var t = clamp(this.holdTime / Math.max(0.08, this.holdWindow), 0, 1);
    // A trout does not ease onto a nymph, it turns and stabs. That sharp first
    // moment is the whole signal on water you cannot see into — and it reaches
    // the sighter only as well as your contact carries it.
    var stab = Math.exp(-this.holdTime / 0.09);
    this.x -= dt * (0.22 + 0.35 * t + 2.4 * stab);
    this.y -= dt * (0.10 + 0.24 * t + 1.35 * stab);

    if (this.holdTime >= this.holdWindow) {
      this.state = 'holding';
      this.takenFly = null;
      this.cooldown = 2.4 + Math.random() * 2.4;
      this.spook = Math.min(1, this.spook + 0.45);
      return { type: 'rejected' };
    }
    return null;
  };

  /**
   * Probability the hook finds a hold when you lift. Contact still dominates —
   * slack is what loses fish — but it pays out from a reachable amount of it
   * rather than demanding a near-perfectly straight leader.
   */
  Fish.prototype.hookChance = function (contact, reaction) {
    var late = clamp(reaction / Math.max(0.1, this.holdWindow), 0, 1);
    var base = 0.34 + 0.60 * clamp((contact - 0.55) / 0.35, 0, 1);
    return clamp(base * (1 - 0.32 * late * late), 0.10, 0.97);
  };

  Fish.prototype.hookUp = function () {
    this.state = 'hooked';
    this.stamina = 1;
    this.surge = 1;
    this.surgeTimer = 0.5;
    this.slackTime = 0;
    this.tippetDamage = 0;
  };

  /**
   * Playing the fish. It swims where it wants; the leader is a rope from the
   * rod tip, so line length and rod position decide how much it gets.
   */
  Fish.prototype.updateHooked = function (dt, tip, rig, tippetStrength, net) {
    var river = this.river;

    this.surgeTimer -= dt;
    if (this.surgeTimer <= 0) {
      this.surge = rand(0.35, 1) * (0.4 + 0.6 * this.stamina);
      this.surgeTimer = rand(0.6, 1.9);
    }

    var dx = this.x - tip.x, dy = this.y - tip.y;
    var dist = Math.max(1e-6, Math.hypot(dx, dy));
    var awayX = dx / dist, awayY = dy / dist;

    var power = (0.55 + 0.50 * Math.sqrt(this.mass)) * (0.10 + 0.90 * this.stamina) * this.surge;
    var u = river.speedAt(this.x, this.y);

    // Wants to bore away from the pressure, downward, and use the current.
    var wantX = awayX * power * 1.2 + u * 0.5 - 0.2 * power;
    var wantY = awayY * power * 0.45 - power * 0.5;

    // A spent fish stops boring away and just gets shepherded in.
    if (this.stamina < 0.25) {
      var give = this.stamina / 0.25;
      wantX = wantX * (0.25 + 0.75 * give) + u * 0.3 * (1 - give);
      wantY *= (0.25 + 0.75 * give);
    }

    this.vx += (wantX - this.vx) * Math.min(1, dt * 5);
    this.vy += (wantY - this.vy) * Math.min(1, dt * 5);

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    var bed = river.bedY(this.x) + 0.05;
    if (this.y < bed) { this.y = bed; this.vy = Math.max(0, this.vy); }
    if (this.y > -0.04) { this.y = -0.04; this.vy = Math.min(0, this.vy); }
    this.x = clamp(this.x, EN.WORLD.xMin + 0.2, EN.WORLD.xMax - 0.2);

    // The rod and the leader are a spring, not a wall. Load builds over about
    // half a metre of give, which is what lets you steer a fish instead of
    // simply snapping it off.
    dx = this.x - tip.x; dy = this.y - tip.y;
    dist = Math.max(1e-6, Math.hypot(dx, dy));
    awayX = dx / dist; awayY = dy / dist;

    var span = rig.lengthTo(this.takenFly);
    var ext = dist - span;
    var tension = 0;
    if (ext > 0) {
      tension = clamp(ext / 0.5, 0, 2);
      var pull = tension * 6.2;
      this.vx -= awayX * pull * dt;
      this.vy -= awayY * pull * dt;
      // Hard stop well past full load so nothing can run away to infinity.
      var maxExt = 0.80;
      if (ext > maxExt) {
        this.x -= awayX * (ext - maxExt);
        this.y -= awayY * (ext - maxExt);
        ext = maxExt;
        tension = clamp(ext / 0.5, 0, 2);
      }
    }

    this.stamina = Math.max(0, this.stamina - dt * (0.075 + tension * 0.22) / Math.max(0.85, this.mass));

    if (tension > tippetStrength * 0.86) {
      this.tippetDamage += dt * (tension - tippetStrength * 0.86) * 2.2;
    } else {
      this.tippetDamage = Math.max(0, this.tippetDamage - dt * 0.25);
    }

    // A hook only falls out of a green fish. Once it is beaten and alongside
    // you, a slack moment is not a disaster.
    if (tension < 0.05 && this.stamina > 0.40) this.slackTime += dt;
    else this.slackTime = 0;

    var result = null;
    if (this.tippetDamage >= 1) {
      this.state = 'lost';
      result = { type: 'broke' };
    } else if (this.slackTime > 1.8) {
      this.state = 'lost';
      result = { type: 'pulled' };
    } else if (this.stamina < 0.35 && net &&
               Math.hypot(this.x - net.x, this.y - net.y) < 1.00) {
      // Landed at your feet, not at the rod tip — which is why you have to
      // drop the rod and lead it in at the end.
      this.state = 'landed';
      result = { type: 'landed' };
    }

    this.tension = tension;
    return result;
  };

  function School(river) {
    this.river = river;
    this.reset();
  }

  School.prototype.reset = function () {
    this.fish = [];
    var lies = this.river.preset.lies;
    for (var i = 0; i < lies.length; i++) {
      // Not every lie holds a fish, and you never know which.
      if (Math.random() < 0.35 + lies[i].quality * 0.5) {
        this.fish.push(new Fish(this.river, lies[i], i));
      }
    }
    if (!this.fish.length) this.fish.push(new Fish(this.river, lies[0], 0));
  };

  School.prototype.active = function () {
    for (var i = 0; i < this.fish.length; i++) {
      var f = this.fish[i];
      if (f.state === 'taken' || f.state === 'hooked') return f;
    }
    return null;
  };

  EN.Fish = Fish;
  EN.School = School;
  EN.SPECIES = SPECIES;
})(window.EN = window.EN || {});
