import { Router } from 'express';

import { listProducts } from '../repositories/products.js';

export const productsRouter = Router();

productsRouter.get('/api/products', (_req, res) => {
  res.json({ products: listProducts() });
});
