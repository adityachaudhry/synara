# Gitea-bound file previews

Date: 2026-08-07

## Problem

Glasswing projects created from the Gitea company catalog retain a compatibility `workspaceRoot`
such as `/data/gitea-company-projects/nth`, but the controller does not materialize a checkout at
that path. The provider worker instead sparse-checks the bound company directory into a disposable
Railway Sandbox. File preview still calls the ordinary `projects.readFile` RPC with the controller
path, so `WorkspaceFileSystem.realpath` fails before it can render the file.

The reported `technical_diligence.md` reference also demonstrates the existing partial-reference
contract: the repository contains the file at `analysis/technical_diligence.md`. Local projects
resolve a unique suffix through `WorkspaceEntries`; repository-bound projects need the equivalent
behavior against their durable repository.

## Decision

Keep the existing local filesystem preview path unchanged and add a repository-backed fallback for
catalog-bound projects. When the local `WorkspaceFileSystem.readFile` operation fails, the server
asks `GiteaCompanyCatalog` whether the requested workspace root belongs to a canonical catalog
descriptor. If it does not, the original local error is preserved. If it does, the catalog reads
the file from the descriptor's authenticated Gitea repository and ref.

The catalog resolves a requested path in this order:

1. accept an exact blob path beneath the descriptor's bound subdirectory;
2. otherwise accept a single blob whose path ends in the requested relative suffix;
3. reject zero or ambiguous matches.

This mirrors the local preview contract without making the controller clone a second repository or
making browser reads depend on a live sandbox. Gitea remains durable file truth; Railway Sandbox
state remains disposable execution state.

## Boundaries and security

- The browser cannot supply a repository origin, owner, repository, ref, or company path.
- The controller maps `cwd` only through a canonical catalog descriptor returned by the configured
  catalog.
- Relative paths must pass the existing workspace-relative safety predicate before any request.
- URL path segments are encoded independently.
- The existing one-megabyte text-read cap, UTF-8 result, binary rejection, and truncation contract
  remain unchanged. Image/PDF requests retain their extension allowlist and authenticated HTTP
  route.
- Ordinary local, GitHub, Studio, worktree, and absolute preview-grant reads retain their current
  behavior.

## Components

- `GiteaCompanyCatalog` gains a repository-file open operation returning `Option.none` when a cwd
  is not catalog-bound and an authenticated Gitea response plus the canonical relative path when
  it is.
- Its live layer caches/coalesces directory traversal for only the bound company subtree, with a
  bounded entry count and the same short TTL used by catalog metadata, then fetches only the
  selected file's contents. It deliberately does not request a recursive tree for the full
  multi-company repository because Gitea can truncate that response.
- A small workspace read adapter composes the current local `WorkspaceFileSystem` text read with
  the catalog fallback, applies the existing text limits, and preserves the original local error
  for unbound workspaces.
- `projects.readFile` delegates to that adapter; no browser or contract change is required.
- The existing authenticated `/api/local-image` route retains local-file priority and uses the same
  catalog operation when a safe workspace-relative image or PDF is absent locally. Remote bytes
  stream through Synara; repository credentials never reach the browser.

## Error handling

- Unbound cwd: return the original local filesystem error.
- Unsafe, missing, or ambiguous bound path: return a bounded catalog read error without exposing
  credentials.
- Gitea authentication, transport, or server failure: fail visibly; do not silently return stale or
  unrelated contents.
- Binary content: preserve the existing text-preview rejection.

## Verification

1. A red-green catalog test proves a bare `technical_diligence.md` reference resolves uniquely to
   `analysis/technical_diligence.md` from the bound company subtree and returns the resolved
   relative path without depending on the repository-wide tree endpoint.
2. A red-green adapter test proves local reads win, bound fallbacks recover missing local roots, and
   unbound workspaces preserve the local failure.
3. A route regression proves a repository-bound image/PDF can use the authenticated preview route
   without weakening the extension or project-binding allowlists.
4. Existing Gitea catalog, workspace filesystem, and web file-preview tests remain green.
5. Production web/server builds succeed.
6. After v3/dev deployment, repeating the original chat-file click renders the markdown instead of
   the `workspaceFileSystem.realpath` error.

## Non-goals

- Persisting or reusing sandbox files as controller storage.
- Adding a second Project, Thread, Turn, or artifact identity.
- Changing how providers check out or write the company repository.
- Materializing the full repository-backed file explorer on the controller. Previewing a selected
  or referenced file is in scope; browsing every remote directory is a separate read-model concern.
