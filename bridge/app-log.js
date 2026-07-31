/* =============================================================================
 * App log: persistent file log + in-memory ring buffer
 * -----------------------------------------------------------------------------
 * Until v1.0 every log line went to the console only, which is invisible in a
 * packaged install. A producer whose app misbehaves had nothing to send. This
 * module tees console.log/warn/error into:
 *   - <userData>/logs/casterverse.log  (append, rotated once at ROTATE_BYTES
 *     to casterverse.old.log, so disk use is bounded at ~2x the cap)
 *   - a ring buffer of the last RING_MAX lines, exposed via recentLines() for
 *     the diagnostics export
 *
 * Logging must NEVER take the app down: every filesystem touch is wrapped, and
 * on failure the tee degrades to console-only exactly as before.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");
const util = require("util");

const ROTATE_BYTES = 512 * 1024;
const RING_MAX = 400;

const ring = [];
let logFile = null;
let installed = false;

function stamp() {
  return new Date().toISOString();
}

function record(level, args) {
  let line;
  try {
    line = `${stamp()} ${level} ${util.format(...args)}`;
  } catch (e) {
    line = `${stamp()} ${level} [unformattable log line]`;
  }
  ring.push(line);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, line + "\n");
    const size = fs.statSync(logFile).size;
    if (size > ROTATE_BYTES) {
      const old = logFile.replace(/\.log$/, ".old.log");
      fs.rmSync(old, { force: true });
      fs.renameSync(logFile, old);
    }
  } catch (e) {
    // Disk trouble must not cascade; stop writing, keep the ring.
    logFile = null;
  }
}

/**
 * Start teeing console output. Safe to call once, early in boot; idempotent.
 * Returns the log file path (or null if the directory could not be created).
 */
function initAppLog(userDataDir) {
  if (!installed) {
    installed = true;
    for (const level of ["log", "warn", "error"]) {
      const original = console[level].bind(console);
      console[level] = (...args) => {
        record(level.toUpperCase(), args);
        original(...args);
      };
    }
  }
  try {
    const dir = path.join(userDataDir, "logs");
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, "casterverse.log");
  } catch (e) {
    logFile = null;
  }
  return logFile;
}

/** Last N ring-buffer lines (default: all retained), newest last. */
function recentLines(n) {
  return typeof n === "number" ? ring.slice(-n) : ring.slice();
}

function logFilePath() {
  return logFile;
}

module.exports = { initAppLog, recentLines, logFilePath, ROTATE_BYTES, RING_MAX };
