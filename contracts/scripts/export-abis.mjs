import { readFile, writeFile, mkdir } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const names = [
  "AtlasUSDT",
  "AtlasVault",
  "AtlasStockToken",
  "AtlasStockFactory",
  "AtlasPriceEngine",
  "AtlasMarketRegistry",
  "AtlasTradingEngine",
  "AtlasCountryMarket",
  "AtlasCountryProxy",
  "AtlasCountryTradingEngine",
];
const abis = {};
await mkdir(new URL("abi/", root), { recursive: true });
for (const name of names) {
  const artifact = JSON.parse(
    await readFile(new URL(`out/${name}.sol/${name}.json`, root), "utf8"),
  );
  abis[name] = artifact.abi;
  await writeFile(
    new URL(`abi/${name}.json`, root),
    JSON.stringify(artifact.abi, null, 2) + "\n",
  );
}
for (const target of [
  "../frontend/src/lib/protocol/abis.json",
  "../backend/src/protocol/abis.json",
])
  await writeFile(new URL(target, root), JSON.stringify(abis, null, 2) + "\n");
await writeFile(
  new URL("../admin/src/abis.json", root),
  JSON.stringify(
    Object.fromEntries(
      [
        "AtlasUSDT",
        "AtlasVault",
        "AtlasCountryMarket",
        "AtlasCountryTradingEngine",
      ].map((name) => [name, abis[name]]),
    ),
    null,
    2,
  ) + "\n",
);
console.log(
  "Exported contract ABIs to contracts/abi, Atlas, backend and the standalone dashboard.",
);
const catalog = await readFile(new URL("config/stocks.json", root), "utf8");
for (const target of [
  "../frontend/src/lib/protocol/catalog.json",
  "../backend/src/protocol/catalog.json",
])
  await writeFile(new URL(target, root), catalog);
