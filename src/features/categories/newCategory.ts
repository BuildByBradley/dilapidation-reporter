import * as repo from '../../data/repo';

/** Value of the "+ New category…" entry at the end of a category dropdown. */
export const NEW_CATEGORY = '__new_category__';

/** Ask for a name and add the category. Returns its id, or null if cancelled. Errors (e.g. duplicate name) are thrown. */
export async function promptNewCategory(projectId: string): Promise<string | null> {
  const name = window.prompt('Name of the new category');
  if (!name?.trim()) return null;
  return (await repo.quickAddCategory(projectId, name)).id;
}
