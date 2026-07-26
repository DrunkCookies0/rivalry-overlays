/* =============================================================================
 * Who has our port?  (main process)
 * -----------------------------------------------------------------------------
 * The app needs three fixed loopback ports. When one is taken the old message
 * was "is another overlay app running? close it" — which is a guess handed to
 * the producer to act on.
 *
 * It is answerable: Windows can map a listening port to a PID, and a PID to an
 * image name. The overwhelmingly common cause is an OLDER version of this same
 * app still installed and auto-starting with Windows (it enables that on first
 * run), so a fresh install of the renamed build comes up dead with no clue why.
 * Naming the process turns a dead end into an instruction.
 *
 * Read-only. This never kills anything: the port squatter might be a real
 * broadcast in progress on the older build, and that is the producer's call.
 * ===========================================================================*/

"use strict";

const { execFileSync } = require("child_process");

// Any of our own product names, current or historical. Used to tell "your old
// version is in the way" from "something unrelated took the port".
const OUR_NAMES = [/casterverse/i, /rivalry.*overlay/i];

function parseNetstatPid(output, port) {
  for (const line of String(output).split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    // "  TCP    127.0.0.1:49080    0.0.0.0:0    LISTENING    50344"
    const cols = line.trim().split(/\s+/);
    const local = cols[1] || "";
    if (!local.endsWith(":" + port)) continue;
    const pid = Number(cols[cols.length - 1]);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return null;
}

function parseTasklistName(output) {
  // `tasklist /FI "PID eq n" /NH` -> "RIVALRY Overlay Beta.exe  50344 Console ..."
  const line = String(output).split(/\r?\n/).find((l) => /\.exe/i.test(l));
  if (!line) return null;
  const m = /^(.*?\.exe)\s/i.exec(line.trim());
  return m ? m[1].trim() : null;
}

/**
 * @returns {{pid:number|null, name:string|null, isOurs:boolean}}
 */
function findPortOwner(port, { exec = execFileSync } = {}) {
  const unknown = { pid: null, name: null, isOurs: false };
  try {
    const pid = parseNetstatPid(
      exec("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
      port
    );
    if (!pid) return unknown;
    let name = null;
    try {
      name = parseTasklistName(
        exec("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      );
    } catch { /* PID vanished between the two calls */ }
    return { pid, name, isOurs: !!name && OUR_NAMES.some((re) => re.test(name)) };
  } catch {
    return unknown;
  }
}

/**
 * The message a producer actually needs, given who holds the port.
 * @param {string} [selfName] this process's own exe name, so a SECOND COPY of
 *   the current app isn't described as "an older version" — different problem,
 *   different fix.
 */
function portConflictMessage(port, what, owner, appTitle, selfName) {
  const lines = [`The ${what} could not start because port ${port} is already taken.`, ""];
  const sameBuild = owner && owner.name && selfName &&
    owner.name.toLowerCase() === String(selfName).toLowerCase();

  if (sameBuild) {
    lines.push(
      `${appTitle} is already running (process ${owner.pid}).`,
      "",
      "Look for its icon in the system tray — you may already have what you need.",
      "If it is stuck, quit it from the tray and start it again."
    );
  } else if (owner && owner.name && owner.isOurs) {
    lines.push(
      `It is being used by ${owner.name} (process ${owner.pid}) — an older version of this app.`,
      "",
      "Quit it from its tray icon (or uninstall it from Windows Settings, Apps),",
      `then start ${appTitle} again.`,
      "",
      "Older versions start automatically with Windows, so uninstalling is the",
      "fix that sticks."
    );
  } else if (owner && owner.name) {
    lines.push(
      `It is being used by ${owner.name} (process ${owner.pid}).`,
      "",
      `Close that program, then start ${appTitle} again.`
    );
  } else {
    lines.push(
      "Is another overlay app (or a second copy of this one) running?",
      `Close it, then restart ${appTitle}.`
    );
  }
  return lines.join("\n");
}

module.exports = { findPortOwner, portConflictMessage, parseNetstatPid, parseTasklistName };
