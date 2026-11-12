import path from "node:path";

interface Managed {
  readonly name: string;
  readonly dir: string;
  /** Why write, edit and bash may not change it, as the model reads it. */
  readonly block: string;
}

/** Where things live in the data folder. Only the workspace is open to tools; the managed folders inside it change only through their own tools. */
export interface Layout {
  readonly dataDir: string;
  /** Where gws downloads before a file moves into the workspace, outside every tool's reach. */
  readonly downloads: string;
  readonly workspace: string;
  /** Files read from the owner's Drive. */
  readonly drive: string;
  readonly items: string;
  /** Files the owner shares, received into the items folder. */
  readonly files: string;
  readonly flows: string;
  readonly lists: string;
  readonly skills: string;
  readonly managed: readonly Managed[];
}

/** The managed folders by name, as a sentence lists them: "items, flows, lists and skills". */
export const managedNames = (layout: Layout): string =>
  new Intl.ListFormat("en", { type: "conjunction" }).format(
    layout.managed.map(({ name }) => name)
  );

export const layoutOf = (dataDir: string): Layout => {
  const workspace = path.join(dataDir, "workspace");
  const items = path.join(workspace, "items");
  const flows = path.join(workspace, "flows");
  const lists = path.join(workspace, "lists");
  const skills = path.join(workspace, "skills");

  return {
    dataDir,
    downloads: path.join(dataDir, "downloads"),
    drive: path.join(workspace, "drive"),
    files: path.join(items, "files"),
    flows,
    items,
    lists,
    managed: [
      {
        block: "Saved items change only through save_item.",
        dir: items,
        name: "items",
      },
      {
        block: "Flows change only through save_flow.",
        dir: flows,
        name: "flows",
      },
      {
        block: "Lists change only through the list tools.",
        dir: lists,
        name: "lists",
      },
      {
        block: "Skills are owner-managed and cannot be changed by tools.",
        dir: skills,
        name: "skills",
      },
    ],
    skills,
    workspace,
  };
};
