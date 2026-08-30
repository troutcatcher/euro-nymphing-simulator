/*
 * main.js — wiring: input, the frame loop, and the HUD.
 */
(function (EN) {
  'use strict';

  var clamp = EN.clamp;
  var canvas = document.getElementById('scene');
  var game = new EN.Game();
  var renderer = new EN.Renderer(canvas, game);
  EN.game = game;       // handy from the console when you want to poke at the sim
  EN.renderer = renderer;

  var el = {};
  ['phase', 'log', 'drift-section', 'contact-val', 'contact-fill', 'contact-band', 'depth-val', 'depth-fill',
   'drag-val', 'drag-fill', 'fight-section', 'tension-val', 'tension-fill', 'tension-band',
   'stamina-val', 'stamina-fill', 'preset', 'bead', 'bead-val', 'leader', 'leader-val',
   'tippet', 'dropper', 'lies', 'reset', 's-drifts', 's-takes', 's-hooked', 's-landed',
   's-best', 's-zone', 's-dead', 's-last',
   'lift', 'lift-sens', 'lift-val', 'lift-field', 'lift-read', 'lift-fill',
   'btn-full', 'btn-sound', 'hud-mini', 'rotate-hint', 'm-contact', 'm-contact-v', 'm-depth',
   'm-depth-v', 'm-drag', 'm-drag-v', 'm-fight', 'm-tension', 'm-tension-v'
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  // ---- input ---------------------------------------------------------------

  // Everything is done with the rod itself: sweep it to cast, lift it to set,
  // hold the pointer down to gather line while a fish is on.
  var touchMode = false;
  try {
    touchMode = window.matchMedia('(pointer: coarse)').matches;
  } catch (e) { /* older browsers: fall back to detecting a touch pointer */ }

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
    if (ev.pointerType === 'touch' || ev.pointerType === 'pen') touchMode = true;
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* not fatal */ }
    var w = pointerToWorld(ev);
    game.setTipTarget(w.x, w.y);
    // Only means anything with a fish on, so it costs nothing the rest of the time.
    game.gathering = true;
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
        game.gathering = true;
        break;
      case 'r': case 'R':
        if (game.phase === 'fishing') game.resetDrift();
        break;
      case 'c': case 'C':
        // Keyboard-only fallback for anyone who cannot get the sweep to load.
        if (game.phase === 'fishing') game.cast();
        break;
      case 'l': case 'L':
        el.lies.checked = !el.lies.checked;
        game.showLies = el.lies.checked;
        break;
      case 'p': case 'P':
        game.paused = !game.paused;
        break;
      case 'f': case 'F':
        toggleFullscreen();
        break;
      case 'm': case 'M':
        toggleSound();
        break;
      case '1': setPreset('riffle'); break;
      case '2': setPreset('pocket'); break;
      case '3': setPreset('tailout'); break;
      case '4': setPreset('boulders'); break;
      case '5': setPreset('stained'); break;
    }
  });

  window.addEventListener('keyup', function (ev) {
    if (ev.key === ' ') game.gathering = false;
  });

  // ---- sound ---------------------------------------------------------------

  // Browsers will not let audio start without a gesture, so the context is
  // created on the first interaction and the preference is remembered.
  EN.audio = new EN.Audio();
  var soundWanted = true;
  try {
    var saved = window.localStorage.getItem('en-sound');
    if (saved !== null) soundWanted = saved === '1';
  } catch (e) { /* private windows and blocked storage */ }

  function paintSound() {
    el['btn-sound'].textContent = soundWanted ? '🔊' : '🔈';
    el['btn-sound'].classList.toggle('on', soundWanted && EN.audio.enabled);
    el['btn-sound'].title = soundWanted ? 'Sound on (M)' : 'Sound off (M)';
  }

  function applySound() {
    EN.audio.setEnabled(soundWanted);
    if (EN.audio.enabled) EN.audio.setRiver(game.river.preset);
    paintSound();
  }

  function toggleSound() {
    soundWanted = !soundWanted;
    try { window.localStorage.setItem('en-sound', soundWanted ? '1' : '0'); } catch (e) {}
    applySound();
  }

  // The first gesture of any kind is what unlocks the audio context.
  function unlockAudio() {
    if (soundWanted && !EN.audio.enabled) applySound();
    else EN.audio.resume();
  }
  window.addEventListener('pointerdown', unlockAudio, true);
  window.addEventListener('keydown', unlockAudio, true);

  el['btn-sound'].addEventListener('click', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    toggleSound();
  });
  paintSound();

  // ---- full screen ---------------------------------------------------------

  // Immersive mode is its own thing: it hides the panel and moves the meters to
  // the top edge. Native fullscreen is requested on top of that when the
  // browser allows it — inside an embedded frame it often does not, and the
  // mode still has to work.
  var immersive = false;
  var wentFullscreen = false;

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function lockLandscape() {
    try {
      if (screen.orientation && screen.orientation.lock) {
        var r = screen.orientation.lock('landscape');
        if (r && r.catch) r.catch(function () { /* desktop and iOS decline */ });
      }
    } catch (e) { /* not supported */ }
  }

  function setImmersive(on) {
    immersive = on;
    document.body.classList.toggle('immersive', on);
    // The canvas box changes size, so refit on the next frame.
    requestAnimationFrame(function () { renderer.resize(); });
    setTimeout(function () { renderer.resize(); }, 160);
  }

  function toggleFullscreen() {
    if (immersive) {
      setImmersive(false);
      if (fullscreenElement()) {
        var exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) { try { exit.call(document); } catch (e) { /* ignore */ } }
      }
      wentFullscreen = false;
      try {
        if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
      } catch (e) { /* ignore */ }
      return;
    }

    setImmersive(true);
    var node = document.documentElement;
    var req = node.requestFullscreen || node.webkitRequestFullscreen;
    if (!req) { lockLandscape(); return; }
    try {
      var p = req.call(node);
      if (p && p.then) {
        p.then(function () { wentFullscreen = true; lockLandscape(); })
         .catch(function () { /* embedded frames may refuse; immersive still applies */ });
      } else {
        wentFullscreen = true;
        lockLandscape();
      }
    } catch (e) { /* immersive still applies */ }
  }

  el['btn-full'].addEventListener('click', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    toggleFullscreen();
  });

  function onFullscreenChange() {
    // Leaving fullscreen by the browser's own gesture should leave the mode too.
    if (wentFullscreen && !fullscreenElement()) {
      wentFullscreen = false;
      setImmersive(false);
    } else {
      renderer.resize();
    }
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

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

  var SENS_LABEL = { 1: 'very firm', 2: 'firm', 3: 'normal', 4: 'light', 5: 'hair trigger' };

  function applyLiftSettings() {
    var sens = parseInt(el['lift-sens'].value, 10);
    game.liftStrike = el.lift.checked;
    game.liftThreshold = 0.38 - (sens - 1) * 0.06;
    el['lift-val'].textContent = SENS_LABEL[sens];
    el['lift-field'].style.opacity = el.lift.checked ? '1' : '0.4';
  }

  el.lift.addEventListener('change', applyLiftSettings);
  el['lift-sens'].addEventListener('input', applyLiftSettings);

  el.reset.addEventListener('click', function () {
    var keep = game.rig.config;
    game = new EN.Game();
    game.setRig(keep);
    game.setPreset(el.preset.value);
    game.showLies = el.lies.checked;
    renderer.game = game;
    EN.game = game;
    applyLiftSettings();
  });

  // ---- HUD -----------------------------------------------------------------

  var PHASE_TEXT = {
    idle: 'Sweep the rod upstream to flick the flies out',
    drifting: 'Drifting — lead the sighter, <strong>sweep the rod up</strong> to set',
    fighting: 'Fish on — <strong>hold</strong> to gather line, release to give it',
    netting: 'Netting it…'
  };

  var PHASE_TEXT_TOUCH = {
    idle: 'Sweep the rod upstream to flick the flies out',
    drifting: 'Drifting — lead the sighter, <strong>flick up</strong> to set',
    fighting: 'Fish on — <strong>press and hold</strong> to gather line, let go to give it',
    netting: 'Netting it…'
  };

  function setFill(node, pct, color) {
    node.style.width = clamp(pct, 0, 100).toFixed(1) + '%';
    node.style.background = color;
  }

  var logSig = '';

  function updateHud() {
    var hud = game.hudState();
    var s = game.stats;

    var cue = game.phase === 'netting' ? 'netting'
            : game.phase === 'fighting' ? 'fighting'
            : (game.driftActive ? 'drifting' : 'idle');
    el.phase.innerHTML = game.paused
      ? 'Paused — <kbd>P</kbd> to resume'
      : (touchMode ? PHASE_TEXT_TOUCH : PHASE_TEXT)[cue];

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

    if (immersive) {
      el['m-contact'].style.width = clamp(c, 0, 100).toFixed(1) + '%';
      el['m-contact'].style.background = el['contact-fill'].style.background;
      el['m-contact-v'].textContent = c.toFixed(0) + '%';

      el['m-depth'].style.width = el['depth-fill'].style.width;
      el['m-depth'].style.background = el['depth-fill'].style.background;
      el['m-depth-v'].textContent = hud.depth === null ? 'air' : hud.depth.toFixed(2) + 'm';

      el['m-drag'].style.width = el['drag-fill'].style.width;
      el['m-drag'].style.background = el['drag-fill'].style.background;
      el['m-drag-v'].textContent = hud.drag.toFixed(2);
    }

    // Sideways is the view this wants; say so once the screen is small enough
    // for it to matter.
    el['rotate-hint'].hidden = !(immersive && window.innerHeight > window.innerWidth
                                 && window.innerWidth < 620);

    var fighting = game.phase === 'fighting';
    el['fight-section'].hidden = !fighting;
    el['m-fight'].hidden = !fighting;
    el['drift-section'].classList.toggle('dim', fighting || !game.driftActive);
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

      if (immersive) {
        el['m-tension'].style.width = el['tension-fill'].style.width;
        el['m-tension'].style.background = el['tension-fill'].style.background;
        el['m-tension-v'].textContent = hud.tension.toFixed(2);
      }
    }

    // Show how close the last rod movement came to registering as a set.
    var liftPct = clamp(game.lift / Math.max(0.05, game.liftThreshold), 0, 1.4) * 71;
    el['lift-read'].textContent = game.liftStrike
      ? (game.liftCooldown > 0 ? 'set' : Math.round(liftPct / 0.71) + '%')
      : 'off';
    setFill(el['lift-fill'], liftPct,
      game.liftCooldown > 0 ? '#ffd75e' : (liftPct > 71 ? '#ffb03a' : '#5b7f8c'));

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

  applyLiftSettings();
  renderer.resize();
  updateHud();
  requestAnimationFrame(frame);
})(window.EN);
