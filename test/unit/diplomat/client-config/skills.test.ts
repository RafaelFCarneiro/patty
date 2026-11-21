import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installSkills, removeSkills, SKILLS_ROOT } from '../../../../src/diplomat/client-config/skills.js';
import { runSkillsRemoval } from '../../../../src/diplomat/cli/commands/setup.js';
import { clientConfigs } from '../../../../src/diplomat/client-config/clients.js';
import { leftUnchangedNotOwn, SKILL_POINTER_MARKER } from '../../../../src/models/client-config.js';
import { SetupOptionsSchema } from '../../../../src/wire/in/cli.js';

const packaged = (name: string) => readFileSync(join(SKILLS_ROOT, name, 'SKILL.md'), 'utf8');

describe('the packaged skills are pointers', () => {
  it('dashboard-building keeps its name, description and trigger, and sends the agent to get_dashboard_guide', () => {
    const skill = packaged('dashboard-building');
    expect(skill).toMatch(/^---\nname: dashboard-building\ndescription: Use when the user asks to build/);
    expect(skill).toContain('get_dashboard_guide');
    expect(skill).toContain(SKILL_POINTER_MARKER);
    expect(skill.split('\n').length).toBeLessThan(30);
  });

  it('dashboard-building keeps the guide, the contract and the save on one server', () => {
    const skill = packaged('dashboard-building');
    expect(skill).toContain('patty-demo');
    expect(skill).toContain('the same instance');
  });

  it('patty-tour keeps its name and description, and sends the agent to get_workflow with the tour', () => {
    const skill = packaged('patty-tour');
    expect(skill).toMatch(/^---\nname: patty-tour\ndescription: Use when the user wants a tour/);
    expect(skill).toContain('get_workflow');
    expect(skill).toContain('"name": "tour"');
    expect(skill).toContain(SKILL_POINTER_MARKER);
  });

  it('keeps no copy of the guide: the full text lives where get_dashboard_guide reads it', () => {
    expect(packaged('dashboard-building')).not.toContain('Hard rules');
    expect(readFileSync(join(SKILLS_ROOT, '..', 'ui', 'guides', 'dashboard-building.md'), 'utf8')).toContain(
      'Hard rules',
    );
  });
});

describe('installing and removing the pointer skills', () => {
  let root = '';
  const skillFile = (directory: string) => join(root, directory, 'SKILL.md');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'patty-skills-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes both pointers where there is none', () => {
    const report = installSkills(root)._unsafeUnwrap();
    expect(report.lines).toEqual([
      `  Installed skill: ${skillFile('patty-dashboard')}`,
      `  Installed skill: ${skillFile('patty-tour')}`,
    ]);
    expect(readFileSync(skillFile('patty-dashboard'), 'utf8')).toBe(packaged('dashboard-building'));
    expect(readFileSync(skillFile('patty-tour'), 'utf8')).toBe(packaged('patty-tour'));
  });

  it('replaces PATTY’s own earlier copy', () => {
    mkdirSync(join(root, 'patty-dashboard'), { recursive: true });
    writeFileSync(skillFile('patty-dashboard'), `${SKILL_POINTER_MARKER}\nan older pointer`);
    installSkills(root)._unsafeUnwrap();
    expect(readFileSync(skillFile('patty-dashboard'), 'utf8')).toBe(packaged('dashboard-building'));
  });

  it('leaves a file of the person’s own, and says so', () => {
    mkdirSync(join(root, 'patty-tour'), { recursive: true });
    writeFileSync(skillFile('patty-tour'), 'my own tour skill');
    const report = installSkills(root)._unsafeUnwrap();
    expect(readFileSync(skillFile('patty-tour'), 'utf8')).toBe('my own tour skill');
    expect(report.lines).toContain(leftUnchangedNotOwn(skillFile('patty-tour')));
  });

  it('removes only PATTY’s pointers, leaving other skills and a person’s own file', () => {
    mkdirSync(join(root, 'other-skill'), { recursive: true });
    writeFileSync(join(root, 'other-skill', 'SKILL.md'), 'someone else');
    installSkills(root)._unsafeUnwrap();
    writeFileSync(skillFile('patty-tour'), 'edited by the person');

    const report = removeSkills(root)._unsafeUnwrap();

    expect(existsSync(skillFile('patty-dashboard'))).toBe(false);
    expect(existsSync(join(root, 'patty-dashboard'))).toBe(false);
    expect(readFileSync(skillFile('patty-tour'), 'utf8')).toBe('edited by the person');
    expect(readFileSync(join(root, 'other-skill', 'SKILL.md'), 'utf8')).toBe('someone else');
    expect(report.lines).toEqual([
      `  Removed skill: ${skillFile('patty-dashboard')}`,
      leftUnchangedNotOwn(skillFile('patty-tour')),
    ]);
  });

  it('says there is nothing to remove when nothing was installed', () => {
    expect(removeSkills(root)._unsafeUnwrap().lines).toEqual([
      `  No skill to remove: ${skillFile('patty-dashboard')} does not exist`,
      `  No skill to remove: ${skillFile('patty-tour')} does not exist`,
    ]);
  });

  it('keeps a folder that holds something else of the person’s', () => {
    installSkills(root)._unsafeUnwrap();
    writeFileSync(join(root, 'patty-dashboard', 'notes.md'), 'mine');
    removeSkills(root)._unsafeUnwrap();
    expect(existsSync(skillFile('patty-dashboard'))).toBe(false);
    expect(readFileSync(join(root, 'patty-dashboard', 'notes.md'), 'utf8')).toBe('mine');
  });

  it('reports a skill path it cannot read as a read failure', () => {
    mkdirSync(skillFile('patty-dashboard'), { recursive: true });
    const failure = installSkills(root)._unsafeUnwrapErr();
    expect(failure.code).toBe('read_failed');
    expect(failure.path).toBe(skillFile('patty-dashboard'));
  });
});

describe('setup --remove-skills', () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), clients: clientConfigs },
    };
  };

  it('says a client with no skills folder has nothing to remove', () => {
    const { io, out } = capture();
    expect(runSkillsRemoval(io, 'copilot')).toBe(0);
    expect(out).toEqual([expect.stringContaining('has no skills folder')]);
  });

  it('fails for an unknown tool and prints the help for none', () => {
    const unknown = capture();
    expect(runSkillsRemoval(unknown.io, 'nope')).toBe(1);
    expect(unknown.err[0]).toContain('unknown tool "nope"');
    const none = capture();
    expect(runSkillsRemoval(none.io, undefined)).toBe(0);
    expect(none.out[0]).toContain('--remove-skills');
  });

  it('is a flag to use alone', () => {
    expect(SetupOptionsSchema.parse({ 'remove-skills': true }).removeSkills).toBe(true);
    expect(SetupOptionsSchema.safeParse({ 'remove-skills': true, 'remove-demo': true }).success).toBe(false);
    expect(SetupOptionsSchema.safeParse({ 'remove-skills': true, username: 'ana' }).success).toBe(false);
  });
});
