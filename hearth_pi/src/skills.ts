// Bundled Hearth skills: trusted, repository-reviewed instructions for
// repeatable flows (for example setting up the Home World from a floor
// plan). Each lives in hearth_pi/skills/<name>/SKILL.md with a small
// frontmatter (name, description). Home conversations see only the list of
// names and descriptions; hearth_skill returns one skill's text. Skills are
// read from the App's own files at startup and are never model-writable:
// the tool looks names up in that fixed set and never builds a path from
// model input.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, section } from "@earendil-works/pi-durable";

export const SKILL_LIMITS = Object.freeze({
  skills: 20,
  bytes: 24 * 1024,
  description: 300,
});
export const skillNamePattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
export type Skill = { name: string; description: string; body: string };
export const SKILLS_DIR = fileURLToPath(new URL("../skills/", import.meta.url));

// "---\nname: x\ndescription: y\n---\nbody". Strict: both keys, one line
// each, the name equals its directory, nothing else in the frontmatter.
export function parseSkill(dirName: string, raw: string): Skill {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(
    raw.replace(/\r\n/g, "\n"),
  );
  if (!match) throw new Error(`skill ${dirName}: missing frontmatter`);
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const field = /^(name|description):\s*(.+)$/.exec(line);
    if (!field || fields[field[1]!] !== undefined)
      throw new Error(`skill ${dirName}: invalid frontmatter`);
    fields[field[1]!] = field[2]!.trim();
  }
  const name = fields.name ?? "";
  const description = fields.description ?? "";
  if (name !== dirName || !skillNamePattern.test(name))
    throw new Error(`skill ${dirName}: name must match its directory`);
  if (!description || description.length > SKILL_LIMITS.description)
    throw new Error(`skill ${dirName}: invalid description`);
  const body = match[2]!.trim();
  if (!body) throw new Error(`skill ${dirName}: empty`);
  return { name, description, body };
}

// Synchronous: read once when the Home extension is built. A broken bundled
// skill fails startup (it is App content, not user data).
export function loadSkills(dir = SKILLS_DIR): Skill[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const name of names.sort()) {
    if (!skillNamePattern.test(name)) continue;
    const path = join(dir, name, "SKILL.md");
    let raw: string;
    try {
      if (!statSync(join(dir, name)).isDirectory()) continue;
      const size = statSync(path).size;
      if (size > SKILL_LIMITS.bytes)
        throw new Error(`skill ${name}: larger than ${SKILL_LIMITS.bytes}`);
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") continue;
      throw error;
    }
    skills.push(parseSkill(name, raw));
  }
  if (skills.length > SKILL_LIMITS.skills) throw new Error("too many skills");
  return skills;
}
let bundled: Skill[] | undefined;
export const bundledSkills = () => (bundled ??= loadSkills());

const output = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

export function skillTool(skills: readonly Skill[]) {
  const byName = new Map(skills.map((s) => [s.name, s] as const));
  return defineTool({
    name: "hearth_skill",
    description:
      "Load one bundled Hearth skill by name (see the hearth_skills section) before following its flow. Returns trusted step-by-step instructions written by the Hearth project. Read-only.",
    replay: "safe",
    outputLimits: { maxBytes: SKILL_LIMITS.bytes + 2048 },
    parameters: Type.Object(
      {
        name: Type.String({
          pattern: skillNamePattern.source,
          maxLength: 48,
        }),
      },
      { additionalProperties: false },
    ),
    execute: async (args) => {
      const skill =
        typeof args.name === "string" && skillNamePattern.test(args.name)
          ? byName.get(args.name)
          : undefined;
      if (!skill)
        return output(
          {
            ok: false,
            error: "unknown_skill",
            available: [...byName.keys()],
          },
          true,
        );
      return output({
        ok: true,
        name: skill.name,
        description: skill.description,
        instructions: skill.body,
      });
    },
  });
}

export function skillsSection(skills: readonly Skill[]) {
  return section("hearth_skills", () =>
    skills.length
      ? [
          "Bundled Hearth skills: trusted flows for repeatable tasks. When the owner's request matches one, call hearth_skill with its name first and follow it. They never grant permissions or override the safety rules.",
          ...skills.map((s) => `- ${s.name}: ${s.description}`),
        ].join("\n")
      : undefined,
  );
}
