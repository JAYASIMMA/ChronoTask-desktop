// Cross-checks JS `call('cmd', {args})` sites against the Rust command signatures.
// Tauri rejects a payload whose top-level keys do not match the declared parameters,
// so this parses only the outermost object keys and treats Option<T> params as optional.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'ui/app.js'), 'utf8');
const lib = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
const cmds = fs.readFileSync(path.join(root, 'src-tauri/src/commands.rs'), 'utf8');

const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

const declared = [...lib.matchAll(/commands::([a-z_0-9]+)/g)].map((m) => m[1]);
const missingImpl = declared.filter((d) => !new RegExp(`pub\\s+(async\\s+)?fn\\s+${d}\\s*\\(`).test(cmds));

// command name -> [{name, optional}]
const sigs = {};
for (const m of cmds.matchAll(/pub\s+(?:async\s+)?fn\s+([a-z_0-9]+)\s*\(([\s\S]*?)\)\s*(?:->|=\s*\{)/g)) {
  const [, name, rawParams] = m;
  const params = [];
  for (const part of splitTop(rawParams)) {
    const t = part.trim();
    if (!t) continue;
    const pm = t.match(/^([a-z_0-9]+)\s*:\s*(.*)$/);
    if (!pm) continue;
    if (pm[1] === 'app') continue;
    params.push({ name: camel(pm[1]), optional: /^\s*Option\s*</.test(pm[2]) });
  }
  sigs[name] = params;
}

// Splits "a: T, b: X<Y, Z>" on top-level commas only.
function splitTop(text) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of text) {
    if ('<([{'.includes(ch)) depth++;
    if ('>)]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// Top-level keys of an object literal, ignoring nested objects/arrays/template strings.
function topLevelKeys(body) {
  const keys = [];
  let depth = 0, i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') { depth++; i++; continue; }
    if (ch === '}' || ch === ']' || ch === ')') { depth--; i++; continue; }
    if (ch === '`') { // skip template literal (no nested braces we care about)
      i++;
      while (i < body.length && body[i] !== '`') { if (body[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (ch === '"' || ch === "'") {
      const q = ch; i++;
      while (i < body.length && body[i] !== q) { if (body[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (depth === 0) {
      const m = body.slice(i).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
      if (m) { keys.push(m[1]); i += m[0].length; continue; }
      const sh = body.slice(i).match(/^([A-Za-z_][A-Za-z0-9_]*)(?=\s*[,}])/);
      if (sh) { keys.push(sh[1]); i += sh[1].length; continue; }
    }
    i++;
  }
  return keys;
}

const problems = [];
for (const m of js.matchAll(/call\(\s*'([a-z_0-9]+)'((?:\s*,\s*\{[\s\S]*?\}\s*)?)\)/g)) {
  const [, cmd, argPart] = m;
  const want = sigs[cmd];
  if (!want) { problems.push(`${cmd}: not implemented in Rust`); continue; }
  let given = [];
  if (argPart.trim()) {
    const open = argPart.indexOf('{');
    const close = argPart.lastIndexOf('}');
    given = topLevelKeys(argPart.slice(open + 1, close));
  }
  const unknown = given.filter((g) => !want.some((p) => p.name === g));
  const required = want.filter((p) => !p.optional && !given.includes(p.name));
  if (unknown.length) problems.push(`${cmd}: JS sends ${unknown.join(', ')} not in Rust signature (${want.map((p) => p.name).join(', ') || 'none'})`);
  if (required.length) problems.push(`${cmd}: JS omits required arg(s) ${required.map((p) => p.name).join(', ')}`);
}

const callSites = (js.match(/call\(\s*'[a-z_0-9]+'/g) || []).length;
console.log(`commands implemented: ${Object.keys(sigs).length}`);
console.log(`declared in invoke_handler: ${declared.length}`);
console.log(`missing implementation: ${missingImpl.length ? missingImpl.join(', ') : 'none'}`);
console.log(`JS call sites checked: ${callSites}`);
console.log(problems.length ? `ARG PROBLEMS:\n - ${problems.join('\n - ')}` : 'arg names: every call site matches its Rust signature');
