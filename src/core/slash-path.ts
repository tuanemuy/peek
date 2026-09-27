declare const slashPathBrand: unique symbol;

/**
 * A `/`-separated path relative to the previewed directory: the form that the
 * file tree, change notifications and `/view?path=` share. On the server only
 * `toSlashPath` (`./path.ts`) produces one, so an OS path cannot reach them
 * unconverted. The client takes one from `/view` URLs, `/api/tree` and change
 * notifications where it reads them.
 */
export type SlashPath = string & { readonly [slashPathBrand]: true };
