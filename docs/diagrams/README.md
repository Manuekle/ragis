# Diagramas

Los SVG de esta carpeta **se generan**; no los edites a mano.

```bash
make diagrams          # equivale a: python3 docs/diagrams/build.py
```

Cada diagrama tiene variante clara (`nombre.svg`) y oscura (`nombre-dark.svg`). Los documentos las enlazan con
`<picture>` para que GitHub elija según el tema del lector.

| Diagrama | Qué muestra | Usado en |
|---|---|---|
| `containers` | Servicios, datos y proveedores de modelos | README, [architecture.md](../architecture.md) |
| `aws-pilot` | Topología del piloto en us-east-2 | [environments.md](../environments.md), [piloto-aws.md](../../ops/runbooks/piloto-aws.md) |
| `environments` | Local, ensayo en Floci y AWS real | README, [environments.md](../environments.md), [floci.md](../guides/floci.md) |
| `ingest` | Los diez pasos de la ingesta | [architecture.md](../architecture.md) |
| `query` | Los nueve pasos de una consulta | [architecture.md](../architecture.md) |
| `auth` | Inicio de sesión dentro de la app | [authentication.md](../authentication.md) |

## Cómo funciona

- [`lib.py`](lib.py) incrusta cada icono de [`../assets/icons`](../assets/icons/README.md) dentro del SVG (ids y clases
  con prefijo para que no choquen). GitHub no carga recursos externos desde un SVG mostrado con `<img>`.
- [`build.py`](build.py) describe cada diagrama con `node`, `group` y `edge`; las coordenadas están a la vista.
- No hay dependencias: solo la biblioteca estándar de Python 3.

## Cambiar un diagrama

1. Edita la función del diagrama en `build.py` (por ejemplo `aws_pilot`).
2. Ejecuta `make diagrams`.
3. Abre el SVG en el navegador y revisa textos cortados o flechas que se cruzan.

Los iconos de AWS se usan sin modificar y los logotipos de tecnología son de sus dueños; ver
[assets/icons/README.md](../assets/icons/README.md).
