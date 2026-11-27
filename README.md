# checksum

This action calculates the checksum (e.g., SHA-256) for all assets in your GitHub releases and generates a `checksum.txt` file. This is useful for ensuring file integrity during downloads and uploads.

Assets are **streamed** from the GitHub Releases API into an incremental hasher. Peak memory stays near the stream chunk size; release assets are **not** written to disk (only `checksum.txt` is).

Recovered/maintained fork of the former `thewh1teagle/checksum` action.

## Usage

Include in your workflow file:

```yml
# Prefer a full commit SHA when the job token can write releases.
uses: XDcobra/checksum@<commit-sha> # v1.0.1
with:
  patterns: | # Optional
    *.zip
    *.tar.gz
  algorithm: sha256 # Optional. See bun.sh/docs/api/hashing#bun-cryptohasher for supported algorithms
```

Floating tags such as `@v1` may move after review. For workflows that upload release assets, pin a reviewed commit SHA (and keep transitive pins inside this action).

You must enable write permission in github.com/user/repo/settings/actions -> Workflow permissions -> Read and write permissions.

## Inputs

| **Input Name** | **Description**                                                                                                                 | **Required** | **Default**      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------- |
| `repo`         | The GitHub repository in the format `owner/repo`.                                                                               | No           |                  |
| `patterns`     | File patterns to run checksum on. Supports glob patterns like `*.zip`, `*.tar.gz`.                                              | No           | `""` (all files) |
| `algorithm`    | Hash algorithm to use. Defaults to `sha256`. See [Bun hashing documentation](https://bun.sh/docs/api/hashing#bun-cryptohasher). | No           | `sha256`         |
| `pre-release`  | Whether to run on pre-releases.                                                                                                 | No           | `false`          |
| `tag`          | The tag of the release to generate checksums for.                                                                               | No           | `''`             |
| `file-name`    | The name of the checksum file to generate.                                                                                      | No           | `checksum.txt`   |
| `dry-run`      | Create checksum without upload. Will be available in the console output of the action.                                          | No           | `false`          |
| `fail-on-error` | Exit non-zero when an asset could not be hashed after retries. With `true` a failure prevents the upload (the existing checksum file stays untouched). With `false` the file is uploaded without the failed assets and only `::warning::` lines are emitted. | No | `true` |
| `bun-version`  | The version of Bun to use (pinned concrete version recommended).                                                                | No           | `1.4.4`          |

## Behaviour with changing release assets

Release assets may be deleted or re-uploaded while the action runs. Errors are handled per asset, never per release:

- Only assets in state `uploaded` are processed; others are logged as skipped.
- `404` while downloading: the release is listed again. If an asset with that name exists with a different id or a newer `updated_at`, the new version is hashed. If it no longer exists, it is skipped with a warning.
- Network errors and `5xx`/`429`: retried with exponential backoff (3 attempts). If it still fails, the asset is recorded as failed and the remaining assets are processed.
- Assets added or replaced while the action runs are picked up by a final re-list; a hash is never written for a version that differs from the final listing.

The checksum file is uploaded exactly once, at the very end of the run:

- right before the upload the release is listed again;
- the file contains only hashes computed in this run, and only for assets that are `uploaded` in that final listing with the same version (id and `updated_at`) that was hashed;
- nothing is carried over from the existing checksum file, which is not even read. An asset that failed, vanished, is not `uploaded` or changed after it was hashed gets no entry;
- if the run stops before the end (cancelled, crashed, timed out), the checksum file already on the release stays untouched.

Lines follow the release asset order. With `fail-on-error: true` (default), if any asset failed persistently nothing is uploaded: the existing checksum file stays untouched and the action exits with 1 after printing the errors and the summary. Assets that vanished or are not `uploaded` are not failures. With `fail-on-error: false` the file is uploaded without the failed assets and only warnings are emitted. A summary lists processed, re-hashed after replacement, skipped (gone / not uploaded) and failed assets. The checksum file itself is never hashed.

## Example checksum.txt

```txt
a.txt	ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb
b.txt	0263829989b6fd954f72baaf2fc64bc2e2f01d692d4de72986ea808f6e99813f
```

Each line separated by tab. (`\t`)

## Full example

<details>

```yml
name: Create checksum.txt

on:
  schedule:
    - cron: "0 1 * * *" # Runs at 1:00 AM UTC daily
  workflow_dispatch:

jobs:
  test:
    runs-on: macos-latest

    steps:
      - name: Run checksum action
        uses: XDcobra/checksum@<commit-sha> # v1.0.1
        with:
          patterns: | # Optional
            *.zip
            *.tar.gz
            *.txt
            !b.txt
          algorithm: sha256 # Optional
        env:
          # You must enable write permission in github.com/user/repo/settings/actions -> Workflow permissions -> Read and write permissions
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

</details>
