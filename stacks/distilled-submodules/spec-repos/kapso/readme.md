# spec-mirror-kapso

A snapshot of Kapso's [WhatsApp (Meta proxy) OpenAPI spec](https://docs.kapso.ai/api/meta/whatsapp/openapi-whatsapp.yaml),
reduced to exactly the file the `@julianarchila/kapso` generator reads:

- `specs/openapi-whatsapp.yaml`

Kapso publishes no git repository for its specs, so the file is fetched from
its documentation site.

## Updating specs

```sh
pnpm specs:fetch    # from the repository root
```

This directory is at the path a `spec-repos/<pkg>` entry has in
[alchemy-run/distilled](https://github.com/alchemy-run/distilled).
