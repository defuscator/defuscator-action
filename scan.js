'use strict';

// Walks the requested paths, runs the CLI once per file, and merges the per-file SARIF into a single
// report that GitHub code scanning will accept.
//
// Two things here are not incidental:
//
//   1. URIs are rewritten relative to the workspace. The CLI reports the path it was handed, which on
//      a runner is absolute (/home/runner/work/repo/repo/src/x.js). GitHub matches SARIF results to
//      files by repository-relative path, so absolute URIs upload without error and then silently
//      annotate nothing.
//
//   2. A non-zero exit from the CLI is not a failure. The exit code is the risk gate - 0/1/2 - so
//      treating it as an error would turn every genuinely obfuscated file into a broken scan.
//      Only unparseable output counts as a failure to analyse.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const WORKSPACE = process.env.GITHUB_WORKSPACE || process.cwd();

const list = (value, fallback) =>
  String(value == null || value === '' ? fallback : value)
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

const paths = list(process.env.INPUT_PATHS, '.');
const extensions = list(process.env.INPUT_EXTENSIONS, '.js,.mjs,.cjs').map((e) =>
  e.startsWith('.') ? e.toLowerCase() : '.' + e.toLowerCase()
);
const excluded = new Set(list(process.env.INPUT_EXCLUDE, 'node_modules,.git'));
const gate = (process.env.INPUT_GATE || 'obfuscation').toLowerCase() === 'risk' ? 'risk' : 'obfuscation';
const failOn = (process.env.INPUT_FAIL_ON || 'high').toLowerCase();
const sarifFile = process.env.INPUT_SARIF_FILE || 'defuscator.sarif';
const maxFiles = parseInt(process.env.INPUT_MAX_FILES || '5000', 10) || 5000;

// ---------------------------------------------------------------- locate the binary

const PACKAGES = {
  'darwin arm64': '@defuscator/cli-darwin-arm64',
  'darwin x64': '@defuscator/cli-darwin-x64',
  'linux arm64': '@defuscator/cli-linux-arm64',
  'linux x64': '@defuscator/cli-linux-x64',
  'win32 x64': '@defuscator/cli-win32-x64'
};

function resolveBinary() {
  const packageName = PACKAGES[process.platform + ' ' + process.arch];
  if (!packageName) {
    fail('No Defuscator binary for ' + process.platform + ' ' + process.arch + '.');
  }
  const binaryName = process.platform === 'win32' ? 'defuscator.exe' : 'defuscator';
  try {
    const resolved = require.resolve(packageName + '/bin/' + binaryName, { paths: [__dirname] });
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(resolved, 0o755);
      } catch (err) {
        /* already executable, or not ours to change */
      }
    }
    return resolved;
  } catch (err) {
    fail('Could not find the Defuscator binary. Did the install step run?\n' + err.message);
  }
}

function fail(message) {
  console.error('::error::' + message);
  process.exit(1);
}

// ---------------------------------------------------------------- collect files

function collect(target, out) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (err) {
    console.log('::warning::skipping ' + target + ' (' + err.code + ')');
    return;
  }

  if (stat.isFile()) {
    out.push(target);
    return;
  }

  if (!stat.isDirectory()) {
    return;
  }

  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (excluded.has(entry.name) || out.length >= maxFiles) {
      continue;
    }
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) {
      collect(child, out);
    } else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
      out.push(child);
    }
  }
}

// ---------------------------------------------------------------- scan

const binary = resolveBinary();
const files = [];
for (const target of paths) {
  collect(path.resolve(WORKSPACE, target), files);
}

if (files.length === 0) {
  console.log('::warning::Defuscator found no matching files.');
}
if (files.length >= maxFiles) {
  console.log('::warning::Stopped at the max-files limit of ' + maxFiles + '.');
}

const rules = new Map();
const results = [];
let maxObfuscation = 0;
let maxRisk = 0;
let worstFile = '';
let worstScore = -1;
let failedToAnalyse = 0;

for (const file of files) {
  const relative = path.relative(WORKSPACE, file).split(path.sep).join('/');
  const run = spawnSync(binary, [file, '--sarif'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });

  if (run.error || !run.stdout) {
    failedToAnalyse++;
    console.log('::warning file=' + relative + '::Defuscator could not analyse this file' +
      (run.stderr ? ': ' + run.stderr.trim().split('\n')[0] : ''));
    continue;
  }

  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch (err) {
    failedToAnalyse++;
    console.log('::warning file=' + relative + '::Defuscator produced output that was not valid SARIF.');
    continue;
  }

  const sarifRun = report.runs && report.runs[0];
  if (!sarifRun) {
    continue;
  }

  for (const rule of (sarifRun.tool && sarifRun.tool.driver && sarifRun.tool.driver.rules) || []) {
    if (!rules.has(rule.id)) {
      rules.set(rule.id, rule);
    }
  }

  const props = sarifRun.properties || {};
  const obfuscation = Number(props.obfuscationScore) || 0;
  const risk = Number(props.riskScore) || 0;
  maxObfuscation = Math.max(maxObfuscation, obfuscation);
  maxRisk = Math.max(maxRisk, risk);

  const score = gate === 'risk' ? risk : obfuscation;
  if (score > worstScore) {
    worstScore = score;
    worstFile = relative;
  }

  for (const result of sarifRun.results || []) {
    // Rewrite every artifact location to the repository-relative path. Without this the upload
    // succeeds and annotates nothing.
    for (const location of result.locations || []) {
      const artifact = location.physicalLocation && location.physicalLocation.artifactLocation;
      if (artifact) {
        artifact.uri = relative;
        artifact.uriBaseId = '%SRCROOT%';
      }
    }
    result.properties = Object.assign({}, result.properties, {
      obfuscationScore: obfuscation,
      riskScore: risk
    });
    results.push(result);
  }
}

// ---------------------------------------------------------------- merged report

const merged = {
  $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
  version: '2.1.0',
  runs: [
    {
      tool: {
        driver: {
          name: 'Defuscator',
          informationUri: 'https://defuscator.com',
          version: '1.0.0',
          rules: Array.from(rules.values())
        }
      },
      originalUriBaseIds: {
        '%SRCROOT%': { uri: 'file://' + WORKSPACE.split(path.sep).join('/') + '/' }
      },
      properties: {
        filesScanned: files.length,
        filesFailed: failedToAnalyse,
        gate: gate,
        maxObfuscationScore: maxObfuscation,
        maxRiskScore: maxRisk
      },
      results: results
    }
  ]
};

fs.writeFileSync(path.resolve(WORKSPACE, sarifFile), JSON.stringify(merged));

// ---------------------------------------------------------------- outputs and verdict

const gateScore = gate === 'risk' ? maxRisk : maxObfuscation;
const output = (key, value) => {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, key + '=' + value + '\n');
  }
};

output('sarif-file', sarifFile);
output('files-scanned', files.length);
output('max-obfuscation', maxObfuscation);
output('max-risk', maxRisk);
output('worst-file', worstFile);

const summary =
  files.length + ' file(s) scanned, ' + results.length + ' finding(s). ' +
  'Highest obfuscation ' + maxObfuscation + ', highest capability risk ' + maxRisk + '.' +
  (worstFile ? ' Worst under the ' + gate + ' gate: ' + worstFile + ' (' + worstScore + ').' : '');
console.log(summary);

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Defuscator\n\n' + summary + '\n');
}

const threshold = failOn === 'never' ? Infinity : failOn === 'medium' ? 34 : 68;
if (gateScore >= threshold) {
  fail(
    'Defuscator gate failed: ' + gate + ' score ' + gateScore + ' is at or above ' + threshold +
    (worstFile ? ' (' + worstFile + ')' : '') + '.'
  );
}
