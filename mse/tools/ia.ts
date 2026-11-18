// bun mse/tools/ia.ts <id...> — что лежит в элементах archive.org (форматы, размеры, число сканов)
for (const id of Bun.argv.slice(2)) {
  const j: any = await (await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`, { headers: { "User-Agent": "BSE1-pipeline/0.2" } })).json();
  const files = (j.files ?? []).filter((x: any) => /\.(pdf|djvu|txt|zip|tar|xml|epub)$/i.test(x.name) && !/_meta\.xml|_files\.xml/.test(x.name));
  console.log(`## ${id}: ${j.metadata?.title ?? "нет"} | сканов ${j.metadata?.imagecount ?? "?"} | ${j.metadata?.date ?? ""} | ${j.metadata?.licenseurl ?? ""}`);
  for (const f of files) console.log(`   ${f.name}  ${Math.round((+f.size || 0) / 1e6)} MB  ${f.format ?? ""}`);
  await Bun.sleep(400);
}
