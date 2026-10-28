export interface Line {
  readonly level: number;
  readonly index: number;
}

export const lineSize = (line: Line): number => 2 ** line.level;

export const firstMessage = (line: Line): number => line.index * lineSize(line);

export const lastMessage = (line: Line): number =>
  firstMessage(line) + lineSize(line) - 1;

export const parentOf = (line: Line): Line => ({
  index: Math.floor(line.index / 2),
  level: line.level + 1,
});

const mostDuePair = (
  view: readonly Line[],
  total: number,
  canMerge: (parent: Line) => boolean
): number => {
  let best = -1;
  let bestDue = Number.NEGATIVE_INFINITY;

  for (let position = 0; position + 1 < view.length; position += 1) {
    const left = view[position];
    const right = view[position + 1];

    const isPair =
      left !== undefined &&
      right !== undefined &&
      left.level === right.level &&
      left.index % 2 === 0 &&
      right.index === left.index + 1;

    if (isPair && canMerge(parentOf(left))) {
      const sinceEnd = total - lastMessage(right);
      const due = sinceEnd / lineSize(right);

      if (due > bestDue) {
        best = position;
        bestDue = due;
      }
    }
  }

  return best;
};

export const shrink = (
  view: readonly Line[],
  total: number,
  canMerge: (parent: Line) => boolean,
  overBudget: (view: readonly Line[]) => boolean
): Line[] => {
  const lines = [...view];

  while (overBudget(lines)) {
    const position = mostDuePair(lines, total, canMerge);
    const left = lines[position];

    if (left === undefined) {
      break;
    }

    lines.splice(position, 2, parentOf(left));
  }

  return lines;
};
