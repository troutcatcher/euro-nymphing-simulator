/*
 * rig.js — the leader itself, simulated as a position-based-dynamics rope.
 *
 * Everything the game is about falls out of this one model:
 *   - thin mono is drag-dominated, so submerged leader gets shoved downstream
 *     and forms a belly;
 *   - a tungsten bead is mass-dominated, so it keeps sinking through that belly;
 *   - the segment constraints only ever *pull*, never push, so slack is real
 *     slack and a take telegraphs up the leader only when you are in contact.
 */
(function (EN) {
  'use strict';

  var G = 9.81;

  // Density ratios -> the fraction of dry weight that still pulls down in water.
  var BUOY = {
    mono: 1 - 1000 / 1140,   // nylon is very nearly neutral, ~0.12
    fly: 0.88                // tungsten bead + hook
  };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** Sink rate in still water for a given tungsten bead, m/s. */
  function beadSinkRate(mm) {
    if (mm <= 2.6) return 0.24;
    if (mm <= 3.6) return 0.38;
    if (mm <= 4.6) return 0.52;
    return 0.62;
  }

  function Node(x, y, opts) {
    this.x = x; this.y = y;
    this.px = x; this.py = y;
    this.vx = 0; this.vy = 0;
    this.invMass = opts.invMass;
    this.buoy = opts.buoy;
    this.waterRate = opts.waterRate; // velocity relaxation toward the current, 1/s
    this.airRate = opts.airRate;
    this.section = opts.section;
    this.pinned = !!opts.pinned;
  }

  var DEFAULTS = {
    leaderLength: 3.2,   // working length: rod tip to point fly, metres
    nodes: 28,
    sighterFrom: 0.50,
    sighterTo: 0.67,
    pointBead: 3.5,      // mm tungsten
    dropperBead: 2.5,
    dropperAt: 0.76,     // fraction along the leader
    dropperTag: 0.15,    // tag length, metres
    tippet: 0.14,        // mm
    useDropper: true
  };

  function Rig(config) {
    this.config = {};
    this.configure(config);
  }

  Rig.prototype.configure = function (config) {
    var c = this.config;
    for (var k in DEFAULTS) if (!(k in c)) c[k] = DEFAULTS[k];
    if (config) for (var j in config) c[j] = config[j];

    var n = c.nodes;
    this.seg = c.leaderLength / (n - 1);
    this.nodes = [];

    // Mono mass per node: ~0.55 g per metre of leader.
    var monoMass = 0.00055 * this.seg;
    var pointMass = 0.00008 * Math.pow(c.pointBead, 3) / 27; // ~0.3 g at 3.5 mm
    var dropperMass = 0.00008 * Math.pow(c.dropperBead, 3) / 27;

    for (var i = 0; i < n; i++) {
      var f = i / (n - 1);
      var section = 'butt';
      var waterRate = 95, airRate = 1.1;
      if (f >= c.sighterFrom && f <= c.sighterTo) {
        section = 'sighter';
        waterRate = 115; airRate = 1.5;
      } else if (f > c.sighterTo) {
        section = 'tippet';
        // Thinner tippet cuts the current better -> less belly below the sighter.
        waterRate = 55 * (0.14 / c.tippet);
        airRate = 0.8;
      }
      var isPoint = (i === n - 1);
      this.nodes.push(new Node(0, 0, {
        invMass: i === 0 ? 0 : 1 / (isPoint ? pointMass : monoMass),
        buoy: isPoint ? BUOY.fly : BUOY.mono,
        waterRate: isPoint ? G * BUOY.fly / beadSinkRate(c.pointBead) : waterRate,
        airRate: isPoint ? 0.45 : airRate,
        section: isPoint ? 'point' : section,
        pinned: i === 0
      }));
    }

    this.pointIndex = n - 1;
    this.sighterFrom = Math.round(c.sighterFrom * (n - 1));
    this.sighterTo = Math.round(c.sighterTo * (n - 1));

    // The dropper hangs off a tag part way down and rides higher in the column.
    this.dropperHost = Math.round(c.dropperAt * (n - 1));
    this.dropperIndex = -1;
    if (c.useDropper) {
      this.dropperIndex = this.nodes.length;
      this.nodes.push(new Node(0, 0, {
        invMass: 1 / dropperMass,
        buoy: BUOY.fly,
        waterRate: G * BUOY.fly / beadSinkRate(c.dropperBead),
        airRate: 0.5,
        section: 'dropper',
        pinned: false
      }));
    }

    this.contact = 0;
    this.tension = 0;
    this.bedHits = 0;      // beads knocking the stones since the last read
    this.anchor = null;      // set while a fish has the fly
    this.snagged = false;
    this.lineOut = c.leaderLength; // shortened by hand while playing a fish
  };

  Rig.prototype.point = function () { return this.nodes[this.pointIndex]; };
  Rig.prototype.dropper = function () {
    return this.dropperIndex >= 0 ? this.nodes[this.dropperIndex] : null;
  };

  /** Lay the whole rig out in a straight line — used by the cast. */
  Rig.prototype.layout = function (tipX, tipY, pointX, pointY) {
    var n = this.config.nodes;
    for (var i = 0; i < n; i++) {
      var f = i / (n - 1);
      var nd = this.nodes[i];
      nd.x = nd.px = tipX + (pointX - tipX) * f;
      nd.y = nd.py = tipY + (pointY - tipY) * f;
      nd.vx = nd.vy = 0;
    }
    var d = this.dropper();
    if (d) {
      var host = this.nodes[this.dropperHost];
      d.x = d.px = host.x;
      d.y = d.py = host.y - this.config.dropperTag;
      d.vx = d.vy = 0;
    }
    this.anchor = null;
    this.snagged = false;
    this.lineOut = this.config.leaderLength;
  };

  Rig.prototype.setPointVelocity = function (vx, vy) {
    var p = this.point();
    p.vx = vx; p.vy = vy;
  };

  /**
   * One physics substep.
   *   tip    — {x, y} rod tip position this step
   *   river  — EN.River
   *   dt     — seconds
   */
  Rig.prototype.step = function (dt, tip, river) {
    var nodes = this.nodes;
    var i, nd;

    // ---- predict -----------------------------------------------------------
    for (i = 0; i < nodes.length; i++) {
      nd = nodes[i];
      nd.px = nd.x;
      nd.py = nd.y;
      if (nd.pinned) continue;

      var submerged = nd.y < 0;
      if (submerged) {
        var u = river.speedAt(nd.x, nd.y);
        var turb = river.turbulenceAt(nd.x, nd.y, river.time);
        // Exponential relaxation toward the water: stable at any drag strength,
        // and it is the honest model for something this thin in moving water.
        var k = 1 - Math.exp(-nd.waterRate * dt);
        nd.vx += ((u + turb.x) - nd.vx) * k;
        nd.vy += (turb.y - nd.vy) * k;
        nd.vy -= G * nd.buoy * dt;
      } else {
        var ka = 1 - Math.exp(-nd.airRate * dt);
        nd.vx += (0 - nd.vx) * ka;
        nd.vy += (0 - nd.vy) * ka;
        nd.vy -= G * dt;
      }

      nd.x += nd.vx * dt;
      nd.y += nd.vy * dt;
    }

    // ---- constraints -------------------------------------------------------
    nodes[0].x = tip.x;
    nodes[0].y = tip.y;

    var iterations = 10;
    for (var it = 0; it < iterations; it++) {
      this._solveSegments();
      this._solveAttachments();
      this._solveWorld(river);
    }

    // ---- derive velocities from the corrected positions ---------------------
    for (i = 0; i < nodes.length; i++) {
      nd = nodes[i];
      if (nd.pinned) { nd.vx = nd.vy = 0; continue; }
      nd.vx = (nd.x - nd.px) / dt;
      nd.vy = (nd.y - nd.py) / dt;
    }

    this._measure(tip);
  };

  Rig.prototype._solveSegments = function () {
    var n = this.config.nodes;
    var rest = this.seg;
    // Shorten the working length when the angler gathers line during a fight.
    var scale = this.lineOut / this.config.leaderLength;
    rest *= scale;

    for (var i = 0; i < n - 1; i++) {
      var a = this.nodes[i], b = this.nodes[i + 1];
      var dx = b.x - a.x, dy = b.y - a.y;
      var d = Math.hypot(dx, dy);
      if (d < 1e-9) continue;
      // A rope only pulls. Slack stays slack — that is the whole point.
      if (d <= rest) continue;
      var w = a.invMass + b.invMass;
      if (w === 0) continue;
      var corr = (d - rest) / d;
      var cx = dx * corr, cy = dy * corr;
      a.x += cx * (a.invMass / w);
      a.y += cy * (a.invMass / w);
      b.x -= cx * (b.invMass / w);
      b.y -= cy * (b.invMass / w);
    }
  };

  Rig.prototype._solveAttachments = function () {
    var d = this.dropper();
    if (d) {
      var host = this.nodes[this.dropperHost];
      var dx = d.x - host.x, dy = d.y - host.y;
      var dist = Math.hypot(dx, dy);
      var tag = this.config.dropperTag;
      if (dist > tag && dist > 1e-9) {
        var w = host.invMass + d.invMass;
        var corr = (dist - tag) / dist;
        host.x += dx * corr * (host.invMass / w);
        host.y += dy * corr * (host.invMass / w);
        d.x -= dx * corr * (d.invMass / w);
        d.y -= dy * corr * (d.invMass / w);
      }
    }

    // A fish on, or a rock hold, pins whichever fly is caught.
    if (this.anchor) {
      var p = this.anchor.node || this.point();
      p.x = this.anchor.x;
      p.y = this.anchor.y;
    }
  };

  Rig.prototype._solveWorld = function (river) {
    var rocks = river.preset.rocks || [];
    for (var i = 1; i < this.nodes.length; i++) {
      var nd = this.nodes[i];
      if (nd.invMass === 0) continue;

      for (var r = 0; r < rocks.length; r++) {
        var rock = rocks[r];
        var cx = rock.x, cy = river.bedY(rock.x) + rock.r * 0.55;
        var dx = nd.x - cx, dy = nd.y - cy;
        var d = Math.hypot(dx, dy);
        if (d < rock.r && d > 1e-9) {
          nd.x = cx + dx / d * rock.r;
          nd.y = cy + dy / d * rock.r;
        }
      }

      var bed = river.bedY(nd.x);
      if (nd.y < bed) {
        var wasAbove = nd.py > bed;
        nd.y = bed;
        // Bed friction: this is the "tick, tick" you feel through the sighter.
        var slip = (nd.section === 'point' || nd.section === 'dropper') ? 0.55 : 0.85;
        nd.x = nd.px + (nd.x - nd.px) * slip;
        if (wasAbove && (nd.section === 'point' || nd.section === 'dropper')) {
          this.bedHits += Math.min(1, Math.abs(nd.py - bed) * 30);
        }
      }
    }
  };

  /** Leader in play out to a given fly — shorter if it is the dropper. */
  Rig.prototype.lengthTo = function (node) {
    if (node && node.section === 'dropper') {
      return this.lineOut * this.config.dropperAt + this.config.dropperTag;
    }
    return this.lineOut;
  };

  Rig.prototype._measure = function (tip) {
    var p = (this.anchor && this.anchor.node) || this.point();
    var span = this.lengthTo(p);
    var chord = Math.hypot(p.x - tip.x, p.y - tip.y);
    this.contact = clamp(chord / span, 0, 1);

    // How hard the leader is loaded, normalised so 1.0 is roughly a straight,
    // fully weighted rig. Used for the sighter read and for the fight.
    var stretch = chord - span;
    this.tension = Math.max(0, stretch) * 40 + Math.max(0, this.contact - 0.9) * 2.2;
  };

  /** RMS speed of the sighter relative to the water — how much it is "talking". */
  Rig.prototype.sighterSignal = function (river) {
    var sum = 0, count = 0;
    for (var i = this.sighterFrom; i <= this.sighterTo; i++) {
      var nd = this.nodes[i];
      var u = nd.y < 0 ? river.speedAt(nd.x, nd.y) : 0;
      sum += Math.hypot(nd.vx - u, nd.vy);
      count++;
    }
    return count ? sum / count : 0;
  };

  EN.Rig = Rig;
  EN.beadSinkRate = beadSinkRate;
  EN.clamp = clamp;
})(window.EN = window.EN || {});
