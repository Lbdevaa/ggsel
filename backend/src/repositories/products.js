/** Каталог статичный, читается из data/products.json один раз при старте. */
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';

const { products } = JSON.parse(
  fs.readFileSync(path.join(config.dataDir, 'products.json'), 'utf8'),
);

const bySku = new Map(products.map((p) => [p.sku, p]));

export const listProducts = () => products;

/** @returns {object | undefined} */
export const findProduct = (sku) => bySku.get(sku);
