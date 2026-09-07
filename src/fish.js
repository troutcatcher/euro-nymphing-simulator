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
    {
      key: 'brown', name: 'Brown',
      back: '#4a3c1e', body: '#b08a3e', belly: '#e8d6a4',
      spot: 'rgba(38,24,10,0.9)', redSpots: true, redSpot: 'rgba(196,72,42,0.9)',
      fin: 'rgba(138,110,62,0.9)'
    },
    {
      key: 'rainbow', name: 'Rainbow',
      back: '#2f4a52', body: '#8c9aa4', belly: '#eef3f6',
      spot: 'rgba(28,36,44,0.85)', redSpots: false, redSpot: 'rgba(190,80,90,0.8)',
      fin: 'rgba(120,134,144,0.9)'
    }
  ];

  function rand(a, b) { return a + Math.random() * (b - a); }

  function Fish(river, lie, index, z) {
    this.river = river;
    this.lie = lie;
    this.index = index;
    this.z = z || 0;               // across the river: which lane it lives in
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

    this.behaviour = 'bore';
    this.runDir = 1;
    this.airborne = false;
    this.jumpCooldown = 0;
    this.jumpEvent = null;     // 'launch' | 'land', drained by the game
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
    this.behaviour = 'run';
    this.runDir = Math.random() < 0.5 ? -1 : 1;
    this.airborne = false;
    this.jumpCooldown = 0.6;
    this.jumpEvent = null;
  };

  /**
   * What the fish does next. A fresh one runs and jumps; as it tires it bores
   * deep and finally wallows on the top. Choosing a behaviour, rather than
   * always swimming away from the rod, is what stops a fight being one long tug.
   */
  Fish.prototype._pickBehaviour = function () {
    var s = this.stamina;
    var r = Math.random();
    if (s > 0.6) {
      if (r < 0.30) return 'run';
      if (r < 0.60) return 'jump';
      if (r < 0.84) return 'bore';
      return 'hold';
    }
    if (s > 0.32) {
      if (r < 0.24) return 'run';
      if (r < 0.42) return 'jump';
      if (r < 0.74) return 'bore';
      return 'hold';
    }
    if (r < 0.50) return 'wallow';
    return 'hold';
  };

  /**
   * Playing the fish. It swims where it wants; the leader is a rope from the
   * rod tip, so line length and rod position decide how much it gets.
   */
  Fish.prototype.updateHooked = function (dt, tip, rig, tippetStrength, net) {
    var river = this.river;

    this.jumpEvent = null;
    this.jumpCooldown = Math.max(0, this.jumpCooldown - dt);

    this.surgeTimer -= dt;
    if (this.surgeTimer <= 0) {
      this.surge = rand(0.45, 1) * (0.4 + 0.6 * this.stamina);
      this.surgeTimer = rand(0.7, 2.1);
      this.behaviour = this._pickBehaviour();
      if (this.behaviour === 'run') this.runDir = Math.random() < 0.45 ? -1 : 1;
      if (this.behaviour === 'jump' && this.jumpCooldown > 0) this.behaviour = 'run';
    }

    var dx = this.x - tip.x, dy = this.y - tip.y;
    var dist = Math.max(1e-6, Math.hypot(dx, dy));
    var awayX = dx / dist, awayY = dy / dist;

    var power = (0.55 + 0.50 * Math.sqrt(this.mass)) * (0.10 + 0.90 * this.stamina) * this.surge;
    var u = river.speedAt(this.x, this.y);
    var wantX, wantY;

    if (this.airborne) {
      // Clear of the water: nothing but gravity and whatever the leader does.
      this.vy -= 9.81 * dt;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      if (this.y <= -0.03 && this.vy < 0) {
        this.airborne = false;
        this.jumpEvent = 'land';
        this.vy = -0.5;
        this.behaviour = 'bore';
      }
    } else {
      switch (this.behaviour) {
        case 'run':
          // A committed run in one direction, using or fighting the current.
          wantX = this.runDir * power * 2.3 + u * 0.6;
          wantY = -power * 0.30 + awayY * power * 0.2;
          break;
        case 'hold':
          // Sulking: nose into the flow and hold station, deep, giving nothing
          // away. It does not drift down onto the rod, which would be slack.
          wantX = -power * 0.35;
          wantY = -power * 0.45;
          break;
        case 'wallow':
          // Beaten and rolling on the top.
          wantX = awayX * power * 0.7 + u * 0.4;
          wantY = power * 0.55;
          break;
        case 'jump':
          // Drive for the surface, then leave it.
          wantX = this.runDir * power * 1.1 + u * 0.5;
          wantY = power * 2.6;
          if (this.y > -0.10 && this.jumpCooldown <= 0) {
            this.airborne = true;
            this.jumpEvent = 'launch';
            this.jumpCooldown = rand(1.8, 3.2);
            this.vy = 2.3 + Math.random() * 1.5;
            this.vx = this.runDir * (0.5 + Math.random() * 1.2) + u * 0.4;
            this.behaviour = 'bore';
          }
          break;
        default:
          // Boring away from the pressure, down, using the current.
          wantX = awayX * power * 1.4 + u * 0.5 - 0.2 * power;
          wantY = awayY * power * 0.45 - power * 0.5;
      }

      if (this.airborne) {
        // Launched this frame: carry the takeoff velocity and skip the surface
        // clamp, which would otherwise cancel the jump the instant it started.
        this.x += this.vx * dt;
        this.y += this.vy * dt;
      } else {
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
      }
    }

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
    if (tension < 0.05 && this.stamina > 0.40) this.slackTime += dt * (this.airborne ? 2.2 : 1);
    else this.slackTime = 0;

    var result = null;
    if (this.tippetDamage >= 1) {
      this.state = 'lost';
      result = { type: 'broke' };
    } else if (this.slackTime > 2.6) {
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

  /**
   * The lies of a beat, moved across to a lane: shifted along the river so
   * the lanes do not line up, and better or worse than the near lane by turn.
   */
  function laneLie(lie, lane) {
    if (!lane) return lie;
    var x = lie.x + lane * 0.45 * (lane % 2 ? 1 : -1);
    if (x < 0.9) x += 4.2; else if (x > 6.3) x -= 4.2;
    var q = Math.max(0.1, Math.min(1, lie.quality + (lane % 2 ? 0.12 : -0.08)));
    return { x: x, quality: q };
  }

  function School(river, lane) {
    this.river = river;
    this.lane = lane || 0;
    this.z = EN.LANES ? EN.LANES[this.lane].z : 0;
    this.reset();
  }

  School.prototype.lies = function () {
    var lies = this.river.preset.lies, out = [];
    for (var i = 0; i < lies.length; i++) out.push(laneLie(lies[i], this.lane));
    return out;
  };

  School.prototype.reset = function () {
    this.fish = [];
    // Fish are laid out on their own lane's bed, whichever lane is fished now.
    var keep = this.river.lane;
    this.river.lane = this.lane;
    var lies = this.lies();
    for (var i = 0; i < lies.length; i++) {
      // Not every lie holds a fish, and you never know which.
      if (Math.random() < 0.35 + lies[i].quality * 0.5) {
        this.fish.push(new Fish(this.river, lies[i], i, this.z));
      }
    }
    if (!this.fish.length) this.fish.push(new Fish(this.river, lies[0], 0, this.z));
    this.river.lane = keep;
  };

  School.prototype.active = function () {
    for (var i = 0; i < this.fish.length; i++) {
      var f = this.fish[i];
      if (f.state === 'taken' || f.state === 'hooked' || f.state === 'netting') return f;
    }
    return null;
  };

  EN.Fish = Fish;
  EN.School = School;
  EN.laneLie = laneLie;
  EN.SPECIES = SPECIES;
})(window.EN = window.EN || {});
