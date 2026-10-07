# @jimmy927/devwire

A thin Chrome DevTools Protocol wire for Bun.

## What it is

- **Commands and replies:** `CdpConnection.send(method, params)` sends a command and
  resolves with its result, or rejects with a `CdpError`.
- **Events:** subscribe to any CDP event by method name.
- **Flat target sessions:** attach to a target with `flatten: true` and drive it through a
  `CdpSession` — how popups and iframes are reached.
- **Two transports:**
  - WebSocket (`--remote-debugging-port`), found with `debuggerWsUrl`.
  - `--remote-debugging-pipe` (`PipeTransport`), needed for the `Extensions` domain in
    branded Google Chrome, which serves it only over the pipe.

## What it is not

- It launches no browser.
- It enables no CDP domain on its own — never `Runtime.enable`, a known automation tell.
  Every domain enabled is the caller's choice.
- It has no typed protocol, no stealth and no captcha code.

## Install

```json
"@jimmy927/devwire": "git+ssh://git@github.com/jimmy927/devwire.git#v0.1.0"
```

The repo is private; CI in each consumer reads it with the read-only deploy key held in
that repo's `DEVWIRE_DEPLOY_KEY` Actions secret.

## Consumers

- threadhawk
- ts-bot-factory
- prifly

## Releasing

Change it here, run `bun test`, `bun run check` and `bun run typecheck`, bump `version`,
tag (`git tag vX.Y.Z && git push origin vX.Y.Z`), then each consumer bumps the tag in its
`package.json`.
