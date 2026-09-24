/**
 * Every host orly installs into: where its hooks live, which adapter answers them, and
 * how its goal command is spelled. `orly install <host>` plans from this table; the
 * README's support table is rendered from it. Host knowledge lives here, not in src/.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { planJson, planText, renderCommand, toml, upsertEntry, withFrontmatter, type Planned } from "../src/install.ts";

export type Tier =
  | "native" // the host blocks the stop and hands the reason back
  | "emulated" // the host cannot block, but the adapter prompts it again with the reason
  | "cli"; // no hook can keep the agent working; call `orly judge` from your own loop

export type Host = {
  id: string;
  name: string;
  tier: Tier;
  /** The adapter file under adapters/, or null when the host is CLI-only. */
  adapter: string | null;
  /** The hook event names the adapter answers, in the host's own spelling. */
  events: string;
  /** How the goal command is spelled once installed. */
  command: string;
  /** Wired and exercised against the host's real payloads in this repository's tests. */
  verified: boolean;
  /** One line of caveat for the table. */
  note?: string;
  plan?: (ctx: Ctx) => Planned[];
};

export type Ctx = {
  /** The orly checkout the adapters run from. */
  root: string;
  /** Where project files go. */
  cwd: string;
  home: string;
  global: boolean;
};

/** How commands/orly.md and the skill spell the CLI; every rendering replaces it. */
const SOURCE_CLI = 'bun "${CLAUDE_PLUGIN_ROOT}/bin/orly.ts"';
const commandSource = (root: string) => readFileSync(join(root, "commands", "orly.md"), "utf8");
const skillSource = (root: string) => readFileSync(join(root, "skills", "orly", "SKILL.md"), "utf8");
const cli = (root: string) => `bun "${join(root, "bin", "orly.ts")}"`;
const adapterCommand = (root: string, file: string) => `bun "${join(root, "adapters", file)}"`;
const ours = (file: string) => (e: any) => JSON.stringify(e).includes(`/adapters/${file}`);

/** The command file, rendered for a markdown host. */
function markdownCommand(ctx: Ctx, path: string, args = "$ARGUMENTS", frontmatter = true): Planned {
  const { description, body } = renderCommand(commandSource(ctx.root), { args, from: SOURCE_CLI, cli: cli(ctx.root) });
  return planText(path, frontmatter ? withFrontmatter({ description }, body) : body);
}

/** The skill, with the CLI spelled for this checkout. */
function skill(ctx: Ctx, path: string): Planned {
  const { description, body } = renderCommand(skillSource(ctx.root), { args: "$ARGUMENTS", from: SOURCE_CLI, cli: cli(ctx.root) });
  return planText(path, withFrontmatter({ name: "orly", description }, body));
}

/** A Claude-dialect hooks object: {Event: [{matcher?, hooks: [{type: "command", command, timeout}]}]}. */
function claudeDialect(
  ctx: Ctx,
  settingsPath: string,
  adapter: string,
  events: Array<[string, string | undefined]>,
  timeoutSeconds = 30,
  hookExtra: Record<string, unknown> = {},
): Planned {
  return planJson(settingsPath, (doc) => {
    let changed = false;
    for (const [event, matcher] of events) {
      const entry: any = { hooks: [{ type: "command", command: adapterCommand(ctx.root, adapter), timeout: timeoutSeconds, ...hookExtra }] };
      if (matcher) entry.matcher = matcher;
      changed = upsertEntry(doc, ["hooks", event], entry, ours(adapter)) || changed;
    }
    return changed;
  });
}

const at = (ctx: Ctx, project: string, global: string) => (ctx.global ? join(ctx.home, global) : join(ctx.cwd, project));

export const HOSTS: Host[] = [
  {
    id: "claude",
    name: "Claude Code",
    tier: "native",
    adapter: "claude-code.ts",
    events: "Stop, SessionStart, PreToolUse",
    command: "/orly:orly (plugin) or /orly",
    verified: true,
    plan: (ctx) => [
      claudeDialect(ctx, at(ctx, ".claude/settings.json", ".claude/settings.json"), "claude-code.ts", [
        ["Stop", undefined],
        ["SessionStart", "startup|resume|clear"],
        ["PreToolUse", "Edit|Write|MultiEdit|NotebookEdit"],
      ]),
      markdownCommand(ctx, at(ctx, ".claude/commands/orly.md", ".claude/commands/orly.md")),
    ],
  },
  {
    id: "codex",
    name: "Codex CLI",
    tier: "native",
    adapter: "codex.ts",
    events: "Stop, SessionStart, PreToolUse",
    command: "$orly (skill)",
    verified: true,
    note: "hooks may need [features] hooks = true in config.toml on older builds",
    plan: (ctx) => [
      claudeDialect(ctx, at(ctx, ".codex/hooks.json", ".codex/hooks.json"), "codex.ts", [
        ["Stop", undefined],
        ["SessionStart", undefined],
        ["PreToolUse", undefined],
      ]),
      skill(ctx, at(ctx, ".agents/skills/orly/SKILL.md", ".codex/skills/orly/SKILL.md")),
    ],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    tier: "native",
    adapter: "gemini.ts",
    events: "AfterAgent, SessionStart, BeforeTool",
    command: "/orly",
    verified: true,
    note: "needs a build that fills transcript_path; older ones left it empty",
    plan: (ctx) => [
      planJson(at(ctx, ".gemini/settings.json", ".gemini/settings.json"), (doc) => {
        let changed = false;
        for (const [event, matcher] of [
          ["AfterAgent", undefined],
          ["SessionStart", undefined],
          ["BeforeTool", "write_file|replace"],
        ] as Array<[string, string | undefined]>) {
          const entry: any = { hooks: [{ name: "orly", type: "command", command: adapterCommand(ctx.root, "gemini.ts"), timeout: 30000 }] };
          if (matcher) entry.matcher = matcher;
          changed = upsertEntry(doc, ["hooks", event], entry, ours("gemini.ts")) || changed;
        }
        return changed;
      }),
      (() => {
        const { description, body } = renderCommand(commandSource(ctx.root), { args: "{{args}}", from: SOURCE_CLI, cli: cli(ctx.root) });
        return planText(at(ctx, ".gemini/commands/orly.toml", ".gemini/commands/orly.toml"), toml(description, body));
      })(),
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    tier: "emulated",
    adapter: "cursor.ts",
    events: "stop, sessionStart",
    command: "/orly",
    verified: true,
    note: "a block is a follow-up message; Cursor allows 5 in a row, and there is no pre-edit hook",
    plan: (ctx) => [
      planJson(
        at(ctx, ".cursor/hooks.json", ".cursor/hooks.json"),
        (doc) => {
          let changed = false;
          for (const event of ["stop", "sessionStart"]) {
            changed = upsertEntry(doc, ["hooks", event], { command: adapterCommand(ctx.root, "cursor.ts") }, ours("cursor.ts")) || changed;
          }
          return changed;
        },
        { version: 1 },
      ),
      markdownCommand(ctx, at(ctx, ".cursor/commands/orly.md", ".cursor/commands/orly.md"), "$ARGUMENTS", false),
    ],
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    tier: "native",
    adapter: "copilot.ts",
    events: "agentStop, sessionStart, preToolUse",
    command: "/orly (skill)",
    verified: true,
    note: "Copilot ends the turn after 8 blocks in a row",
    plan: (ctx) => [
      planJson(
        at(ctx, ".github/hooks/orly.json", ".copilot/hooks/orly.json"),
        (doc) => {
          let changed = false;
          for (const event of ["agentStop", "sessionStart", "preToolUse"]) {
            const entry = { type: "command", bash: adapterCommand(ctx.root, "copilot.ts"), timeoutSec: 30 };
            changed = upsertEntry(doc, ["hooks", event], entry, ours("copilot.ts")) || changed;
          }
          return changed;
        },
        { version: 1 },
      ),
      skill(ctx, at(ctx, ".github/skills/orly/SKILL.md", ".copilot/skills/orly/SKILL.md")),
    ],
  },
  {
    id: "droid",
    name: "Factory Droid",
    tier: "native",
    adapter: "claude-code.ts",
    events: "Stop, SessionStart, PreToolUse",
    command: "/orly",
    verified: false,
    note: "Claude Code's hook dialect; transcript format read by sniffing",
    plan: (ctx) => [
      claudeDialect(ctx, at(ctx, ".factory/settings.json", ".factory/settings.json"), "claude-code.ts", [
        ["Stop", undefined],
        ["SessionStart", undefined],
        ["PreToolUse", "Edit|Write|MultiEdit"],
      ]),
      markdownCommand(ctx, at(ctx, ".factory/commands/orly.md", ".factory/commands/orly.md")),
    ],
  },
  {
    id: "qwen",
    name: "Qwen Code",
    tier: "native",
    adapter: "claude-code.ts",
    events: "Stop, SessionStart, PreToolUse",
    command: "/orly",
    verified: false,
    note: "Claude Code's hook dialect; blocks capped by stopHookBlockingCap (8)",
    plan: (ctx) => [
      claudeDialect(
        ctx,
        at(ctx, ".qwen/settings.json", ".qwen/settings.json"),
        "claude-code.ts",
        [
          ["Stop", undefined],
          ["SessionStart", undefined],
          ["PreToolUse", "write_file|replace|edit"],
        ],
        30,
        { name: "orly" },
      ),
      markdownCommand(ctx, at(ctx, ".qwen/commands/orly.md", ".qwen/commands/orly.md"), "{{args}}"),
    ],
  },
  {
    id: "goose",
    name: "Goose",
    tier: "native",
    adapter: "goose.ts",
    events: "Stop, SessionStart, PreToolUse",
    command: "orly skill",
    verified: true,
    note: "no transcript in the payload; the turn comes from `goose session export`",
    plan: (ctx) => {
      const dir = at(ctx, ".agents/plugins/orly", ".agents/plugins/orly");
      const hooks: Record<string, unknown> = {};
      for (const event of ["Stop", "SessionStart", "PreToolUse"]) {
        hooks[event] = [{ matcher: ".*", hooks: [{ type: "command", command: adapterCommand(ctx.root, "goose.ts"), timeout: 30, on_failure: "allow" }] }];
      }
      return [
        planText(join(dir, "plugin.json"), JSON.stringify({ name: "orly", version: "0.3.0", description: "orly? — a turn-end gate" }, null, 2) + "\n"),
        planText(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks }, null, 2) + "\n"),
        skill(ctx, join(dir, "skills", "orly", "SKILL.md")),
      ];
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    tier: "emulated",
    adapter: "opencode.ts",
    events: "session.idle, session.created, tool.execute.before",
    command: "/orly",
    verified: true,
    note: "a block prompts the session again; orly's round cap ends the loop",
    plan: (ctx) => [
      planText(
        at(ctx, ".opencode/plugins/orly.ts", ".config/opencode/plugins/orly.ts"),
        `// orly? — written by \`orly install opencode\`; the plugin lives in the orly checkout.\nexport { default } from ${JSON.stringify(join(ctx.root, "adapters", "opencode.ts"))};\n`,
      ),
      markdownCommand(ctx, at(ctx, ".opencode/commands/orly.md", ".config/opencode/commands/orly.md")),
    ],
  },
  {
    id: "kilo",
    name: "Kilo Code",
    tier: "emulated",
    adapter: "opencode.ts",
    events: "session.idle, session.created, tool.execute.before",
    command: "/orly",
    verified: false,
    note: "OpenCode's plugin API under another name",
    plan: (ctx) => [
      planText(
        at(ctx, ".kilo/plugin/orly.ts", ".config/kilo/plugin/orly.ts"),
        `// orly? — written by \`orly install kilo\`; the plugin lives in the orly checkout.\nimport { OrlyPlugin } from ${JSON.stringify(join(ctx.root, "adapters", "opencode.ts"))};\nexport default { id: "orly", server: OrlyPlugin };\n`,
      ),
      markdownCommand(ctx, at(ctx, ".kilo/commands/orly.md", ".config/kilo/commands/orly.md")),
    ],
  },
  {
    id: "pi",
    name: "Pi",
    tier: "native",
    adapter: "pi.ts",
    events: "agent_end, session_start, tool_call",
    command: "/orly",
    verified: true,
    note: "or install as a package: pi install git:github.com/yesitsfebreeze/orly",
    plan: (ctx) => [
      planText(
        at(ctx, ".pi/extensions/orly.ts", ".pi/agent/extensions/orly.ts"),
        `// orly? — written by \`orly install pi\`; the extension lives in the orly checkout.\nexport { default } from ${JSON.stringify(join(ctx.root, "adapters", "pi.ts"))};\n`,
      ),
      markdownCommand(ctx, at(ctx, ".pi/prompts/orly.md", ".pi/agent/prompts/orly.md")),
    ],
  },
  {
    id: "continue",
    name: "Continue CLI",
    tier: "native",
    adapter: "claude-code.ts",
    events: "Stop, SessionStart, PreToolUse",
    command: "none",
    verified: false,
    note: "Claude Code's hook dialect",
    plan: (ctx) => [
      claudeDialect(ctx, at(ctx, ".continue/settings.json", ".continue/settings.json"), "claude-code.ts", [
        ["Stop", undefined],
        ["SessionStart", undefined],
        ["PreToolUse", undefined],
      ]),
    ],
  },
  {
    id: "junie",
    name: "JetBrains Junie CLI",
    tier: "native",
    adapter: "claude-code.ts",
    events: "Stop, SessionStart, PreToolUse",
    command: "none",
    verified: false,
    note: "Claude Code's hook dialect; whether Stop blocks is not confirmed; global config only",
    plan: (ctx) => [
      claudeDialect(ctx, join(ctx.home, ".junie", "config.json"), "claude-code.ts", [
        ["Stop", undefined],
        ["SessionStart", undefined],
        ["PreToolUse", undefined],
      ]),
    ],
  },
  { id: "amp", name: "Amp", tier: "cli", adapter: null, events: "none stable", command: "orly skill", verified: false, note: "plugin API is experimental; use `orly judge` from the terminal" },
  { id: "windsurf", name: "Windsurf", tier: "cli", adapter: null, events: "post_cascade_response cannot block", command: "none", verified: false },
  { id: "cline", name: "Cline", tier: "cli", adapter: null, events: "TaskComplete can only cancel", command: "none", verified: false },
  { id: "kiro", name: "Kiro", tier: "cli", adapter: null, events: "Stop carries no transcript and cannot block", command: "none", verified: false },
  { id: "aider", name: "Aider", tier: "cli", adapter: null, events: "no hooks", command: "none", verified: false },
];

export const findHost = (id: string) => HOSTS.find((h) => h.id === id || h.name.toLowerCase() === id.toLowerCase());

/** The checkout this file belongs to. */
export const ORLY_ROOT = resolve(import.meta.dir, "..");

export function plan(host: Host, opts: { cwd?: string; global?: boolean; home?: string } = {}): Planned[] {
  if (!host.plan) return [];
  return host.plan({ root: ORLY_ROOT, cwd: opts.cwd ?? process.cwd(), home: opts.home ?? process.env.HOME ?? homedir(), global: !!opts.global });
}

/** commands/orly.toml, the Gemini extension's copy of the command, rendered from the one source. */
export function shippedToml(root = ORLY_ROOT): string {
  const { description, body } = renderCommand(commandSource(root), { args: "{{args}}", from: SOURCE_CLI, cli: 'bun "${extensionPath}/bin/orly.ts"' });
  return toml(description, body);
}

/** The markdown table the README shows. */
export function supportTable(): string {
  const rows = HOSTS.map((h) => {
    const how = h.tier === "native" ? "blocks the stop" : h.tier === "emulated" ? "re-prompts" : "orly judge";
    return `| ${h.name} | ${how} | ${h.adapter ? `\`orly install ${h.id}\`` : "—"} | ${h.note ?? ""} |`;
  });
  return ["| Agent | Gate | Install | Notes |", "|---|---|---|---|", ...rows].join("\n");
}
