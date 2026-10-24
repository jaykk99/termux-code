/**
 * Agent Skills loader — the vendored Venice skills under skills/venice/.
 *
 * The format is the Agent Skills convention (github.com/veniceai/skills,
 * MIT): one folder per skill, a SKILL.md whose YAML frontmatter carries
 * `name` and `description`, and the markdown body as the instructions an
 * agent loads ON DEMAND — exactly how this module serves them:
 *
 *   - listSkills() reads only the frontmatter of every SKILL.md (cheap),
 *     which is what the chatbot's system prompt advertises and what its
 *     list_skills tool returns.
 *   - loadSkill(name) returns the full SKILL.md text for one skill, which
 *     is what the read_skill tool hands the model when a task matches.
 *
 * Discovery is a directory scan, so dropping a new skill folder into
 * skills/venice/ is all it takes — no registry to update. A skill folder
 * with a missing or malformed SKILL.md is skipped, never fatal.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SKILLS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'skills',
  'venice'
);

export function skillsDir(env = process.env) {
  return env.VENICE_SKILLS_DIR || DEFAULT_SKILLS_DIR;
}

const MAX_SKILL_CHARS = 60_000;

/** Minimal frontmatter reader: the `name:` / `description:` lines only. */
export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const block = text.slice(3, end);
  const fields = {};
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match) fields[match[1]] = match[2].trim();
  }
  if (!fields.name) return null;
  return { name: fields.name, description: fields.description || '' };
}

/** [{ name, description }] for every well-formed skill, sorted by name. */
export async function listSkills(env = process.env) {
  const dir = skillsDir(env);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const text = await fs.readFile(path.join(dir, entry.name, 'SKILL.md'), 'utf8');
      const meta = parseFrontmatter(text);
      if (meta) skills.push(meta);
    } catch {
      /* a folder without a readable SKILL.md is not a skill */
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The full text of one skill: { name, description, body } where body is the
 * whole SKILL.md (frontmatter included, so cross-references between skills
 * read exactly as upstream wrote them). Null for unknown skills.
 */
export async function loadSkill(name, env = process.env) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name)) return null;
  const file = path.join(skillsDir(env), name, 'SKILL.md');
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const meta = parseFrontmatter(text);
  if (!meta) return null;
  return {
    name: meta.name,
    description: meta.description,
    body: text.length > MAX_SKILL_CHARS ? text.slice(0, MAX_SKILL_CHARS) + '\n\n[skill truncated]' : text,
  };
}

/** One-line-per-skill index for the chatbot's system prompt. */
export async function skillIndex(env = process.env) {
  const skills = await listSkills(env);
  return skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
}
