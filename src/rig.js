/*
 * rig.js — the leader itself, simulated as a position-based-dynamics rope.
 *
 * Everything the game is about falls out of this one model:
 *   - thin mono is drag-dominated, so submerged leader gets shoved downstream
 *     and forms a belly;
 *   - a tungsten bead is mass-dominated, so it keeps sinking through that belly;
 *   - the segment constraints only ever *pull*, never push, so slack is real
 *     slack and a take telegraphs up the leader only when you are in contact.
 *
 * The same rope fishes two ways. Tight-line (Euro): mono from the tip to the
 * flies, nothing on the surface. Indicator: a floating fly line and greased
 * leader lying on the water out to a buoyant indicator, and a sunk tippet and
 * nymph hanging under it. Floating sections ride the surface current, which
 * is what drags the indicator when the line bellies; the take shows as the
 * indicator stalling or dipping; and the hookset first has to take the slack
 * line off the water.
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

  // Strike indicators: radius, how hard the surface current takes hold of
  // them (relaxation rate), and how stiffly they float back up when pulled
  // under. A big one drags more and is harder for a fish to sink.
  var INDICATORS = {
    small:  { r: 0.011, rate: 20, floatK: 45,  mass: 0.00025 },
    medium: { r: 0.016, rate: 28, floatK: 70,  mass: 0.00060 },
    large:  { r: 0.022, rate: 36, floatK: 105, mass: 0.00120 }
  };

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
    this.airQuad = opts.airQuad || 0;  // extra air drag per m/s: whips die, loops carry
    this.section = opts.section;
    this.pinned = !!opts.pinned;
    this.floats = !!opts.floats;      // rides the surface rather than sinking
    this.zf = opts.zf === undefined ? 1 : opts.zf; // 0 at the rod tip's side, 1 in the lane
    this.draft = opts.draft || 0;     // how deep it sits when floating, metres
    this.floatK = opts.floatK || 0;   // stiffness of the return to the waterline
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
    tippet: 0.18,        // mm
    useDropper: true,
    // Indicator style: leaderLength is then line and leader from tip to the
    // indicator, and the nymph hangs indicatorDepth below it.
    style: 'euro',       // 'euro' | 'indicator'
    indicatorDepth: 1.2, // metres, indicator to point fly
    indicatorSize: 'medium'
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
    var indicator = c.style === 'indicator';
    this.indicator = indicator;
    // The whole rope, tip to point fly.
    this.total = indicator ? c.leaderLength + c.indicatorDepth : c.leaderLength;
    this.seg = this.total / (n - 1);
    this.nodes = [];

    // Mono mass per node: ~0.55 g per metre of leader; fly line about 1.1 g/m.
    var monoMass = 0.00055 * this.seg;
    var lineMass = 0.0011 * this.seg;
    var pointMass = 0.00008 * Math.pow(c.pointBead, 3) / 27; // ~0.3 g at 3.5 mm
    var dropperMass = 0.00008 * Math.pow(c.dropperBead, 3) / 27;
    var ind = INDICATORS[c.indicatorSize] || INDICATORS.medium;
    this.indicatorSpec = ind;
    var indIndex = indicator ? Math.round((c.leaderLength / this.total) * (n - 1)) : -1;
    this.indicatorIndex = indIndex;

    for (var i = 0; i < n; i++) {
      var f = i / (n - 1);
      var section = 'butt';
      var waterRate = 95, airRate = 1.1;
      var opts = { buoy: BUOY.mono, mass: monoMass };
      var isPoint = (i === n - 1);
      if (indicator) {
        if (i < indIndex * 0.72) {
          // Floating fly line: fat, and the surface takes hold of it hard.
          section = 'line'; waterRate = 70; airRate = 0.7;
          opts = { buoy: 0, mass: lineMass, floats: true, draft: 0.0015, floatK: 90 };
        } else if (i < indIndex) {
          // Greased leader butt, floating but lighter on the water.
          section = 'butt'; waterRate = 35; airRate = 0.9;
          opts = { buoy: 0, mass: monoMass, floats: true, draft: 0.002, floatK: 60 };
        } else if (i === indIndex) {
          // A foam ball is nearly all drag: it kills the whip at the end of a cast.
          section = 'indicator'; waterRate = ind.rate; airRate = 1.7;
          opts = { buoy: 0, mass: ind.mass, floats: true, draft: ind.r * 0.55, floatK: ind.floatK };
        } else {
          section = 'tippet'; waterRate = 55 * (c.tippet / 0.14); airRate = 1.5;
        }
      } else if (f >= c.sighterFrom && f <= c.sighterTo) {
        section = 'sighter';
        waterRate = 115; airRate = 1.5;
      } else if (f > c.sighterTo) {
        section = 'tippet';
        // Thicker tippet catches more water, so it bellies more and drags the
        // point fly with it. Going finer buys a better drift and costs strength.
        waterRate = 55 * (c.tippet / 0.14);
        airRate = 0.8;
      }
      this.nodes.push(new Node(0, 0, {
        invMass: i === 0 ? 0 : 1 / (isPoint ? pointMass : opts.mass),
        buoy: isPoint ? BUOY.fly : opts.buoy,
        waterRate: isPoint ? G * BUOY.fly / beadSinkRate(c.pointBead) : waterRate,
        airRate: isPoint ? (indicator ? 0.9 : 0.45) : airRate,
        airQuad: indicator ? (isPoint ? 0.05 : (section === 'line' ? 0.04 : 0.14)) : 0,
        section: isPoint ? 'point' : section,
        pinned: i === 0,
        floats: !isPoint && opts.floats,
        draft: opts.draft,
        floatK: opts.floatK,
        // Under an indicator the line runs across the river from the tip to
        // the lane; the rope's own maths stays in the lane's plane.
        zf: indicator ? Math.min(1, i / Math.max(1, indIndex)) : 1
      }));
    }

    this.pointIndex = n - 1;
    if (indicator) {
      // The indicator is the sighter now: it is the thing you read.
      this.sighterFrom = this.sighterTo = indIndex;
    } else {
      this.sighterFrom = Math.round(c.sighterFrom * (n - 1));
      this.sighterTo = Math.round(c.sighterTo * (n - 1));
    }

    // The dropper hangs off a tag part way down and rides higher in the column
    // — under an indicator, part way down the tippet.
    this.dropperHost = indicator ? indIndex + Math.round((n - 1 - indIndex) * 0.55)
                                 : Math.round(c.dropperAt * (n - 1));
    this.dropperFrac = this.dropperHost / (n - 1);
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
    this.slack = 0;        // indicator style: line bellied on the water, metres
    this.tension = 0;
    this.bedHits = 0;      // beads knocking the stones since the last read
    this.anchor = null;      // set while a fish has the fly
    this.snagged = false;
    this.lineOut = this.total; // shortened by hand while playing a fish
  };

  Rig.prototype.point = function () { return this.nodes[this.pointIndex]; };

  /** Where a node sits across the river, between the rod tip and the lane. */
  Rig.prototype.nodeZ = function (i, river) {
    if (!this.indicator) return river.laneZ();
    return river.tipZ + (river.laneZ() - river.tipZ) * this.nodes[i].zf;
  };
  Rig.prototype.indicatorNode = function () {
    return this.indicatorIndex >= 0 ? this.nodes[this.indicatorIndex] : null;
  };
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
    this.lineOut = this.total;
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
      if (nd.floats && nd.y < 0.04) {
        // On the surface: carried by the surface current, held at its
        // waterline by buoyancy, and pushed back up if something pulls it under.
        // Line lying over other lanes is pushed at their speed, not the lane's:
        // that difference is the belly, and the belly is the drag.
        var us = river.surfaceSpeedAt(nd.x, this.nodeZ(i, river));
        var st = river.turbulenceAt(nd.x, -0.01, river.time);
        var kf = 1 - Math.exp(-nd.waterRate * dt);
        nd.vx += ((us + st.x * 0.6) - nd.vx) * kf;
        var y0 = -nd.draft;
        nd.vy += (-(nd.y - y0) * nd.floatK - nd.vy * 9) * dt + st.y * 0.4 * dt;
      } else if (submerged) {
        var u = river.speedAt(nd.x, nd.y);
        var turb = river.turbulenceAt(nd.x, nd.y, river.time);
        // Exponential relaxation toward the water: stable at any drag strength,
        // and it is the honest model for something this thin in moving water.
        var k = 1 - Math.exp(-nd.waterRate * dt);
        nd.vx += ((u + turb.x) - nd.vx) * k;
        nd.vy += (turb.y - nd.vy) * k;
        nd.vy -= G * nd.buoy * dt;
      } else if (nd.airQuad > 0) {
        // A line in the air: little drag along its own length, a great deal
        // across it. That is what lets a loop carry while a straightened line
        // hangs in the air instead of dropping like a stone.
        var pa = nodes[Math.max(0, i - 1)], pb = nodes[Math.min(nodes.length - 1, i + 1)];
        var tx = pb.x - pa.x, ty = pb.y - pa.y, tl = Math.hypot(tx, ty) || 1;
        tx /= tl; ty /= tl;
        var spd = Math.hypot(nd.vx, nd.vy);
        var along = nd.vx * tx + nd.vy * ty;
        var perpX = nd.vx - along * tx, perpY = nd.vy - along * ty;
        var kAlong = 1 - Math.exp(-(nd.airRate + nd.airQuad * spd) * dt);
        var kPerp = 1 - Math.exp(-(nd.airRate * 4 + nd.airQuad * 2.5 * spd) * dt);
        along *= (1 - kAlong);
        perpX *= (1 - kPerp); perpY *= (1 - kPerp);
        nd.vx = along * tx + perpX;
        nd.vy = along * ty + perpY - G * dt;
      } else {
        var kair = 1 - Math.exp(-nd.airRate * dt);
        nd.vx += (0 - nd.vx) * kair;
        nd.vy += (0 - nd.vy) * kair;
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
    // Shorten the working length when the angler gathers or strips line. Under
    // an indicator only the line above it shortens; the drop to the nymph is
    // the depth you set and stays put.
    var scale = this.lineScale();
    var restLine = this.seg * scale, restDrop = this.indicator ? this.seg : restLine;

    for (var i = 0; i < n - 1; i++) {
      var a = this.nodes[i], b = this.nodes[i + 1];
      var rest = i < this.indicatorIndex ? restLine : restDrop;
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

  /** The shortest the rope can be gathered to: the drop plus a rod's tip of line. */
  Rig.prototype.minLineOut = function () {
    return this.indicator ? this.config.indicatorDepth + 0.5 : 0.85;
  };

  /** Fraction of the line (above the indicator, or the whole leader) in play. */
  Rig.prototype.lineScale = function () {
    if (!this.indicator) return this.lineOut / this.total;
    return clamp((this.lineOut - this.config.indicatorDepth) / this.config.leaderLength, 0.08, 1);
  };

  /** Leader in play out to a given fly — shorter if it is the dropper. */
  Rig.prototype.lengthTo = function (node) {
    if (this.indicator) {
      var line = this.lineOut - this.config.indicatorDepth;
      if (node && node.section === 'dropper') {
        return line + (this.dropperHost - this.indicatorIndex) * this.seg + this.config.dropperTag;
      }
      return this.lineOut;
    }
    if (node && node.section === 'dropper') {
      return this.lineOut * this.dropperFrac + this.config.dropperTag;
    }
    return this.lineOut;
  };

  Rig.prototype._measure = function (tip) {
    var p = (this.anchor && this.anchor.node) || this.point();
    var span = this.lengthTo(p);
    var chord = Math.hypot(p.x - tip.x, p.y - tip.y);
    if (this.indicator) {
      // Contact is the tippet under the indicator: only a fairly straight
      // tippet lets a take move the indicator. Slack is the line on the water
      // between rod tip and indicator that a hookset has to pick up first.
      var ind = this.indicatorNode();
      var down = Math.hypot(p.x - ind.x, p.y - ind.y);
      var downSpan = p.section === 'dropper' ? (this.dropperHost - this.indicatorIndex) * this.seg + this.config.dropperTag
                                             : (this.pointIndex - this.indicatorIndex) * this.seg;
      this.contact = clamp(down / Math.max(0.05, downSpan), 0, 1);
      var rope = 0;
      for (var i = 0; i < this.indicatorIndex; i++) {
        var a = this.nodes[i], b = this.nodes[i + 1];
        rope += Math.hypot(b.x - a.x, b.y - a.y);
      }
      this.slack = Math.max(0, rope - Math.hypot(ind.x - tip.x, ind.y - tip.y));
    } else {
      this.contact = clamp(chord / span, 0, 1);
      this.slack = 0;
    }

    // How hard the leader is loaded, normalised so 1.0 is roughly a straight,
    // fully weighted rig. Used for the sighter read and for the fight.
    var stretch = chord - span;
    this.tension = Math.max(0, stretch) * 40 + Math.max(0, this.contact - 0.9) * 2.2;
  };

  /**
   * What a hookset has to work with: tight-line, the contact itself; under an
   * indicator, the tippet's contact discounted by the slack line the lift
   * must pick up off the water before it reaches the fish.
   */
  Rig.prototype.hookContact = function () {
    if (!this.indicator) return this.contact;
    return this.contact * clamp(1 - Math.max(0, this.slack - 0.25) / 1.3, 0.15, 1);
  };

  /** RMS speed of the sighter relative to the water — how much it is "talking". */
  Rig.prototype.sighterSignal = function (river) {
    if (this.indicator) {
      var ind = this.indicatorNode();
      var us = river.surfaceSpeed(ind.x);
      return Math.hypot(ind.vx - us, ind.vy * 2.0);
    }
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
  EN.INDICATORS = INDICATORS;
  EN.beadSinkRate = beadSinkRate;
  EN.clamp = clamp;
})(window.EN = window.EN || {});
