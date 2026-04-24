import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadSkills,
  parseSimpleYaml,
  parseSkillFile,
  renderSkillCatalog,
  renderSkillsForCoder,
  selectSkillsForTask,
} from "../src/skills.js";

describe("parseSimpleYaml", () => {
  it("parses scalar values", () => {
    const out = parseSimpleYaml("name: foo\ndescription: A thing");
    expect(out.name).toBe("foo");
    expect(out.description).toBe("A thing");
  });
  it("parses inline lists", () => {
    const out = parseSimpleYaml(`apply_to: ["*.py", "tests/**"]`);
    expect(out.apply_to).toEqual(["*.py", "tests/**"]);
  });
  it("strips quotes", () => {
    const out = parseSimpleYaml(`name: 'hello world'`);
    expect(out.name).toBe("hello world");
  });
  it("ignores comments and blanks", () => {
    const out = parseSimpleYaml(`# comment\n\nname: x\n`);
    expect(out.name).toBe("x");
  });
});

describe("parseSkillFile", () => {
  it("parses frontmatter + body", () => {
    const src = `---\nname: python-testing\ndescription: pytest help\napply_to: ["*_test.py"]\n---\n# Body\n\nGuidance here.\n`;
    const s = parseSkillFile(src, "/fake");
    expect(s?.name).toBe("python-testing");
    expect(s?.description).toBe("pytest help");
    expect(s?.applyTo).toEqual(["*_test.py"]);
    expect(s?.body).toContain("Guidance here");
  });
  it("throws without frontmatter", () => {
    expect(() => parseSkillFile("hello", "/fake")).toThrow(/frontmatter/);
  });
  it("throws without name or description", () => {
    const src = `---\nname: x\n---\nbody`;
    expect(() => parseSkillFile(src, "/fake")).toThrow();
  });
});

describe("loadSkills", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claw-skills-"));
    mkdirSync(join(root, ".claw-squad/skills"), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty when no skills dir", () => {
    const empty = mkdtempSync(join(tmpdir(), "claw-skills-empty-"));
    expect(loadSkills(empty)).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });

  it("loads valid skill files and sorts alphabetically", () => {
    writeFileSync(
      join(root, ".claw-squad/skills/b-skill.md"),
      `---\nname: beta\ndescription: second\n---\nBeta body\n`,
    );
    writeFileSync(
      join(root, ".claw-squad/skills/a-skill.md"),
      `---\nname: alpha\ndescription: first\n---\nAlpha body\n`,
    );
    const skills = loadSkills(root);
    expect(skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
  });

  it("skips malformed files with a warning", () => {
    writeFileSync(
      join(root, ".claw-squad/skills/bad.md"),
      "no frontmatter here",
    );
    writeFileSync(
      join(root, ".claw-squad/skills/ok.md"),
      `---\nname: ok\ndescription: fine\n---\nok body`,
    );
    const logs: string[] = [];
    const skills = loadSkills(root, (m) => logs.push(m));
    expect(skills).toHaveLength(1);
    expect(logs[0]).toMatch(/bad\.md/);
  });
});

describe("selectSkillsForTask", () => {
  const skills = [
    {
      name: "python-testing",
      description: "d",
      body: "b",
      path: "x",
      // `**` matches any depth so paths like "tests/test_x.py" activate too.
      applyTo: ["**/test_*.py", "**/*_test.py"],
    },
    {
      name: "api-conventions",
      description: "d",
      body: "b",
      path: "x",
    },
  ];

  it("picks by explicit tag", () => {
    const picked = selectSkillsForTask({
      allSkills: skills,
      taggedNames: ["api-conventions"],
    });
    expect(picked.map((s) => s.name)).toEqual(["api-conventions"]);
  });

  it("picks by apply_to glob match", () => {
    const picked = selectSkillsForTask({
      allSkills: skills,
      contextFilePaths: ["tests/test_users.py"],
    });
    expect(picked.map((s) => s.name)).toEqual(["python-testing"]);
  });

  it("deduplicates when a skill matches both tag and glob", () => {
    const picked = selectSkillsForTask({
      allSkills: skills,
      taggedNames: ["python-testing"],
      contextFilePaths: ["user_test.py"],
    });
    expect(picked).toHaveLength(1);
  });

  it("ignores unknown tags silently", () => {
    const picked = selectSkillsForTask({
      allSkills: skills,
      taggedNames: ["does-not-exist"],
    });
    expect(picked).toEqual([]);
  });
});

describe("rendering", () => {
  const skills = [
    { name: "a", description: "desc-a", body: "body-a", path: "x" },
    { name: "b", description: "desc-b", body: "body-b", path: "x" },
  ];
  it("renderSkillCatalog lists name + description", () => {
    const out = renderSkillCatalog(skills);
    expect(out).toContain("a");
    expect(out).toContain("desc-b");
  });
  it("renderSkillsForCoder inlines full body", () => {
    const out = renderSkillsForCoder(skills);
    expect(out).toContain("body-a");
    expect(out).toContain("body-b");
  });
  it("returns empty string for empty arrays", () => {
    expect(renderSkillCatalog([])).toBe("");
    expect(renderSkillsForCoder([])).toBe("");
  });
});
