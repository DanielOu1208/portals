import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchPriceList, priceFileText, pricesUrl, trimPrices } from "../src/usage/prices.ts";

// Makes src/usage/prices.json, the price table the host ships with, from LiteLLM's public
// list: run at each release (`node scripts/prices.ts`), and the change committed. The
// host fetches the same list once a day itself (src/usage/prices.ts); this is what it
// has before that, and when it cannot.

const target = fileURLToPath(new URL("../src/usage/prices.json", import.meta.url));
const file = trimPrices(await fetchPriceList(pricesUrl), Date.now());
writeFileSync(target, priceFileText(file));
console.log(`${Object.keys(file.perMillion).length} models written to ${target}`);
