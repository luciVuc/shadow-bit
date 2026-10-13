// Interactive prompt helpers for the CLI (no external dependencies).
// Supports hidden password input by masking keystrokes.

import * as readline from "readline";

// --- piped (non-TTY) input: manual line queue -------------------------------
//
// readline over piped stdin is unreliable for sequential prompts: a fresh
// interface per question drops already-buffered lines, and a shared one can
// close before a question is registered (EOF race), leaving commands hanging
// or silently exiting 0. So for non-TTY stdin we consume raw chunks and hand
// out lines on demand.

let pipedStarted = false;
let pipedEnded = false;
let pipedPartial = "";
let pipedQueued: string[] = [];
let pipedWaiters: Array<(line: string) => void> = [];

function startPipedReader(): void {
  if (pipedStarted) return;
  pipedStarted = true;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    const parts = (pipedPartial + chunk).split("\n");
    pipedPartial = parts.pop()!;
    for (const p of parts) {
      // Strip only the CRLF terminator — never whitespace, so scripted
      // passwords survive exactly as written (M5).
      const line = p.replace(/\r$/, "");
      const w = pipedWaiters.shift();
      if (w) w(line);
      else pipedQueued.push(line);
    }
  });
  process.stdin.on("end", () => {
    pipedEnded = true;
    if (pipedPartial) {
      const line = pipedPartial.replace(/\r$/, "");
      pipedPartial = "";
      const w = pipedWaiters.shift();
      if (w) w(line);
      else pipedQueued.push(line);
    }
    while (pipedWaiters.length) pipedWaiters.shift()!("");
  });
  process.stdin.resume();
}

function nonTtyQuestion(question: string): Promise<string> {
  startPipedReader();
  process.stdout.write(question);
  return new Promise((resolve) => {
    if (pipedQueued.length) {
      resolve(pipedQueued.shift()!);
    } else if (pipedEnded) {
      resolve("");
    } else {
      pipedWaiters.push(resolve);
    }
  });
}

/** Ask a question and read one line on an interactive terminal. */
function ttyQuestion(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer); // raw — do not trim (passwords may have leading/trailing spaces)
    });
  });
}

/** Prompt for a line of visible input. */
export function prompt(question: string): Promise<string> {
  return process.stdin.isTTY ? ttyQuestion(question) : nonTtyQuestion(question);
}

/** Prompt for hidden (masked) input, e.g. a password. */
export function promptHidden(question: string): Promise<string> {
  // Non-TTY stdin (piped/scripted input): no terminal to mask in, so read a
  // plain line. Without this, raw-TTY mode is skipped and EOF mid-prompt
  // leaves the command hanging (or silently exiting with code 0).
  if (!process.stdin.isTTY) {
    return nonTtyQuestion(question);
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);

    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    let value = "";
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        if (code === 3) {
          // Ctrl-C
          stdout.write("\n");
          cleanup();
          process.exit(130);
        } else if (code === 13 || code === 10) {
          // Enter
          stdout.write("\n");
          cleanup();
          resolve(value);
          return;
        } else if (code === 127 || code === 8) {
          // Backspace
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
        } else if (code >= 32) {
          value += ch;
          stdout.write("*");
        }
      }
    };

    const cleanup = () => {
      stdin.removeListener("data", onData);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    stdin.on("data", onData);
  });
}

/** Prompt for a password twice and confirm they match. */
export async function promptNewPassword(label = "password"): Promise<string> {
  // Imported dynamically so the CLI keeps the single source of truth for the
  // policy: MIN_PASSWORD_LENGTH lives in core/vault.ts, which is where it is
  // enforced, and duplicating the literal here would let the prompt accept a
  // password the core then rejects. (There is no import cycle — this is about
  // not maintaining two copies of a security constant.)
  const { MIN_PASSWORD_LENGTH } = await import("../core/vault.js");
  const pwd = await promptHidden(`Set ${label}: `);
  if (!pwd) {
    throw new Error("Password cannot be empty.");
  }
  if (pwd.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  const confirm = await promptHidden(`Confirm ${label}: `);
  if (pwd !== confirm) {
    throw new Error("Passwords do not match.");
  }
  return pwd;
}

/** Yes/no confirmation. Whitespace is intentionally trimmed here (M5). */
export async function confirm(question: string): Promise<boolean> {
  const ans = (await prompt(`${question} [y/N] `)).trim().toLowerCase();
  return ans === "y" || ans === "yes";
}
