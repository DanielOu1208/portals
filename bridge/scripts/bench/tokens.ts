import { agentInstructions, guide } from "../../src/portals/guide.ts";
import { recipe } from "./registry.ts";
import { bridgeWith, table, type Cell, type Run, type Table } from "./run.ts";

// `tokens`: what agents are given to read because of the fleet, in characters and about
// that many tokens (a quarter). No model is called: these are the lengths of the texts
// the bridge puts into prompts and of what the `portals` command prints.

/** Where an installed bridge's command is, for a user with a name of usual length: the path is part of the instructions. */
const usualCommand = "/Users/username/Library/Application Support/portals-bridge/bin/portals";

export async function tokens(run: Run): Promise<Table[]> {
  const threads = run.quick ? 60 : 1000;
  run.say(`tokens: what agents are given, with ${threads} threads on the list`);
  const rows: Cell[][] = [];
  const row = (what: string, text: string, paid: string) => rows.push([what, text.length, Math.round(text.length / 4), paid]);

  row("The agents' instructions about the portals command", agentInstructions(usualCommand), "In every Claude Code thread's system prompt; once in each new Codex thread");
  row("`portals guide`", guide, "Each time an agent runs it: once in a thread that uses the command");

  const { bridge, written } = await bridgeWith(run, "tokens", { threads, long: true });
  try {
    const printed = async (args: string[]) => {
      const ran = await run.scratch.portals(bridge.home, args);
      if (ran.code !== 0) throw new Error(`portals ${args[0]} failed: ${ran.stderr}`);
      return ran.stdout;
    };
    const long = written.ids[0];
    const turn = `a thread whose last turn has a reply of ${recipe.longReply} characters, ${recipe.longReasoning} of reasoning and a tool's output of ${recipe.longToolOutput}`;
    row(`\`portals threads\`, ${threads} threads on the list`, await printed(["threads"]), "Every call (the newest 50 are printed)");
    row(`\`portals read\` of ${turn}`, await printed(["read", long]), "Every call");
    row("`portals wait` on the same thread, at rest", await printed(["wait", long]), "Every wait, and every send or start with --wait");
  } finally {
    await bridge.stop();
  }

  return [
    table("tokens", "what agents are given because of the fleet", ["What", "Characters", "About that many tokens", "Paid"], rows, [
      "A token is taken as four characters. Nothing is sent to a model.",
      "The instructions are measured with the path of an installed bridge's command for a user name of eight letters.",
      "`portals read` cuts a tool's output and arguments at 2000 characters, and nothing else; a wait's answer carries the whole reply.",
    ]),
  ];
}
