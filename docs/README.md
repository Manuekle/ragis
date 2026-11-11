# Ragsis documentation

Start with what you need:

| I want to… | Read |
|---|---|
| Understand how it is built | [architecture.md](architecture.md) |
| Run it and develop | [development.md](development.md) |
| Know where each environment runs and what it costs | [environments.md](environments.md) |
| Try AWS infrastructure without touching AWS | [guides/floci.md](guides/floci.md) |
| Configure variables and secrets | [configuration.md](configuration.md) |
| Understand sign-in | [authentication.md](authentication.md) |
| Review security controls | [security.md](security.md) |
| See what each feature does | [features.md](features.md) |
| Connect Gmail, Slack or ClickUp | [connectors-setup.md](connectors-setup.md) |
| Operate the AWS pilot | [../ops/runbooks/piloto-aws.md](../ops/runbooks/piloto-aws.md) |
| Resolve an incident or operation | [../ops/runbooks](../ops/runbooks/README.md) |
| Know why something was decided | [adr/README.md](adr/README.md) |

## Map

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/environments-dark.svg">
  <img alt="Local, rehearsal in Floci and real AWS" src="diagrams/environments.svg">
</picture>

| Folder | Contents |
|---|---|
| `docs/` | This documentation |
| `docs/adr/` | Architecture decision records (ADRs) |
| `docs/guides/` | Practical guides (Floci) |
| `docs/diagrams/` | SVG diagrams generated with `make diagrams` |
| `docs/assets/icons/` | AWS and technology icons used in the diagrams |
| `../ops/runbooks/` | Operational procedures |

## How to maintain the documentation

- A behavior change updates its document in the same pull request.
- A design change that an ADR no longer reflects adds a new ADR (history is not rewritten).
- Diagrams are edited in `docs/diagrams/build.py`, never by hand in the SVG.
- The README and all documentation are written in English; no secrets or real account identifiers in examples.
