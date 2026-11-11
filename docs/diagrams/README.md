# Diagrams

The SVGs in this folder are **generated**; do not edit them by hand.

```bash
make diagrams          # equivalent to: python3 docs/diagrams/build.py
```

Each diagram has a light variant (`name.svg`) and a dark one (`name-dark.svg`). Documents link them with
`<picture>` so GitHub picks one according to the reader's theme.

| Diagram | What it shows | Used in |
|---|---|---|
| `rag-pipeline` | How a file becomes typed units, a dual knowledge graph and vectors, and how a question is answered | README, [architecture.md](../architecture.md) |
| `containers` | Services, data and model providers | README, [architecture.md](../architecture.md) |
| `aws-pilot` | Pilot topology in us-east-2 | [environments.md](../environments.md), [piloto-aws.md](../../ops/runbooks/piloto-aws.md) |
| `environments` | Local, rehearsal in Floci and real AWS | README, [environments.md](../environments.md), [floci.md](../guides/floci.md) |
| `ingest` | The ten ingestion steps | [architecture.md](../architecture.md) |
| `query` | The nine steps of a query | [architecture.md](../architecture.md) |
| `auth` | In-app sign-in | [authentication.md](../authentication.md) |

## How it works

- [`lib.py`](lib.py) embeds each icon from [`../assets/icons`](../assets/icons/README.md) inside the SVG (ids and classes
  are prefixed so they do not collide). GitHub does not load external resources from an SVG shown with `<img>`.
- [`build.py`](build.py) describes each diagram with `node`, `group` and `edge`; the coordinates are in plain sight.
- No dependencies: only the Python 3 standard library.

## Changing a diagram

1. Edit the diagram's function in `build.py` (for example `aws_pilot`).
2. Run `make diagrams`.
3. Open the SVG in the browser, in both variants, and check for cut-off text, crossing arrows and icons that disappear
   on the dark background.

AWS icons are used unmodified and technology logos belong to their owners; see
[assets/icons/README.md](../assets/icons/README.md).
