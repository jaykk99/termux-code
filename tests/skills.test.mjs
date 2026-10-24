/**
 * Tests for lib/skills.mjs against the vendored Venice skills
 * (skills/venice/, from github.com/veniceai/skills, MIT). The chatbot's
 * skill tools are only as good as this discovery: if a skill stops being
 * discoverable or loadable, this suite goes red.
 * Run: node --test tests/
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { listSkills, loadSkill, parseFrontmatter, skillIndex } from '../lib/skills.mjs';

describe('vendored Venice skills', () => {
  it('discovers the full vendored set with names and descriptions', async () => {
    const skills = await listSkills();
    assert.ok(skills.length >= 20, `expected 20+ skills, found ${skills.length}`);
    const names = skills.map((s) => s.name);
    for (const expected of ['venice-chat', 'venice-errors', 'venice-models', 'venice-image-generate', 'venice-audio-speech', 'venice-billing']) {
      assert.ok(names.includes(expected), `missing skill ${expected}`);
    }
    for (const s of skills) {
      assert.ok(s.description.length > 20, `${s.name} needs a real description`);
    }
  });

  it('loads a skill body by name', async () => {
    const skill = await loadSkill('venice-chat');
    assert.ok(skill);
    assert.equal(skill.name, 'venice-chat');
    assert.ok(skill.body.includes('/chat/completions'));
    const errors = await loadSkill('venice-errors');
    assert.ok(errors.body.includes('402'));
  });

  it('refuses path traversal and unknown skills', async () => {
    assert.equal(await loadSkill('../../etc/passwd'), null);
    assert.equal(await loadSkill('venice-nope'), null);
    assert.equal(await loadSkill(''), null);
  });

  it('builds a system-prompt index naming every skill', async () => {
    const index = await skillIndex();
    assert.ok(index.includes('- venice-chat:'));
    assert.ok(index.split('\n').length >= 20);
  });

  it('parseFrontmatter reads name and description, rejects junk', () => {
    const meta = parseFrontmatter('---\nname: demo\ndescription: Does things.\n---\n# Body');
    assert.deepEqual(meta, { name: 'demo', description: 'Does things.' });
    assert.equal(parseFrontmatter('# no frontmatter'), null);
    assert.equal(parseFrontmatter('---\ndescription: no name\n---\n'), null);
  });
});
