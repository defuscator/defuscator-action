# Defuscator GitHub Action

Statically deobfuscates JavaScript in a repository, uploads the findings to GitHub code scanning, and
optionally fails the build. The analysed code is never executed.

## Quick start

```yaml
name: Defuscator
on: [push, pull_request]

permissions:
  contents: read
  security-events: write   # required to upload SARIF

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: defuscator/defuscator-action@v1
        id: defuscator
        with:
          paths: src

      - name: Upload to code scanning
        if: always()          # upload findings even when the gate fails
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: ${{ steps.defuscator.outputs.sarif-file }}
```

Findings then appear in the repository's **Security → Code scanning** tab, annotated on the exact
files, and on the diff of a pull request.

`if: always()` on the upload step is deliberate. Without it a failing gate skips the upload, and the
run reports a failure with nothing to look at.

## What it gates on

By default the gate is the **obfuscation** score, not capability risk. That is almost always what a
build wants: an ordinary minified dependency scores 0 for obfuscation but high for capability,
because it calls `setTimeout` and touches the DOM. Gating on risk would fail on jQuery.

Use `gate: risk` when the question is "what would this code do if it ran" rather than "is something
hiding here" - triaging an unknown sample rather than guarding a build.

| `fail-on` | Fails when the gate score is |
|---|---|
| `high` (default) | 68 or above |
| `medium` | 34 or above |
| `never` | never - report only |

## Inputs

| Input | Default | Description |
|---|---|---|
| `paths` | `.` | Files or directories, one per line or comma separated. Directories are walked recursively. |
| `extensions` | `.js,.mjs,.cjs` | Extensions to include when walking directories. |
| `exclude` | `node_modules,dist,build,out,coverage,vendor,.git` | Path segments to skip. |
| `gate` | `obfuscation` | `obfuscation` or `risk`. |
| `fail-on` | `high` | `high`, `medium`, or `never`. |
| `sarif-file` | `defuscator.sarif` | Where to write the merged report. |
| `max-files` | `5000` | Guard against scanning an unexpectedly large tree. |
| `version` | `latest` | Version of the `defuscator` npm package to use. |

Globs are deliberately not supported. Directory walking with an extension filter is predictable
across runners and shells, where glob expansion is not.

## Outputs

| Output | Description |
|---|---|
| `sarif-file` | Path to the merged SARIF report. |
| `files-scanned` | Number of files analysed. |
| `max-obfuscation` | Highest obfuscation score found. |
| `max-risk` | Highest capability risk score found. |
| `worst-file` | File with the highest score under the selected gate. |

## Report without failing

```yaml
      - uses: defuscator/defuscator-action@v1
        id: defuscator
        with:
          paths: |
            src
            public/js
          fail-on: never
```

Everything still lands in code scanning; nothing blocks the merge. A reasonable way to start on an
existing repository, where the first run usually finds vendored bundles nobody remembers adding.

## Notes

- Runs on `ubuntu-latest`, `macos-latest` and `windows-latest`.
- The CLI is a self-contained binary. No .NET or Python is installed on the runner.
- Results are merged into one SARIF run with paths rewritten relative to the repository. GitHub
  matches findings to files by repository-relative path; absolute runner paths upload without error
  and then annotate nothing, which is the failure mode this handles for you.
