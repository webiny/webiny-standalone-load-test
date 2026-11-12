# The background tasks API checks a permission the admin never grants

webiny-js `6f462b597f`, standalone, Postgres. Not load related; found while setting up scenario 3.

## What I did

The load-test API key was created in the Admin with these permissions (as stored in
`webiny_core_api_keys`):

```
[{"name": "cms.*"}, {"name": "backgroundTasks.*"}]
```

`backgroundTasks.*` is what Access Management writes for full access to Background Tasks. With that
key:

```
POST /graphql {backgroundTasks{listDefinitions{data{id} error{message}}}}
{"data":{"backgroundTasks":{"listDefinitions":{"data":null,"error":{"message":"Not authorized!"}}}}}
```

Adding `{"name": "tasks.*"}` changed nothing. Adding `{"name": "tasks"}` (by hand, in the database)
fixed it on both processes:

```
{"data":{"backgroundTasks":{"listDefinitions":{"data":[{"id":"testingRun"},{"id":"selfCleaningTask"}],"error":null}}}}
```

## Why

The permission schema the Admin uses is `backgroundTasks`:

```ts
// packages/background-tasks/src/api/permissions.ts
createPermissionSchema({ prefix: "backgroundTasks", fullAccess: true, entities: [{ permission: "backgroundTasks.task", ... }] })
```

The GraphQL resolvers check a different name:

```ts
// packages/background-tasks/src/api/graphql/checkPermissions.ts
const taskPermissions = await context.container.resolve(IdentityContext).getPermissions<TaskPermission>("tasks");
```

`IdentityContext.getPermissions(name)` keeps a permission when its name equals `name` or
`minimatch(name, permission.name)` matches (`packages/api-core/src/features/security/IdentityContext/IdentityContext.ts:114`).
`minimatch("tasks", "backgroundTasks.*")` and `minimatch("tasks", "tasks.*")` are both false, so
only `*` (full access) or a permission named exactly `tasks` passes.

## Effect

Any API key or role that is given Background Tasks access, and not full access, gets
`Not authorized!` from every `backgroundTasks` query and mutation (`listTasks`, `getTask`,
`listLogs`, `listDefinitions`, `triggerTask`, `abortTask`, `deleteTask`). Admin users with full
access don't notice.

## Suggested direction

Check `backgroundTasks.task` (or `getPermissions("backgroundTasks.task")`, which `backgroundTasks.*`
matches) in `checkPermissions.ts`, and add a test that a non-full-access identity with the Admin's
Background Tasks permission can list tasks.

Files: `packages/background-tasks/src/api/graphql/checkPermissions.ts`,
`packages/background-tasks/src/api/permissions.ts`.
