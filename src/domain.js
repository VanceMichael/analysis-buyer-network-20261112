import { validateRecords } from './dataset.js';

export function summarize(records) {
  validateRecords(records);
  const grouped = new Map();
  for (const row of [...records].sort((left, right) => left.id.localeCompare(right.id, 'en'))) {
    const key = String(row["relation"]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const groups = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, members]) => {
      const totals = Object.fromEntries(["period", "amount"].map(field => [field,
        members.reduce((sum, row) => sum + row[field], 0)]));
      return { key, count: members.length, sum: totals["amount"], nodes: new Set(members.flatMap(row => [row.left, row.right])).size };
    });
  return { groupBy: "relation", valueField: "amount", count: records.length, groups };
}
