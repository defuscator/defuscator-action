# Changelog

## v1.0.1

- Pins the Defuscator CLI to `defuscator@1.0.1`, which hardens analysis against malformed and
  adversarial input (it no longer crashes on an empty string-array with rotation machinery, or on
  pathologically deep expressions) and improves source-map recovery. No change to the action's
  inputs, outputs, or behaviour.
- The merged SARIF report's tool driver version now reads 1.0.1 to match the CLI.

## v1.0.0

First release. Statically deobfuscates JavaScript in a repository, merges per-file SARIF into one
report for GitHub code scanning, and gates the build on the obfuscation or capability-risk score.
