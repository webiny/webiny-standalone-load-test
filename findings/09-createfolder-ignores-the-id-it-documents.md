# `createFolder` ignores the `id` its input type documents

webiny-js `6f462b597f`. Not load related; found while writing the websocket client. Not specific
to standalone.

## What I did

```
mutation { aco { createFolder(data: { id: "363ae59f7d4b7554a26ca51e", title: "id probe", slug: "id-probe-363ae59f", type: "ws-load-test" }) { data { id } error { message } } } }
```

## What happened

```
{"data":{"aco":{"createFolder":{"data":{"id":"6af455b6a0e7e80001450024"},"error":null}}}}
```

No error, and a different id than the one sent.

## Why

The input type promises it (`packages/api-aco/src/folder/createFolderTypeDefs.ts:82-85`):

```graphql
input FolderCreateInput {
     # Pass an ID if you want to create a folder with a specific ID.
     id: ID
```

`CreateFolderRepository.execute` spreads the whole input into the entry's `values`
(`packages/api-aco/src/features/folder/CreateFolder/CreateFolderRepository.ts:48-54`):

```ts
const result = await this.createEntry.execute<CmsEntryFolder>(folderModel, {
    values: { ...data, parentId: data.parentId || null, path: pathResult.value }
});
```

`createEntry` takes the entry id at the top level of its input, not in `values`, so the id is
dropped and a new one generated.

## Suggested direction

Pass `id: data.id` at the top level of the `createEntry` input and leave it out of `values`, or
remove `id` from `FolderCreateInput` if choosing the id is not meant to be supported. A test that
creates a folder with an id and reads it back by that id would cover it.

Files: `packages/api-aco/src/features/folder/CreateFolder/CreateFolderRepository.ts`,
`packages/api-aco/src/folder/createFolderTypeDefs.ts`.
