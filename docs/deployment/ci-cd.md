# CI/CD Pipeline

## Strategy

GitHub Action with `workflow_dispatch` (manual trigger only) in this repo. Builds a single Docker image containing both Psycheros and entity-core, pushes to GHCR.

## Build Pipeline

1. Manual trigger via GitHub Actions UI (or `gh workflow run docker-build.yml`)
2. Checkout Psycheros into `Psycheros/` subdirectory
3. Clone entity-core into `entity-core/` (private repo — uses PAT)
4. Copy `Dockerfile` and `entrypoint.sh` from Psycheros repo root to build context root
5. Build Docker image (linux/amd64) with GitHub Actions cache
6. Push to `ghcr.io/zarilewis/psycheros:latest` + SHA-tagged

## Build Context Layout

The Dockerfile expects `Psycheros/` and `entity-core/` as sibling directories. The workflow reconstructs this:

```
workspace/           # GitHub Actions runner workspace
├── Dockerfile       # copied from Psycheros/Dockerfile
├── entrypoint.sh    # copied from Psycheros/entrypoint.sh
├── Psycheros/       # checked out with path: Psycheros
│   ├── src/
│   ├── web/
│   ├── Dockerfile   # source copy (committed in repo)
│   └── entrypoint.sh
└── entity-core/     # cloned via PAT
    └── src/
```

## Private Repo Access

entity-core is a private repo. The workflow clones it using a PAT stored as a repository secret.

## Workflow File

Located at `.github/workflows/docker-build.yml`.

Key features:
- **Docker Buildx** for cross-platform builds (linux/amd64 on ubuntu runner)
- **GitHub Actions cache** (`cache-from/to: type=gha`) for layer caching between builds
- **Metadata action** for consistent tagging (custom tag + commit SHA)
- **GHCR login** via built-in `GITHUB_TOKEN` (no extra PAT needed for push)

## Secrets Required

| Secret | Purpose | How to create |
|--------|---------|---------------|
| `ENTITY_CORE_PAT` | PAT with `repo` scope to clone entity-core | GitHub → Settings → Developer settings → Fine-grained PATs → create with `Contents: Read` on `zarilewis/entity-core` |
| `GITHUB_TOKEN` | Auto-provided by GitHub Actions, used for GHCR push | No action needed |

### Setting the secret

```bash
# Via gh CLI (from this repo):
gh secret set ENTITY_CORE_PAT

# Or: GitHub UI → Psycheros repo → Settings → Secrets and variables → Actions → New repository secret
```

## Triggering a Build

```bash
# Default tag (latest):
gh workflow run docker-build.yml

# Custom tag:
gh workflow run docker-build.yml -f tag=v1.0.0

# Watch the run:
gh run watch
```

Or use the GitHub Actions UI: Psycheros repo → Actions → "Build & Push Docker Image" → Run workflow.

## UnRAID Pull

On the UnRAID machine:
```bash
# Authenticate with GHCR (one-time setup):
docker login ghcr.io -u zarilewis

# Pull the image:
docker pull ghcr.io/zarilewis/psycheros:latest
```

Then configure the container with volume mounts and env vars per `docker-strategy.md`.

## Local Build

From a workspace with Psycheros and entity-core as siblings:
```bash
docker build --platform linux/amd64 -t psycheros .
```
