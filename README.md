# check-nixpkgs-go

A Gitea Action that fails when `go.mod` requires a newer Go than the current
nixpkgs stable channel ships, so the module can still be packaged with
nixpkgs stable.

```yaml
jobs:
  nixpkgs-go:
    runs-on: ubuntu-slim-amd64
    steps:
      - uses: josh/check-nixpkgs-go@v1
```

No checkout or Go toolchain is needed. If `go.mod` isn't in the workspace,
the action reads it through the Gitea API at the commit being tested, so it
also works after `actions/checkout`.

It compares the `go` directive in `go.mod` with nixpkgs' default `go` in the
current stable channel. The newest stable release comes from the NixOS channel
monitor at `prometheus.nixos.org`. The `nixos-YY.MM` channel on
`channels.nixos.org` points at a release directory whose `src-url` names the
Hydra evaluation it was built from, and the Go version is that evaluation's
`nixpkgs.go.x86_64-linux` build. So the check matches exactly what the channel
ships today.

## Inputs

| Name          | Default               | Description                                                      |
| ------------- | --------------------- | ---------------------------------------------------------------- |
| `go-mod-file` | `go.mod`              | Path to the `go.mod` to check, relative to the workspace.        |
| `token`       | `${{ github.token }}` | Token for reading `go.mod` through the API without a checkout.   |

## Notes

- This is a JavaScript action (`runs.using: node24`) that runs the job
  image's `node`, so there's nothing to compile or download. It uses only
  Node's standard library, with no npm dependencies.
- Run the tests with `node --test`. Some of them query the live NixOS
  infrastructure.
