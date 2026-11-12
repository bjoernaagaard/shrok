import path from "node:path";

interface Managed {
  readonly dir: string;
  /** Why write, edit and bash may not change it, as the model reads it. */
  readonly block: string;
}

/** Where things live in the data folder. Only the workspace is open to tools; the managed folders inside it change only through their own tools. */
export interface Layout {
  readonly dataDir: string;
  readonly workspace: string;
  readonly items: string;
  /** Files the owner shares, received into the items folder. */
  readonly files: string;
  readonly flows: string;
  readonly lists: string;
  readonly skills: string;
  readonly managed: readonly Managed[];
}

export const layoutOf = (dataDir: string): Layout => {
  const workspace = path.join(dataDir, "workspace");
  const items = path.join(workspace, "items");
  const flows = path.join(workspace, "flows");
  const lists = path.join(workspace, "lists");
  const skills = path.join(workspace, "skills");

  return {
    dataDir,
    files: path.join(items, "files"),
    flows,
    items,
    lists,
    managed: [
      { block: "Saved items change only through save_item.", dir: items },
      { block: "Flows change only through save_flow.", dir: flows },
      { block: "Lists change only through the list tools.", dir: lists },
      {
        block: "Skills are owner-managed and cannot be changed by tools.",
        dir: skills,
      },
    ],
    skills,
    workspace,
  };
};
