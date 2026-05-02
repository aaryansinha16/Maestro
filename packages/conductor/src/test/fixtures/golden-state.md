# Current State

## Focus
Build the websocket-based agent feed for the dashboard. The HTTP polling
prototype is in main; we need an event stream.

## Next Concrete Tasks
- [ ] Wire the conductor to broadcast session events over WS at /events
- [ ] Add a useEvents() hook on the dashboard
- [ ] Show live session status without page refresh

## Blockers

_(none)_

## Recent Context

Polling-based status indicator landed last week. It works but creates
unnecessary load every 15s for every open dashboard tab.

## Notes

Prefer ws over socket.io — single dashboard user, no need for the abstraction.
