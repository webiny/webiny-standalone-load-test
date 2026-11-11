# One extension with a missing license-gated dependency fails every CMS request

webiny-js `6f462b597f`, standalone, Postgres, two API processes.

## What I did

Built the API from the monorepo with the checkout's `.env` loaded, which carries
`WEBINY_PROJECT_ID` and `WEBINY_PROJECT_API_KEY`. The build saw a license with `aiPowerups`, so
`webiny.config.tsx` rendered `<FeatureFlag.CanUse name="aiPowerups"><AiContentExtension /></...>`
and the bundle contains `GenerateAiSummaryBulkAction`.

Ran the build with `node start.mjs` without those two variables, as the handoff's runtime env
lists them. At runtime the project is unlicensed, so `ai-powerups` does not register
`CmsGenerateEntryContentFeature` (`packages/ai-powerups/src/api/Extension.ts:76`).

## What happened

Every authenticated request to `/cms/manage` and `/cms/read` failed, on both processes, for any
query, including `listContentModels`:

```
{"message":"No registration found for AiPowerUpsCmsGenerateEntryContentUseCase","code":"INVALID_GRAPHQL_SCHEMA_LOCATIONS","data":{"endpoint":"read"}}
```

API log:

```
HTTP handler WebinyError: INVALID_GRAPHQL_SCHEMA_LOCATIONS No registration found for AiPowerUpsCmsGenerateEntryContentUseCase
```

`/graphql` kept working. Rebuilding with `WEBINY_PROJECT_ID=` and `WEBINY_PROJECT_API_KEY=` (empty)
removed the extension from the bundle and the CMS API answered again.

## Why it matters

The trigger here is a demo extension in the monorepo (`extensions/bulkActions/aiContent`), so this
is not a bug a customer project hits as-is. Two things carry over to real projects:

1. **Build-time and run-time license can differ.** `<FeatureFlag.CanUse>` in `webiny.config.tsx`
   is decided at build time; the API decides its own features from the license it loads at
   startup. A project built in CI with WCP credentials and run without them (or with a license
   that has since lost a feature) ships extensions whose dependencies are not registered.
2. **The blast radius is the whole CMS schema.** One resolver dependency that cannot be resolved
   fails schema generation for the endpoint, so every CMS request fails instead of the one
   bulk action. Nothing at startup reports the missing registration; the first CMS request does.

## Suggested direction

Either check, at startup, that every registered extension's dependencies resolve and log which
one does not, or have schema generation skip a contributor whose dependencies are missing and log
it, so one optional piece cannot take the endpoint down.

Files: `packages/ai-powerups/src/api/Extension.ts`,
`extensions/bulkActions/aiContent/api/GenerateAiSummaryBulkAction.ts`, `webiny.config.tsx:48-52`,
and wherever the CMS schema builder resolves resolver dependencies (the error code is
`INVALID_GRAPHQL_SCHEMA_LOCATIONS`).
