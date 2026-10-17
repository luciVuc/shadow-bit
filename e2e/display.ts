// Makes the Electron smoke suite runnable with no physical display.
//
// Electron on Linux is not headless-capable. `--headless=new` fails at
// `GtkStyleContext without a display connection`, and `--ozone-platform=headless`
// SIGSEGVs before the first window — verified against a minimal BrowserWindow
// app, so neither is a defect in ShadowBit. What works is a virtual X server,
// which is why this module provisions Xvfb rather than passing clever flags.
//
// The display is only provisioned when one is not already available, so running
// on a developer desktop (or macOS, as CI does) changes nothing. Set
// SHADOWBIT_HEADLESS=1 to force a virtual display even when DISPLAY is set —
// useful for proving the headless path works on a machine that has a display.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";

export interface Display {
  /** The DISPLAY value to hand to Electron, e.g. ":99". */
  display: string;
  /** True when we started a server and must stop it. */
  ours: boolean;
  cleanup: () => void;
}

const PASSTHROUGH: Display = {
  display: "",
  ours: false,
  cleanup: () => {},
};

function which(bin: string): string | null {
  const r = spawnSync("sh", ["-c", `command -v ${bin}`], {
    encoding: "utf8",
  });
  const out = r.stdout.trim();
  return r.status === 0 && out ? out : null;
}

/** True when the caller asked for the virtual-display path unconditionally. */
export function headlessRequested(): boolean {
  return (
    process.env.SHADOWBIT_HEADLESS === "1" ||
    process.argv.includes("--headless")
  );
}

/** First display number whose socket and lock are both free. */
function freeDisplay(): number {
  for (let n = 99; n < 130; n++) {
    if (
      !fs.existsSync(`/tmp/.X${n}-lock`) &&
      !fs.existsSync(`/tmp/.X11-unix/X${n}`)
    ) {
      return n;
    }
  }
  throw new Error(
    "no free X display number in :99-:129; set SHADOWBIT_HEADLESS_DISPLAY",
  );
}

/**
 * Return a DISPLAY that Electron can actually use.
 *
 * @param opts.force provision Xvfb even if DISPLAY is already set
 */
export async function ensureDisplay(
  opts: { force?: boolean } = {},
): Promise<Display> {
  const force = opts.force ?? headlessRequested();

  // Only Linux/X11 needs help. macOS has a window server and Windows uses its
  // own display stack; neither sets DISPLAY, so without this branch a developer
  // on either would be told to install Xvfb for a suite that already runs.
  if (process.platform !== "linux" && !process.env.DISPLAY) return PASSTHROUGH;

  if (!force && process.env.DISPLAY) return PASSTHROUGH;

  const bin =
    process.env.SHADOWBIT_XVFB ??
    process.env.SHADOWBIT_HEADLESS_DISPLAY ??
    which("Xvfb") ??
    which("xvfb-run");

  if (!bin) {
    throw new Error(
      "no display available and no Xvfb found.\n" +
        "Electron requires an X server on Linux; it has no working headless mode.\n" +
        "Install one (Debian/Ubuntu: `apt-get install -y xvfb`,\n" +
        "macOS: `brew install xvfb`, Fedora: `dnf install xorg-x11-server-Xvfb`)\n" +
        "or run `npm run test:gui` on a machine/VM that already has a display.\n" +
        "CI does not need this: GitHub's ubuntu runners ship Xvfb.",
    );
  }

  if (bin.endsWith("xvfb-run")) {
    // xvfb-run only makes sense if it wraps the whole process tree, which is
    // too late here. Fail loudly rather than silently ignoring the request.
    throw new Error(
      `${bin} cannot be used from inside the test process — it must wrap the ` +
        "command (`xvfb-run npm run test:gui`). Install the Xvfb package so the " +
        "`Xvfb` binary itself is available, or use that wrapper form.",
    );
  }

  const num = freeDisplay();
  const display = `:${num}`;
  const proc = spawn(
    bin,
    [display, "-screen", "0", "1280x1024x24", "-nolisten", "tcp"],
    { stdio: "ignore", detached: false },
  );

  const socket = `/tmp/.X11-unix/X${num}`;
  const stop = () => {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  };

  // Wait on real timers rather than a blocking sleep: a busy-wait would starve
  // the event loop, and the 'error'/'exit' events below are exactly what tells
  // us the binary is missing or died. Those only arrive if the loop is free.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${bin} did not create ${socket} within 10s`));
    }, 10_000);

    const onError = (e: Error) => {
      cleanup();
      reject(new Error(`could not run ${bin}: ${e.message}`));
    };
    const onExit = (code: number | null, signal: string | null) => {
      cleanup();
      reject(
        new Error(
          `${bin} exited immediately (code ${code}, signal ${signal}); ` +
            `cannot create ${display}`,
        ),
      );
    };
    const onSocket = () => {
      cleanup();
      resolve();
    };
    const poll = setInterval(() => {
      if (fs.existsSync(socket)) onSocket();
    }, 50);

    function cleanup() {
      clearTimeout(timer);
      clearInterval(poll);
      proc.off("error", onError);
      proc.off("exit", onExit);
    }

    proc.on("error", onError);
    proc.on("exit", onExit);
    if (fs.existsSync(socket)) onSocket();
  }).catch((e) => {
    stop();
    throw e;
  });

  return { display, ours: true, cleanup: stop };
}
