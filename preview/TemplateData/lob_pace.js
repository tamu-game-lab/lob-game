// Line of Balance - E29 (WO-287): the steady beat. The page runs the game's frame on the first requestAnimationFrame callback that
// comes at least 12.5 ms after the last one it ran in: a 60 Hz screen runs every callback, as before; 120 Hz every second one, a
// steady 60; 144 Hz every second one, 72. "At least 12.5 ms" is judged in whole refreshes of the period read from the browser's own
// timestamps, so that a screen whose refreshes add up to 12.5 ms exactly (240 Hz) or timestamps that jitter never flap between two
// beats. With no steady period (callbacks irregular, or far faster than any screen, as with the browser's frame cap off) it is the
// plain time rule. A gap can only be one refresh or longer, so a gap clearly shorter than the period believed disproves it at once
// (round 2: a stretch where the graphics card set the cadence had taught a period of two refreshes). Loaded by index.html before
// the game's loader, and by lob-tools/pace_selftest.js under Node. Plain ES5, as the page.
(function (root) {
  "use strict";

  var BEAT_MS = 12.5;
  // A period sample is the gap after a callback that ended within half of it: one that ended later may have missed a refresh.
  var PERIOD_SAMPLES = 24;
  var PERIOD_MIN_SAMPLES = 8;
  // Faster than any screen (400 Hz) is a browser without its frame cap; slower than 25 Hz is a stall or a hidden tab.
  var PERIOD_MIN_MS = 2.5;
  var PERIOD_MAX_MS = 40;
  // A multiple of the period that misses 12.5 ms by a twentieth of a refresh still meets it (240 Hz: three refreshes), and the
  // beat moves only once the period has gone a further twentieth past that boundary.
  var MEET = 0.05;
  var HOLD = 0.05;
  // Round 2, the hard floor under every belief: no frame runs sooner than this after the last. 12.5 ms less 1.25: room for three
  // refreshes of a 240 Hz screen (12.5 ms) with a timestamp jitter of a few tenths each way, and nothing a wrong period can open.
  var FLOOR_MS = 11.25;
  // The fps counter's line (?fps=1): the median gap between the browser's callbacks over about the last second.
  var GAP_WINDOW_MS = 1000;
  var GAP_SLOTS = 512;
  var PACE_OFF = /(?:^|[?&])pace=off(?:&|$)/;

  function byNumber(a, b) {
    return a - b;
  }

  // How far a gap may stray from the period and still be that period: jitter is tenths of a millisecond, this is 1.25 ms or more.
  function tolerance(period) {
    return Math.max(1.25, period * 0.15);
  }

  /** The rule alone: which browser callbacks the game's frame runs in. */
  function Beat() {
    this.lastRun = -1;
    this.previous = -1;
    this.previousBusy = 0;
    this.samples = [];
    this.sorted = [];
    this.period = 0;
    this.refreshes = 0;
  }

  // Every browser callback, before the rule: the gap since the previous callback of an unbroken chain. A gap shorter than the period
  // believed by more than its tolerance disproves it: back to the plain rule, and the period is read again from fresh samples.
  Beat.prototype.observe = function (time) {
    var gap = time - this.previous;
    if (this.previous >= 0 && this.period > 0 && gap < this.period - tolerance(this.period)) this.forget();
    if (this.previous >= 0 && this.previousBusy * 2 < gap && gap <= PERIOD_MAX_MS) {
      this.samples.push(gap);
      if (this.samples.length > PERIOD_SAMPLES) this.samples.shift();
      this.measure();
    }
    this.previous = time;
  };

  // After the callback: how long it ran from its timestamp. A chain that stops (nothing asked for the next refresh) gives no gap.
  Beat.prototype.finish = function (time, end, chained) {
    this.previousBusy = end - time;
    if (!chained) this.previous = -1;
  };

  Beat.prototype.forget = function () {
    this.samples.length = 0;
    this.period = 0;
    this.refreshes = 0;
  };

  // A long gap (a hidden tab, a stall) is one elapsed time like any other: the next callback runs one frame.
  Beat.prototype.due = function (time) {
    var elapsed = time - this.lastRun;
    var run = this.lastRun < 0 || elapsed < 0 || (elapsed >= FLOOR_MS &&
      (this.refreshes > 0 ? elapsed >= (this.refreshes - 0.5) * this.period : elapsed >= BEAT_MS));
    if (run) this.lastRun = time;
    return run;
  };

  Beat.prototype.measure = function () {
    var n = this.samples.length, sorted = this.sorted, sum = 0, count = 0, median, near, needed, i;
    if (n < PERIOD_MIN_SAMPLES) return;
    sorted.length = n;
    for (i = 0; i < n; i++) sorted[i] = this.samples[i];
    sorted.sort(byNumber);
    median = sorted[n >> 1];
    near = tolerance(median);
    for (i = 0; i < n; i++) {
      if (Math.abs(sorted[i] - median) <= near) {
        sum += sorted[i];
        count++;
      }
    }
    if (median < PERIOD_MIN_MS || count * 4 < n * 3) {
      this.period = 0;
      this.refreshes = 0;
      return;
    }
    this.period = sum / count;
    needed = BEAT_MS / this.period;
    if (this.refreshes > 0 && needed > this.refreshes - 1 + MEET - HOLD && needed <= this.refreshes + MEET + HOLD) return;
    this.refreshes = Math.max(1, Math.ceil(needed - MEET));
  };

  /**
   * Wraps win.requestAnimationFrame and cancelAnimationFrame. Callbacks are held and run, in the order they were registered and
   * with that browser callback's timestamp, in the first browser callback the rule lets through; one registered while they run
   * goes to the next run, as the browser's own does. Returns the pace, or null when ?pace=off is in the link (the page as W15).
   */
  function install(win, search) {
    var request = win.requestAnimationFrame, cancel = win.cancelAnimationFrame, clock = win.performance;
    var beat = new Beat(), held = [], running = [], nextId = 0, asked = false;
    var gapTimes = [], gapValues = [], gapNext = 0, gapCount = 0;
    if (PACE_OFF.test(search || "") || typeof request !== "function" || request.lobPaced) return null;

    function ask() {
      if (asked) return;
      asked = true;
      request.call(win, tick);
    }

    // A callback that throws does not stop the others; its error still reaches the page's error handler, as the browser's would.
    function call(callback, time) {
      try {
        callback(time);
      } catch (error) {
        win.setTimeout(function () { throw error; }, 0);
      }
    }

    function keepGap(time, gap) {
      gapTimes[gapNext] = time;
      gapValues[gapNext] = gap;
      gapNext = (gapNext + 1) % GAP_SLOTS;
      if (gapCount < GAP_SLOTS) gapCount++;
    }

    function tick(time) {
      var i;
      asked = false;
      if (beat.previous >= 0) keepGap(time, time - beat.previous);
      beat.observe(time);
      if (held.length > 0 && beat.due(time)) {
        running = held;
        held = [];
        for (i = 0; i < running.length; i++) if (running[i].callback) call(running[i].callback, time);
        running = [];
      }
      if (held.length > 0) ask();
      beat.finish(time, clock.now(), asked);
    }

    function paced(callback) {
      if (typeof callback !== "function") throw new TypeError("requestAnimationFrame needs a function");
      nextId += 1;
      held.push({ id: nextId, callback: callback });
      ask();
      return nextId;
    }
    paced.lobPaced = true;

    // A held id leaves the queue; one in the run under way is skipped. The browser's own ids are never handed out.
    function unpaced(id) {
      var i;
      for (i = 0; i < held.length; i++) {
        if (held[i].id === id) {
          held.splice(i, 1);
          return;
        }
      }
      for (i = 0; i < running.length; i++) if (running[i].id === id) running[i].callback = null;
    }

    win.requestAnimationFrame = paced;
    if (typeof cancel === "function") win.cancelAnimationFrame = unpaced;

    return {
      beat: beat,
      /** The median gap between the browser's callbacks over about the last second, in ms; -1 before there is one. */
      gapMs: function () {
        var recent = [], newest, slot, i;
        if (gapCount === 0) return -1;
        newest = gapTimes[(gapNext - 1 + GAP_SLOTS) % GAP_SLOTS];
        for (i = 0; i < gapCount; i++) {
          slot = (gapNext - 1 - i + GAP_SLOTS) % GAP_SLOTS;
          if (newest - gapTimes[slot] > GAP_WINDOW_MS) break;
          recent.push(gapValues[slot]);
        }
        recent.sort(byNumber);
        return recent[recent.length >> 1];
      }
    };
  }

  var api = {
    Beat: Beat,
    /** The page's own pace once installed; the game's fps counter reads its gap (LobMemory.jslib, LobPace_GapMs). */
    active: null,
    install: function (win, search) {
      var pace = install(win, search);
      if (pace) api.active = pace;
      return pace;
    }
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  else root.lobPace = api;
})(this);
