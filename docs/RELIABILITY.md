# Connection reliability

This document defines the transport invariants shared by the extension,
Control Center, native agents, and relay. Code changes that affect a WebSocket
lifecycle should preserve these rules and extend the reconnect integration
tests when behavior changes.

## Roles and ownership

| Role | Owner | Replaces an existing connection of the same role | UI presence |
| --- | --- | --- | --- |
| `control-gui` | Relay-mode Control Center | Yes | Relay transport only |
| `extension-client` | Extension offscreen document | Yes | Browser extension connected |
| `native-input-client` | Python EXE/module or C# host/DLL | Yes | Native client connected |
| `screen-share-stream` | Browser screen-share page | Yes | Stream transport, not extension presence |

The direct bridge also accepts the legacy `screen-share.stream-register` first
frame, but new clients use `client.register` with `role=screen-share-stream` in
both direct and relay modes.

## Lifecycle

```text
disabled/stopped
      |
      | explicit start or enabled setting
      v
resolving -> connecting -> registered -> connected
    ^            |             |             |
    |            +-------------+-------------+
    |                    unexpected failure
    +------------- waiting/backoff

Any state -> disabled/stopped only through an intentional stop action.
Relay authentication failure -> auth-paused -> connecting after UI update.
```

The extension bounds a handshake to 12 seconds and retries with 5, 10, 20,
and then 30 second delays. A browser `online` event skips the remaining delay.
The browser stream uses a separate 1 to 15 second reconnect schedule while the
captured media track remains active.

Python and C# native agents cycle their configured endpoints forever with a
five second delay. Their outer batch supervisor restarts the process after a
crash. A process restart and a socket reconnect are separate layers: the first
handles runtime failure; the second handles network/server failure.

## Registration and health

- The first direct-bridge frame must register within 15 seconds.
- Relay registration must match the configured session ID.
- Only the Control Center relay role carries username/password credentials.
- Direct and relay servers send WebSocket control pings and close peers that do
  not answer within the configured timeout.
- Application messages are bounded to 64 MiB. Binary metadata is length-prefixed
  JSON, capped at 1 MiB, and malformed envelopes are ignored without crashing
  the server.
- Native send paths are serialized because capture frames, popup callbacks, and
  request responses may originate from different tasks or threads.

## Capability-driven UI

The Control Center never assumes that every connected client supports every
operation. Registration capabilities are forwarded through direct and relay
events and reduced to one immutable UI snapshot. That snapshot controls action
visibility, status rows, popup history, viewer controls, keyboard shortcuts,
and request-provider selection.

- Extension-only browser clipboard actions require `clipboard.write`.
- Native desktop capture requires `screen-capture`.
- Native remote control requires `os-input`; a native client without it cannot
  displace the extension input route.
- Browser popup/file capabilities and `native-popup` provide separate fallback
  paths.
- Disconnect and reconnect events recompute the complete UI immediately.

## Request recovery

Control Center requests use UUID request IDs and finite timeouts. The direct
bridge retains pending extension request futures when the extension socket is
replaced. The extension offscreen client queues completed responses while its
socket is unavailable and flushes them after registration. Together these
behaviors allow a request that reached the extension to complete after a brief
disconnect.

Commands are not blindly replayed by the server. Replaying mouse clicks, key
events, file writes, or popup actions could duplicate side effects. If a command
never reached a client, its caller receives a send failure or timeout and may
choose whether a retry is safe.

Relay transport loss is different from a direct extension reconnect. The relay
does not retain a peer response while no GUI is paired, so the Control Center
fails all in-flight relay requests immediately and reconnects the transport.
The operator can retry after peers are visible again.

## Screen stream recovery

The browser stream is deliberately independent from the main extension socket.
When only the stream disconnects:

1. The bridge emits `screen_share_stream_interrupted`.
2. The GUI keeps its viewer session and shows a reconnecting status.
3. The browser keeps the media track and frame pump alive.
4. A new `screen-share-stream` socket registers and frames resume.

Disconnecting the selected main provider emits `screen_share_stream_ended` and
ends the GUI session. An explicit Stop action closes the stream with no retry.

## Relay authentication

Repeated invalid passwords must not loop automatically because that causes
rate-limit lockout. A rejected login therefore moves the relay client into an
auth-paused state. The GUI displays a modal credential prompt. Submitting new
credentials wakes the existing reconnect task; cancelling leaves it paused and
keeps the rest of the UI open.

## Intentional stop conditions

Automatic reconnect is suppressed when:

- the extension bridge setting is disabled;
- the screen-share Stop action is used;
- the Control Center is closed;
- the native agent or its supervisor is stopped;
- relay authentication is waiting for corrected credentials.

## Verification matrix

`verify.bat` covers deterministic, non-interactive checks:

| Area | Automated evidence |
| --- | --- |
| Extension | Strict type check and production bundle |
| Direct bridge | Registration, malformed frame isolation, role isolation |
| Reconnect | In-flight extension request completion after replacement |
| Relay | Target extraction for text and binary envelopes |
| Configuration | Parent `.env`, process override, URL normalization |
| Native Python | Unit import/compile and shared protocol tests |
| UI capability model | Extension-only, native-only, combined, legacy, and missing-capability states |
| Native C# | DLL, AnyCPU injector UI, x64/x86 hosts and bootstraps, package self-test, x64 help smoke, x86 static validation |

Interactive release checks should additionally cover Chrome debugger capture,
clipboard write, ChatGPT text/image paste, browser and native popups, one file
in each direction, live screen frames, and one mouse/key action on a disposable
test page.
