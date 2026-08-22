/*
 * main.js — wiring: input, the frame loop, and the HUD.
 */
(function (EN) {
  'use strict';

  var clamp = EN.clamp;
  var canvas = document.getElementById('scene');
  var game = new EN.Game();
  var renderer = new EN.Renderer(canvas, game);
  EN.game = game;   // handy from the console when you want to poke at the sim

  var el = {};
  ['phase', 'log', 'drift-section', 'contact-val', 'contact-fill', 'contact-band', 'depth-val', 'depth-fill',
   'drag-val', 'drag-fill', 'fight-section', 'tension-val', 'tension-fill', 'tension-band',
   'stamina-val', 'stamina-fill', 'preset', 'bead', 'bead-val', 'leader', 'leader-val',
   'tippet', 'dropper', 'lies', 'reset', 's-drifts', 's-takes', 's-hooked', 's-landed',
   's-best', 's-zone', 's-dead', 's-last', 'touch-controls', 'btn-action'
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  // ---- input ---------------------------------------------------------------

  // On a touchscreen a tap cannot mean both "put the rod here" and "strike" —
  // you would set the hook every time you moved the rod. So on touch the canvas
  // only aims the rod and a button does the casting, striking and gathering.
  var touchMode = false;
  try {
    touchMode = window.matchMedia('(pointer: coarse)').matches;
  } catch (e) { /* older browsers: fall back to detecting a touch pointer */ }

  function setTouchMode(on) {
    if (on === touchMode) return;
    touchMode = on;
    el['touch-controls'].hidden = !on;
  }

  function doAction() {
    if (game.phase === 'fighting') game.gathering = true;
    else game.strike();
  }

  function pointerToWorld(ev) {
    var rect = canvas.getBoundingClientRect();
    return renderer.toWorld(ev.clientX - rect.left, ev.clientY - rect.top);
  }

  canvas.addEventListener('pointermove', function (ev) {
    if (ev.pointerType === 'touch' && ev.buttons === 0) return;
    var w = pointerToWorld(ev);
    game.setTipTarget(w.x, w.y);
  });

  canvas.addEventListener('pointerdown', function (ev) {
    ev.preventDefault();
    if (ev.pointerType === 'touch' || ev.pointerType === 'pen') setTouchMode(true);
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* not fatal */ }
    var w = pointerToWorld(ev);
    game.setTipTarget(w.x, w.y);
    if (!touchMode) doAction();
  });

  function releasePointer() { game.gathering = false; }
  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  window.addEventListener('blur', releasePointer);
  canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

  window.addEventListener('keydown', function (ev) {
    if (ev.target && /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName)) return;
    switch (ev.key) {
      case ' ':
        ev.preventDefault();
        if (game.phase === 'fighting') game.gathering = true; else game.strike();
        break;
      case 'r': case 'R':
        if (game.phase !== 'fighting') { game.resetDrift(); game.cast(); }
        break;
      case 'l': case 'L':
        el.lies.checked = !el.lies.checked;
        game.showLies = el.lies.checked;
        break;
      case 'p': case 'P':
        game.paused = !game.paused;
        break;
      case '1': setPreset('riffle'); break;
      case '2': setPreset('pocket'); break;
      case '3': setPreset('tailout'); break;
    }
  });

  window.addEventListener('keyup', function (ev) {
    if (ev.key === ' ') game.gathering = false;
  });

  el['btn-action'].addEventListener('pointerdown', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    doAction();
  });
  el['btn-action'].addEventListener('pointerup', releasePointer);
  el['btn-action'].addEventListener('pointercancel', releasePointer);
  el['btn-action'].addEventListener('pointerleave', releasePointer);
  el['btn-action'].addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

  el['touch-controls'].hidden = !touchMode;

  window.addEventListener('resize', function () { renderer.resize(); });
  window.addEventListener('orientationchange', function () {
    setTimeout(function () { renderer.resize(); }, 120);
  });

  // ---- controls ------------------------------------------------------------

  function setPreset(key) {
    el.preset.value = key;
    game.setPreset(key);
  }

  el.preset.addEventListener('change', function () { game.setPreset(el.preset.value); });

  el.bead.addEventListener('input', function () {
    var mm = parseFloat(el.bead.value);
    el['bead-val'].textContent = mm.toFixed(1) + ' mm';
    game.setRig({ pointBead: mm, dropperBead: Math.max(2.0, mm - 1) });
  });

  el.leader.addEventListener('input', function () {
    var m = parseFloat(el.leader.value);
    el['leader-val'].textContent = m.toFixed(1) + ' m';
    game.setRig({ leaderLength: m });
  });

  el.tippet.addEventListener('change', function () {
    game.setRig({ tippet: parseFloat(el.tippet.value) });
  });

  el.dropper.addEventListener('change', function () {
    game.setRig({ useDropper: el.dropper.checked });
  });

  el.lies.addEventListener('change', function () { game.showLies = el.lies.checked; });

  el.reset.addEventListener('click', function () {
    var keep = game.rig.config;
    game = new EN.Game();
    game.setRig(keep);
    game.setPreset(el.preset.value);
    game.showLies = el.lies.checked;
    renderer.game = game;
    EN.game = game;
  });

  // ---- HUD -----------------------------------------------------------------

  var PHASE_TEXT = {
    ready: 'Ready — <strong>click</strong> or <kbd>Space</kbd> to tuck a cast upstream',
    drifting: 'Drifting — lead the sighter, strike at anything odd',
    fighting: 'Fish on — <strong>hold</strong> to gather line, release to give it'
  };

  var PHASE_TEXT_TOUCH = {
    ready: 'Drag to hold the rod tip — tap <strong>CAST</strong>',
    drifting: 'Drifting — lead the sighter, tap <strong>STRIKE</strong> at anything odd',
    fighting: 'Fish on — <strong>hold GATHER</strong> to take line, let go to give it'
  };

  var ACTION_LABEL = { ready: 'CAST', drifting: 'STRIKE', fighting: 'GATHER' };

  function setFill(node, pct, color) {
    node.style.width = clamp(pct, 0, 100).toFixed(1) + '%';
    node.style.background = color;
  }

  var logSig = '';

  function updateHud() {
    var hud = game.hudState();
    var s = game.stats;

    el.phase.innerHTML = game.paused
      ? 'Paused — <kbd>P</kbd> to resume'
      : (touchMode ? PHASE_TEXT_TOUCH : PHASE_TEXT)[game.phase];
    if (touchMode) el['btn-action'].textContent = ACTION_LABEL[game.phase] || 'CAST';

    // Contact: the band is where a take actually reaches you.
    var c = hud.contact * 100;
    el['contact-val'].textContent = c.toFixed(0) + '%';
    el['contact-band'].style.left = '82%';
    el['contact-band'].style.width = '17%';
    setFill(el['contact-fill'], c,
      c < 78 ? '#5b7f8c' : (c > 99.4 ? '#ef6b5e' : '#6fd18a'));

    if (hud.depth === null) {
      el['depth-val'].textContent = 'in the air';
      setFill(el['depth-fill'], 0, '#5b7f8c');
    } else {
      el['depth-val'].textContent = hud.depth.toFixed(2) + ' m  ·  '
        + hud.totalDepth.toFixed(2) + ' m deep';
      setFill(el['depth-fill'], (1 - clamp(hud.depth / 0.7, 0, 1)) * 100,
        hud.depth < 0.30 ? '#6fd18a' : (hud.depth < 0.5 ? '#ffb03a' : '#ef6b5e'));
    }

    var drag = Math.abs(hud.drag);
    el['drag-val'].textContent = (hud.drag >= 0 ? '+' : '') + hud.drag.toFixed(2) + ' m/s';
    setFill(el['drag-fill'], clamp(drag / 0.5, 0, 1) * 100,
      drag < 0.14 ? '#6fd18a' : (drag < 0.3 ? '#ffb03a' : '#ef6b5e'));

    var fighting = game.phase === 'fighting';
    el['fight-section'].hidden = !fighting;
    el['drift-section'].classList.toggle('dim', fighting);
    if (fighting) {
      var maxLoad = 2.0;
      var breakAt = game.tippetStrength() * 0.86;
      var t = hud.tension / maxLoad * 100;
      el['tension-band'].style.left = '8%';
      el['tension-band'].style.width = Math.max(4, (breakAt / maxLoad * 100) - 8).toFixed(1) + '%';
      el['tension-val'].textContent = hud.tension.toFixed(2);
      setFill(el['tension-fill'], t,
        hud.tension > breakAt ? '#ef6b5e' : (hud.tension < 0.08 ? '#5b7f8c' : '#6fd18a'));
      el['stamina-val'].textContent = Math.round(hud.stamina * 100) + '%';
      setFill(el['stamina-fill'], hud.stamina * 100, '#ffb03a');
    }

    el['s-drifts'].textContent = s.drifts;
    el['s-takes'].textContent = s.takes;
    el['s-hooked'].textContent = s.hooked;
    el['s-landed'].textContent = s.landed;
    el['s-best'].textContent = s.bestFish ? s.bestFish + ' cm' : '—';
    el['s-zone'].textContent = s.drifts ? Math.round(s.zonePct) + '%' : '—';
    el['s-dead'].textContent = s.drifts ? Math.round(s.deadPct) + '%' : '—';
    el['s-last'].textContent = game.lastDrift ? game.lastDrift.score + ' / 100' : '—';

    var sig = game.messages.map(function (m) { return m.kind + m.text; }).join('|');
    if (sig !== logSig) {
      logSig = sig;
      el.log.innerHTML = '';
      game.messages.forEach(function (m) {
        var div = document.createElement('div');
        div.className = 'msg ' + m.kind;
        div.textContent = m.text;
        el.log.appendChild(div);
      });
    }
  }

  // ---- loop ----------------------------------------------------------------

  var last = performance.now();
  var hudTimer = 0;

  function frame(now) {
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    game.update(dt);
    if (!game.paused) renderer.update(dt);
    renderer.draw();

    hudTimer += dt;
    if (hudTimer > 1 / 30) { hudTimer = 0; updateHud(); }

    requestAnimationFrame(frame);
  }

  renderer.resize();
  updateHud();
  requestAnimationFrame(frame);
})(window.EN);
