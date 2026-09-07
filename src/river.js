/*
 * river.js — river geometry and the velocity field the whole sim rides on.
 *
 * World units are metres. +x is downstream (left to right on screen), +y is up,
 * and y = 0 is the water surface, so the bed lives at negative y.
 */
(function (EN) {
  'use strict';

  /**
   * Drift lanes across the river. The rig physics lives in one vertical plane
   * at a time; a lane picks which plane, how far across from the angler it
   * sits and how much deeper the bed is there. z is metres across (negative
   * is away from the near bank), depth is added to the beat's bed profile.
   */
  var LANES = [
    { key: 'near',   name: 'Near lane',   z:  0.0, depth:  0.00, blurb: 'The soft water at your feet. Easy to reach, easy to line.' },
    { key: 'seam',   name: 'The seam',    z: -0.7, depth: -0.14, blurb: 'Where the quick water meets the slow — fish sit on this edge.' },
    { key: 'middle', name: 'Mid-river',   z: -1.4, depth: -0.30, blurb: 'The main current tongue. Deepest, fastest, needs the most weight.' },
    { key: 'far',    name: 'Far lane',    z: -2.1, depth: -0.12, blurb: 'A long reach. The rod barely gets there, so the leader angles across.' }
  ];

  var WORLD = {
    xMin: 0.4,
    xMax: 7.6,
    yTop: 2.35,
    yBed: -1.45
  };

  // Linear interpolation through a list of {x, y} bed control points.
  function sampleProfile(points, x) {
    if (x <= points[0].x) return points[0].y;
    var last = points[points.length - 1];
    if (x >= last.x) return last.y;
    for (var i = 1; i < points.length; i++) {
      if (x <= points[i].x) {
        var a = points[i - 1], b = points[i];
        var t = (x - a.x) / (b.x - a.x);
        // Smoothstep keeps the bed rounded instead of faceted.
        t = t * t * (3 - 2 * t);
        return a.y + (b.y - a.y) * t;
      }
    }
    return last.y;
  }

  var PRESETS = {
    riffle: {
      key: 'riffle',
      name: 'Riffle run',
      blind: false,
      murk: 0,
      water: { surface: '#2c5a63', mid: '#1d4048', deep: '#12292f' },
      blurb: 'Shallow broken water, quick current. Short leash, high rod, keep the bugs ticking.',
      // Mean surface speed at the reference depth, m/s.
      flow: 0.92,
      refDepth: 0.5,
      turbulence: 0.10,
      spook: 0.25,
      bed: [
        { x: 0.0, y: -0.42 }, { x: 1.3, y: -0.55 }, { x: 2.4, y: -0.48 },
        { x: 3.3, y: -0.72 }, { x: 4.2, y: -0.52 }, { x: 5.1, y: -0.64 },
        { x: 6.1, y: -0.45 }, { x: 8.0, y: -0.40 }
      ],
      rocks: [
        { x: 1.9, r: 0.20 }, { x: 3.0, r: 0.24 }, { x: 4.7, r: 0.17 }, { x: 5.7, r: 0.20 }
      ],
      lies: [
        { x: 3.35, name: 'pocket behind the boulder', quality: 1.0 },
        { x: 5.10, name: 'slot on the seam', quality: 0.85 },
        { x: 2.10, name: 'head of the riffle', quality: 0.7 }
      ]
    },

    pocket: {
      key: 'pocket',
      name: 'Deep pocket',
      blind: false,
      murk: 0.18,
      water: { surface: '#2c5a63', mid: '#1b3c46', deep: '#0f2429' },
      blurb: 'A gouged-out slot with slow water on the bottom. Heavy bugs, patient drift.',
      flow: 0.78,
      refDepth: 0.8,
      turbulence: 0.14,
      spook: 0.18,
      bed: [
        { x: 0.0, y: -0.45 }, { x: 1.45, y: -0.58 }, { x: 2.40, y: -1.05 },
        { x: 3.50, y: -1.25 }, { x: 4.65, y: -1.18 }, { x: 5.50, y: -0.85 },
        { x: 6.60, y: -0.52 }, { x: 8.00, y: -0.46 }
      ],
      rocks: [
        { x: 2.50, r: 0.28 }, { x: 4.50, r: 0.32 }, { x: 5.95, r: 0.20 }
      ],
      lies: [
        { x: 3.70, name: 'the guts of the pocket', quality: 1.0 },
        { x: 2.65, name: 'the drop-off lip', quality: 0.9 },
        { x: 5.30, name: 'tail of the pocket', quality: 0.75 }
      ]
    },

    tailout: {
      key: 'tailout',
      name: 'Glassy tailout',
      blind: false,
      murk: 0,
      water: { surface: '#31626a', mid: '#204750', deep: '#143036' },
      blurb: 'Slow, smooth and shallow. Fish see everything — drag shows up instantly.',
      flow: 0.55,
      refDepth: 0.6,
      turbulence: 0.05,
      spook: 0.55,
      bed: [
        { x: 0.0, y: -1.05 }, { x: 1.60, y: -0.95 }, { x: 2.90, y: -0.78 },
        { x: 4.00, y: -0.66 }, { x: 5.10, y: -0.52 }, { x: 6.40, y: -0.38 },
        { x: 8.00, y: -0.30 }
      ],
      rocks: [
        { x: 1.80, r: 0.18 }, { x: 3.85, r: 0.15 }, { x: 5.50, r: 0.13 }
      ],
      lies: [
        { x: 3.05, name: 'the last deep crease', quality: 1.0 },
        { x: 4.50, name: 'mid tailout', quality: 0.8 },
        { x: 1.85, name: 'inside edge', quality: 0.7 }
      ]
    },

    boulders: {
      key: 'boulders',
      name: 'Boulder garden',
      blurb: 'Broken white water. You will not see a fish in it — the sighter is the only thing that tells you.',
      blind: true,
      murk: 0.30,
      foam: true,
      water: { surface: '#54767a', mid: '#31555c', deep: '#1a343d' },
      flow: 0.88,
      refDepth: 0.55,
      turbulence: 0.24,
      spook: 0.10,
      // Trout in aerated pocket water sit up in the cushion and feed through
      // more of the column than they will in smooth water.
      hold: [0.16, 0.30],
      feedBand: 0.62,
      bed: [
        { x: 0.0, y: -0.38 }, { x: 1.10, y: -0.58 }, { x: 1.95, y: -0.36 },
        { x: 2.80, y: -0.66 }, { x: 3.60, y: -0.40 }, { x: 4.40, y: -0.70 },
        { x: 5.20, y: -0.44 }, { x: 6.10, y: -0.60 }, { x: 8.00, y: -0.42 }
      ],
      rocks: [
        { x: 1.55, r: 0.30 }, { x: 2.35, r: 0.26 }, { x: 3.95, r: 0.34 },
        { x: 4.95, r: 0.24 }, { x: 5.70, r: 0.28 }
      ],
      lies: [
        { x: 4.40, name: 'pocket behind the big rock', quality: 1.0 },
        { x: 2.80, name: 'slot between boulders', quality: 0.9 },
        { x: 6.10, name: 'tail of the garden', quality: 0.75 }
      ]
    },

    stained: {
      key: 'stained',
      name: 'Tea-stained run',
      blurb: 'Peat-dark water over an even run. Nothing shows below the surface — read the sighter and trust it.',
      blind: true,
      murk: 0.88,
      water: { surface: '#6d5731', mid: '#40331b', deep: '#20190c' },
      flow: 0.60,
      refDepth: 0.70,
      turbulence: 0.07,
      spook: 0.18,
      bed: [
        { x: 0.0, y: -0.62 }, { x: 1.40, y: -0.74 }, { x: 2.60, y: -0.82 },
        { x: 3.80, y: -0.80 }, { x: 5.00, y: -0.74 }, { x: 6.20, y: -0.62 },
        { x: 8.00, y: -0.52 }
      ],
      rocks: [
        { x: 2.10, r: 0.22 }, { x: 4.30, r: 0.26 }, { x: 5.80, r: 0.18 }
      ],
      lies: [
        { x: 3.20, name: 'the deep middle', quality: 1.0 },
        { x: 4.80, name: 'the inside seam', quality: 0.85 },
        { x: 1.90, name: 'head of the run', quality: 0.75 }
      ]
    }
  };


  function River(presetKey) {
    this.setPreset(presetKey || 'riffle');
    this.time = 0;
    this.lane = 0;
    this.lanes = LANES;
  }

  River.prototype.laneZ = function () { return LANES[this.lane].z; };

  /** Extra bed depth for a position across the river, interpolated between lanes. */
  River.prototype.laneDepthAt = function (z) {
    if (z >= LANES[0].z) return LANES[0].depth;
    var last = LANES[LANES.length - 1];
    if (z <= last.z) return last.depth;
    for (var i = 1; i < LANES.length; i++) {
      if (z >= LANES[i].z) {
        var a = LANES[i - 1], b = LANES[i];
        var t = (z - a.z) / (b.z - a.z);
        return a.depth + (b.depth - a.depth) * (t * t * (3 - 2 * t));
      }
    }
    return last.depth;
  };

  River.prototype.setPreset = function (key) {
    this.preset = PRESETS[key] || PRESETS.riffle;
    this.flowScale = 1;
    var deepest = 0;
    for (var i = 0; i < this.preset.bed.length; i++) {
      deepest = Math.max(deepest, -this.preset.bed[i].y);
    }
    this.maxDepth = deepest + 0.30;
  };

  /** The beat's bed profile on its own, before any lane offset. */
  River.prototype.profileY = function (x) {
    return sampleProfile(this.preset.bed, x);
  };

  /** Bed elevation (negative) at a downstream position, in the current lane. */
  River.prototype.bedY = function (x) {
    return sampleProfile(this.preset.bed, x) + LANES[this.lane].depth;
  };

  /** Water depth at a downstream position, metres. */
  River.prototype.depth = function (x) {
    return -this.bedY(x);
  };

  /**
   * Surface speed. Continuity says the river has to move faster where it is
   * shallower, which is exactly why a riffle rips and a pocket loafs.
   */
  River.prototype.surfaceSpeed = function (x) {
    var p = this.preset;
    var h = Math.max(0.12, this.depth(x));
    return p.flow * this.flowScale * Math.pow(p.refDepth / h, 0.45);
  };

  /**
   * Downstream water speed at a point. A 1/6-power boundary layer: the current
   * dies to nothing at the bed, which is the whole reason we want the nymph
   * down there — slow water, natural drift, and fish that do not have to work.
   */
  River.prototype.speedAt = function (x, y) {
    var bed = this.bedY(x);
    if (y <= bed) return 0;
    var h = Math.max(0.12, -bed);
    var z = Math.min(h, y - bed);
    var shear = Math.pow(Math.max(0, z) / h, 1 / 6);
    var u = this.surfaceSpeed(x) * shear;
    // Above the surface there is no push at all.
    return y > 0 ? 0 : u;
  };

  /** Small unsteady component so drifts never look like they are on rails. */
  River.prototype.turbulenceAt = function (x, y, t) {
    var p = this.preset;
    if (y > 0) return { x: 0, y: 0 };
    var bed = this.bedY(x);
    var h = Math.max(0.12, -bed);
    var z = Math.max(0, y - bed);
    // Strongest just off the bed where the boulders shed eddies.
    var envelope = Math.exp(-Math.pow((z / h - 0.25) * 2.4, 2));
    var s = p.turbulence * envelope;
    var a = Math.sin(x * 3.1 + t * 2.3) * Math.cos(y * 5.0 - t * 1.7);
    var b = Math.cos(x * 4.7 - t * 3.1) * Math.sin(y * 3.3 + t * 2.9);
    return { x: a * s, y: b * s * 0.6 };
  };

  /** Height of the nymph above the bed — the number the HUD lives on. */
  River.prototype.heightAboveBed = function (x, y) {
    return y - this.bedY(x);
  };

  River.prototype.update = function (dt) {
    this.time += dt;
  };

  EN.WORLD = WORLD;
  EN.LANES = LANES;
  EN.PRESETS = PRESETS;
  EN.River = River;
})(window.EN = window.EN || {});
