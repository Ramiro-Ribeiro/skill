#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const RED    = '\x1b[31m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

function log(color, msg) { console.log(color + msg + RESET); }

function findSkillsDir() {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'skills');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function installSkills(skillsSrc, destDir, label) {
  fs.mkdirSync(destDir, { recursive: true });

  const skills = fs.readdirSync(skillsSrc, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();

  if (skills.length === 0) return 0;

  log(BOLD, `\n  [${label}]`);
  log(DIM,  '  → ' + destDir + '\n');

  for (const skill of skills) {
    const src    = path.join(skillsSrc, skill);
    const dest   = path.join(destDir, skill);
    const exists = fs.existsSync(dest);
    copyDir(src, dest);
    log(exists ? YELLOW : GREEN,
      `  ${exists ? '~' : '+'} ${exists ? 'updated  ' : 'installed'} ${skill}`);
  }
  return skills.length;
}

function registerPlugin(installPath) {
  const pluginsDir = path.join(os.homedir(), '.claude', 'plugins');
  const jsonPath   = path.join(pluginsDir, 'installed_plugins.json');
  let data = { version: 2, plugins: {} };
  if (fs.existsSync(jsonPath)) {
    try { data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
    catch { /* reset */ }
  }
  const now = new Date().toISOString();
  const key = 'golang-skills@golang-skills';
  data.plugins = data.plugins || {};
  data.plugins[key] = [{
    scope:       'user',
    installPath: installPath,
    version:     '1.0.0',
    installedAt: data.plugins[key]?.[0]?.installedAt || now,
    lastUpdated: now,
  }];
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 4));
}

// Find project root by walking up from cwd looking for .claude or .agents
// Stops at home dir to avoid false positives.
function findProjectRoot(startDir) {
  const home = os.homedir();
  let dir = path.resolve(startDir);
  while (dir !== home && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.claude')) ||
        fs.existsSync(path.join(dir, '.agents'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

function projectSkillsDir(projectRoot) {
  if (fs.existsSync(path.join(projectRoot, '.agents'))) {
    return path.join(projectRoot, '.agents', 'skills');
  }
  return path.join(projectRoot, '.claude', 'skills');
}

function parseArgs(argv) {
  const args = { projectPath: null, globalOnly: false, projectOnly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--project':
        args.projectPath = argv[++i];
        break;
      case '--global':
        args.globalOnly = true;
        break;
      case '--project-only':
        args.projectOnly = true;
        break;
      case '--help': case '-h':
        args.help = true;
        break;
    }
  }
  return args;
}

function main() {
  log(BOLD + CYAN, '\n  Claude Code Skills Installer — Go');
  log(CYAN,        '  github.com/Ramiro-Ribeiro/skills\n');

  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log('  Usage: npx github:Ramiro-Ribeiro/skills [options]\n');
    console.log('  Options:');
    console.log('    --project <path>   Install into <path>/.claude/skills (project-local)');
    console.log('    --global           Install globally only, skip project detection');
    console.log('    --project-only     Skip global install, project only\n');
    console.log('  Examples:');
    console.log('    npx github:Ramiro-Ribeiro/skillss');
    console.log('    npx github:Ramiro-Ribeiro/skills --project ~/Documentos/grownt-nexus');
    console.log('    npx github:Ramiro-Ribeiro/skills --global\n');
    process.exit(0);
  }

  const skillsSrc = findSkillsDir();
  if (!skillsSrc) {
    log(RED, '  ERROR: skills/ not found. __dirname: ' + __dirname);
    process.exit(1);
  }

  let totalInstalled = 0;

  // ── Global: plugin cache ──────────────────────────────────────────
  if (!args.projectOnly) {
    const globalBase   = path.join(os.homedir(), '.claude', 'plugins', 'cache',
                                   'golang-skills', 'golang-skills', '1.0.0');
    const globalSkills = path.join(globalBase, 'skills');
    totalInstalled += installSkills(skillsSrc, globalSkills, 'global plugin cache');
    registerPlugin(globalBase);
  }

  // ── Project ───────────────────────────────────────────────────────
  if (!args.globalOnly) {
    let projectRoot = null;

    if (args.projectPath) {
      // explicit --project flag: trust it
      projectRoot = path.resolve(args.projectPath);
      if (!fs.existsSync(projectRoot)) {
        log(RED, `  ERROR: --project path not found: ${projectRoot}`);
        process.exit(1);
      }
      // ensure .claude exists in target
      fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    } else {
      // auto-detect: walk up from cwd, stop at home
      const cwd = process.env.INIT_CWD || process.cwd();
      projectRoot = findProjectRoot(cwd);
    }

    if (projectRoot) {
      const destDir = projectSkillsDir(projectRoot);
      totalInstalled += installSkills(skillsSrc, destDir,
        'project ' + path.relative(os.homedir(), projectRoot));
    } else {
      log(DIM, '\n  (no project detected — skipping project install)');
      log(DIM,  '  Run with --project <path> to install into a specific project\n');
    }
  }

  console.log();
  log(BOLD, `  Done! ${totalInstalled} installation(s) complete.`);
  log(DIM,  '  Restart Claude Code to load the new skills.\n');
}

main();
