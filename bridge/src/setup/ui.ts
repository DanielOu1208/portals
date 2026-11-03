import * as clack from "@clack/prompts";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { styleText } from "node:util";

// How setup talks to the person running it: short lines, a question when a choice is
// theirs, and with `--yes` (or no terminal) the default answer to every question,
// printed so the output still reads as what happened. In a terminal someone is at,
// ClackUi draws it as a guided flow (@clack/prompts): arrow-key choices, a spinner while
// something slow runs, and the steps joined by a line down the left; elsewhere
// TerminalUi prints plain lines, which read well in a log.

export interface Choice<T extends string> {
  value: T;
  label: string;
  /** A few words shown beside the choice while it is picked. */
  hint?: string;
}

export interface Ui {
  /** The command's title, and a line on what it does: first, once. */
  begin(title: string, subtitle?: string): void;
  /** The last line, once the command is over. */
  end(text: string): void;
  /** Runs `work`, saying meanwhile what is happening (`text`, as "Installing the bridge"). */
  task<T>(text: string, work: () => Promise<T>): Promise<T>;
  /** A line of text under the current step. */
  say(text: string): void;
  /** A new step: a blank line and its title. */
  step(title: string): void;
  /** Something done or found. */
  ok(text: string): void;
  /** Something missing or wrong, and what to do about it. */
  warn(text: string): void;
  /** Lines printed as they are (a QR code, a link). */
  raw(text: string): void;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  choose<T extends string>(question: string, choices: readonly Choice<T>[], fallback: T): Promise<T>;
  /** Typed without echo; "" when nobody can type. */
  secret(question: string): Promise<string>;
}

export class TerminalUi implements Ui {
  private readonly interactive: boolean;
  private readonly bold: (text: string) => string;

  /** `interactive` false answers every question with its default. */
  constructor(options: { interactive: boolean }) {
    this.interactive = options.interactive && Boolean(process.stdin.isTTY);
    this.bold = process.stdout.isTTY ? (text) => `\x1b[1m${text}\x1b[22m` : (text) => text;
  }

  begin(title: string, subtitle?: string): void {
    process.stdout.write(this.bold(title) + "\n");
    if (subtitle) this.say(subtitle);
  }

  end(text: string): void {
    if (text) process.stdout.write(`\n${text}\n`);
  }

  task<T>(_text: string, work: () => Promise<T>): Promise<T> {
    return work();
  }

  say(text: string): void {
    process.stdout.write(indent(text, "  ") + "\n");
  }

  step(title: string): void {
    process.stdout.write(`\n${this.bold(title)}\n`);
  }

  ok(text: string): void {
    process.stdout.write(indent(text, "  ✓ ", "    ") + "\n");
  }

  warn(text: string): void {
    process.stdout.write(indent(text, "  ! ", "    ") + "\n");
  }

  raw(text: string): void {
    process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  }

  async confirm(question: string, fallback: boolean): Promise<boolean> {
    const hint = fallback ? "Y/n" : "y/N";
    if (!this.interactive) {
      this.say(`${question} [${hint}] ${fallback ? "yes" : "no"}`);
      return fallback;
    }
    for (;;) {
      const answer = (await this.line(`  ${question} [${hint}] `)).trim().toLowerCase();
      if (answer === "") return fallback;
      if (["y", "yes"].includes(answer)) return true;
      if (["n", "no"].includes(answer)) return false;
    }
  }

  async choose<T extends string>(question: string, choices: readonly Choice<T>[], fallback: T): Promise<T> {
    const fallbackIndex = Math.max(0, choices.findIndex((choice) => choice.value === fallback));
    this.say(question);
    choices.forEach((choice, index) => this.say(`  ${index + 1}. ${choice.label}${index === fallbackIndex ? " (default)" : ""}`));
    if (!this.interactive) {
      this.say(`→ ${fallbackIndex + 1}`);
      return choices[fallbackIndex].value;
    }
    for (;;) {
      const answer = (await this.line(`  Choose 1–${choices.length} [${fallbackIndex + 1}] `)).trim();
      if (answer === "") return choices[fallbackIndex].value;
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && index >= 0 && index < choices.length) return choices[index].value;
    }
  }

  async secret(question: string): Promise<string> {
    if (!this.interactive) return "";
    return readHidden(`  ${question} `);
  }

  private async line(prompt: string): Promise<string> {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await reader.question(prompt);
    } finally {
      reader.close();
    }
  }
}

/** Ctrl-C (or Esc) at a question: what is said, then `run` ends the command. */
export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/**
 * The guided flow for someone at a terminal. Questions are answered with the arrow keys
 * and Return; Ctrl-C at one stops the command with a line saying so.
 */
export class ClackUi implements Ui {
  /** The flow has its last line (end, or a cancel). */
  private ended = false;

  /** After the command: a last line for a flow that ended without one (it stopped early). */
  close(code: number): void {
    if (this.ended || code === 130) return;
    this.end(code === 0 ? "Done." : styleText("yellow", "Not finished: what's above says why."));
  }

  begin(title: string, subtitle?: string): void {
    process.stdout.write("\n" + gate.map((line) => "  " + line).join("\n") + "\n\n");
    // Inverse video: the terminal's own two colours, light or dark, like the icon.
    clack.intro(styleText(["inverse", "bold"], ` ${title} `));
    if (subtitle) clack.log.message(this.fit(subtitle));
  }

  end(text: string): void {
    this.ended = true;
    clack.outro(text);
  }

  async task<T>(text: string, work: () => Promise<T>): Promise<T> {
    // Only what takes a moment gets a spinner; a quick step would just flicker.
    let spinner: ReturnType<typeof clack.spinner> | undefined;
    const timer = setTimeout(() => {
      spinner = clack.spinner();
      spinner.start(text);
    }, 400);
    try {
      return await work();
    } finally {
      clearTimeout(timer);
      spinner?.clear();
    }
  }

  say(text: string): void {
    clack.log.message(this.fit(text), { spacing: 0 });
  }

  step(title: string): void {
    clack.log.step(styleText("bold", title));
  }

  ok(text: string): void {
    clack.log.message(this.fit(text), { spacing: 0, symbol: styleText("green", "✓") });
  }

  warn(text: string): void {
    clack.log.message(this.fit(text), { spacing: 0, symbol: styleText("yellow", "!") });
  }

  raw(text: string): void {
    const bar = styleText("gray", "│");
    process.stdout.write(text.split("\n").map((line) => (line ? `${bar}  ${line}` : bar)).join("\n") + "\n");
  }

  async confirm(question: string, fallback: boolean): Promise<boolean> {
    return answered<boolean>(await clack.confirm({ message: this.fit(question, 16), initialValue: fallback }));
  }

  async choose<T extends string>(question: string, choices: readonly Choice<T>[], fallback: T): Promise<T> {
    const options = choices.map(({ value, label, hint }) => ({ value, label, hint }) as clack.Option<T>);
    return answered<T>(await clack.select<T>({ message: this.fit(question, 16), options, initialValue: fallback }));
  }

  async secret(question: string): Promise<string> {
    return answered<string>(await clack.password({ message: this.fit(question, 16), mask: "•" }));
  }

  /** `text` with the home folder as ~, wrapped to the terminal inside the line down the left (and `margin` more). */
  private fit(text: string, margin = 4): string {
    return wrap(tilde(text), Math.max(40, (process.stdout.columns ?? 80) - margin));
  }
}

/** Paths in the home folder written from ~, except inside quotes, where a shell would not expand it. */
function tilde(text: string): string {
  const home = homedir();
  return text.replace(new RegExp(`(?<!["'])${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=/|$)`, "g"), "~");
}

/** Each line of `text` broken at spaces to at most `width` columns; a longer word (a path) after a slash where it can be. */
export function wrap(text: string, width: number): string {
  return text
    .split("\n")
    .flatMap((paragraph) => {
      const lines: string[] = [];
      let line = "";
      for (const word of paragraph.split(" ")) {
        let rest = word;
        while (rest.length > width) {
          if (line) lines.push(line);
          const cut = rest.lastIndexOf("/", width - 1) + 1 || width;
          lines.push(rest.slice(0, cut));
          rest = rest.slice(cut);
          line = "";
        }
        if (!line) line = rest;
        else if (line.length + 1 + rest.length <= width) line += " " + rest;
        else {
          lines.push(line);
          line = rest;
        }
      }
      lines.push(line);
      return lines;
    })
    .join("\n");
}

/**
 * The Gate of Athena Archegetis, as on the app's icon: a low pediment on its cornice,
 * the architrave, four columns with the way through the middle wider, and the steps.
 * In half blocks, so each cell is two pixels tall and the pixels are about square.
 */
const gate = [
  "       ▄▄▄███▄▄▄       ",
  " ▄▄▄███████████████▄▄▄ ",
  " ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄ ",
  "   ██  ██     ██  ██   ",
  "   ██  ██     ██  ██   ",
  "   ██  ██     ██  ██   ",
  "▄█████████████████████▄",
];

/** A prompt's answer, or Cancelled after saying the command stopped. */
function answered<T>(value: T | symbol): T {
  if (clack.isCancel(value)) {
    clack.cancel("Stopped. Run it again any time: it keeps what is done.");
    throw new Cancelled();
  }
  return value as T;
}

/** Reads a line from the terminal without showing it, after writing `prompt` to `output`. Ctrl-C rejects. */
export function readHidden(prompt: string, output: NodeJS.WriteStream = process.stdout): Promise<string> {
  const input = process.stdin;
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let typed = "";
    const done = () => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
    };
    const onData = (data: Buffer) => {
      for (const character of data.toString("utf8")) {
        if (character === "\r" || character === "\n") {
          done();
          output.write("\n");
          resolve(typed);
          return;
        }
        if (character === "\u0003") {
          done();
          output.write("\n");
          reject(new Error("cancelled"));
          return;
        }
        typed = character === "\u007f" ? typed.slice(0, -1) : typed + character;
      }
    };
    input.on("data", onData);
  });
}

function indent(text: string, first: string, rest = "  "): string {
  return text
    .split("\n")
    .map((line, index) => (index === 0 ? first : rest) + line)
    .join("\n");
}
