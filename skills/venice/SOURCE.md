# Vendored Venice skills

Source: https://github.com/veniceai/skills (skills.json version 0.2.0)
Upstream commit: eea6a0b0f51b900969b0111ce864a6425a59ff48
Vendored: 2026-10-23. License: MIT (see LICENSE in this folder, (c) Venice.ai).

Each subfolder is one Agent Skill: a SKILL.md with YAML frontmatter
(name, description) plus any supporting files the skill references.
lib/skills.mjs discovers them at runtime; the hosted chatbot lists them
in its system prompt and loads a skill's full text on demand through
its read_skill tool. To update: re-copy skills/* from a fresh clone of
the upstream repo and bump the commit above.
