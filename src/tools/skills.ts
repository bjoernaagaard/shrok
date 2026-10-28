import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { parse } from "yaml";

import { integrations } from "../settings.ts";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const SKILL_FILE = "SKILL.md";
const SKILL_COMMAND = "/skill:";
const NAME_CHARS = /^[a-z0-9-]+$/u;
const LINE_ENDINGS = /\r\n?/gu;
const XML_CHARS = /[&<>"']/gu;

const XML_ESCAPES = new Map([
  ['"', "&quot;"],
  ["&", "&amp;"],
  ["'", "&apos;"],
  ["<", "&lt;"],
  [">", "&gt;"],
]);

const FrontmatterSchema = Type.Object({
  description: Type.Optional(Type.Unknown()),
  "disable-model-invocation": Type.Optional(Type.Unknown()),
  name: Type.Optional(Type.Unknown()),
});

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
  readonly baseDir: string;
  readonly disableModelInvocation: boolean;
}

interface SkillDiagnostic {
  readonly message: string;
  readonly path: string;
}

export interface LoadSkillsResult {
  readonly skills: Skill[];
  readonly diagnostics: SkillDiagnostic[];
}

const splitFrontmatter = (
  content: string
): { yaml: string | undefined; body: string } => {
  const normalized = content
    .replace(/^\uFEFF/u, "")
    .replaceAll(LINE_ENDINGS, "\n");

  const end = normalized.startsWith("---")
    ? normalized.indexOf("\n---", 3)
    : -1;

  return end === -1
    ? { body: normalized, yaml: undefined }
    : {
        body: normalized.slice(end + 4).trim(),
        yaml: normalized.slice(4, end),
      };
};

const nameErrors = (name: string): string[] =>
  [
    name.length > MAX_NAME_LENGTH
      ? `name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`
      : "",
    NAME_CHARS.test(name)
      ? ""
      : "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)",
    name.startsWith("-") || name.endsWith("-")
      ? "name must not start or end with a hyphen"
      : "",
    name.includes("--") ? "name must not contain consecutive hyphens" : "",
  ].filter((error) => error !== "");

const loadSkillFile = (
  filePath: string,
  diagnostics: SkillDiagnostic[]
): Skill | undefined => {
  const isDeclared = path.basename(filePath) === SKILL_FILE;
  let frontmatter: Static<typeof FrontmatterSchema>;

  try {
    const { yaml } = splitFrontmatter(readFileSync(filePath, "utf-8"));
    const parsed: unknown = yaml === undefined ? {} : (parse(yaml) ?? {});

    frontmatter = Value.Parse(FrontmatterSchema, parsed);
  } catch (error) {
    if (isDeclared) {
      diagnostics.push({ message: String(error), path: filePath });
    }

    return undefined;
  }

  const description = Value.Check(Type.String(), frontmatter.description)
    ? frontmatter.description
    : "";

  const hasDescription = description.trim() !== "";

  if (!isDeclared && !hasDescription) {
    return undefined;
  }

  if (!hasDescription) {
    diagnostics.push({ message: "description is required", path: filePath });

    return undefined;
  }

  // A skill's name and description go into the system prompt, so one that breaks the limits is left out.
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    diagnostics.push({
      message: `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`,
      path: filePath,
    });

    return undefined;
  }

  const baseDir = path.dirname(filePath);

  const name =
    Value.Check(Type.String(), frontmatter.name) && frontmatter.name !== ""
      ? frontmatter.name
      : path.basename(baseDir);

  const errors = nameErrors(name);

  for (const message of errors) {
    diagnostics.push({ message, path: filePath });
  }

  if (errors.length > 0) {
    return undefined;
  }

  return {
    baseDir,
    description,
    disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    filePath,
    name,
  };
};

const kindOf = (fullPath: string): "directory" | "file" | undefined => {
  try {
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      return "directory";
    }

    return stats.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
};

const scan = (
  dir: string,
  includeRootFiles: boolean,
  result: LoadSkillsResult
): void => {
  const entries = readdirSync(dir, { withFileTypes: true });

  if (
    entries.some(
      (entry) =>
        entry.name === SKILL_FILE &&
        kindOf(path.join(dir, entry.name)) === "file"
    )
  ) {
    const skill = loadSkillFile(path.join(dir, SKILL_FILE), result.diagnostics);

    if (skill !== undefined) {
      result.skills.push(skill);
    }

    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    const kind =
      entry.name.startsWith(".") || entry.name === "node_modules"
        ? undefined
        : kindOf(fullPath);

    if (kind === "directory") {
      scan(fullPath, false, result);
    } else if (
      kind === "file" &&
      includeRootFiles &&
      entry.name.endsWith(".md")
    ) {
      const skill = loadSkillFile(fullPath, result.diagnostics);

      if (skill !== undefined) {
        result.skills.push(skill);
      }
    }
  }
};

const loadSkillsFromDir = (dir: string): LoadSkillsResult => {
  const result: LoadSkillsResult = { diagnostics: [], skills: [] };

  if (existsSync(dir)) {
    scan(dir, true, result);
  }

  return result;
};

export const BUNDLED_SKILLS = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "skills"
);

/** Bundled skills about an integration that isn't set up would point at tools Shrok doesn't have. */
const BUNDLED_NEEDS = new Map<string, keyof typeof integrations>([
  ["calendar", "google"],
  ["gmail", "google"],
  ["x-posts", "x"],
]);

const usable = (dir: string, skill: Skill): boolean => {
  const needs = BUNDLED_NEEDS.get(skill.name);

  return dir !== BUNDLED_SKILLS || needs === undefined || integrations[needs];
};

export const loadSkills = (dirs: readonly string[]): LoadSkillsResult => {
  const result: LoadSkillsResult = { diagnostics: [], skills: [] };
  const names = new Set<string>();

  for (const dir of dirs) {
    const loaded = loadSkillsFromDir(dir);

    result.diagnostics.push(...loaded.diagnostics);

    for (const skill of loaded.skills.filter((each) => usable(dir, each))) {
      if (names.has(skill.name)) {
        result.diagnostics.push({
          message: `name "${skill.name}" collision`,
          path: skill.filePath,
        });
      } else {
        names.add(skill.name);
        result.skills.push(skill);
      }
    }
  }

  return result;
};

// Each value stays on its line of the prompt: a block scalar in front matter can hold line breaks.
const escapeXml = (text: string): string =>
  text
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replaceAll(XML_CHARS, (char) => XML_ESCAPES.get(char) ?? char);

export const formatSkillsForPrompt = (skills: readonly Skill[]): string => {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);

  if (visible.length === 0) {
    return "";
  }

  return [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
    ...visible.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
};

export const expandSkillCommand = (
  text: string,
  skills: readonly Skill[]
): string => {
  if (!text.startsWith(SKILL_COMMAND)) {
    return text;
  }

  const space = text.indexOf(" ");

  const name =
    space === -1
      ? text.slice(SKILL_COMMAND.length)
      : text.slice(SKILL_COMMAND.length, space);

  const args = space === -1 ? "" : text.slice(space + 1).trim();
  const skill = skills.find((candidate) => candidate.name === name);

  if (skill === undefined) {
    return text;
  }

  const { body } = splitFrontmatter(readFileSync(skill.filePath, "utf-8"));
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body.trim()}\n</skill>`;

  return args === "" ? block : `${block}\n\n${args}`;
};
