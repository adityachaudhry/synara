# @glasswing/synara-react

This package is a build artifact of Synara's existing web application, intended for native React
embedding inside Glasswing. It exports the same application root used by the standalone Synara web
entrypoint; the host supplies memory history, an HTTP proxy prefix, and a fresh WebSocket URL
resolver.

The package deliberately does not introduce a second conversation model, transport protocol, or
auth system. React and React DOM remain peer dependencies so the host owns the React runtime.
